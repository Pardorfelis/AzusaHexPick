using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using Velopack;
using Velopack.Sources;
using Forms = System.Windows.Forms;

namespace AzusaHexPick;

public partial class MainWindow : Window
{
    private readonly UserSettings settings = UserSettings.Load();
    private readonly ProcessManager processes = new();
    private readonly LocalBridge bridge = new();
    private readonly Forms.NotifyIcon tray;
    private UpdateManager updates = UpdatePolicy.CreateManager();
    private CancellationTokenSource? downloadCancellation;
    private UpdateInfo? pending;
    private bool downloaded, exiting, busy, updating, checking;
    private bool pendingFromWebsite, preferFallback;
    private string updateState = "idle", updateText = "尚未检查更新。", nextVersion = "", notes = "";
    private int progress;
    private readonly string version = typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "0.7.1";
    private readonly string[] arguments;

    public MainWindow(string[] args)
    {
        InitializeComponent();
        arguments = args;
        var bitmap = new BitmapImage(new Uri("pack://application:,,,/Assets/signature.png"));
        Signature.Source = new CroppedBitmap(bitmap, new Int32Rect(90, 85, 475, 270));
        PhoneMode.IsChecked = settings.PhoneMode;
        LoadDeliveryFeedback();
        FeedbackAddress.Text = settings.FeedbackUrl;
        SettingsPanel.IsExpanded = !settings.OnboardingComplete;
        VersionLabel.Text = "v" + version;
        KeyHint.Text = UserSettings.HasKey ? "密钥已加密保存在这台电脑。需要更换时重新粘贴即可。" : KeyHint.Text;
        if (UserSettings.ReadWarning != "") ServiceStatus.Text = UserSettings.ReadWarning;
        using var iconStream = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/Assets/app.ico")).Stream;
        tray = new Forms.NotifyIcon { Text = "梓有妙选｜Azusa HexPick", Icon = new System.Drawing.Icon(iconStream), Visible = true };
        tray.DoubleClick += (_, _) => Dispatcher.Invoke(Reveal);
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("打开启动器", null, (_, _) => Dispatcher.Invoke(Reveal));
        menu.Items.Add("打开控制台", null, (_, _) => Dispatcher.Invoke(() => OpenConsole()));
        menu.Items.Add("显示桌面副屏", null, (_, _) => Dispatcher.Invoke(ShowDesktop));
        menu.Items.Add("设置", null, (_, _) => Dispatcher.Invoke(() => { Reveal(); SettingsPanel.IsExpanded = true; }));
        menu.Items.Add("问题反馈", null, (_, _) => Dispatcher.Invoke(Feedback));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("退出全部", null, (_, _) => Dispatcher.Invoke(() => _ = Exit(true)));
        tray.ContextMenuStrip = menu;
        bridge.State = () => new { state = updateState, message = updateText, version, nextVersion,
            notes, progress, feedbackUrl = UserSettings.ValidFeedback(settings.FeedbackUrl) };
        bridge.Command = action => Dispatcher.BeginInvoke(() => HandleCommand(action));
        Loaded += async (_, _) =>
        {
            try { await bridge.Start(); }
            catch { ServiceStatus.Text = "本机管理接口未能启动，请退出后重试。"; StartButton.IsEnabled = false; return; }
#if UPDATE_TESTING
            if (args.Contains("--smoke-update") || args.Contains("--smoke-complete")) { await RunUpdateSmoke(args); return; }
#endif
            _ = CheckUpdates();
            if (args.Contains("--resume")) await StartUse();
        };
        Closing += OnClosing;
        StateChanged += (_, _) => { if (WindowState == WindowState.Minimized) Hide(); };
    }

    private void LoadDeliveryFeedback()
    {
        if (UserSettings.ValidFeedback(settings.FeedbackUrl) != "") return;
        try
        {
            var delivery = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(ProcessManager.AppRoot, "delivery.json")));
            settings.FeedbackUrl = UserSettings.ValidFeedback(delivery.GetProperty("feedbackUrl").GetString() ?? "");
        }
        catch { }
    }

    public void Reveal() { Show(); WindowState = WindowState.Normal; Activate(); }
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (exiting) return;
        e.Cancel = true;
        if (processes.Running) { Hide(); tray.ShowBalloonTip(3000, "梓有妙选仍在运行", "从托盘可以重新打开；结束使用请选择退出全部。", Forms.ToolTipIcon.Info); }
        else _ = Exit(false);
    }
    private void OpenConsole() { if (processes.Running) ProcessManager.Open(ProcessManager.BaseUrl); else Reveal(); }
    private void ShowDesktop()
    {
        if (busy || updating || exiting) return;
        try { processes.ShowDesktop(); }
        catch { ServiceStatus.Text = "副屏未能打开，请检查程序文件是否完整，再重试。"; }
    }
    private void HandleCommand(string action)
    {
        switch (action)
        {
            case "show": Reveal(); break;
            case "settings": Reveal(); SettingsPanel.IsExpanded = true; break;
            case "desktop": ShowDesktop(); break;
            case "check-update": _ = CheckUpdates(); break;
            case "update": Reveal(); _ = ApplyUpdate(); break;
            case "exit": _ = Exit(false); break;
        }
    }

    private async Task StartUse()
    {
        if (busy || updating || exiting) return;
        busy = true; StartButton.IsEnabled = false; ServiceStatus.Text = "正在准备服务与桌面副屏……";
        InstallButton.IsEnabled = false;
        try { await StartManaged(); }
        catch (Exception error) { ServiceStatus.Text = Friendly(error, "启动没有完成，请重试或打开使用教程。"); }
        finally { busy = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall; }
    }
    private async Task StartManaged(bool openConsole = true, bool hideWindow = true)
    {
        await processes.Start(settings, bridge);
        if (!settings.OnboardingComplete) { settings.OnboardingComplete = true; settings.Save(); }
        ServiceStatus.Text = "正在运行。窗口收起后，可以从托盘重新打开。";
        StartButton.Content = "打开控制台";
        if (openConsole) ProcessManager.Open(ProcessManager.BaseUrl);
        if (hideWindow) Hide();
    }
    private bool CanInstall => pending != null && !updating && !busy && !checking && !exiting;
    private async Task CancelRestartGate()
    {
        if (processes.Running) { try { await processes.Control("cancel-update"); } catch { } }
    }
    private async void Start_Click(object sender, RoutedEventArgs e) => await StartUse();

    private async void SaveKey_Click(object sender, RoutedEventArgs e)
    {
        if (busy || updating || exiting) return;
        busy = true; StartButton.IsEnabled = false; InstallButton.IsEnabled = false;
        bool restart = processes.Running;
        bool saved = false;
        try
        {
            if (restart && await processes.Collecting()) { ServiceStatus.Text = "请先结束本轮收集，再保存密钥。"; return; }
            if (restart && System.Windows.MessageBox.Show(this, "保存后需要重启服务，本场灰名单会清空。现在继续吗？", "保存密钥", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            // 确认期间仍可收到快捷键；服务门禁会再次检查收集状态并阻止新轮。
            if (restart) await processes.Control("prepare-update");
            UserSettings.SaveKey(ApiKey.Password); ApiKey.Clear();
            saved = true;
            KeyHint.Text = "密钥已加密保存，以后无需再次填写。";
            if (restart) { await processes.Stop(); await StartManaged(); }
            else ServiceStatus.Text = "已保存密钥。点击开始使用即可。";
        }
        catch (Exception error) { ServiceStatus.Text = saved ? "密钥已保存，服务暂未重新启动。请点击开始使用重试。"
            : Friendly(error, "密钥未能保存。请先结束本轮收集，并检查用户数据目录权限后重试。"); }
        finally
        {
            if (restart) await CancelRestartGate();
            busy = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall;
        }
    }

    private async void SaveSettings_Click(object sender, RoutedEventArgs e)
    {
        if (busy || updating || exiting) return;
        string feedback = FeedbackAddress.Text.Trim();
        if (feedback != "" && UserSettings.ValidFeedback(feedback) == "") { ServiceStatus.Text = "请填写腾讯问卷的 HTTPS 公开填写链接。"; return; }
        busy = true; StartButton.IsEnabled = false; InstallButton.IsEnabled = false;
        bool previousPhoneMode = settings.PhoneMode;
        string previousFeedback = settings.FeedbackUrl;
        bool restart = processes.Running && settings.PhoneMode != (PhoneMode.IsChecked == true);
        bool saved = false;
        try
        {
            if (restart && (await processes.Collecting() || System.Windows.MessageBox.Show(this,
                "切换手机模式需要重启服务，本场灰名单会清空。现在继续吗？", "保存偏好", MessageBoxButton.OKCancel) != MessageBoxResult.OK))
            { ServiceStatus.Text = "尚未切换手机模式，请在结束本轮后重试。"; return; }
            if (restart) await processes.Control("prepare-update");
            settings.PhoneMode = PhoneMode.IsChecked == true; settings.FeedbackUrl = feedback; settings.Save();
            saved = true;
            ServiceStatus.Text = "偏好已保存。";
            if (restart) { await processes.Stop(); await StartManaged(); }
        }
        catch
        {
            if (!saved) { settings.PhoneMode = previousPhoneMode; settings.FeedbackUrl = previousFeedback; }
            ServiceStatus.Text = saved ? "偏好已保存，服务暂未重新启动。请点击开始使用重试。"
                : "偏好未能保存。请先结束本轮收集，并检查用户数据目录权限后重试。";
        }
        finally
        {
            if (restart) await CancelRestartGate();
            busy = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall;
        }
    }

    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        if (busy || updating || exiting || processes.Running) { ServiceStatus.Text = "导入前请先退出全部，再打开启动器。"; return; }
        busy = true; StartButton.IsEnabled = false; InstallButton.IsEnabled = false;
        try
        {
            var picker = new OpenFolderDialog { Title = "选择旧版梓有妙选文件夹" };
            if (picker.ShowDialog(this) != true) return;
            var info = new ProcessStartInfo(ProcessManager.NodePath) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardError = true, RedirectStandardOutput = true, WorkingDirectory = ProcessManager.AppRoot };
            info.ArgumentList.Add(Path.Combine(ProcessManager.AppRoot, "scripts", "migrate-user-data.mjs"));
            info.ArgumentList.Add(picker.FolderName); info.ArgumentList.Add(UserSettings.DirectoryPath);
            using var process = Process.Start(info)!;
            var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            if (process.ExitCode != 0) throw new InvalidDataException();
            int copied = JsonSerializer.Deserialize<JsonElement>(await output).GetProperty("copied").GetInt32();
            ServiceStatus.Text = copied > 0 ? "旧版外观、背景、名单和字号已导入，原文件保留。密钥请单独填写。" : "该目录未找到可导入的个人设置，原文件未改动。";
            await error;
        }
        catch { ServiceStatus.Text = "导入未完成。请确认旧版目录正确、新版尚未产生同名设置。原文件和导入备份均保留。"; }
        finally { busy = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall; }
    }

    private void Guide_Click(object sender, RoutedEventArgs e)
    {
        try { ProcessManager.Open(Path.Combine(ProcessManager.AppRoot, "public", "guide.html")); }
        catch { ServiceStatus.Text = "教程文件无法打开，请检查是否完整解压。"; }
    }
    private void Feedback_Click(object sender, RoutedEventArgs e) => Feedback();
    private void Feedback()
    {
        string url = UserSettings.ValidFeedback(settings.FeedbackUrl);
        if (url == "") { Reveal(); SettingsPanel.IsExpanded = true; ServiceStatus.Text = "反馈问卷尚未配置，请由维护者填写公开链接后使用。"; return; }
        try { ProcessManager.Open(url); }
        catch { ServiceStatus.Text = "反馈页未能打开，请检查网络后重试。"; }
    }

    private void UpdateUi(string state, string message)
    {
        updateState = state; updateText = message; UpdateMessage.Text = message;
        ReleaseNotes.Text = notes;
        UpdateActions.Visibility = pending != null ? Visibility.Visible : Visibility.Collapsed;
        InstallButton.IsEnabled = CanInstall;
        UpdateProgress.Visibility = updating ? Visibility.Visible : Visibility.Collapsed;
        CancelDownload.Visibility = state == "downloading" ? Visibility.Visible : Visibility.Collapsed;
        UpdateProgress.Value = progress;
    }
    private async Task CheckUpdates()
    {
        if (updating || checking || busy || exiting) return;
        checking = true;
        UpdateUi("checking", "正在检查正式版本……");
        try
        {
            if (!updates.IsInstalled) { UpdateUi("development", "当前为开发目录；便携发布包支持应用内更新。"); return; }
            var checkedRelease = await UpdatePolicy.CheckForUpdatesAsync(UpdatePolicy.CreateManager(), preferFallback);
            updates = checkedRelease.Manager;
            pending = checkedRelease.Release;
            pendingFromWebsite = checkedRelease.FromWebsite;
            downloaded = false;
            nextVersion = pending?.TargetFullRelease.Version.ToString() ?? "";
            notes = pending?.TargetFullRelease.NotesMarkdown ?? "";
            if (notes.Length > 1200) notes = notes[..1200];
            string fallbackNote = checkedRelease.UsedFallback ? "官网更新暂不可用，已通过备用来源检查。" : "";
            UpdateUi(pending == null ? "current" : "available", fallbackNote + (pending == null ? "当前已是最新正式版本。" : "发现 v" + nextVersion + "，方便时点一下即可更新。"));
        }
        catch { UpdateUi("error", "暂时无法连接更新源。当前版本仍可使用，稍后可以重新检查。"); }
        finally { checking = false; InstallButton.IsEnabled = CanInstall; }
    }
    private async void Check_Click(object sender, RoutedEventArgs e) => await CheckUpdates();
    private async void Update_Click(object sender, RoutedEventArgs e) => await ApplyUpdate();
    private void CancelDownload_Click(object sender, RoutedEventArgs e) => downloadCancellation?.Cancel();
    private void Later_Click(object sender, RoutedEventArgs e) { UpdateActions.Visibility = Visibility.Collapsed; UpdateMessage.Text = "已暂缓更新，需要时点击检查更新。"; }

    private async Task ApplyUpdate()
    {
        if (updating || busy || checking || exiting || pending == null) return;
        // Dispatcher 中先占用操作状态，再等待服务，避免重复点击同时进入升级。
        updating = true;
        var target = pending;
        var targetManager = updates;
        bool wasRunning = processes.Running;
        StartButton.IsEnabled = false;
        UpdateUi("preparing", "正在检查本轮是否已经结束……");
        try
        {
            if (await processes.Collecting()) { UpdateUi("available", "本轮仍在收集，请结束后再更新。更新会重启服务并结束本场灰名单。"); return; }
            UpdateUi("downloading", "正在下载并校验更新，暂不关闭当前服务……");
            UpdatePolicy.CheckDiskSpace(target.TargetFullRelease.Size);
            downloadCancellation = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            if (!downloaded)
                await targetManager.DownloadUpdatesAsync(target, p => Dispatcher.BeginInvoke(() => { progress = p; UpdateProgress.Value = p; }), downloadCancellation.Token);
            await UpdatePolicy.VerifyDownloadedAsync(targetManager, target.TargetFullRelease);
            downloaded = true;
            if (await processes.Collecting()) { UpdateUi("ready", "更新已准备好。本轮收集结束后，再点击更新即可。"); return; }
            if (processes.Running) await processes.Control("prepare-update");
            UpdatePolicy.CheckDiskSpace(target.TargetFullRelease.Size);
            BackupSettings();
            UpdateUi("applying", "正在关闭服务并更新，稍后自动重新打开……");
            await processes.Stop();
#if UPDATE_TESTING
            targetManager.ApplyUpdatesAndRestart(target, restartArgs: arguments.Contains("--smoke-update") ? ["--smoke-complete"] : ["--resume"]);
#else
            targetManager.ApplyUpdatesAndRestart(target, restartArgs: ["--resume"]);
#endif
        }
        catch (OperationCanceledException error) when (downloadCancellation?.IsCancellationRequested == true || !UpdatePolicy.IsNetworkFailure(error))
        {
            await RestoreAfterUpdate(wasRunning);
            UpdateUi("available", "下载已取消，当前版本继续可用。需要时可以重试。");
        }
        catch (Exception error)
        {
#if UPDATE_TESTING
            File.WriteAllText(Path.Combine(UserSettings.DirectoryPath, "smoke-update-error.json"), JsonSerializer.Serialize(new { error = error.ToString() }));
#endif
            if (error is Velopack.Exceptions.ChecksumFailedException) downloaded = false;
            await RestoreAfterUpdate(wasRunning);
            if (pendingFromWebsite && !downloaded && UpdatePolicy.IsNetworkFailure(error))
            {
                preferFallback = true;
                pending = null;
                UpdateUi("error", "当前下载源连接失败，旧版仍可使用。点击“检查更新”，可以通过备用来源重试。");
            }
            else UpdateUi("error", "更新未完成，已保留当前程序和个人设置。请检查网络、空间或文件占用后重试。");
        }
        finally { downloadCancellation?.Dispose(); downloadCancellation = null; updating = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall; CancelDownload.Visibility = Visibility.Collapsed; UpdateProgress.Visibility = Visibility.Collapsed; }
    }

    private async Task RestoreAfterUpdate(bool wasRunning)
    {
        if (processes.Running)
        {
            await CancelRestartGate();
            ServiceStatus.Text = "正在运行。更新未完成，当前版本继续可用。";
            return;
        }
        if (!wasRunning) { ServiceStatus.Text = "服务尚未启动。点击开始使用即可。"; return; }
        try
        {
            await StartManaged(openConsole: false, hideWindow: false);
            ServiceStatus.Text = "更新未完成，当前版本已重新启动。";
        }
        catch { ServiceStatus.Text = "更新未完成，服务暂未恢复。请点击开始使用重试。"; StartButton.Content = "开始使用"; }
    }

    private static void BackupSettings()
    {
        string backup = Path.Combine(UserSettings.DirectoryPath, "backups", "update-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"));
        Directory.CreateDirectory(backup);
        foreach (var name in new[] { "launcher.json", "deepseek.key", "app-settings.json", "appearance.json", "song-blacklist.json" })
        {
            string path = Path.Combine(UserSettings.DirectoryPath, name);
            if (File.Exists(path)) File.Copy(path, Path.Combine(backup, name), false);
        }
    }

    private async Task Exit(bool confirm)
    {
        if (exiting || updating || busy) return;
        busy = true; StartButton.IsEnabled = false; InstallButton.IsEnabled = false;
        try
        {
            if (confirm && System.Windows.MessageBox.Show(this, "退出全部会关闭服务与桌面副屏，并结束本场灰名单。", "结束使用", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            exiting = true;
            await processes.Stop(); await bridge.DisposeAsync();
            tray.Visible = false; tray.Dispose(); processes.Dispose();
            System.Windows.Application.Current.Shutdown();
        }
        catch { exiting = false; ServiceStatus.Text = "退出未能完成，请稍后重试。"; }
        finally { busy = false; StartButton.IsEnabled = true; InstallButton.IsEnabled = CanInstall; }
    }
    private static string Friendly(Exception error, string fallback) => error is InvalidOperationException or InvalidDataException ? error.Message : fallback;
}

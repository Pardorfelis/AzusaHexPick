using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace AzusaHexPick;

public sealed class ProcessManager : IDisposable
{
    public static string AppRoot => Path.Combine(AppContext.BaseDirectory, "app");
    public static string NodePath => Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
    public static string PanelPath => Path.Combine(AppContext.BaseDirectory, "runtime", "desktop", "AzusaPanel.exe");
    public const string BaseUrl = "http://127.0.0.1:5178";
    private readonly HttpClient client = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(4), MaxResponseContentBufferSize = 1048576 };
    private Process? service;
    private Process? desktop;
    public bool Running => service is { HasExited: false };

    public async Task<JsonElement?> Get(string route)
    {
        try { return await client.GetFromJsonAsync<JsonElement>(BaseUrl + route); }
        catch { return null; }
    }

    public async Task<bool> Collecting() => (await Get("/api/state")) is { } value
        && value.TryGetProperty("status", out var status) && status.GetString() == "collecting";

    public async Task Control(string action)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/api/control");
        request.Headers.Add("X-Panel-Control", "1");
        request.Content = JsonContent.Create(new { action });
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public async Task Start(UserSettings settings, LocalBridge bridge)
    {
        if (Running) { ShowDesktop(); return; }
        if (await Get("/api/health") != null)
            throw new InvalidOperationException("端口 5178 已有服务运行。请先退出旧版，再点击开始使用。");
        if (!File.Exists(NodePath) || !File.Exists(PanelPath) || !File.Exists(Path.Combine(AppRoot, "server.mjs")))
            throw new InvalidOperationException("程序文件不完整。请把整个压缩包解压后，再打开梓有妙选.exe。");
        string key;
        try { key = UserSettings.ReadKey(); }
        catch { throw new InvalidOperationException("密钥无法解密，请在首次设置中重新粘贴保存。"); }
        var start = new ProcessStartInfo(NodePath) { WorkingDirectory = AppRoot, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true, RedirectStandardOutput = true };
        start.ArgumentList.Add(Path.Combine(AppRoot, "server.mjs"));
        if (settings.PhoneMode) start.ArgumentList.Add("--lan");
        start.Environment["AZUSA_USER_DATA"] = UserSettings.DirectoryPath;
        start.Environment["AZUSA_LAUNCHER_URL"] = bridge.Url;
        start.Environment["AZUSA_LAUNCHER_SECRET"] = bridge.Secret;
        start.Environment["DEEPSEEK_API_KEY"] = key;
        start.Environment["AZUSA_PORT"] = "5178";
        start.Environment.Remove("NODE_OPTIONS");
        service = Process.Start(start) ?? throw new InvalidOperationException("本机服务未能启动，请重新解压到可写文件夹。");
        // 不把子进程输出写入诊断，避免未来依赖把环境或私人路径带入日志。
        _ = service.StandardOutput.ReadToEndAsync();
        _ = service.StandardError.ReadToEndAsync();
        for (int i = 0; i < 40; i++)
        {
            if (service.HasExited) break;
            if ((await Get("/api/health")) is { } health && health.GetProperty("app").GetString() == "azusa-validation")
            { ShowDesktop(); return; }
            await Task.Delay(200);
        }
        await Stop();
        throw new InvalidOperationException("服务未能就绪，请检查端口占用，或使用问题反馈入口联系维护者。");
    }

    public void ShowDesktop()
    {
        if (!Running || desktop is { HasExited: false }) return;
        var start = new ProcessStartInfo(PanelPath) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppRoot };
        start.Environment["AZUSA_USER_DATA"] = UserSettings.DirectoryPath;
        start.Environment["AZUSA_RESOURCE_ROOT"] = AppRoot;
        start.Environment.Remove("DEEPSEEK_API_KEY");
        desktop = Process.Start(start);
    }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);

    private static async Task StopOwned(Process? process, bool native)
    {
        if (process == null) return;
        try
        {
            if (process.HasExited) return;
            if (native) EnumWindows((hwnd, _) => { GetWindowThreadProcessId(hwnd, out uint pid);
                if (pid == process.Id) PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); return true; }, IntPtr.Zero);
            using var timeout = new CancellationTokenSource(4000);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { if (!process.HasExited) process.Kill(true); await process.WaitForExitAsync(); }
        }
        catch (InvalidOperationException) { }
        finally { process.Dispose(); }
    }

    public async Task Stop()
    {
        if (Running) { try { await Control("shutdown"); } catch { } }
        await Task.WhenAll(StopOwned(desktop, true), StopOwned(service, false));
        desktop = service = null;
    }

    public static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
    public void Dispose() => client.Dispose();
}

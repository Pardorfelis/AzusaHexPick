using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Velopack;
using Velopack.Logging;
using Velopack.Locators;
using Velopack.Sources;

namespace AzusaHexPick;

public static class UpdatePolicy
{
    public sealed record CheckedRelease(UpdateManager Manager, UpdateInfo? Release, bool UsedFallback, bool FromWebsite = false);

    public static UpdateManager CreateManager()
    {
#if UPDATE_TESTING
        // 仅独立升级测试构建支持本地源，正式包不存在此入口。
        var feed = Environment.GetEnvironmentVariable("AZUSA_TEST_UPDATE_FEED");
        if (!string.IsNullOrWhiteSpace(feed)) return feed.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)
            ? new VerifiedUpdateManager(new StableWebSource(feed)) : new VerifiedUpdateManager(new SimpleFileSource(new DirectoryInfo(feed)));
#endif
        return new VerifiedUpdateManager(new GithubSource("https://github.com/Pardorfelis/AzusaHexPick", null, false));
    }

    public static string ReadWebFeed()
    {
        try
        {
            var delivery = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(ProcessManager.AppRoot, "delivery.json")));
            if (!delivery.TryGetProperty("updateBaseUrl", out var value)) return "";
            return ValidWebFeed(value.GetString());
        }
        catch { return ""; }
    }

    public static string ValidWebFeed(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            uri.HostNameType != UriHostNameType.Dns || uri.IsLoopback || uri.Port != 443 ||
            uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "") return "";
        return uri.AbsoluteUri.TrimEnd('/') + "/";
    }

    public static async Task<CheckedRelease> CheckForUpdatesAsync(UpdateManager fallback, bool preferFallback = false)
    {
#if UPDATE_TESTING
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AZUSA_TEST_UPDATE_FEED")))
            return new(fallback, await fallback.CheckForUpdatesAsync(), false);
#endif
        string feed = ReadWebFeed();
        if (feed == "") return new(fallback, await fallback.CheckForUpdatesAsync(), false);
        if (preferFallback) return new(fallback, await fallback.CheckForUpdatesAsync(), true);
        var primary = new VerifiedUpdateManager(new StableWebSource(feed));
        return await CheckSourcesAsync(primary, fallback);
    }

    internal static async Task<CheckedRelease> CheckSourcesAsync(UpdateManager primary, UpdateManager fallback)
    {
        try { return new(primary, await primary.CheckForUpdatesAsync(), false, true); }
        catch { return new(fallback, await fallback.CheckForUpdatesAsync(), true); }
    }

    public static bool IsNetworkFailure(Exception error) =>
        error is System.Net.Http.HttpRequestException or System.Net.Http.HttpIOException or
            System.Net.WebException or System.Net.Sockets.SocketException or TimeoutException ||
        (error.InnerException != null && IsNetworkFailure(error.InnerException));

    public static Task VerifyDownloadedAsync(UpdateManager manager, VelopackAsset release) =>
        manager is VerifiedUpdateManager verified ? verified.VerifyCachedAsync(release) :
            throw new InvalidOperationException("更新管理器无法验证下载成果。");

    // 差量重建改变 ZIP 压缩字节。受检差量链完成后保存受用户加密保护的缓存凭据，重启后继续核验。
    internal sealed class VerifiedUpdateManager(IUpdateSource source, UpdateOptions? options = null, IVelopackLocator? locator = null)
        : UpdateManager(new RecordedSource(source), options, locator)
    {
        private sealed record CacheReceipt(string PackageId, string Version, string Channel, string FileName,
            long PublishedSize, string PublishedHash, long CachedSize, string CachedHash);
        private static readonly byte[] ReceiptEntropy = System.Text.Encoding.UTF8.GetBytes("AzusaHexPick/delta-cache/v1");
        private string CachePath(VelopackAsset release)
        {
            string directory = Path.GetFullPath(Locator.PackagesDir ?? throw new InvalidDataException("更新缓存位置不存在。"));
            if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("更新缓存目录经过文件链接，已停止应用更新。");
            if (release.PackageId != AppId || release.Type != VelopackAssetType.Full ||
                release.FileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                release.FileName != $"{release.PackageId}-{release.Version}-full.nupkg")
                throw new InvalidDataException("更新缓存不属于本应用，已停止应用更新。");
            string path = Path.Combine(directory, release.FileName);
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("更新缓存经过文件链接，已停止应用更新。");
            return path;
        }
        private static async Task<string> HashFile(string path)
        {
            await using var file = File.OpenRead(path);
            return Convert.ToHexString(await SHA256.HashDataAsync(file));
        }
        private async Task<bool> HasVerifiedReceipt(VelopackAsset release, string path)
        {
            try
            {
                string proof = path + ".azusa-verified";
                if (!File.Exists(proof) || (File.GetAttributes(proof) & FileAttributes.ReparsePoint) != 0 || new FileInfo(proof).Length > 8192) return false;
                var receipt = JsonSerializer.Deserialize<CacheReceipt>(ProtectedData.Unprotect(await File.ReadAllBytesAsync(proof), ReceiptEntropy, DataProtectionScope.CurrentUser));
                return receipt != null && receipt.PackageId == AppId && receipt.Version == release.Version.ToString() &&
                    receipt.Channel == Channel && receipt.FileName == release.FileName && receipt.PublishedSize == release.Size &&
                    string.Equals(receipt.PublishedHash, release.SHA256, StringComparison.OrdinalIgnoreCase) && File.Exists(path) &&
                    receipt.CachedSize == new FileInfo(path).Length && receipt.CachedHash == await HashFile(path);
            }
            catch (Exception error) when (error is IOException or CryptographicException or JsonException) { return false; }
        }
        internal async Task VerifyCachedAsync(VelopackAsset release)
        {
            string path = CachePath(release);
            try { await VerifyPackageChecksumAsync(release, path); }
            catch (Velopack.Exceptions.ChecksumFailedException)
            {
                if (await HasVerifiedReceipt(release, path)) return;
                if (File.Exists(path)) File.Delete(path);
                if (File.Exists(path + ".azusa-verified")) File.Delete(path + ".azusa-verified");
                throw;
            }
        }
        protected override async Task DownloadAndApplyDeltaUpdates(UpdateInfo updates, string targetFile, Action<int> progress, CancellationToken cancelToken)
        {
            var baseline = ((RecordedSource)Source).Assets.FirstOrDefault(asset => asset.Type == VelopackAssetType.Full &&
                asset.PackageId == AppId && asset.Version == updates.BaseRelease?.Version);
            if (baseline == null) throw new InvalidDataException("更新源缺少可验证的差量基础包，将使用完整更新包。");
            await VerifyCachedAsync(baseline);
            await base.DownloadAndApplyDeltaUpdates(updates, targetFile, progress, cancelToken);
            cancelToken.ThrowIfCancellationRequested();
            await ValidateRebuiltPackage(targetFile, updates.TargetFullRelease);
            string path = CachePath(updates.TargetFullRelease);
            var receipt = new CacheReceipt(AppId!, updates.TargetFullRelease.Version.ToString(), Channel,
                updates.TargetFullRelease.FileName, updates.TargetFullRelease.Size, updates.TargetFullRelease.SHA256,
                new FileInfo(targetFile).Length, await HashFile(targetFile));
            string temporary = path + ".azusa-verified." + Guid.NewGuid().ToString("N") + ".tmp";
            await File.WriteAllBytesAsync(temporary, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(receipt), ReceiptEntropy, DataProtectionScope.CurrentUser), cancelToken);
            File.Move(temporary, path + ".azusa-verified", true);
        }
        internal static async Task ValidateRebuiltPackage(string path, VelopackAsset release)
        {
            using var archive = ZipFile.OpenRead(path);
            var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
            bool SafePath(string name) => name != "" && !name.StartsWith('/') && !name.Contains('\\') && !name.Contains(':') &&
                !name.Split('/').Any(part => part is "." or "..");
            foreach (var entry in archive.Entries)
            {
                if (!SafePath(entry.FullName) || !entries.TryAdd(entry.FullName, entry) || Regex.IsMatch(entry.FullName,
                    @"(?i)(^|/)(\.env(?:\.[^/]*)?|(?:AGENTS|CLAUDE|GEMINI)\.md|\.agents|\.codex|\.claude|\.git|\.impeccable|user-data|userdata|deepseek\.key|launcher\.json|app-settings\.json|appearance\.json|desktop-display-\d+\.json|song-(?:blacklist|greylist)\.json)(/|$)"))
                    throw new InvalidDataException("重建更新包包含不安全路径或本机配置。");
            }
            ZipArchiveEntry Required(string name) => entries.TryGetValue(name, out var entry) ? entry : throw new InvalidDataException("重建更新包缺少核心文件。");
            using var manifestStream = Required("lib/app/package-manifest.json").Open();
            using var document = await JsonDocument.ParseAsync(manifestStream);
            var manifest = document.RootElement;
            if (manifest.GetProperty("version").GetString() != release.Version.ToString() || manifest.GetProperty("platform").GetString() != "win-x64" ||
                !manifest.GetProperty("selfContained").GetBoolean() || manifest.GetProperty("personalDataIncluded").GetBoolean() || manifest.GetProperty("files").GetArrayLength() < 10)
                throw new InvalidDataException("重建更新包的交付清单不符。");
            var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in manifest.GetProperty("files").EnumerateArray())
            {
                string name = file.GetProperty("path").GetString() ?? "";
                string hash = file.GetProperty("sha256").GetString() ?? "";
                if (!SafePath(name) || !Regex.IsMatch(hash, "^[a-fA-F0-9]{64}$") || !declared.Add("lib/app/" + name))
                    throw new InvalidDataException("重建更新包的文件清单不合法。");
                using var stream = Required("lib/app/" + name).Open();
                if (!Convert.ToHexString(await SHA256.HashDataAsync(stream)).Equals(hash, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("重建更新包内容与清单不一致。");
            }
            foreach (var core in new[] { "梓有妙选.exe", "Velopack.dll", "runtime/node.exe", "runtime/desktop/AzusaPanel.exe", "app/server.mjs", "app/package.json", "app/delivery.json", "app/public/index.html", "app/public/app.js", "app/public/guide.html" })
                if (!declared.Contains("lib/app/" + core)) throw new InvalidDataException("重建更新包缺少应用文件。");
            using var versionStream = Required("lib/app/sq.version").Open();
            using var xmlReader = XmlReader.Create(versionStream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            var metadata = XDocument.Load(xmlReader).Descendants().Single(node => node.Name.LocalName == "metadata");
            string Value(string key) => metadata.Elements().Single(node => node.Name.LocalName == key).Value;
            if (Value("id") != release.PackageId || Value("version") != release.Version.ToString() || Value("channel") != "win" || Value("mainExe") != "梓有妙选.exe")
                throw new InvalidDataException("重建更新包的应用身份不符。");
            var generated = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "lib/app/package-manifest.json", "lib/app/sq.version", "lib/app/Squirrel.exe", "lib/app/" + Value("title") + "_ExecutionStub.exe" };
            foreach (var entry in archive.Entries)
                if (entry.Name != "" && entry.FullName.StartsWith("lib/app/", StringComparison.OrdinalIgnoreCase) && !declared.Contains(entry.FullName) && !generated.Contains(entry.FullName))
                    throw new InvalidDataException("重建更新包存在清单之外的应用文件。");
        }
    }

    private sealed class RecordedSource(IUpdateSource source) : IUpdateSource
    {
        internal VelopackAsset[] Assets { get; private set; } = [];
        public async Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId, string channel, Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
        {
            var feed = await source.GetReleaseFeed(logger, appId, channel, stagingId, latestLocalRelease);
            Assets = feed.Assets.Select(asset => new VelopackAsset { PackageId = asset.PackageId, Version = asset.Version,
                Type = asset.Type, FileName = asset.FileName, Size = asset.Size, SHA256 = asset.SHA256, SHA1 = asset.SHA1 }).ToArray();
            return feed;
        }
        public Task DownloadReleaseEntry(IVelopackLogger logger, VelopackAsset releaseEntry, string localFile, Action<int> progress, CancellationToken cancelToken = default) =>
            source.DownloadReleaseEntry(logger, releaseEntry, localFile, progress, cancelToken);
    }

    // 官网仅发布稳定 win 渠道；客户端也排除误上传的预发布包与其他应用。
    internal sealed class StableWebSource(string url, IFileDownloader? downloader = null) : IUpdateSource
    {
        private readonly SimpleWebSource feedSource = new(url, downloader, timeout: 0.25);
        private readonly SimpleWebSource downloadSource = new(url, downloader, timeout: 10);
        public async Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId, string channel,
            Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
        {
            var feed = await feedSource.GetReleaseFeed(logger, appId, channel, stagingId, latestLocalRelease);
            feed.Assets = feed.Assets.Where(asset => !asset.Version.IsPrerelease && asset.PackageId == (appId ?? "AzusaHexPickApp") &&
                asset.FileName == $"{asset.PackageId}-{asset.Version}-{asset.Type.ToString().ToLowerInvariant()}.nupkg" &&
                asset.Size > 0 && asset.SHA256?.Length == 64 && asset.SHA256.All(Uri.IsHexDigit)).ToArray();
            if (feed.Assets.Length == 0) throw new InvalidDataException("官网没有可用的稳定更新清单。");
            return feed;
        }
        public Task DownloadReleaseEntry(IVelopackLogger logger, VelopackAsset releaseEntry, string localFile,
            Action<int> progress, CancellationToken cancelToken = default) =>
            downloadSource.DownloadReleaseEntry(logger, releaseEntry, localFile, progress, cancelToken);
    }

    public static long RequiredSpace(long packageBytes, long currentBytes) => checked(Math.Max(packageBytes * 6, currentBytes * 2) + 128L * 1024 * 1024);
    public static void EnsureSpace(long available, long packageBytes, long currentBytes)
    {
        if (available < RequiredSpace(packageBytes, currentBytes)) throw new IOException("磁盘空间不足，请清理空间后重试。");
    }
    public static void CheckDiskSpace(long packageBytes)
    {
        string root = Path.GetPathRoot(AppContext.BaseDirectory)!;
        long current = Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories).Sum(path => new FileInfo(path).Length);
        EnsureSpace(new DriveInfo(root).AvailableFreeSpace, packageBytes, current);
    }
}

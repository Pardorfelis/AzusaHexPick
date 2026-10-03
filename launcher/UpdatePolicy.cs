using System.IO;
using Velopack;
using Velopack.Sources;

namespace AzusaHexPick;

public static class UpdatePolicy
{
    public static UpdateManager CreateManager()
    {
#if UPDATE_TESTING
        // 仅独立升级测试构建支持本地源，正式包不存在此入口。
        var feed = Environment.GetEnvironmentVariable("AZUSA_TEST_UPDATE_FEED");
        if (!string.IsNullOrWhiteSpace(feed)) return feed.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)
            ? new UpdateManager(new SimpleWebSource(feed)) : new UpdateManager(new SimpleFileSource(new DirectoryInfo(feed)));
#endif
        return new UpdateManager(new GithubSource("https://github.com/Pardorfelis/AzusaHexPick", null, false));
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

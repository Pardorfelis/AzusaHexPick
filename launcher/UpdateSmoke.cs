#if UPDATE_TESTING
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AzusaHexPick;

// 此验证入口仅存在于独立测试构建中，正式发布不包含它。
public partial class MainWindow
{
    private static readonly string SmokeReport = Path.Combine(UserSettings.DirectoryPath, "smoke-result.json");
    private static readonly string PreserveFile = Path.Combine(UserSettings.DirectoryPath, "smoke-before.json");
    private static Dictionary<string, string> PersonalHashes() => new[] { "deepseek.key", "launcher.json", "app-settings.json", "appearance.json", "song-blacklist.json", "runtime/desktop-display-5178.json" }
        .Where(name => File.Exists(Path.Combine(UserSettings.DirectoryPath, name)))
        .ToDictionary(name => name, name => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(UserSettings.DirectoryPath, name)))));

    private async Task RunUpdateSmoke(string[] args)
    {
        Directory.CreateDirectory(UserSettings.DirectoryPath);
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(ProcessManager.BaseUrl) };
        client.DefaultRequestHeaders.Add("X-Panel-Control", "1");
        async Task<JsonElement> Post(string path, object data)
        {
            using var response = await client.PostAsync(path, new StringContent(JsonSerializer.Serialize(data), Encoding.UTF8, "application/json"));
            response.EnsureSuccessStatusCode();
            return JsonSerializer.Deserialize<JsonElement>(await response.Content.ReadAsStringAsync());
        }
        try
        {
            if (args.Contains("--smoke-complete"))
            {
                var before = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(PreserveFile))!;
                var after = PersonalHashes();
                if (before.Any(pair => !after.TryGetValue(pair.Key, out var hash) || hash != pair.Value)) throw new Exception("personal-data-changed");
                if (UserSettings.ReadKey() != "synthetic-never-a-real-key") throw new Exception("dpapi-decryption-failed");
                await processes.Start(settings, bridge);
                var health = JsonSerializer.Deserialize<JsonElement>(await client.GetStringAsync("/api/health"));
                await processes.Stop();
                File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = true, version, preservedFiles = after.Keys, service = health, paidApiCalls = 0 }));
                await Exit(false); return;
            }
            UserSettings.SaveKey("synthetic-never-a-real-key");
            if (Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(UserSettings.DirectoryPath, "deepseek.key"))).Contains("synthetic-never")) throw new Exception("plaintext-key");
            settings.OnboardingComplete = true; settings.Save();
            File.WriteAllText(Path.Combine(UserSettings.DirectoryPath, "app-settings.json"), "{\"enabled\":false,\"hexEnabled\":false,\"model\":\"deepseek-flash\"}");
            await processes.Start(settings, bridge);
            await Post("/api/appearance", new { target = "console", patch = new { theme = "mint" }, sync = true });
            await Post("/api/control", new { action = "song-black-add", title = "普通朋友", term = "forever" });
            await CheckUpdates();
            if (pending == null) throw new Exception("no-test-update-available-" + updateState);
            await Post("/api/control", new { action = "replay-load", dataset = "azusa-p3", position = 6830, speed = 1 });
            await Post("/api/control", new { action = "replay-play", mode = "hex", seconds = 60 });
            if (!await processes.Collecting()) throw new Exception("collection-not-started");
            await ApplyUpdate();
            if (downloaded || !processes.Running || !await processes.Collecting()) throw new Exception("collection-guard-failed");
            await Post("/api/control", new { action = "replay-pause" });
            try { UpdatePolicy.EnsureSpace(1, 1_000_000, 1_000_000); throw new Exception("disk-guard-failed"); } catch (IOException) { }
            var fault = Environment.GetEnvironmentVariable("AZUSA_SMOKE_FAULT") ?? "";
            if (fault == "download")
            {
                var beforeFailure = PersonalHashes();
                await ApplyUpdate();
                if (updateState != "error" || !processes.Running || beforeFailure.Any(pair => PersonalHashes()[pair.Key] != pair.Value)) throw new Exception("download-failure-did-not-preserve-old-app");
                await processes.Stop();
                File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = true, version, scenario = "download-failure", oldVersionPreserved = true, paidApiCalls = 0 }));
                await Exit(false); return;
            }
            if (fault == "cancel")
            {
                var beforeFailure = PersonalHashes();
                _ = Task.Run(async () => { await Task.Delay(800); _ = Dispatcher.BeginInvoke(() => downloadCancellation?.Cancel()); });
                await ApplyUpdate();
                if (updateState != "available" || downloaded || !processes.Running || beforeFailure.Any(pair => PersonalHashes()[pair.Key] != pair.Value)) throw new Exception("cancel-did-not-preserve-old-app");
                await processes.Stop();
                File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = true, version, scenario = "download-cancel", oldVersionPreserved = true, paidApiCalls = 0 }));
                await Exit(false); return;
            }
            if (fault == "new-round")
            {
                _ = Task.Run(async () => { await Task.Delay(600); await Post("/api/control", new { action = "replay-play", mode = "hex", seconds = 60 }); });
                await ApplyUpdate();
                if (updateState != "ready" || !downloaded || !processes.Running || !await processes.Collecting()) throw new Exception("download-end-collection-guard-failed");
                await Post("/api/control", new { action = "replay-pause" });
            }
            if (fault == "cached")
            {
                await updates.DownloadUpdatesAsync(pending);
                downloaded = true;
                string cache = Path.Combine(Velopack.Locators.VelopackLocator.Current.PackagesDir!, pending.TargetFullRelease.FileName);
                using (var file = new FileStream(cache, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                {
                    int first = file.ReadByte(); file.Position = 0; file.WriteByte((byte)(first ^ 1));
                }
                var beforeFailure = PersonalHashes();
                await ApplyUpdate();
                if (updateState != "error" || downloaded || File.Exists(cache) || !processes.Running || beforeFailure.Any(pair => PersonalHashes()[pair.Key] != pair.Value))
                    throw new Exception("cached-checksum-failure-did-not-preserve-old-app");
                File.WriteAllText(Path.Combine(UserSettings.DirectoryPath, "smoke-cache.json"),
                    JsonSerializer.Serialize(new { success = true, corruptCacheRejected = true, cacheRemovedForRetry = true, oldVersionKeptRunning = true }));
            }
            Directory.CreateDirectory(Path.Combine(UserSettings.DirectoryPath, "runtime"));
            File.WriteAllText(Path.Combine(UserSettings.DirectoryPath, "runtime/desktop-display-5178.json"), "{\"width\":660,\"height\":850,\"zoom\":1.5}");
            await processes.Stop();
            File.WriteAllText(PreserveFile, JsonSerializer.Serialize(PersonalHashes()));
            if (fault == "concurrent")
            {
                var expected = pending;
                var first = ApplyUpdate();
                if (!updating) throw new Exception("update-lock-not-held-before-first-await");
                await ApplyUpdate();
                await CheckUpdates();
                if (!updating || !ReferenceEquals(pending, expected) || checking)
                    throw new Exception("concurrent-update-not-rejected");
                File.WriteAllText(Path.Combine(UserSettings.DirectoryPath, "smoke-concurrency.json"),
                    JsonSerializer.Serialize(new { success = true, duplicateApplyRejected = true, checkingRejected = true, fixedTarget = true }));
                await first;
            }
            else await ApplyUpdate();
            throw new Exception("apply-returned-" + updateState);
        }
        catch (Exception error)
        {
            await processes.Stop();
            File.WriteAllText(SmokeReport, JsonSerializer.Serialize(new { success = false, version, error = error.ToString() }));
            updating = false; await Exit(false);
        }
    }
}
#endif

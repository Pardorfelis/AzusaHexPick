using System.IO;
using System.Net.Http;
using System.Text.Json;
using AzusaHexPick;
using Velopack;
using Velopack.Locators;
using Velopack.Logging;
using Velopack.Sources;

var checks = new List<string>();
void Check(bool value, string name) { if (!value) throw new Exception(name); checks.Add(name); }
var valid = UpdatePolicy.ValidWebFeed("https://azusa510.cn/updates");
Check(valid == "https://azusa510.cn/updates/", "HTTPS source normalised");
foreach (var bad in new[] { "http://azusa510.cn/updates", "https://user:pass@azusa510.cn/updates", "https://127.0.0.1/updates", "https://localhost/updates", "https://azusa510.cn:8080/updates", "https://azusa510.cn/updates?key=x", "https://azusa510.cn/updates#x", "file:///D:/updates" })
    Check(UpdatePolicy.ValidWebFeed(bad) == "", "Unsafe source rejected: " + bad.Split(':')[0]);
Check(UpdatePolicy.IsNetworkFailure(new HttpRequestException("synthetic HTTP failure")), "HTTP failure prefers fallback");
Check(UpdatePolicy.IsNetworkFailure(new IOException("wrapped", new HttpRequestException())), "Wrapped network failure recognised");
Check(!UpdatePolicy.IsNetworkFailure(new IOException("disk-space")), "Disk failure does not prefer fallback");
Check(!UpdatePolicy.IsNetworkFailure(new OperationCanceledException()), "User cancellation does not prefer fallback");
Check(!UpdatePolicy.IsNetworkFailure(new Velopack.Exceptions.ChecksumFailedException("synthetic-path")), "Checksum failure does not silently change source");

VelopackAsset Asset(string id, string version, string name) => new() { PackageId = id, Version = SemanticVersion.Parse(version), FileName = name, Type = VelopackAssetType.Full, Size = 100, SHA256 = new string('a', 64), SHA1 = new string('b', 40) };
var full = Asset("AzusaHexPickApp", "0.7.1", "AzusaHexPickApp-0.7.1-full.nupkg");
VelopackAsset[] mockAssets = [full,
    Asset("AzusaHexPickApp", "0.7.2-preview", "AzusaHexPickApp-0.7.2-preview-full.nupkg"),
    Asset("DifferentApp", "9.0.0", "DifferentApp-9.0.0-full.nupkg"),
    Asset("AzusaHexPickApp", "0.7.3", "../outside.nupkg"),
    Asset("AzusaHexPickApp", "0.7.4", "https://other.invalid/outside.nupkg"),
    Asset("AzusaHexPickApp", "0.7.5", "%2e%2e%2foutside.nupkg"),
    Asset("AzusaHexPickApp", "0.7.6", "AzusaHexPickApp-0.7.6-full.nupkg?download=x"),
    Asset("AzusaHexPickApp", "0.7.7", "AzusaHexPickApp-0.7.8-full.nupkg")];
var mock = new MockDownloader(JsonSerializer.Serialize(new { Assets = mockAssets.Select(asset => new {
    asset.PackageId, Version = asset.Version.ToString(), Type = asset.Type.ToString(), asset.FileName,
    asset.Size, asset.SHA256, asset.SHA1 }) }));
var web = new UpdatePolicy.StableWebSource("https://azusa510.cn/updates/", mock);
var filtered = await web.GetReleaseFeed(new NullVelopackLogger(), "AzusaHexPickApp", "win");
Check(filtered.Assets.Length == 1 && filtered.Assets[0].Version.ToString() == "0.7.1", "Only same-app stable relative assets accepted");
Check(mock.Timeout == .25, "Feed timeout is bounded");
await web.DownloadReleaseEntry(new NullVelopackLogger(), full, "unused", _ => { });
Check(mock.Url == "https://azusa510.cn/updates/AzusaHexPickApp-0.7.1-full.nupkg" && mock.Timeout == 10, "Downloads remain on selected source");

var packages = Path.Combine(ProcessManager.AppRoot, "packages");
Directory.CreateDirectory(packages);
var locator = new TestVelopackLocator("AzusaHexPickApp", "0.7.0", packages);
UpdateManager Manager(MockSource source) => new(source, new UpdateOptions { ExplicitChannel = "win" }, locator);
var primarySource = new MockSource([full]);
var fallbackSource = new MockSource([Asset("AzusaHexPickApp", "0.7.2", "AzusaHexPickApp-0.7.2-full.nupkg")]);
var primary = Manager(primarySource); var fallback = Manager(fallbackSource);
var selected = await UpdatePolicy.CheckSourcesAsync(primary, fallback);
Check(ReferenceEquals(selected.Manager, primary) && selected.FromWebsite && !selected.UsedFallback && fallbackSource.Calls == 0, "Healthy primary prevents fallback check");
primarySource.Fail = true;
var afterFailure = await UpdatePolicy.CheckSourcesAsync(primary, fallback);
Check(ReferenceEquals(afterFailure.Manager, fallback) && afterFailure.UsedFallback && afterFailure.Release!.TargetFullRelease.Version.ToString() == "0.7.2", "Primary failure selects fallback");
Check(ReferenceEquals(selected.Manager, primary) && selected.Release!.TargetFullRelease.Version.ToString() == "0.7.1", "Prior selected target and source stay fixed");
var current = new MockSource([Asset("AzusaHexPickApp", "0.7.0", "AzusaHexPickApp-0.7.0-full.nupkg")]);
fallbackSource.Calls = 0;
var noUpdate = await UpdatePolicy.CheckSourcesAsync(Manager(current), fallback);
Check(noUpdate.Release == null && fallbackSource.Calls == 0, "Current website feed is not replaced by different GitHub version");
var verifier = new UpdatePolicy.VerifiedUpdateManager(new MockSource([]), new UpdateOptions { ExplicitChannel = "win" }, locator);
var cachedAsset = Asset("AzusaHexPickApp", "0.7.5", "AzusaHexPickApp-0.7.5-full.nupkg");
byte[] cachedBytes = System.Text.Encoding.UTF8.GetBytes("synthetic-package-cache");
cachedAsset.Size = cachedBytes.Length;
cachedAsset.SHA256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(cachedBytes));
string cachedPath = Path.Combine(packages, cachedAsset.FileName);
File.WriteAllBytes(cachedPath, cachedBytes);
await UpdatePolicy.VerifyDownloadedAsync(verifier, cachedAsset);
Check(File.Exists(cachedPath), "Healthy cached package is preserved");
var corrupted = cachedBytes.ToArray(); corrupted[0] ^= 1;
File.WriteAllBytes(cachedPath, corrupted);
try { await UpdatePolicy.VerifyDownloadedAsync(verifier, cachedAsset); throw new Exception("corrupt cache accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath), "Same-size corrupt cache is rejected and removed for retry");
File.WriteAllBytes(cachedPath, [1]);
try { await UpdatePolicy.VerifyDownloadedAsync(verifier, cachedAsset); throw new Exception("wrong cache size accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath), "Wrong cache size is rejected and removed for retry");
string outside = Path.Combine(ProcessManager.AppRoot, "outside.nupkg");
File.WriteAllText(outside, "keep-unrelated-file");
var wrongPath = Asset("AzusaHexPickApp", "0.7.5", "../outside.nupkg");
try { await UpdatePolicy.VerifyDownloadedAsync(verifier, wrongPath); throw new Exception("outside cache accepted"); }
catch (InvalidDataException) { }
Check(File.ReadAllText(outside) == "keep-unrelated-file", "Verification never deletes an unrelated package path");
byte[] rebuiltBytes = System.Text.Encoding.UTF8.GetBytes("synthetic-rebuilt-container-different-from-original");
string proofPath = cachedPath + ".azusa-verified";
byte[] proof = System.Security.Cryptography.ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(new {
    PackageId = cachedAsset.PackageId, Version = cachedAsset.Version.ToString(), Channel = "win", FileName = cachedAsset.FileName,
    PublishedSize = cachedAsset.Size, PublishedHash = cachedAsset.SHA256, CachedSize = rebuiltBytes.Length,
    CachedHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(rebuiltBytes)) }),
    System.Text.Encoding.UTF8.GetBytes("AzusaHexPick/delta-cache/v1"), System.Security.Cryptography.DataProtectionScope.CurrentUser);
File.WriteAllBytes(cachedPath, rebuiltBytes);
try { await UpdatePolicy.VerifyDownloadedAsync(verifier, cachedAsset); throw new Exception("unknown rebuilt cache accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath), "Unknown rebuilt cache is rejected");
File.WriteAllBytes(cachedPath, rebuiltBytes); File.WriteAllBytes(proofPath, proof);
var freshVerifier = new UpdatePolicy.VerifiedUpdateManager(new MockSource([]), new UpdateOptions { ExplicitChannel = "win" }, locator);
await UpdatePolicy.VerifyDownloadedAsync(freshVerifier, cachedAsset);
Check(File.Exists(cachedPath), "Protected rebuilt cache survives a fresh manager");
var alteredProof = proof.ToArray(); alteredProof[^1] ^= 1; File.WriteAllBytes(proofPath, alteredProof);
try { await UpdatePolicy.VerifyDownloadedAsync(freshVerifier, cachedAsset); throw new Exception("tampered receipt accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath) && !File.Exists(proofPath), "Tampered protected receipt is rejected");
File.WriteAllBytes(cachedPath, rebuiltBytes); File.WriteAllBytes(proofPath, proof);
var alteredCache = rebuiltBytes.ToArray(); alteredCache[0] ^= 1; File.WriteAllBytes(cachedPath, alteredCache);
try { await UpdatePolicy.VerifyDownloadedAsync(freshVerifier, cachedAsset); throw new Exception("tampered rebuilt cache accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath), "Same-size rebuilt cache corruption is rejected");
File.WriteAllBytes(cachedPath, rebuiltBytes); File.WriteAllBytes(proofPath, proof);
cachedAsset.SHA256 = new string('c',64);
try { await UpdatePolicy.VerifyDownloadedAsync(freshVerifier, cachedAsset); throw new Exception("changed target accepted"); }
catch (Velopack.Exceptions.ChecksumFailedException) { }
Check(!File.Exists(cachedPath), "Receipt cannot authorise a different published target");
string rebuiltFixture = Path.Combine(ProcessManager.AppRoot, "manifest-fixture.nupkg");
var coreFiles = new[] { "梓有妙选.exe", "Velopack.dll", "runtime/node.exe", "runtime/desktop/AzusaPanel.exe", "app/server.mjs", "app/package.json", "app/delivery.json", "app/public/index.html", "app/public/app.js", "app/public/guide.html" };
void Fixture(string? extra = null, bool corruptContent = false)
{
    if (File.Exists(rebuiltFixture)) File.Delete(rebuiltFixture);
    using var archive = System.IO.Compression.ZipFile.Open(rebuiltFixture, System.IO.Compression.ZipArchiveMode.Create);
    void Write(string name, string value) { using var writer = new StreamWriter(archive.CreateEntry(name).Open(), System.Text.Encoding.UTF8); writer.Write(value); }
    byte[] fixtureBytes = System.Text.Encoding.UTF8.GetBytes("fixture");
    foreach (var name in coreFiles)
    { using var output = archive.CreateEntry("lib/app/" + name).Open(); output.Write(corruptContent && name == "app/server.mjs" ? [1,2,3] : fixtureBytes); }
    Write("lib/app/package-manifest.json", JsonSerializer.Serialize(new { version = cachedAsset.Version.ToString(), platform = "win-x64", selfContained = true, personalDataIncluded = false,
        files = coreFiles.Select(name => new { path = name, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fixtureBytes)) }) }));
    Write("lib/app/sq.version", $"<package><metadata><id>{cachedAsset.PackageId}</id><version>{cachedAsset.Version}</version><channel>win</channel><mainExe>梓有妙选.exe</mainExe><title>Fixture</title></metadata></package>");
    if (extra != null) Write(extra, "synthetic-private-value");
}
Fixture(); await UpdatePolicy.VerifiedUpdateManager.ValidateRebuiltPackage(rebuiltFixture, cachedAsset);
Check(true, "Rebuilt content is verified against the complete per-file manifest");
foreach (var variant in new[] { "hash", "extra", "private", "duplicate" })
{
    Fixture(variant switch { "extra" => "lib/app/unlisted.txt", "private" => "lib/app/app/.env.local", "duplicate" => "lib/app/VELOPACK.DLL", _ => null }, variant == "hash");
    try { await UpdatePolicy.VerifiedUpdateManager.ValidateRebuiltPackage(rebuiltFixture, cachedAsset); throw new Exception("invalid rebuilt content accepted"); }
    catch (InvalidDataException) { }
    Check(true, "Invalid rebuilt content rejected: " + variant);
}
if (args.Length is 2 or 3)
{
    using var nativeJson = JsonDocument.Parse(File.ReadAllText(args[0]));
    var nativeData = nativeJson.RootElement;
    var nativeAsset = new VelopackAsset { PackageId = nativeData.GetProperty("PackageId").GetString()!,
        Version = SemanticVersion.Parse(nativeData.GetProperty("Version").GetString()!), FileName = nativeData.GetProperty("FileName").GetString()!,
        Type = Enum.Parse<VelopackAssetType>(nativeData.GetProperty("Type").GetString()!), Size = nativeData.GetProperty("Size").GetInt64(),
        SHA256 = nativeData.GetProperty("SHA256").GetString()!, SHA1 = nativeData.GetProperty("SHA1").GetString()! };
    try
    {
        if (args.Length == 3)
        {
            await UpdatePolicy.VerifiedUpdateManager.ValidateRebuiltPackage(args[2], nativeAsset);
            Check(true, "Actual archive content passes the rebuilt-package verifier");
        }
        else
        {
            var nativeLocator = new TestVelopackLocator(nativeAsset.PackageId, nativeAsset.Version.ToString(), Path.GetFullPath(args[1]));
            var nativeVerifier = new UpdatePolicy.VerifiedUpdateManager(new MockSource([]), new UpdateOptions { ExplicitChannel = "win" }, nativeLocator);
            await UpdatePolicy.VerifyDownloadedAsync(nativeVerifier, nativeAsset);
            Check(File.Exists(Path.Combine(args[1], nativeAsset.FileName + ".azusa-verified")), "Actual rebuilt cache is verified after app restart in a new process");
        }
    }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.Exit(1); }
}
Console.WriteLine(JsonSerializer.Serialize(new { success = true, checks = checks.Count, scenarios = checks, paidApiCalls = 0 }));

sealed class MockSource(VelopackAsset[] assets) : IUpdateSource
{
    public int Calls; public bool Fail;
    public Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId, string channel, Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
    { Calls++; if (Fail) throw new HttpRequestException("synthetic"); return Task.FromResult(new VelopackAssetFeed { Assets = assets }); }
    public Task DownloadReleaseEntry(IVelopackLogger logger, VelopackAsset asset, string file, Action<int> progress, CancellationToken token = default) => Task.CompletedTask;
}
sealed class MockDownloader(string json) : IFileDownloader
{
    public string Url = ""; public double Timeout;
    public Task DownloadFile(string url, string targetFile, Action<int> progress, IDictionary<string, string>? headers = null, double timeout = 30, CancellationToken cancelToken = default)
    { Url = url; Timeout = timeout; return Task.CompletedTask; }
    public Task<byte[]> DownloadBytes(string url, IDictionary<string, string>? headers = null, double timeout = 30) => Task.FromResult(Array.Empty<byte>());
    public Task<string> DownloadString(string url, IDictionary<string, string>? headers = null, double timeout = 30)
    { Url = url; Timeout = timeout; return Task.FromResult(json); }
}
namespace AzusaHexPick
{
    public static class ProcessManager { public static string AppRoot => Environment.GetEnvironmentVariable("AZUSA_POLICY_TEST_DIR") ?? throw new InvalidOperationException("Isolated test directory is required."); }
}

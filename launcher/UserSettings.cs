using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AzusaHexPick;

public sealed class UserSettings
{
    public bool PhoneMode { get; set; }
    public bool OnboardingComplete { get; set; }
    public string FeedbackUrl { get; set; } = "";
    public static string DirectoryPath { get; } = Environment.GetEnvironmentVariable("AZUSA_USER_DATA") is { Length: > 0 } explicitPath
        ? Path.GetFullPath(explicitPath) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AzusaHexPick", "UserData");
    private static readonly string ConfigPath = Path.Combine(DirectoryPath, "launcher.json");
    private static readonly string SecretPath = Path.Combine(DirectoryPath, "deepseek.key");
    public static string ReadWarning { get; private set; } = "";
    public static bool HasKey => File.Exists(SecretPath);

    public static UserSettings Load()
    {
        System.IO.Directory.CreateDirectory(DirectoryPath);
        if (!File.Exists(ConfigPath)) return new();
        try
        {
            if (new FileInfo(ConfigPath).Length > 8192) throw new InvalidDataException();
            return JsonSerializer.Deserialize<UserSettings>(File.ReadAllText(ConfigPath)) ?? new();
        }
        catch { ReadWarning = "设置文件无法读取，原文件已保留。请检查后重新保存设置。"; return new(); }
    }

    public void Save()
    {
        if (File.Exists(ConfigPath))
        {
            System.IO.Directory.CreateDirectory(Path.Combine(DirectoryPath, "backups"));
            File.Copy(ConfigPath, Path.Combine(DirectoryPath, "backups", "launcher.previous.json"), true);
        }
        AtomicWrite(ConfigPath, JsonSerializer.SerializeToUtf8Bytes(this));
    }

    public static void SaveKey(string value)
    {
        value = value.Trim();
        if (value.Length < 12 || value.Length > 256 || value.Any(char.IsWhiteSpace))
            throw new InvalidDataException("请粘贴完整的 DeepSeek API Key，中间不要有空格。");
        AtomicWrite(SecretPath, ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    }

    public static string ReadKey()
    {
        if (!HasKey) return "";
        if (new FileInfo(SecretPath).Length > 8192) throw new InvalidDataException();
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(SecretPath), null, DataProtectionScope.CurrentUser));
    }

    public static void AtomicWrite(string path, byte[] bytes)
    {
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path + ".tmp", bytes);
        File.Move(path + ".tmp", path, true);
    }

    public static string ValidFeedback(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == "https"
            && uri.Host == "wj.qq.com" && uri.UserInfo == "" && uri.AbsolutePath.StartsWith("/s2/") && value.Length < 600
            ? uri.AbsoluteUri : "";
    }
}

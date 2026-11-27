// DTOs serializados em JSON — espelham exatamente src/shared/types/disk.ts (camelCase, datas em epoch ms).
// O projeto é "trimmed" com reflexão desligada: a serialização usa o gerador de código (JsonSerializerContext).
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace IaCleaner.Scanner;

public sealed class DirNodeDto
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public long Bytes { get; set; }
    public long Files { get; set; }
    public long Dirs { get; set; }
    public long? LastWrite { get; set; }
    public List<DirNodeDto>? Children { get; set; }
    /// <summary>Bytes não representados pelos filhos (arquivos soltos + subpastas podadas).</summary>
    public long? OtherBytes { get; set; }
    /// <summary>Bytes dos arquivos diretamente nesta pasta (parte de otherBytes).</summary>
    public long? FileBytes { get; set; }
    public bool? Inaccessible { get; set; }
}

public sealed class FileEntryDto
{
    public string Path { get; set; } = "";
    public long Bytes { get; set; }
    public long LastWrite { get; set; }
    public long? LastAccess { get; set; }
    public string Ext { get; set; } = "";
    public string Category { get; set; } = "other";
}

public sealed class CategoryStatDto
{
    public string Category { get; set; } = "other";
    public long Bytes { get; set; }
    public long Files { get; set; }
}

public sealed class ExtStatDto
{
    /// <summary>Extensão minúscula sem ponto; "" = sem extensão; "*" = outras (longas/não ASCII).</summary>
    public string Ext { get; set; } = "";
    public string Category { get; set; } = "other";
    public long Bytes { get; set; }
    public long Files { get; set; }
}

public sealed class DriveScanResultDto
{
    public string Root { get; set; } = "";
    public string ScannedAt { get; set; } = "";
    public long DurationMs { get; set; }
    public long TotalBytes { get; set; }
    public long Files { get; set; }
    public long Dirs { get; set; }
    public long CloudOnlyBytes { get; set; }
    public long InaccessibleDirs { get; set; }
    public DirNodeDto Tree { get; set; } = new();
    public List<FileEntryDto> TopFiles { get; set; } = new();
    public List<FileEntryDto> OldLargeFiles { get; set; } = new();
    public List<CategoryStatDto> Categories { get; set; } = new();
    public string Engine { get; set; } = "native";
    public string? Error { get; set; }
    // ---- extensões opcionais (compatíveis) ----
    public long? CloudOnlyFiles { get; set; }
    public long? SkippedLinks { get; set; }
    public List<string>? InaccessibleSamples { get; set; }
    public long? VolumeTotalBytes { get; set; }
    public long? VolumeUsedBytes { get; set; }
    public int? Threads { get; set; }
    public List<ExtStatDto>? Extensions { get; set; }
}

public sealed class DuplicateFileDto
{
    public string Path { get; set; } = "";
    public long LastWrite { get; set; }
}

public sealed class DuplicateGroupDto
{
    public string Hash { get; set; } = "";
    public long Bytes { get; set; }
    public List<DuplicateFileDto> Files { get; set; } = new();
    public long WastedBytes { get; set; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(DriveScanResultDto[]))]
[JsonSerializable(typeof(DuplicateGroupDto[]))]
internal partial class ScanJsonContext : JsonSerializerContext
{
}

internal static class Json
{
    /// <summary>Contexto com escape relaxado (acentos sem \uXXXX): JSON menor e legível.</summary>
    public static readonly ScanJsonContext Ctx = new(new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    });

    /// <summary>Grava o arquivo de saída de forma atômica (temp + rename).</summary>
    public static void WriteFile<T>(string outFile, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info)
    {
        var full = System.IO.Path.GetFullPath(outFile);
        var dir = System.IO.Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var tmp = full + ".tmp";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
        {
            JsonSerializer.Serialize(fs, value, info);
        }
        File.Move(tmp, full, overwrite: true);
    }

    /// <summary>Remove surrogates órfãos (nomes de arquivo inválidos em UTF-16) que quebrariam o JSON.</summary>
    public static string Clean(string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsSurrogate(c))
            {
                bool ok = char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]);
                if (ok) { i++; continue; }
                return CleanSlow(s);
            }
        }
        return s;
    }

    private static string CleanSlow(string s)
    {
        var sb = new System.Text.StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                sb.Append(c).Append(s[i + 1]);
                i++;
            }
            else if (char.IsSurrogate(c)) sb.Append('�');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    public static long ToEpochMs(long utcTicks)
    {
        if (utcTicks <= DateTime.UnixEpoch.Ticks) return 0;
        return (utcTicks - DateTime.UnixEpoch.Ticks) / TimeSpan.TicksPerMillisecond;
    }
}

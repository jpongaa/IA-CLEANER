namespace IaCleaner.Scanner;

/// <summary>
/// Classificação de arquivos em FileCategory (src/shared/types/disk.ts).
/// 1) Contexto da pasta (jogos, Windows, Temp) tem prioridade; 2) senão, pela extensão.
/// A busca por extensão não aloca: os até 8 caracteres ASCII minúsculos são empacotados num ulong.
/// </summary>
internal static class Categories
{
    public const int Video = 0, Image = 1, Audio = 2, Archive = 3, Installer = 4, DiskImage = 5, VirtualDisk = 6,
        Document = 7, Code = 8, GameData = 9, Backup = 10, Log = 11, Temp = 12, Executable = 13, System = 14, Other = 15;

    public const int Count = 16;
    public const byte NoCtx = 255;

    public static readonly string[] Names =
    {
        "video", "image", "audio", "archive", "installer", "diskImage", "virtualDisk", "document",
        "code", "gameData", "backup", "log", "temp", "executable", "system", "other"
    };

    private static readonly Dictionary<ulong, int> ByExt = Build();

    /// <summary>Pastas cujo conteúdo é de jogos (bibliotecas dos launchers).</summary>
    private static readonly HashSet<string> GameDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "steamapps", "SteamLibrary", "Epic Games", "XboxGames", "Riot Games", "EA Games", "Origin Games",
        "GOG Games", "GOG Galaxy Games", "Ubisoft Game Launcher", "Rockstar Games Launcher Games", "Battle.net Games",
        "Amazon Games", "Games Library"
    };

    private static readonly HashSet<string> TempDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "Temp", "Tmp", "INetCache", "CrashDumps", "D3DSCache", "DXCache", "GLCache", "ShaderCache", "NV_Cache"
    };

    private static Dictionary<ulong, int> Build()
    {
        var map = new Dictionary<ulong, int>();
        void Add(int cat, params string[] exts)
        {
            foreach (var e in exts)
            {
                if (TryPack(e, out var key)) map[key] = cat;
            }
        }

        Add(Video, "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "m2ts", "mts", "3gp", "vob", "ogv", "rmvb", "divx");
        Add(Image, "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "raw", "cr2", "cr3", "nef", "arw", "dng",
            "psd", "svg", "ico", "avif", "jfif", "xcf", "kra", "exr", "hdr");
        Add(Audio, "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff", "aif", "alac", "mid", "midi", "ape");
        Add(Archive, "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "lz", "lzma", "cab", "z01", "r00", "001");
        Add(Installer, "msi", "msix", "msixbundle", "appx", "appxbundle", "msp", "msu", "apk", "xapk", "pkg", "deb", "rpm", "esd");
        Add(DiskImage, "iso", "img", "nrg", "dmg", "wim", "swm", "mdf", "mds", "cue", "ccd", "toast");
        Add(VirtualDisk, "vhd", "vhdx", "vmdk", "vdi", "qcow2", "avhdx", "vmem", "vmsn", "vmss", "hdd", "nvram");
        Add(Document, "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "md", "csv",
            "epub", "mobi", "pages", "key", "numbers", "one", "pst", "ost", "eml", "msg", "xps", "djvu");
        Add(Code, "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "pyc", "pyd", "c", "cc", "cpp", "h", "hpp", "cs", "java", "class", "jar",
            "go", "rs", "rb", "php", "lua", "json", "xml", "yml", "yaml", "toml", "html", "htm", "css", "scss", "sql", "sqlite", "db",
            "pdb", "obj", "o", "lib", "a", "ipch", "pch", "node", "wasm", "map", "ps1", "psm1", "bat", "cmd", "sh", "ipynb", "whl");
        Add(GameData, "pak", "vpk", "bundle", "assets", "resource", "ucas", "utoc", "forge", "big", "bsa", "ba2", "wad", "esm",
            "unity3d", "bik", "bk2", "usm", "rpf", "gcf", "ncf", "arc", "ress", "sb", "toc", "cas", "dat2", "pck", "pkx", "xvc",
            "sav", "save", "uasset", "umap", "streamed", "cpk", "awb", "acb", "wem", "bnk", "fsb", "dds", "xnb", "ytd", "ydr",
            "vdf", "acf", "rgss3a", "nsp", "xci", "gba", "nds", "z64", "n64", "smc", "sfc", "gb", "gbc", "cia", "3ds", "wbfs",
            "rvz", "gcm", "chd", "pbp", "cso");
        Add(Backup, "bak", "old", "backup", "bkp", "bkf", "tib", "tibx", "vbk", "wbcat", "gho", "sbk", "mrimg", "orig");
        Add(Log, "log", "etl", "evtx", "dmp", "mdmp", "hdmp", "trace", "blf", "regtrans-ms", "jrs", "chk");
        Add(Temp, "tmp", "temp", "crdownload", "part", "partial", "download", "opdownload", "!ut", "dlpart", "aria2", "~tmp");
        Add(Executable, "exe", "dll", "ocx", "scr", "com", "efi", "cpl", "drv", "winmd", "msstyles", "ax");
        Add(System, "sys", "mui", "cat", "manifest", "pf", "edb", "dat", "ini", "inf", "pnf", "nls", "ttf", "otf", "fon", "ttc",
            "cdf-ms", "mum", "admx", "adml", "tlb", "rll", "sdb", "jfm");
        return map;
    }

    private static bool TryPack(ReadOnlySpan<char> ext, out ulong key)
    {
        key = 0;
        if (ext.Length == 0 || ext.Length > 8) return false;
        for (int i = 0; i < ext.Length; i++)
        {
            char c = ext[i];
            if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
            else if (c > 127) return false;
            key = (key << 8) | (byte)c;
        }
        return true;
    }

    /// <summary>Extensão (sem ponto) a partir do nome; vazio se não houver.</summary>
    public static ReadOnlySpan<char> Extension(ReadOnlySpan<char> fileName)
    {
        int dot = fileName.LastIndexOf('.');
        if (dot <= 0 || dot == fileName.Length - 1) return ReadOnlySpan<char>.Empty;
        return fileName[(dot + 1)..];
    }

    public static int ForExtension(ReadOnlySpan<char> ext)
    {
        if (TryPack(ext, out var key) && ByExt.TryGetValue(key, out var cat)) return cat;
        return Other;
    }

    /// <summary>Chave compacta da extensão: 0 = sem extensão, 1 = não representável (longa/não ASCII).</summary>
    public const ulong NoExtKey = 0, OddExtKey = 1;

    public static ulong ExtKey(ReadOnlySpan<char> ext)
    {
        if (ext.Length == 0) return NoExtKey;
        return TryPack(ext, out var key) && key > OddExtKey ? key : OddExtKey;
    }

    public static int ForKey(ulong key) => key > OddExtKey && ByExt.TryGetValue(key, out var cat) ? cat : Other;

    public static string KeyToString(ulong key)
    {
        if (key == NoExtKey) return "";
        if (key == OddExtKey) return "*";
        Span<char> buf = stackalloc char[8];
        int n = 0;
        for (int shift = 56; shift >= 0; shift -= 8)
        {
            var b = (byte)(key >> shift);
            if (b != 0) buf[n++] = (char)b;
        }
        return new string(buf[..n]);
    }

    /// <summary>Contexto herdado por uma subpasta (NoCtx = classificar pela extensão).</summary>
    public static byte DirContext(string name, int depth, byte parentCtx)
    {
        if (parentCtx != NoCtx) return parentCtx;
        if (depth == 1)
        {
            if (name.Equals("Windows", StringComparison.OrdinalIgnoreCase)) return System;
            if (name.Equals("Windows.old", StringComparison.OrdinalIgnoreCase)) return Backup;
            if (name.Equals("$WINDOWS.~BT", StringComparison.OrdinalIgnoreCase) || name.Equals("$WinREAgent", StringComparison.OrdinalIgnoreCase))
                return Temp;
        }
        if (GameDirs.Contains(name)) return GameData;
        if (TempDirs.Contains(name)) return Temp;
        return NoCtx;
    }
}

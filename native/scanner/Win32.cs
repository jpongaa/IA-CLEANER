using System.Runtime.InteropServices;

namespace IaCleaner.Scanner;

/// <summary>Chamadas Win32 somente-leitura (atributos de reparse point, identificador de arquivo).</summary>
internal static class Win32
{
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint FILE_SHARE_ALL = 0x1 | 0x2 | 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const int FileAttributeTagInfo = 9;
    private static readonly IntPtr Invalid = new(-1);

    /// <summary>Bit "name surrogate" da tag: junctions, symlinks, montagens de volume etc. (apontam para outro lugar).</summary>
    private const uint NameSurrogateBit = 0x20000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    // Pack = 4: os FILETIME do Win32 são 2 DWORDs (alinhamento 4), não um int64 alinhado em 8.
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(IntPtr hFile, int fileInformationClass, out FILE_ATTRIBUTE_TAG_INFO info, uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr hFile, out BY_HANDLE_FILE_INFORMATION info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>Prefixo \\?\ para caminhos longos em chamadas Win32 diretas.</summary>
    public static string Extended(string path)
    {
        if (path.Length < 248 || path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path[2..];
        return @"\\?\" + path;
    }

    /// <summary>Tag do reparse point (0 se não for reparse point ou não der para ler).</summary>
    public static uint GetReparseTag(string path)
    {
        var h = CreateFile(Extended(path), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (h == Invalid || h == IntPtr.Zero) return 0;
        try
        {
            if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, out var info, (uint)Marshal.SizeOf<FILE_ATTRIBUTE_TAG_INFO>()))
                return 0;
            return (info.FileAttributes & (uint)FileAttributes.ReparsePoint) != 0 ? info.ReparseTag : 0;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    /// <summary>
    /// Um reparse point pode ser seguido com segurança? Junctions/symlinks/montagens (name surrogates) NÃO:
    /// apontam para outro lugar e contariam bytes em dobro (ex.: "C:\Documents and Settings").
    /// Pastas do OneDrive (tag de nuvem) SIM: o conteúdo é real. Na dúvida (tag ilegível), não segue.
    /// </summary>
    public static bool IsFollowableReparse(string path)
    {
        uint tag = GetReparseTag(path);
        if (tag == 0) return false;
        return (tag & NameSurrogateBit) == 0;
    }

    /// <summary>Identificador único do arquivo no volume (para detectar hardlinks). null se falhar.</summary>
    public static (uint volume, ulong index, uint links)? GetFileId(Microsoft.Win32.SafeHandles.SafeFileHandle handle)
    {
        bool added = false;
        try
        {
            handle.DangerousAddRef(ref added);
            if (!GetFileInformationByHandle(handle.DangerousGetHandle(), out var info)) return null;
            return (info.VolumeSerialNumber, ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow, info.NumberOfLinks);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (added) handle.DangerousRelease();
        }
    }
}

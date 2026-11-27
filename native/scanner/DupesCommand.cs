// dupes --root C:\ [--root D:\] --out f.json [--min-mb 10] [--threads N] [--exclude dir]...
// Encontra arquivos duplicados (SOMENTE LEITURA): agrupa por tamanho → hash parcial (início+meio+fim) →
// SHA-256 completo só dos candidatos. Ignora pastas do sistema, de programas e de jogos (apagar ali quebra coisas),
// placeholders de nuvem (ler baixaria o arquivo) e hardlinks (mesmo arquivo físico com dois nomes).
using System.Collections.Concurrent;
using System.IO.Enumeration;
using System.Security.Cryptography;

namespace IaCleaner.Scanner;

internal readonly record struct DupeCandidate(string Path, long Bytes, long LastWrite);

public static class DupesCommand
{
    private const int ChunkSize = 64 * 1024;
    private const int MaxGroups = 5000;

    /// <summary>Pastas ignoradas em qualquer nível.</summary>
    private static readonly HashSet<string> SkipAnyDepth = new(StringComparer.OrdinalIgnoreCase)
    {
        "AppData", "$Recycle.Bin", "System Volume Information", "steamapps", "SteamLibrary", "Steam", "Epic Games",
        "XboxGames", "EA Games", "EA Desktop", "Origin Games", "Riot Games", "Battle.net", "Ubisoft", "Ubisoft Game Launcher",
        "GOG Games", "GOG Galaxy", "Rockstar Games", "Amazon Games", "WindowsApps", "ModifiableWindowsApps", "node_modules", ".git",
        ".svn", ".nuget", ".gradle", ".m2", ".cargo", ".rustup", "site-packages", ".venv", "venv", "Windows.old", "$WINDOWS.~BT",
        "$WinREAgent", "$SysReset", "$GetCurrent", "MSOCache", "Config.Msi", "Recovery", "OneDriveTemp"
    };

    /// <summary>Pastas ignoradas apenas na raiz da unidade.</summary>
    private static readonly HashSet<string> SkipAtRoot = new(StringComparer.OrdinalIgnoreCase)
    {
        "Windows", "ProgramData", "PerfLogs", "Intel", "AMD", "NVIDIA", "Drivers", "inetpub", "Boot", "EFI"
    };

    internal static bool ShouldSkipDir(ReadOnlySpan<char> name, int depth)
    {
        var s = name.ToString();
        if (SkipAnyDepth.Contains(s)) return true;
        if (depth == 1 && (SkipAtRoot.Contains(s) || s.StartsWith("Program Files", StringComparison.OrdinalIgnoreCase))) return true;
        return false;
    }

    public static int Run(string[] argv)
    {
        var args = new Args(argv);
        args.WatchParent();
        var roots = args.All("root").Select(Args.NormalizeRoot).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (roots.Count == 0) throw new ArgumentException("informe ao menos um --root");
        var outFile = args.Required("out");
        long minBytes = args.Long("min-mb", 10, 1, 1 << 20) << 20;
        int threads = args.Int("threads", 4, 1, 32);
        var excludes = Args.NormalizeExcludes(args.All("exclude"));

        var state = new DupesState();
        using var stop = new CancellationTokenSource();
        var reporter = new Thread(() =>
        {
            while (!stop.Token.WaitHandle.WaitOne(250)) state.Report();
        })
        { IsBackground = true, Name = "progress" };
        reporter.Start();

        // 1) Listagem paralela dos arquivos >= minBytes
        var all = new ConcurrentBag<DupeCandidate>();
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = false,
                IgnoreInaccessible = true,
                AttributesToSkip = 0,
                ReturnSpecialDirectories = false,
                BufferSize = 32 * 1024
            };
            WorkQueue<(string path, int depth)> queue = null!;
            queue = new WorkQueue<(string, int)>(Math.Max(2, threads * 2), (item, _) =>
            {
                state.Current = item.Item1;
                using var e = new DupesEnumerator(item.Item1, options, item.Item2, minBytes, excludes, queue, all, state);
                while (e.MoveNext()) { }
            });
            queue.Run((root, 0));
        }

        // 2) Agrupa por tamanho
        var bySize = all.GroupBy(c => c.Bytes).Where(g => g.Count() > 1).ToList();
        var partialList = bySize.SelectMany(g => g).ToList();
        state.Phase = "hashing";
        state.Step = "partial";
        state.TotalToHash = partialList.Count;
        state.BytesToHash = 0;

        // 3) Hash parcial + id do arquivo (descarta hardlinks do mesmo arquivo físico)
        var partial = new ConcurrentDictionary<string, ConcurrentBag<(DupeCandidate c, string fileId)>>();
        Parallel.ForEach(partialList, new ParallelOptions { MaxDegreeOfParallelism = threads }, c =>
        {
            state.Current = c.Path;
            try
            {
                var (hash, fileId) = PartialHash(c);
                if (hash != null)
                    partial.GetOrAdd($"{c.Bytes}:{hash}", _ => new ConcurrentBag<(DupeCandidate, string)>()).Add((c, fileId));
            }
            catch
            {
                // arquivo em uso / sem permissão: ignora
            }
            Interlocked.Increment(ref state.Hashed);
        });

        var fullList = new List<DupeCandidate>();
        foreach (var bag in partial.Values)
        {
            // um representante por arquivo físico (determinístico: menor caminho em ordem alfabética)
            var unique = bag.GroupBy(x => x.fileId)
                .Select(g => g.Select(x => x.c).OrderBy(c => c.Path, StringComparer.OrdinalIgnoreCase).First())
                .ToList();
            if (unique.Count > 1) fullList.AddRange(unique);
        }

        // 4) SHA-256 completo dos candidatos
        state.Step = "full";
        state.Hashed = 0;
        state.TotalToHash = fullList.Count;
        state.BytesToHash = fullList.Sum(c => c.Bytes);
        var full = new ConcurrentDictionary<string, ConcurrentBag<DupeCandidate>>();
        // Arquivos grandes primeiro: distribui melhor o trabalho entre as threads.
        fullList.Sort((a, b) => b.Bytes.CompareTo(a.Bytes));
        Parallel.ForEach(fullList, new ParallelOptions { MaxDegreeOfParallelism = threads }, c =>
        {
            state.Current = c.Path;
            try
            {
                var hash = FullHash(c, state);
                if (hash != null) full.GetOrAdd($"{c.Bytes}:{hash}", _ => new ConcurrentBag<DupeCandidate>()).Add(c);
            }
            catch
            {
                // ignora
            }
            Interlocked.Increment(ref state.Hashed);
        });

        var groups = full
            .Where(kv => kv.Value.Count > 1)
            .Select(kv =>
            {
                var files = kv.Value.OrderBy(f => f.LastWrite).ThenBy(f => f.Path, StringComparer.OrdinalIgnoreCase).ToList();
                long bytes = files[0].Bytes;
                return new DuplicateGroupDto
                {
                    Hash = kv.Key[(kv.Key.IndexOf(':') + 1)..],
                    Bytes = bytes,
                    Files = files.Select(f => new DuplicateFileDto { Path = Json.Clean(f.Path), LastWrite = Json.ToEpochMs(f.LastWrite) }).ToList(),
                    WastedBytes = bytes * (files.Count - 1)
                };
            })
            .OrderByDescending(g => g.WastedBytes)
            .Take(MaxGroups)
            .ToArray();

        state.Phase = "done";
        stop.Cancel();
        reporter.Join();
        state.Report();

        Json.WriteFile(outFile, groups, Json.Ctx.DuplicateGroupDtoArray);
        Output.Done(Path.GetFullPath(outFile));
        return 0;
    }

    private static SafeHandleScope Open(string path, FileOptions options) =>
        new(File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, options));

    private static (string? hash, string fileId) PartialHash(DupeCandidate c)
    {
        using var scope = Open(c.Path, FileOptions.RandomAccess);
        var h = scope.Handle;
        long len = RandomAccess.GetLength(h);
        if (len != c.Bytes) return (null, ""); // mudou desde a listagem
        var id = Win32.GetFileId(h);
        string fileId = id is { } v ? $"{v.volume:x}:{v.index:x}" : c.Path;
        var buffer = new byte[ChunkSize];
        using var inc = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (long offset in new[] { 0L, Math.Max(0, len / 2 - ChunkSize / 2), Math.Max(0, len - ChunkSize) })
        {
            int read = RandomAccess.Read(h, buffer, offset);
            inc.AppendData(buffer, 0, read);
        }
        return (Convert.ToHexString(inc.GetHashAndReset()), fileId);
    }

    private static string? FullHash(DupeCandidate c, DupesState state)
    {
        using var scope = Open(c.Path, FileOptions.SequentialScan);
        var h = scope.Handle;
        var buffer = new byte[1 << 20];
        using var inc = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long offset = 0;
        while (true)
        {
            int read = RandomAccess.Read(h, buffer, offset);
            if (read <= 0) break;
            inc.AppendData(buffer, 0, read);
            offset += read;
            Interlocked.Add(ref state.BytesHashed, read);
        }
        if (offset != c.Bytes) return null;
        return Convert.ToHexString(inc.GetHashAndReset()).ToLowerInvariant();
    }

    private sealed class SafeHandleScope : IDisposable
    {
        public readonly Microsoft.Win32.SafeHandles.SafeFileHandle Handle;
        public SafeHandleScope(Microsoft.Win32.SafeHandles.SafeFileHandle h) => Handle = h;
        public void Dispose() => Handle.Dispose();
    }
}

internal sealed class DupesState
{
    public volatile string Phase = "listing";
    public volatile string Step = "";
    public volatile string? Current;
    public long FilesConsidered;
    public long Hashed;
    public long TotalToHash;
    public long BytesHashed;
    public long BytesToHash;

    public void Report() => Output.Line(w =>
    {
        w.WriteString("type", "progress");
        w.WriteString("phase", Phase);
        if (Step.Length > 0) w.WriteString("step", Step);
        w.WriteNumber("filesConsidered", Interlocked.Read(ref FilesConsidered));
        w.WriteNumber("hashed", Interlocked.Read(ref Hashed));
        w.WriteNumber("totalToHash", Interlocked.Read(ref TotalToHash));
        if (Step == "full")
        {
            w.WriteNumber("bytesHashed", Interlocked.Read(ref BytesHashed));
            w.WriteNumber("bytesToHash", Interlocked.Read(ref BytesToHash));
        }
        w.WriteString("current", Json.Clean(Current ?? ""));
    });
}

/// <summary>Enumera UMA pasta para a busca de duplicados: coleta arquivos grandes e enfileira subpastas.</summary>
internal sealed class DupesEnumerator : FileSystemEnumerator<byte>
{
    private const int CloudMask = 0x400000 | 0x40000 | 0x1000;
    private const int ReparsePoint = (int)FileAttributes.ReparsePoint;
    private readonly int _depth;
    private readonly long _minBytes;
    private readonly HashSet<string> _excludes;
    private readonly WorkQueue<(string, int)> _queue;
    private readonly ConcurrentBag<DupeCandidate> _out;
    private readonly DupesState _state;

    public DupesEnumerator(string dir, EnumerationOptions options, int depth, long minBytes, HashSet<string> excludes,
        WorkQueue<(string, int)> queue, ConcurrentBag<DupeCandidate> output, DupesState state)
        : base(dir, options)
    {
        _depth = depth;
        _minBytes = minBytes;
        _excludes = excludes;
        _queue = queue;
        _out = output;
        _state = state;
    }

    protected override bool ContinueOnError(int error) => true;

    protected override bool ShouldIncludeEntry(ref FileSystemEntry entry)
    {
        int attrs = (int)entry.Attributes;
        if (entry.IsDirectory)
        {
            if (DupesCommand.ShouldSkipDir(entry.FileName, _depth + 1)) return false;
            var full = entry.ToFullPath();
            if ((attrs & ReparsePoint) != 0 && !Win32.IsFollowableReparse(full)) return false;
            if (_excludes.Count > 0 && _excludes.Contains(full)) return false;
            _queue.Add((full, _depth + 1));
            return false;
        }
        long len = entry.Length;
        if (len < _minBytes) return false;
        if ((attrs & CloudMask) != 0) return false; // ler um placeholder baixaria o arquivo da nuvem
        var path = entry.ToFullPath();
        if ((attrs & ReparsePoint) != 0 && !Win32.IsFollowableReparse(path)) return false; // symlink de arquivo
        _out.Add(new DupeCandidate(path, len, entry.LastWriteTimeUtc.UtcTicks));
        Interlocked.Increment(ref _state.FilesConsidered);
        return false;
    }

    protected override byte TransformEntry(ref FileSystemEntry entry) => 0;
}

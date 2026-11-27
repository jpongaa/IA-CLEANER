// Varredura paralela SOMENTE LEITURA de uma raiz (drive ou pasta).
// - Enumeração com FileSystemEnumerator (sem recursão automática); a recursão é feita por uma fila paralela.
// - Não segue junctions/symlinks/montagens (name surrogates); segue pastas de nuvem (OneDrive).
// - Placeholders de nuvem (RECALL_ON_DATA_ACCESS / RECALL_ON_OPEN / OFFLINE) somam em cloudOnlyBytes.
// - Atributos Oculto/Sistema NÃO são ignorados (pagefile.sys, hiberfil.sys e swapfile.sys aparecem).
using System.Diagnostics;
using System.IO.Enumeration;

namespace IaCleaner.Scanner;

internal sealed class ScanSettings
{
    public int TopFiles = 300;
    public long MinNodeBytes = 64L << 20;
    public int MaxDepth = 8;
    public int Threads = 8;
    public int MaxChildrenPerNode = 120;
    public long OldMinBytes = 100L << 20;
    public int OldDays = 180;
    public int OldMax = 200;
    public HashSet<string> Excludes = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>Pasta na árvore em memória. Os filhos são adicionados apenas pelo worker que enumera a pasta.</summary>
internal sealed class Node
{
    public readonly string Name;
    public readonly Node? Parent;
    public readonly byte Ctx;
    public readonly int Depth;
    public long Bytes;      // após agregação: total da subárvore
    public long FileBytes;  // arquivos diretamente nesta pasta
    public long Files;
    public long Dirs;
    public long LastWrite;  // ticks UTC
    public List<Node>? Children;
    public bool Inaccessible;
    public bool SubtreeInaccessible;

    public Node(string name, Node? parent, byte ctx, int depth)
    {
        Name = name;
        Parent = parent;
        Ctx = ctx;
        Depth = depth;
    }
}

internal readonly record struct FileRec(string Path, long Bytes, long LastWrite, long LastAccess, int Cat);

/// <summary>Acumuladores por worker (sem travas no caminho quente).</summary>
internal sealed class WorkerState
{
    public readonly long[] CatBytes = new long[Categories.Count];
    public readonly long[] CatFiles = new long[Categories.Count];
    public readonly PriorityQueue<FileRec, long> Top = new();
    public readonly PriorityQueue<FileRec, long> Old = new();
    /// <summary>Por extensão: [bytes, arquivos].</summary>
    public readonly Dictionary<ulong, long[]> Ext = new();
    public long CloudBytes;
    public long CloudFiles;
    public long SkippedLinks;
}

internal sealed class TreeScanner
{
    private readonly string _root;
    private readonly ScanSettings _s;
    private readonly EnumerationOptions _options = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = false, // tratamos o erro em ContinueOnError para CONTAR pastas sem permissão
        AttributesToSkip = 0,
        ReturnSpecialDirectories = false,
        BufferSize = 32 * 1024
    };

    private readonly long _oldCutoffTicks;
    private WorkerState[] _workers = Array.Empty<WorkerState>();
    private WorkQueue<(Node, string)> _queue = null!;
    private long _files, _dirs, _bytes, _inaccessible;
    private volatile string _current = "";
    private readonly List<string> _inaccessibleSamples = new();

    public TreeScanner(string root, ScanSettings settings)
    {
        _root = root;
        _s = settings;
        _oldCutoffTicks = DateTime.UtcNow.AddDays(-settings.OldDays).Ticks;
    }

    public long FilesSoFar => Interlocked.Read(ref _files);
    public long DirsSoFar => Interlocked.Read(ref _dirs);
    public long BytesSoFar => Interlocked.Read(ref _bytes);
    public string Current => _current;

    public DriveScanResultDto Run()
    {
        var started = DateTime.UtcNow;
        var sw = Stopwatch.StartNew();
        var result = new DriveScanResultDto { Root = _root, ScannedAt = started.ToString("o"), Engine = "native", Threads = _s.Threads };

        if (!Directory.Exists(_root))
        {
            result.Error = "Unidade ou pasta não encontrada: " + _root;
            result.Tree = new DirNodeDto { Name = _root, Path = _root };
            result.DurationMs = sw.ElapsedMilliseconds;
            return result;
        }

        var root = new Node(_root, null, Categories.NoCtx, 0);
        _workers = new WorkerState[_s.Threads];
        for (int i = 0; i < _workers.Length; i++) _workers[i] = new WorkerState();

        // Progresso a cada ~250 ms
        using var stop = new CancellationTokenSource();
        var reporter = new Thread(() =>
        {
            while (!stop.Token.WaitHandle.WaitOne(250))
                Output.ScanProgress(_root, FilesSoFar, DirsSoFar, BytesSoFar, _current);
        })
        { IsBackground = true, Name = "progress" };
        reporter.Start();

        _queue = new WorkQueue<(Node, string)>(_s.Threads, (item, w) => Enumerate(item.Item1, item.Item2, _workers[w]));
        _queue.Run((root, _root));

        stop.Cancel();
        reporter.Join();

        Aggregate(root);

        result.TotalBytes = root.Bytes;
        result.Files = root.Files;
        result.Dirs = root.Dirs;
        result.InaccessibleDirs = Interlocked.Read(ref _inaccessible);
        result.Tree = BuildDto(root, _root);
        long cloudBytes = 0, cloudFiles = 0, links = 0;
        var catBytes = new long[Categories.Count];
        var catFiles = new long[Categories.Count];
        var top = new List<FileRec>();
        var old = new List<FileRec>();
        var ext = new Dictionary<ulong, long[]>();
        foreach (var ws in _workers)
        {
            foreach (var kv in ws.Ext)
            {
                if (!ext.TryGetValue(kv.Key, out var acc)) ext[kv.Key] = acc = new long[2];
                acc[0] += kv.Value[0];
                acc[1] += kv.Value[1];
            }
            cloudBytes += ws.CloudBytes;
            cloudFiles += ws.CloudFiles;
            links += ws.SkippedLinks;
            for (int c = 0; c < Categories.Count; c++)
            {
                catBytes[c] += ws.CatBytes[c];
                catFiles[c] += ws.CatFiles[c];
            }
            top.AddRange(ws.Top.UnorderedItems.Select(x => x.Element));
            old.AddRange(ws.Old.UnorderedItems.Select(x => x.Element));
        }
        result.CloudOnlyBytes = cloudBytes;
        result.CloudOnlyFiles = cloudFiles;
        result.SkippedLinks = links;
        result.TopFiles = top.OrderByDescending(f => f.Bytes).Take(_s.TopFiles).Select(ToDto).ToList();
        result.OldLargeFiles = old.OrderByDescending(f => f.Bytes).Take(_s.OldMax).Select(ToDto).ToList();
        for (int c = 0; c < Categories.Count; c++)
        {
            if (catFiles[c] > 0)
                result.Categories.Add(new CategoryStatDto { Category = Categories.Names[c], Bytes = catBytes[c], Files = catFiles[c] });
        }
        result.Categories.Sort((a, b) => b.Bytes.CompareTo(a.Bytes));
        result.Extensions = ext
            .OrderByDescending(kv => kv.Value[0])
            .Take(40)
            .Select(kv => new ExtStatDto
            {
                Ext = Categories.KeyToString(kv.Key),
                Category = Categories.Names[Categories.ForKey(kv.Key)],
                Bytes = kv.Value[0],
                Files = kv.Value[1]
            })
            .ToList();
        lock (_inaccessibleSamples)
        {
            if (_inaccessibleSamples.Count > 0) result.InaccessibleSamples = _inaccessibleSamples.Select(Json.Clean).ToList();
        }

        if (_root.Length == 3 && _root[1] == ':')
        {
            try
            {
                var di = new DriveInfo(_root);
                if (di.IsReady)
                {
                    result.VolumeTotalBytes = di.TotalSize;
                    result.VolumeUsedBytes = di.TotalSize - di.TotalFreeSpace;
                }
            }
            catch
            {
                // sem informação de volume
            }
        }

        result.DurationMs = sw.ElapsedMilliseconds;
        Output.ScanProgress(_root, result.Files, result.Dirs, result.TotalBytes, "", rootDone: true);
        return result;
    }

    private static FileEntryDto ToDto(FileRec f)
    {
        var name = System.IO.Path.GetFileName(f.Path.AsSpan());
        var ext = Categories.Extension(name);
        return new FileEntryDto
        {
            Path = Json.Clean(f.Path),
            Bytes = f.Bytes,
            LastWrite = Json.ToEpochMs(f.LastWrite),
            LastAccess = f.LastAccess > 0 ? Json.ToEpochMs(f.LastAccess) : null,
            Ext = Json.Clean(ext.ToString().ToLowerInvariant()),
            Category = Categories.Names[f.Cat]
        };
    }

    private void Enumerate(Node node, string path, WorkerState ws)
    {
        _current = path;
        using var e = new TreeEnumerator(path, _options);
        e.Bind(this, node, ws, _queue);
        while (e.MoveNext())
        {
            // todo o trabalho acontece em ShouldIncludeEntry (nenhum item é materializado)
        }
        node.FileBytes = e.Bytes;
        node.Bytes = e.Bytes;
        node.Files = e.Files;
        node.Dirs = e.Dirs;
        node.LastWrite = e.LastWrite;
        if (e.Failed)
        {
            node.Inaccessible = true;
            Interlocked.Increment(ref _inaccessible);
            lock (_inaccessibleSamples)
            {
                if (_inaccessibleSamples.Count < 40) _inaccessibleSamples.Add(path);
            }
        }
        Interlocked.Add(ref _files, e.Files);
        Interlocked.Add(ref _dirs, e.Dirs);
        Interlocked.Add(ref _bytes, e.Bytes);
    }

    // ---------- chamado pelo enumerador (thread do worker) ----------

    internal bool IsExcluded(string fullPath) => _s.Excludes.Count > 0 && _s.Excludes.Contains(fullPath);

    internal void OfferFile(WorkerState ws, ref FileSystemEntry entry, long len, long lastWrite, int cat)
    {
        if (len <= 0) return;
        var top = ws.Top;
        bool wantTop = top.Count < _s.TopFiles || (top.TryPeek(out _, out var minTop) && len > minTop);
        bool wantOld = len >= _s.OldMinBytes && lastWrite <= _oldCutoffTicks &&
                       (ws.Old.Count < _s.OldMax || (ws.Old.TryPeek(out _, out var minOld) && len > minOld));
        if (!wantTop && !wantOld) return;
        long access = 0;
        try { access = entry.LastAccessTimeUtc.UtcTicks; } catch { /* ignora */ }
        var rec = new FileRec(entry.ToFullPath(), len, lastWrite, access, cat);
        if (wantTop)
        {
            if (top.Count < _s.TopFiles) top.Enqueue(rec, len);
            else top.EnqueueDequeue(rec, len);
        }
        if (wantOld)
        {
            if (ws.Old.Count < _s.OldMax) ws.Old.Enqueue(rec, len);
            else ws.Old.EnqueueDequeue(rec, len);
        }
    }

    // ---------- pós-processamento ----------

    private static void Aggregate(Node root)
    {
        // Ordem BFS (pais antes dos filhos); percorrida ao contrário soma filhos nos pais (sem recursão).
        var order = new List<Node> { root };
        for (int i = 0; i < order.Count; i++)
        {
            var ch = order[i].Children;
            if (ch != null) order.AddRange(ch);
        }
        for (int i = order.Count - 1; i >= 0; i--)
        {
            var n = order[i];
            n.SubtreeInaccessible |= n.Inaccessible;
            var p = n.Parent;
            if (p == null) continue;
            p.Bytes += n.Bytes;
            p.Files += n.Files;
            p.Dirs += n.Dirs;
            if (n.LastWrite > p.LastWrite) p.LastWrite = n.LastWrite;
            if (n.SubtreeInaccessible) p.SubtreeInaccessible = true;
        }
    }

    private DirNodeDto BuildDto(Node n, string path)
    {
        var dto = new DirNodeDto
        {
            Name = Json.Clean(n.Name),
            Path = Json.Clean(path),
            Bytes = n.Bytes,
            Files = n.Files,
            Dirs = n.Dirs,
            LastWrite = n.LastWrite > 0 ? Json.ToEpochMs(n.LastWrite) : null,
            FileBytes = n.FileBytes > 0 ? n.FileBytes : null
        };
        bool inaccessible = n.Inaccessible;
        long shown = 0;
        if (n.Children is { Count: > 0 } children)
        {
            var kept = new List<DirNodeDto>();
            if (n.Depth < _s.MaxDepth)
            {
                children.Sort((a, b) => b.Bytes.CompareTo(a.Bytes));
                foreach (var c in children)
                {
                    if (kept.Count < _s.MaxChildrenPerNode && c.Bytes >= _s.MinNodeBytes)
                    {
                        var childPath = path.EndsWith('\\') ? path + c.Name : path + "\\" + c.Name;
                        kept.Add(BuildDto(c, childPath));
                        shown += c.Bytes;
                    }
                    else if (c.SubtreeInaccessible)
                    {
                        inaccessible = true;
                    }
                }
            }
            else if (n.SubtreeInaccessible)
            {
                inaccessible = true;
            }
            if (kept.Count > 0) dto.Children = kept;
        }
        long other = n.Bytes - shown;
        if (other > 0) dto.OtherBytes = other;
        if (inaccessible) dto.Inaccessible = true;
        return dto;
    }
}

/// <summary>Enumerador de UMA pasta: processa cada entrada em ShouldIncludeEntry e não materializa resultados.</summary>
internal sealed class TreeEnumerator : FileSystemEnumerator<byte>
{
    /// <summary>RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE: arquivo só na nuvem (não ocupa disco).</summary>
    private const int CloudMask = 0x400000 | 0x40000 | 0x1000;
    private const int ReparsePoint = (int)FileAttributes.ReparsePoint;

    private TreeScanner _scanner = null!;
    private Node _node = null!;
    private WorkerState _ws = null!;
    private WorkQueue<(Node, string)> _queue = null!;
    private bool _failed;

    public long Bytes, Files, Dirs, LastWrite;

    public TreeEnumerator(string directory, EnumerationOptions options) : base(directory, options)
    {
    }

    public bool Failed => _failed;

    public void Bind(TreeScanner scanner, Node node, WorkerState ws, WorkQueue<(Node, string)> queue)
    {
        _scanner = scanner;
        _node = node;
        _ws = ws;
        _queue = queue;
    }

    protected override bool ContinueOnError(int error)
    {
        // 2/3 = sumiu durante a varredura (não é falta de permissão)
        if (error != 2 && error != 3) _failed = true;
        return true;
    }

    protected override bool ShouldIncludeEntry(ref FileSystemEntry entry)
    {
        int attrs = (int)entry.Attributes;
        if (entry.IsDirectory)
        {
            string full = entry.ToFullPath();
            if ((attrs & ReparsePoint) != 0 && !Win32.IsFollowableReparse(full))
            {
                _ws.SkippedLinks++;
                return false;
            }
            if (_scanner.IsExcluded(full)) return false;
            string name = entry.FileName.ToString();
            var child = new Node(name, _node, Categories.DirContext(name, _node.Depth + 1, _node.Ctx), _node.Depth + 1);
            (_node.Children ??= new List<Node>()).Add(child);
            Dirs++;
            _queue.Add((child, full));
            return false;
        }

        long len = entry.Length;
        if ((attrs & CloudMask) != 0)
        {
            _ws.CloudBytes += len;
            _ws.CloudFiles++;
            return false;
        }
        Files++;
        Bytes += len;
        long lw = entry.LastWriteTimeUtc.UtcTicks;
        if (lw > LastWrite) LastWrite = lw;
        ulong extKey = Categories.ExtKey(Categories.Extension(entry.FileName));
        int cat = _node.Ctx != Categories.NoCtx ? _node.Ctx : Categories.ForKey(extKey);
        _ws.CatBytes[cat] += len;
        _ws.CatFiles[cat]++;
        if (!_ws.Ext.TryGetValue(extKey, out var extAcc)) _ws.Ext[extKey] = extAcc = new long[2];
        extAcc[0] += len;
        extAcc[1]++;
        _scanner.OfferFile(_ws, ref entry, len, lw, cat);
        return false;
    }

    protected override byte TransformEntry(ref FileSystemEntry entry) => 0;
}

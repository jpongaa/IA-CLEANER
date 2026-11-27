namespace IaCleaner.Scanner;

/// <summary>Leitor simples de argumentos "--chave valor" (chaves repetíveis) e flags sem valor.</summary>
internal sealed class Args
{
    private static readonly HashSet<string> Flags = new(StringComparer.OrdinalIgnoreCase) { "exit-on-stdin-close" };
    private readonly Dictionary<string, List<string>> _values = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _flags = new(StringComparer.OrdinalIgnoreCase);

    public Args(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException($"argumento inesperado: {a}");
            var key = a[2..];
            if (Flags.Contains(key))
            {
                _flags.Add(key);
                continue;
            }
            if (i + 1 >= args.Length) throw new ArgumentException($"faltou o valor de --{key}");
            if (!_values.TryGetValue(key, out var list)) _values[key] = list = new List<string>();
            list.Add(args[++i]);
        }
    }

    public bool Flag(string key) => _flags.Contains(key);

    public IReadOnlyList<string> All(string key) => _values.TryGetValue(key, out var l) ? l : Array.Empty<string>();

    public string? One(string key) => _values.TryGetValue(key, out var l) && l.Count > 0 ? l[^1] : null;

    public string Required(string key) => One(key) ?? throw new ArgumentException($"--{key} é obrigatório");

    public long Long(string key, long def, long min, long max)
    {
        var v = One(key);
        if (v is null) return def;
        if (!long.TryParse(v, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n))
            throw new ArgumentException($"--{key} inválido: {v}");
        return Math.Clamp(n, min, max);
    }

    public int Int(string key, int def, int min, int max) => (int)Long(key, def, min, max);

    /// <summary>Normaliza uma raiz: "C:" / "c:\\" → "C:\\"; pasta → caminho completo sem barra final.</summary>
    public static string NormalizeRoot(string root)
    {
        var r = root.Trim().Trim('"');
        if (r.Length == 2 && r[1] == ':') r += "\\";
        r = Path.GetFullPath(r);
        if (r.Length == 3 && r[1] == ':') return char.ToUpperInvariant(r[0]) + ":\\";
        return r.TrimEnd('\\');
    }

    public static HashSet<string> NormalizeExcludes(IEnumerable<string> excludes)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in excludes)
        {
            if (string.IsNullOrWhiteSpace(e)) continue;
            try
            {
                var full = Path.GetFullPath(e.Trim().Trim('"'));
                set.Add(full.Length > 3 ? full.TrimEnd('\\') : full);
            }
            catch
            {
                // caminho inválido: ignora
            }
        }
        return set;
    }

    /// <summary>Encerra o processo se o stdin fechar (o app pai morreu): evita varredura órfã.</summary>
    public void WatchParent()
    {
        if (!Flag("exit-on-stdin-close")) return;
        var t = new Thread(() =>
        {
            try
            {
                var stdin = Console.OpenStandardInput();
                var buf = new byte[256];
                while (stdin.Read(buf, 0, buf.Length) > 0) { }
            }
            catch
            {
                // ignora
            }
            Environment.Exit(3);
        })
        { IsBackground = true, Name = "parent-watch" };
        t.Start();
    }
}

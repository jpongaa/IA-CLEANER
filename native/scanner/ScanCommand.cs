namespace IaCleaner.Scanner;

/// <summary>
/// scan --root C:\ [--root D:\] --out f.json [--top-files 300] [--min-node-mb 64] [--max-depth 8] [--threads N] [--exclude dir]...
/// Grava DriveScanResult[] (src/shared/types/disk.ts) em --out. SOMENTE LEITURA.
/// </summary>
public static class ScanCommand
{
    public static int Run(string[] argv)
    {
        var args = new Args(argv);
        args.WatchParent();
        var roots = args.All("root").Select(Args.NormalizeRoot).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (roots.Count == 0) throw new ArgumentException("informe ao menos um --root");
        var outFile = args.Required("out");
        var settings = new ScanSettings
        {
            TopFiles = args.Int("top-files", 300, 10, 5000),
            MinNodeBytes = args.Long("min-node-mb", 64, 1, 1 << 20) << 20,
            MaxDepth = args.Int("max-depth", 8, 1, 64),
            Threads = args.Int("threads", Math.Clamp(Environment.ProcessorCount, 2, 16), 1, 64),
            Excludes = Args.NormalizeExcludes(args.All("exclude"))
        };

        var results = new List<DriveScanResultDto>();
        foreach (var root in roots)
        {
            try
            {
                results.Add(new TreeScanner(root, settings).Run());
            }
            catch (Exception ex)
            {
                results.Add(new DriveScanResultDto
                {
                    Root = root,
                    ScannedAt = DateTime.UtcNow.ToString("o"),
                    Tree = new DirNodeDto { Name = root, Path = root },
                    Error = ex.Message
                });
            }
        }

        Json.WriteFile(outFile, results.ToArray(), Json.Ctx.DriveScanResultDtoArray);
        Output.Done(Path.GetFullPath(outFile));
        return 0;
    }
}

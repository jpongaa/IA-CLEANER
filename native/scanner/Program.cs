// iacleaner-scanner: helper nativo SOMENTE LEITURA para varrer discos rapidamente.
// Nunca apaga, move ou altera arquivos.
//
// Comandos:
//   scan  --root C:\ [--root D:\] --out result.json [--top-files 300] [--min-node-mb 64] [--max-depth 8] [--threads N]
//         [--exclude <dir>]... [--exit-on-stdin-close]
//   dupes --root C:\ [--root D:\] --out dupes.json [--min-mb 10] [--threads N] [--exclude <dir>]... [--exit-on-stdin-close]
// --exit-on-stdin-close: encerra se o processo pai fechar o stdin (evita varredura órfã se o app fechar).
// Progresso: linhas JSON em stdout ({"type":"progress",...}); fim: {"type":"done","out":"..."}; erro: {"type":"error","message":"..."}.
using System.Text;

namespace IaCleaner.Scanner;

public static class Program
{
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0)
        {
            Console.Error.WriteLine("uso: iacleaner-scanner <scan|dupes> [opções]");
            return 2;
        }
        try
        {
            return args[0] switch
            {
                "scan" => ScanCommand.Run(args[1..]),
                "dupes" => DupesCommand.Run(args[1..]),
                "--version" => PrintVersion(),
                _ => Unknown(args[0])
            };
        }
        catch (Exception ex)
        {
            Output.Error(ex.Message);
            return 1;
        }
    }

    private static int PrintVersion()
    {
        Console.WriteLine("iacleaner-scanner 1.0");
        return 0;
    }

    private static int Unknown(string cmd)
    {
        Console.Error.WriteLine($"comando desconhecido: {cmd}");
        return 2;
    }
}

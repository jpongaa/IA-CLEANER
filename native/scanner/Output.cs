using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace IaCleaner.Scanner;

/// <summary>Escrita de linhas JSON (progresso/erro/fim) em stdout, thread-safe.</summary>
public static class Output
{
    private static readonly object Gate = new();
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static void Line(Action<Utf8JsonWriter> write)
    {
        string text;
        try
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms, WriterOptions))
            {
                w.WriteStartObject();
                write(w);
                w.WriteEndObject();
            }
            text = Encoding.UTF8.GetString(ms.ToArray());
        }
        catch
        {
            return; // nunca derrubar a varredura por causa de uma linha de progresso
        }
        lock (Gate)
        {
            try
            {
                Console.Out.WriteLine(text);
                Console.Out.Flush();
            }
            catch
            {
                // stdout fechado (processo pai morreu)
            }
        }
    }

    public static void Error(string message) => Line(w =>
    {
        w.WriteString("type", "error");
        w.WriteString("message", Json.Clean(message));
    });

    public static void Warn(string message) => Line(w =>
    {
        w.WriteString("type", "warning");
        w.WriteString("message", Json.Clean(message));
    });

    public static void Done(string outFile) => Line(w =>
    {
        w.WriteString("type", "done");
        w.WriteString("out", outFile);
    });

    public static void ScanProgress(string root, long files, long dirs, long bytes, string? current, bool rootDone = false) => Line(w =>
    {
        w.WriteString("type", "progress");
        w.WriteString("root", root);
        w.WriteNumber("files", files);
        w.WriteNumber("dirs", dirs);
        w.WriteNumber("bytes", bytes);
        w.WriteString("current", Json.Clean(current ?? ""));
        if (rootDone) w.WriteBoolean("rootDone", true);
    });

    public static void DupesProgress(string phase, long filesConsidered, long hashed, long totalToHash, string? current) => Line(w =>
    {
        w.WriteString("type", "progress");
        w.WriteString("phase", phase);
        w.WriteNumber("filesConsidered", filesConsidered);
        w.WriteNumber("hashed", hashed);
        w.WriteNumber("totalToHash", totalToHash);
        w.WriteString("current", Json.Clean(current ?? ""));
    });
}

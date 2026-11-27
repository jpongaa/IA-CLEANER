using System.Collections.Concurrent;

namespace IaCleaner.Scanner;

/// <summary>
/// Fila de trabalho paralela (LIFO = busca em profundidade, menos memória). Cada item processado pode
/// enfileirar novos itens; Run() termina quando não há itens pendentes nem em processamento.
/// </summary>
internal sealed class WorkQueue<T>
{
    private readonly ConcurrentStack<T> _stack = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly int _threads;
    private readonly Action<T, int> _process;
    private int _pending;
    private volatile bool _finished;
    private long _errors;

    /// <param name="process">(item, índice do worker). Exceções são contadas e não interrompem a varredura.</param>
    public WorkQueue(int threads, Action<T, int> process)
    {
        _threads = Math.Max(1, threads);
        _process = process;
    }

    public long Errors => Interlocked.Read(ref _errors);

    public void Add(T item)
    {
        Interlocked.Increment(ref _pending);
        _stack.Push(item);
        _signal.Release();
    }

    public void Run(T first)
    {
        Add(first);
        var workers = new Thread[_threads];
        for (int i = 0; i < _threads; i++)
        {
            int index = i;
            workers[i] = new Thread(() => Worker(index), 4 * 1024 * 1024) { IsBackground = true, Name = $"scan-{index}" };
            workers[i].Start();
        }
        foreach (var w in workers) w.Join();
    }

    private void Worker(int index)
    {
        while (true)
        {
            _signal.Wait();
            if (_stack.TryPop(out var item))
            {
                try
                {
                    _process(item, index);
                }
                catch
                {
                    Interlocked.Increment(ref _errors);
                }
                if (Interlocked.Decrement(ref _pending) == 0)
                {
                    _finished = true;
                    _signal.Release(_threads);
                }
            }
            else if (_finished)
            {
                return;
            }
        }
    }
}

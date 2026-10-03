using System.IO;
using System.IO.Pipes;
using System.Windows;
using Velopack;

namespace AzusaHexPick;

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        VelopackApp.Build().SetAutoApplyOnStartup(false).Run();
        using var singleton = new Mutex(true, @"Local\AzusaHexPick.Launcher", out bool first);
        if (!first)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", "AzusaHexPick.Show", PipeDirection.Out);
                pipe.Connect(1500);
                pipe.WriteByte(1);
            }
            catch { }
            return;
        }
        var app = new System.Windows.Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var window = new MainWindow(args);
        app.MainWindow = window;
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var pipe = new NamedPipeServerStream("AzusaHexPick.Show", PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await pipe.WaitForConnectionAsync();
                    var buffer = new byte[1];
                    await pipe.ReadExactlyAsync(buffer);
                    _ = app.Dispatcher.BeginInvoke(window.Reveal);
                }
                catch { await Task.Delay(1000); }
            }
        });
        app.Run(window);
    }
}

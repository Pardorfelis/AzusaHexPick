using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AzusaHexPick;

public sealed class LocalBridge : IAsyncDisposable
{
    private WebApplication? server;
    public string Url { get; private set; } = "";
    public string Secret { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    public Func<object> State { get; set; } = () => new { state = "idle" };
    public Action<string> Command { get; set; } = _ => { };

    public async Task Start()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Listen(IPAddress.Loopback, 0);
            options.Limits.MaxRequestBodySize = 4096;
        });
        server = builder.Build();
        server.Use(async (context, next) =>
        {
            string token = context.Request.Headers["X-Azusa-Launcher"].ToString();
            if (!IPAddress.IsLoopback(context.Connection.RemoteIpAddress!) || context.Request.Headers.ContainsKey("Origin")
                || context.Request.Host.Host != "127.0.0.1" || token.Length != Secret.Length
                || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(Secret)))
            { context.Response.StatusCode = 403; return; }
            context.Response.Headers.CacheControl = "no-store";
            await next(context);
        });
        server.MapGet("/state", () => Results.Json(State()));
        server.MapPost("/command", async (HttpContext context) =>
        {
            try
            {
                var body = await JsonSerializer.DeserializeAsync<JsonElement>(context.Request.Body, cancellationToken: context.RequestAborted);
                string? action = body.GetProperty("action").GetString();
                if (action is not ("show" or "desktop" or "settings" or "check-update" or "update" or "exit")) return Results.BadRequest();
                Command(action);
                return Results.Json(State());
            }
            catch { return Results.BadRequest(); }
        });
        await server.StartAsync();
        Url = server.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    }

    public async ValueTask DisposeAsync() { if (server != null) await server.DisposeAsync(); }
}

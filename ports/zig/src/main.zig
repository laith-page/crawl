//! crawler prints every page on one host, breadth-first.
const std = @import("std");
const cli = @import("cli");
const Crawler = @import("Crawler.zig");
const Fetcher = @import("Fetcher.zig");
const Tls = @import("Tls.zig");
const http = @import("http");
const Machine = @import("Machine.zig");
const Throttle = @import("Throttle.zig");
const Options = @import("Options.zig");
const urls = @import("urls.zig");
const signals = @import("signals");

/// A safety check tripped inside std by a hostile response ends the crawl through `fatal`.
pub const panic = std.debug.FullPanic(fatal);

/// Ends the crawl with one line and exit 1, not a stack trace.
fn fatal(message: []const u8, _: ?usize) noreturn {
    std.debug.print("error: internal error: {s}\n", .{message});
    std.process.exit(1);
}

pub fn main(init: std.process.Init) u8 {
    var buffers: struct { output: [Crawler.output_buffer_bytes]u8, error_output: [1024]u8 } = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &buffers.output);
    var stderr = std.Io.File.stderr().writerStreaming(init.io, &buffers.error_output);
    defer stderr.interface.flush() catch {};
    return run(init, &stdout, &stderr.interface) catch |err| {
        stderr.interface.print("error: {s}\n", .{@errorName(err)}) catch {};
        return 1;
    };
}

fn run(init: std.process.Init, stdout: *std.Io.File.Writer, stderr: *std.Io.Writer) !u8 {
    var context: Context = .{ .init = init, .stdout = stdout, .stderr = stderr };
    const code = try Options.command.run((try init.minimal.args.toSlice(init.arena.allocator()))[1..], init.environ_map, &context, Context.check, Context.action, std.mem.trimEnd(u8, @import("build_options").version, "\r\n"), &stdout.interface, stderr);
    if (code == 0 and !context.ran) try stdout.interface.flush();
    return code;
}

const Context = struct {
    init: std.process.Init,
    stdout: *std.Io.File.Writer,
    stderr: *std.Io.Writer,
    ran: bool = false,

    fn check(context: *Context, arg: []const u8) error{OutOfMemory}!?[]const u8 {
        return urls.startUrl(context.init.arena.allocator(), arg);
    }

    fn action(context: *Context, values: cli.Values) anyerror!u8 {
        context.ran = true;
        const machine = Machine.detect(values.get("CRAWL_CPUS"));
        const options = Options.of(values, machine);
        return crawl(context.init, context.stdout, context.stderr, options, machine) catch |err| {
            context.stderr.print("error: {s}\n", .{@errorName(err)}) catch {};
            return 1;
        };
    }
};

fn crawl(init: std.process.Init, stdout: *std.Io.File.Writer, stderr: *std.Io.Writer, options: Options, machine: Machine) !u8 {
    signals.trap();
    if (options.verbose) try options.settings(machine, stderr);
    var threaded: std.Io.Threaded = .init(init.gpa, .{ .async_limit = .limited(machine.threads), .concurrent_limit = .limited(4 * options.concurrency + 64) });
    defer threaded.deinit();
    const io = threaded.io();
    const cert_file = init.environ_map.get("SSL_CERT_FILE");
    if (cert_file) |path| {
        const file: ?std.Io.File = std.Io.Dir.cwd().openFile(io, path, .{}) catch null;
        const readable = if (file) |opened| readable: {
            defer opened.close(io);
            const stat = opened.stat(io) catch break :readable false;
            break :readable stat.kind == .file;
        } else false;
        if (!readable) try stderr.print("warning: SSL_CERT_FILE is unreadable; trusting no certificates\n", .{});
    }
    var http_client: http.Client = try .init(io, init.gpa, .{ .max_idle = options.concurrency, .max_in_flight = options.concurrency });
    defer http_client.deinit();
    var tls: Tls = .{ .gpa = init.gpa, .io = io, .cert_file = cert_file };
    defer tls.deinit();
    var throttle: Throttle = .init(options.delay_millis, !options.fast);
    var crawler: Crawler = try .init(init.gpa, options.url, options.concurrency, options.max_pages);
    defer crawler.deinit();
    const fetcher: Fetcher = .{
        .io = io,
        .timeout = .fromSeconds(@intCast(options.timeout_seconds)),
        .throttle = &throttle,
        .http = .init(&http_client, &tls, options.user_agent),
    };
    return crawler.crawl(io, fetcher, Fetcher.fetch, &stdout.interface, stdout, stderr, signals);
}

test {
    _ = @import("Crawler.zig");
    _ = @import("Fetcher.zig");
    _ = @import("Frontier.zig");
    _ = @import("Machine.zig");
    _ = @import("Options.zig");
    _ = @import("Output.zig");
    _ = @import("Page.zig");
    _ = @import("Throttle.zig");
    _ = @import("Tracker.zig");
    _ = @import("Tls.zig");
    _ = @import("failure.zig");
    _ = @import("Links.zig");
    _ = @import("retries.zig");
    _ = @import("Http.zig");
    _ = @import("urls.zig");
}

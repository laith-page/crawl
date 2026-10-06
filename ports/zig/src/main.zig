//! crawler prints every page on one host, breadth-first.
const std = @import("std");
const Io = std.Io;
const cli = @import("cli");
const certs = @import("certs");
const Crawler = @import("Crawler.zig");
const Fetcher = @import("Fetcher.zig");
const Tls = @import("Tls.zig");
const http = @import("http");
const pacing = @import("pacing");
const Machine = @import("Machine.zig");
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
    var buffers: struct { output: [4096]u8, error_output: [1024]u8 } = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(init.io, &buffers.output);
    var stderr = std.Io.File.stderr().writerStreaming(init.io, &buffers.error_output);
    defer stderr.interface.flush() catch {};
    return run(init, &stdout, &stderr.interface) catch |err| {
        stderr.interface.print("error: {s}\n", .{@errorName(err)}) catch {};
        return 1;
    };
}

fn run(init: std.process.Init, stdout: *std.Io.File.Writer, stderr: *std.Io.Writer) !u8 {
    var arena_state: std.heap.ArenaAllocator = .init(init.gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const args = try init.minimal.args.toSlice(arena);
    const version_text = @import("build_options").version;
    const prepared = try Options.command.prepare(args[1..], init.environ_map, arena, urls.startUrl, version_text, &stdout.interface, stderr);
    switch (prepared) {
        .exit => |code| return code,
        .run => |values| {
            const machine = Machine.detect(values.get("CRAWL_CPUS"));
            return crawl(init, Options.of(values, machine), machine, stderr);
        },
    }
}

fn crawl(init: std.process.Init, options: Options, machine: Machine, stderr: *std.Io.Writer) !u8 {
    signals.trap();
    var threaded: std.Io.Threaded = .init(init.gpa, .{ .async_limit = .limited(machine.threads), .concurrent_limit = .limited(4 * options.concurrency + 64) });
    defer threaded.deinit();
    const io = threaded.io();
    const trust = certs.fromEnv(io, init.environ_map);
    if (trust.warning) |warning| try stderr.print("{s}\n", .{warning});
    if (options.verbose) try options.settings(machine, stderr);
    var tls: Tls = .{ .gpa = init.gpa, .io = io, .cert_file = trust.cert_file };
    defer tls.deinit();
    var http_client: http.Client = try .init(io, init.gpa, .{
        .max_connections = options.concurrency,
        .tls = tls.hook(),
        .user_agent = options.user_agent,
    });
    defer http_client.deinit();
    var pacer: pacing.Pacer = .init(Io.Duration.fromMilliseconds(options.delay_millis));
    var seed: u64 = undefined;
    io.random(std.mem.asBytes(&seed));
    var crawler: Crawler = try .init(init.gpa, options.url, options.concurrency, options.max_pages, seed);
    defer crawler.deinit();
    const fetcher: Fetcher = .{
        .io = io,
        .timeout = .fromSeconds(@intCast(options.timeout_seconds)),
        .pacer = &pacer,
        .shared_retries = !options.fast,
        .client = &http_client,
    };
    var output_buffer: [Crawler.output_buffer_bytes]u8 = undefined;
    var stdout_file = std.Io.File.stdout().writerStreaming(io, &.{});
    var out: cli.BlockWriter = .openFile(&stdout_file, &output_buffer);
    return crawler.crawl(io, fetcher, Fetcher.fetch, &out, stderr, signals);
}

test {
    _ = @import("Crawler.zig");
    _ = @import("Fetcher.zig");
    _ = @import("Frontier.zig");
    _ = @import("Machine.zig");
    _ = @import("Options.zig");
    _ = @import("Page.zig");
    _ = @import("Tracker.zig");
    _ = @import("Tls.zig");
    _ = @import("failure.zig");
    _ = @import("Links.zig");
    _ = @import("retries.zig");
    _ = @import("urls.zig");
}

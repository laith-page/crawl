//! Maps the shared cli declaration to crawler settings (DESIGN §1).
const std = @import("std");
const cli = @import("cli");
const Machine = @import("Machine.zig");
const urls = @import("urls.zig");
const Options = @This();

pub const default_user_agent = "crawler/1.0";
pub const max_concurrency: usize = 256;
pub const command: cli.Command = .{
    .program = "crawl",
    .positional = "url",
    .invalid = "not an http or https URL",
    .switches = &.{
        .{ .name = "-f", .env = "CRAWL_FAST", .help = "fast: as many requests as this machine takes, no delay" },
        .{ .name = "-v", .env = "CRAWL_VERBOSE", .help = "verbose: the settings this crawl runs with, on stderr" },
    },
    .flags = &.{
        .{ .name = "-c", .value = "N", .help = "requests in flight at most", .default = 1, .min = 1, .max = max_concurrency, .env = "CRAWL_MAX_CONCURRENCY" },
        .{ .name = "-n", .value = "N", .help = "pages to crawl at most", .default = 1000, .min = 1, .env = "CRAWL_MAX_PAGES" },
        .{ .name = "-t", .value = "SECONDS", .help = "seconds per request timeout", .default = 10, .min = 1, .max = 120, .env = "CRAWL_TIMEOUT" },
        // Cli parses -d seconds into integer milliseconds.
        .{ .name = "-d", .value = "SECONDS", .help = "seconds between request starts", .default = 1000, .min = 0, .max = 60000, .env = "CRAWL_DELAY", .decimals = 3 },
    },
    .settings = &.{.{ .env = "CRAWL_CPUS", .default = 0, .min = 1, .max = 1024 }},
    .texts = &.{.{ .env = "CRAWL_USER_AGENT", .default = default_user_agent }},
    .version = "version and libraries",
    .see = "see DESIGN §1",
};

fast: bool,
verbose: bool,
concurrency: usize,
max_pages: usize,
timeout_seconds: u32,
delay_millis: u32,
user_agent: []const u8,
url: []const u8,

pub fn of(values: cli.Values, machine: Machine) Options {
    const fast = values.on("-f");
    return .{
        .fast = fast,
        .verbose = values.on("-v"),
        .concurrency = if (values.given("-c")) values.get("-c") else if (fast) machine.max_concurrency else 1,
        .max_pages = values.get("-n"),
        .timeout_seconds = @intCast(values.get("-t")),
        .delay_millis = @intCast(if (values.given("-d")) values.get("-d") else if (fast) @as(usize, 0) else @as(usize, 1000)),
        .user_agent = values.text("CRAWL_USER_AGENT"),
        .url = values.positional,
    };
}

pub fn settings(self: Options, machine: Machine, writer: *std.Io.Writer) !void {
    try writer.print("settings: {s}, cpus {d}, threads {d}, concurrency {d} (max {d}), delay {f}s, timeout {d}s, pages {d}\n", .{
        if (self.fast) "fast" else "polite", machine.cpus,         machine.threads, self.concurrency, machine.max_concurrency,
        cli.decimal(self.delay_millis, 3),   self.timeout_seconds, self.max_pages,
    });
}

const testing = std.testing;

test "concurrency" {
    const machine: Machine = .{ .cpus = 2, .threads = 2, .max_concurrency = 48 };
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const polite = of((try command.parse(&[_][]const u8{"http://example.com/"}, null, arena.allocator(), urls.startUrl)).run, machine);
    const fast = of((try command.parse(&[_][]const u8{ "-f", "http://example.com/" }, null, arena.allocator(), urls.startUrl)).run, machine);
    const explicit = of((try command.parse(&[_][]const u8{ "-f", "-c", "4", "http://example.com/" }, null, arena.allocator(), urls.startUrl)).run, machine);
    try testing.expectEqual(1, polite.concurrency);
    try testing.expectEqual(48, fast.concurrency);
    try testing.expectEqual(4, explicit.concurrency);
}

test "settings" {
    const machine: Machine = .{ .cpus = 2, .threads = 2, .max_concurrency = 48 };
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const options = of((try command.parse(&[_][]const u8{ "-f", "-v", "-d", "0.25", "http://example.com/" }, null, arena.allocator(), urls.startUrl)).run, machine);
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    try options.settings(machine, &out.writer);
    try testing.expectEqualStrings("settings: fast, cpus 2, threads 2, concurrency 48 (max 48), delay 0.25s, timeout 10s, pages 1000\n", out.written());
}

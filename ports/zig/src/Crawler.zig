//! Runs a crawl: one thread owns the frontier, the tracker and stdout, so nothing is locked; a fetch only fetches.
const std = @import("std");
const Io = std.Io;
const Frontier = @import("Frontier.zig");
const Output = @import("Output.zig");
const Page = @import("Page.zig");
const Tracker = @import("Tracker.zig");
const workers_lib = @import("workers");
const signals = @import("signals");
const Crawler = @This();

pub const output_buffer_bytes: usize = 256 << 10;

gpa: std.mem.Allocator,
concurrency: usize,
frontier: Frontier,
tracker: Tracker,

/// A crawl from `start` within limits.
pub fn init(gpa: std.mem.Allocator, start: []const u8, concurrency: usize, max_pages: usize) !Crawler {
    return .{ .gpa = gpa, .concurrency = concurrency, .frontier = try .init(gpa, start, max_pages), .tracker = .{ .start = start } };
}

pub fn deinit(self: *Crawler) void {
    self.frontier.deinit();
}

/// Crawls, printing each page to stdout and the summary to stderr; returns the exit code (DESIGN §2). `fetch(context,
/// arena, url)` fetches one page into `arena`; `stdout_file` is stdout's file writer when `stdout` is it.
pub fn crawl(self: *Crawler, io: Io, context: anytype, comptime fetch: fn (@TypeOf(context), std.mem.Allocator, []const u8) Page, stdout: *Io.Writer, stdout_file: ?*Io.File.Writer, stderr: *Io.Writer, sig: anytype) !u8 {
    const begun = Io.Clock.awake.now(io);
    var out: Output = .init(self.gpa, stdout, stdout_file);
    defer out.deinit();
    const Workers = workers_lib.Workers([]const u8, Page, @TypeOf(context), fetch);
    const workers = try Workers.init(self.gpa, io, context, self.concurrency, 256 * 1024);
    defer workers.deinit();
    try self.run(workers, &out, sig);
    out.flush();
    if (!out.failed() and self.tracker.hostIsDead()) try stderr.writeAll("error: host unreachable\n");
    try self.tracker.summary(stderr, @as(f64, @floatFromInt(begun.durationTo(Io.Clock.awake.now(io)).toMilliseconds())) / 1000.0);
    if (out.failed() and out.isPipe()) return sig.exitCodeOr(0);
    if (out.failed()) {
        try stderr.writeAll("error: cannot write output\n");
        return 1;
    }
    if (self.tracker.hostIsDead()) return 1;
    return sig.exitCodeOr(self.tracker.exitCode());
}

fn run(self: *Crawler, workers: anytype, out: *Output, sig: anytype) !void {
    while (true) {
        const active = !sig.received() and !self.tracker.hostIsDead();
        if (active) while (workers.idle() > 0) {
            try workers.submit((try self.frontier.pop()) orelse break);
        };
        if (workers.inFlight() == 0 and (!active or self.frontier.queued() == 0)) return;
        const page = (try workers.take(null)) orelse continue;
        self.tracker.record(page);
        out.write(page);
        if (out.failed()) return;
        if (active) for (page.links) |link| try self.frontier.push(link);
    }
}

const testing = std.testing;
const Allocator = std.mem.Allocator;
const home = "http://example.com/";
/// A queue cap no test reaches.
const roomy = 1 << 30;
const breadth_first =
    \\http://example.com/ 200
    \\http://example.com/a 200
    \\http://example.com/b 200
    \\http://example.com/c 200
    \\http://example.com/d 200
    \\http://example.com/gone 404
    \\
;

/// / links to /a, /b and off the host; /a and /b to /c, which links to /; /d to a 404.
fn site(_: void, arena: Allocator, url: []const u8) Page {
    const site_pages = std.StaticStringMap([]const []const u8).initComptime(.{
        .{ home, &.{ home ++ "a", home ++ "b", "http://other.example/" } },
        .{ home ++ "a", &.{ home ++ "c", home ++ "b" } },
        .{ home ++ "b", &.{ home ++ "c", home ++ "d" } },
        .{ home ++ "c", &.{home} },
        .{ home ++ "d", &.{home ++ "gone"} },
    });
    const found = site_pages.get(url) orelse return .response(url, 404, &.{});
    const copy = arena.alloc([]const u8, found.len) catch @panic("OOM");
    for (copy, found) |*target, source| target.* = arena.dupe(u8, source) catch @panic("OOM");
    return .response(url, 200, copy);
}

/// Home links to 3,000 pages of 100-byte names, which no single chunk holds; every other page is a leaf.
fn wide(_: void, arena: Allocator, url: []const u8) Page {
    if (!std.mem.eql(u8, url, home)) return .response(url, 200, &.{});
    const found = arena.alloc([]const u8, 3000) catch @panic("OOM");
    for (found, 0..) |*link, index| link.* = std.fmt.allocPrint(arena, home ++ "{d}/" ++ "x" ** 100, .{index}) catch @panic("OOM");
    return .response(url, 200, found);
}

const Crawled = struct {
    arena: std.heap.ArenaAllocator,
    stdout: []const u8,
    stderr: []const u8,
    code: u8,

    fn deinit(self: Crawled) void {
        self.arena.deinit();
    }
};

fn crawlHome(comptime fetch: fn (void, Allocator, []const u8) Page, concurrency: usize, max_pages: usize, max_queue_bytes: usize) !Crawled {
    var c: Crawled = undefined;
    c.arena = .init(testing.allocator);
    errdefer c.arena.deinit();
    var stdout: Io.Writer.Allocating = .init(c.arena.allocator());
    var stderr: Io.Writer.Allocating = .init(c.arena.allocator());
    const frontier = try Frontier.withSeen(testing.allocator, home, max_pages, max_queue_bytes, try @import("collections").Hashes.init(testing.allocator, max_pages));
    var crawler: Crawler = .{ .gpa = testing.allocator, .concurrency = concurrency, .frontier = frontier, .tracker = .{ .start = home } };
    defer crawler.deinit();
    c.code = try crawler.crawl(testing.io, {}, fetch, &stdout.writer, null, &stderr.writer, signals);
    c.stdout = stdout.written();
    c.stderr = stderr.written();
    return c;
}

fn sortedLines(arena: Allocator, out: []const u8) ![]const []const u8 {
    var lines: std.ArrayList([]const u8) = .empty;
    var iterator = std.mem.splitScalar(u8, out, '\n');
    while (iterator.next()) |line| try lines.append(arena, line);
    std.mem.sort([]const u8, lines.items, {}, struct {
        fn less(_: void, first: []const u8, second: []const u8) bool {
            return std.mem.order(u8, first, second) == .lt;
        }
    }.less);
    return lines.items;
}

fn pages(out: []const u8) usize {
    return std.mem.count(u8, out, "\n");
}

test "crawl is breadth first in document order" {
    const one = try crawlHome(site, 1, 100, roomy);
    defer one.deinit();
    try testing.expectEqualStrings(breadth_first, one.stdout);
    try testing.expectEqual(0, one.code);
    try testing.expect(std.mem.startsWith(u8, one.stderr, "crawled 6 pages in "));
    try testing.expect(std.mem.endsWith(u8, one.stderr, "s, 0 errors\n")); // a 404 is a page, not an error
    const eight = try crawlHome(site, 8, 100, roomy);
    defer eight.deinit();
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const want = try sortedLines(arena.allocator(), one.stdout);
    const got = try sortedLines(arena.allocator(), eight.stdout);
    try testing.expectEqual(want.len, got.len);
    for (want, got) |wanted, actual| try testing.expectEqualStrings(wanted, actual);
}

test "crawl queues no link past the queue bytes" {
    const crawled = try crawlHome(wide, 1, 10_000, @import("collections").PackedQueue.chunk_bytes);
    defer crawled.deinit();
    const count = pages(crawled.stdout); // one 64 KiB chunk holds about 600 of them
    try testing.expect(count > 500 and count < 700);
}

test "crawl stops when stdout fails" {
    var stdout: Io.Writer = .failing;
    var stderr: Io.Writer.Allocating = .init(testing.allocator);
    defer stderr.deinit();
    var crawler: Crawler = try .init(testing.allocator, home, 8, 100);
    defer crawler.deinit();
    // an error after the summary (DESIGN §2), and no fetch left behind
    try testing.expectEqual(1, try crawler.crawl(testing.io, {}, site, &stdout, null, &stderr.writer, signals));
    try testing.expect(std.mem.endsWith(u8, stderr.written(), "error: cannot write output\n"));
}

test "crawl reports a failed last flush" {
    const FailsAfterFirst = struct {
        wrote: bool = false,
        writer: Io.Writer,

        fn init(buffer: []u8) @This() {
            return .{
                .writer = .{
                    .vtable = &.{
                        .drain = drain,
                        .sendFile = Io.Writer.failingSendFile,
                        .rebase = Io.Writer.failingRebase,
                    },
                    .buffer = buffer,
                },
            };
        }

        fn drain(w: *Io.Writer, data: []const []const u8, splat: usize) Io.Writer.Error!usize {
            const self: *@This() = @alignCast(@fieldParentPtr("writer", w));
            if (self.wrote) return error.WriteFailed;
            self.wrote = true;
            w.end = 0;
            const slice = data[0 .. data.len - 1];
            const pattern = data[slice.len];
            var written: usize = pattern.len * splat;
            for (slice) |bytes| written += bytes.len;
            return written;
        }
    };

    var buf: [output_buffer_bytes]u8 = undefined;
    var sink: FailsAfterFirst = .init(&buf);
    var stderr: Io.Writer.Allocating = .init(testing.allocator);
    defer stderr.deinit();
    var crawler: Crawler = try .init(testing.allocator, home, 1, 100);
    defer crawler.deinit();
    const code = try crawler.crawl(testing.io, {}, site, &sink.writer, null, &stderr.writer, signals);
    try testing.expectEqual(1, code);
    try testing.expect(std.mem.endsWith(u8, stderr.written(), "error: cannot write output\n"));
}

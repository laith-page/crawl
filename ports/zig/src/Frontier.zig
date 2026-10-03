//! The URLs still to fetch: the queue, the seen set, and the page and memory budgets they are held to (DESIGN §2, §3).
const std = @import("std");
const Hashes = @import("collections").Hashes;
const PackedQueue = @import("collections").PackedQueue;
const href = @import("whatwg-url").href;
const urls = @import("urls.zig");
const Frontier = @This();

pub const max_queue_bytes: usize = 128 << 20;

host: []const u8,
max_pages: usize,
seen: Hashes,
queue: PackedQueue,
popped_buf: [urls.max_bytes]u8 = undefined,
popped: usize = 0,

pub fn init(gpa: std.mem.Allocator, start: []const u8, max_pages: usize) !Frontier {
    return withSeen(gpa, start, max_pages, max_queue_bytes, try Hashes.init(gpa, max_pages));
}

pub fn withSeen(gpa: std.mem.Allocator, start: []const u8, max_pages: usize, queue_bytes: usize, seen: Hashes) !Frontier {
    var frontier: Frontier = .{
        .host = href.host(start),
        .max_pages = max_pages,
        .seen = seen,
        .queue = PackedQueue.initWithBudget(gpa, href.origin(start), queue_bytes),
    };
    errdefer frontier.deinit();
    _ = frontier.seen.insert(hash(start));
    _ = try frontier.queue.push(start);
    return frontier;
}

pub fn deinit(self: *Frontier) void {
    self.seen.deinit(self.queue.allocator);
    self.queue.deinit();
}

pub fn pop(self: *Frontier) !?[]const u8 {
    if (self.queue.size() == 0 or self.popped >= self.max_pages) return null;
    self.popped += 1;
    var fba: std.heap.FixedBufferAllocator = .init(&self.popped_buf);
    return self.queue.pop(fba.allocator());
}

pub fn push(self: *Frontier, link: []const u8) !void {
    if (!href.hostEquals(link, self.host)) return;
    if (self.popped + self.queue.size() >= self.max_pages) return;
    const url_hash = hash(link);
    if (self.seen.contains(url_hash) or self.seen.full()) return;
    if (try self.queue.push(link)) _ = self.seen.insert(url_hash);
}

pub fn queued(self: *const Frontier) usize {
    return self.queue.size();
}

fn hash(url: []const u8) u64 {
    return std.hash.Wyhash.hash(0, url);
}

const testing = std.testing;
const home = "http://example.com/";
/// A queue cap no test reaches.
const roomy = 1 << 30;

test "push drops a link the full seen set refuses" {
    const seen = try Hashes.init(testing.allocator, 0); // 1,024 slots, full at 768
    var frontier = try withSeen(testing.allocator, home, 1_000_000, roomy, seen);
    defer frontier.deinit();
    var buf: [64]u8 = undefined;
    for (0..1000) |index| try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}", .{index}));
    // The start URL and 767 links: the rest are neither remembered nor queued.
    try testing.expectEqual(768, frontier.seen.size());
    try testing.expectEqual(768, frontier.queued());
}

test "push remembers no link the queue turns away" {
    const seen = try Hashes.init(testing.allocator, 1_000_000);
    var frontier = try withSeen(testing.allocator, home, 1_000_000, 2 * PackedQueue.chunk_bytes, seen);
    defer frontier.deinit();
    var buf: [2100]u8 = undefined;
    const name = "x" ** 2000;
    for (0..200) |index| try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}-" ++ name, .{index}));
    const held = frontier.queued();
    try testing.expect(held >= 60 and held <= 70);
    for (0..10) |_| _ = try frontier.pop();
    try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}-" ++ name, .{199})); // turned away before, so not remembered
    try testing.expectEqual(frontier.queued() + 10, frontier.seen.size());
}

test "push keeps only links on the start host" {
    const seen = try Hashes.init(testing.allocator, 100);
    var frontier = try withSeen(testing.allocator, home, 100, roomy, seen);
    defer frontier.deinit();
    // The start origin as a prefix, another host.
    for ([_][]const u8{ "http://example.com.evil.test/", "http://example.com@evil.test/", "http://other.test/" }) |other| {
        try frontier.push(other);
    }
    try testing.expectEqual(1, frontier.queued());
    for ([_][]const u8{ "http://example.com:8080/", "https://example.com/a", home ++ "b" }) |same| try frontier.push(same);
    try testing.expectEqual(4, frontier.queued());
}

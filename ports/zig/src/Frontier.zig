//! The URLs still to fetch: the queue, the seen set, and the page and memory budgets they are held to (DESIGN §2, §3).
const std = @import("std");
const collections = @import("collections");
const UniqueQueue = collections.UniqueQueue;
const PackedQueue = collections.PackedQueue;
const hashing = @import("hashing");
const href = @import("whatwg-url").href;
const urls = @import("urls.zig");
const Frontier = @This();

pub const max_queue_bytes: usize = 128 << 20;

host: []const u8,
max_pages: usize,
seed: u64,
queue: UniqueQueue,
popped: usize = 0,

pub fn init(gpa: std.mem.Allocator, start: []const u8, max_pages: usize, seed: u64) !Frontier {
    const queue = try UniqueQueue.init(gpa, href.authorityPrefix(start), max_pages, max_queue_bytes);
    return withQueue(start, max_pages, queue, seed);
}

pub fn withQueue(start: []const u8, max_pages: usize, queue: UniqueQueue, seed: u64) !Frontier {
    var frontier: Frontier = .{
        .host = href.host(start),
        .max_pages = max_pages,
        .seed = seed,
        .queue = queue,
    };
    errdefer frontier.deinit();
    _ = try frontier.queue.offer(frontier.hash(start), start);
    return frontier;
}

pub fn deinit(self: *Frontier) void {
    self.queue.deinit();
}

pub fn pop(self: *Frontier) !?[]const u8 {
    if (self.queue.size() == 0 or self.popped >= self.max_pages) return null;
    self.popped += 1;
    return self.queue.pop();
}

pub fn push(self: *Frontier, link: []const u8) !void {
    if (!href.hostEquals(link, self.host)) return;
    if (self.popped + self.queue.size() >= self.max_pages) return;
    _ = try self.queue.offer(self.hash(link), link);
}

pub fn queued(self: *const Frontier) usize {
    return self.queue.size();
}

fn hash(self: *const Frontier, url: []const u8) u64 {
    return hashing.Xxh3.hash(self.seed, url);
}

const testing = std.testing;
const home = "http://example.com/";
/// A queue cap no test reaches.
const roomy = 1 << 30;

test "push drops a link the full seen set refuses" {
    const queue = try UniqueQueue.init(testing.allocator, href.authorityPrefix(home), 0, roomy); // 1,024 slots, full at 768
    var frontier = try withQueue(home, 1_000_000, queue, 0);
    defer frontier.deinit();
    var buf: [64]u8 = undefined;
    for (0..1000) |index| try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}", .{index}));
    // The start URL and 767 links: the rest are neither remembered nor queued.
    try testing.expectEqual(768, frontier.queue.seen());
    try testing.expectEqual(768, frontier.queued());
}

test "push remembers no link the queue turns away" {
    const queue = try UniqueQueue.init(testing.allocator, href.authorityPrefix(home), 1_000_000, 2 * PackedQueue.chunk_bytes);
    var frontier = try withQueue(home, 1_000_000, queue, 0);
    defer frontier.deinit();
    var buf: [2100]u8 = undefined;
    const name = "x" ** 2000;
    for (0..200) |index| try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}-" ++ name, .{index}));
    const held = frontier.queued();
    try testing.expect(held >= 60 and held <= 70);
    for (0..10) |_| _ = try frontier.pop();
    try frontier.push(try std.fmt.bufPrint(&buf, home ++ "{d}-" ++ name, .{199})); // turned away before, so not remembered
    try testing.expectEqual(frontier.queued() + 10, frontier.queue.seen());
}

test "push keeps only links on the start host" {
    const queue = try UniqueQueue.init(testing.allocator, href.authorityPrefix(home), 100, roomy);
    var frontier = try withQueue(home, 100, queue, 0);
    defer frontier.deinit();
    // The start origin as a prefix, another host.
    for ([_][]const u8{ "http://example.com.evil.test/", "http://example.com@evil.test/", "http://other.test/" }) |other| {
        try frontier.push(other);
    }
    try testing.expectEqual(1, frontier.queued());
    for ([_][]const u8{ "http://example.com:8080/", "https://example.com/a", home ++ "b" }) |same| try frontier.push(same);
    try testing.expectEqual(4, frontier.queued());
}

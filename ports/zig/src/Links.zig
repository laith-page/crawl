//! The links of one page, found while its HTML streams in.
const Links = @This();
const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;
const urls = @import("urls.zig");
const Hrefs = @import("html").Hrefs;
const whatwg_url = @import("whatwg-url");

pub const max_links = 1000;
pub const max_link_bytes = 256 << 10;

arena: Allocator,
base: Base,
hrefs: Hrefs = .empty,
scratch: std.heap.ArenaAllocator,
/// In document order, each once: std's array hash map scans its few first keys, and indexes the rest.
found: std.StringArrayHashMapUnmanaged(void) = .empty,
bytes: usize = 0,
done: bool = false,

pub fn init(arena: Allocator, page: []const u8) Links {
    return .{ .arena = arena, .base = .init(arena, page), .scratch = .init(arena) };
}

pub fn deinit(links: *Links) void {
    links.hrefs.deinit(links.arena);
    links.scratch.deinit();
    links.base.deinit();
}

/// Scans the next bytes of the page.
pub fn feed(links: *Links, chunk: []const u8) !void {
    if (links.done) return;
    try links.hrefs.feed(links.arena, chunk);
    try links.collect();
}

/// The links found, in document order, once the whole body is fed.
pub fn end(links: *Links) ![]const []const u8 {
    if (!links.done) {
        links.hrefs.end();
        try links.collect();
    }
    return links.found.keys();
}

fn collect(links: *Links) !void {
    while (!links.done) {
        _ = links.scratch.reset(.retain_capacity);
        const scratch = links.scratch.allocator();
        const href = (try links.hrefs.next(links.arena)) orelse return;
        const candidate = (try urls.resolveAgainst(scratch, &links.base, href)) orelse continue;
        const entry = try links.found.getOrPut(links.arena, candidate);
        if (entry.found_existing) continue;
        // Counted as bytes: links in the form are ASCII (urls.crawlable).
        if (links.bytes + candidate.len > max_link_bytes) {
            _ = links.found.pop();
            links.done = true;
            return;
        }
        entry.key_ptr.* = try links.arena.dupe(u8, candidate);
        links.bytes += candidate.len;
        links.done = links.found.count() == max_links;
    }
}

fn extract(arena: Allocator, html: []const u8, page: []const u8) ![]const []const u8 {
    var links: Links = .init(arena, page);
    defer links.deinit();
    try links.feed(html);
    return links.end();
}

const Base = whatwg_url.href.Base;

const testing = std.testing;

test "a decoded href remains valid across scratch resets and feed chunks" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var links: Links = .init(arena, "http://example.com/");
    defer links.deinit();
    try links.feed("<a href=/a&amp;b><!--");
    try links.feed("--><a href=/c>");
    const found = try links.end();
    try testing.expectEqual(2, found.len);
    try testing.expectEqualStrings("http://example.com/a&b", found[0]);
    try testing.expectEqualStrings("http://example.com/c", found[1]);
}

test "a byte at a time finds the same links" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const page = "http://example.com/";
    const document = "<a href=/a&amp;b><!-- hidden <a href=/no> --><a href=/c>";
    const whole = try extract(arena, document, page);
    var streamed: Links = .init(arena, page);
    defer streamed.deinit();
    for (document, 0..) |_, at| try streamed.feed(document[at .. at + 1]);
    const pieces = try streamed.end();
    try testing.expectEqual(whole.len, pieces.len);
    for (whole, pieces) |want, got| try testing.expectEqualStrings(want, got);

    var boundary: Links = .init(arena, page);
    defer boundary.deinit();
    const plain = try arena.alloc(u8, (64 << 10) - 2);
    @memset(plain, 'x');
    try boundary.feed(plain);
    try boundary.feed("<a");
    try boundary.feed(" href='/large'>");
    const crossed = try boundary.end();
    try testing.expectEqual(1, crossed.len);
    try testing.expectEqualStrings("http://example.com/large", crossed[0]);
}

// The set finds a repeat as a scan does: first seen first kept, up to max_links distinct.
test "extract keeps each link once in document order" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const page = "http://example.com/d/";
    var html: std.ArrayList(u8) = .empty;
    var want: std.ArrayList([]const u8) = .empty;
    for (0..1500) |i| {
        var buf: [3][32]u8 = undefined;
        const hrefs = [_][]const u8{
            try std.fmt.bufPrint(&buf[0], "/{d}", .{i % 7}),
            try std.fmt.bufPrint(&buf[1], "x{d}", .{i}),
            try std.fmt.bufPrint(&buf[2], "/{d}", .{i / 2}),
        };
        for (hrefs) |href| {
            try html.print(arena, "<a href=\"{s}\">", .{href});
            var base: Base = .init(arena, page);
            defer base.deinit();
            const url = (try urls.resolveAgainst(arena, &base, href)).?;
            var found = false;
            for (want.items) |w| found = found or mem.eql(u8, w, url);
            if (want.items.len < max_links and !found) try want.append(arena, try arena.dupe(u8, url));
        }
    }
    const got = try extract(arena, html.items, page);
    try testing.expectEqual(max_links, want.items.len);
    try testing.expectEqual(want.items.len, got.len);
    for (want.items, got) |w, g| try testing.expectEqualStrings(w, g);
}

// A simple path joined past 8,000 bytes is no link.
test "a joined link past the byte limit is no link" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const page = "http://example.com/d/";
    const rooted = "/" ++ "r" ** (urls.max_bytes - "http://example.com/".len);
    const relative = "l" ** (urls.max_bytes - page.len);
    const html = "<a href=" ++ rooted ++ "><a href=" ++ rooted ++ "r><a href=" ++ relative ++ "><a href=" ++ relative ++ "l>";
    const found = try extract(arena, html, page);
    try testing.expectEqual(2, found.len);
    try testing.expectEqualStrings("http://example.com" ++ rooted, found[0]);
    try testing.expectEqualStrings(page ++ relative, found[1]);
}

// Every prefix of a document of every construct, and 20,000 of random pieces: links in the form, printable.
test "extract returns only printable links" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const page = "http://example.com/dir/page";
    const doc =
        \\<html><head><base href="/b/"><title><a href="/t"></title><style>a{}</style></head><body>
        \\<!-- <a href="/c"> --><script>'<a href="/s">'</script><a title='x>y' href="q?a=1&amp;b=&#x32;">
        \\<a HREF=/u>u</a><textarea><a href=/ta></textarea><a href="https://other.example#f">o</a>
    ;
    for (0..doc.len + 1) |n| try expectPrintable(arena_state.allocator(), doc[0..n], page);
    const pieces = [_][]const u8{ "<a href=", "<A HREF='", "<base href=\"", "\"", "'", ">", "<", "/", " ", "\n", "\x00", "&amp;", "&#x", "&#", ";", "<!--", "-->", "<script>", "</script", "<title", "</textarea>", "http://", "https://h/", "//", "?", "#", "..", "%", "[", "]", ":", "@", "=", "\\", "\xe9", "\xc3\xa9", "^", "{" };
    var prng: std.Random.DefaultPrng = .init(0x5eed);
    const random = prng.random();
    var buf: [512]u8 = undefined;
    for (0..20_000) |_| {
        var len: usize = 0;
        while (len < buf.len - 16) {
            const byte = [1]u8{random.int(u8)};
            const piece = if (random.boolean()) pieces[random.uintLessThan(usize, pieces.len)] else &byte;
            @memcpy(buf[len..][0..piece.len], piece);
            len += piece.len;
            if (random.uintLessThan(u8, 64) == 0) break;
        }
        _ = arena_state.reset(.retain_capacity);
        try expectPrintable(arena_state.allocator(), buf[0..len], page);
    }
}

fn expectPrintable(arena: Allocator, html: []const u8, page: []const u8) !void {
    const found = try extract(arena, html, page);
    try testing.expect(found.len <= max_links);
    for (found) |url| {
        try testing.expect(mem.startsWith(u8, url, "http://") or mem.startsWith(u8, url, "https://"));
        try testing.expect(url.len <= urls.max_bytes);
        for (url) |char| try testing.expect(char > ' ' and char < 0x7f);
    }
}

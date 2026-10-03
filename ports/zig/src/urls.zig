//! The URL form (DESIGN §4): the WHATWG URL Standard, parsed by the whatwg-url package, and the crawler's own rules on
//! top: http and https only, no userinfo, no fragment, 8,000 bytes at most. e2e/urls.json holds it to that, row for
//! row.
const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;
const whatwg_url = @import("whatwg-url");

pub const Url = whatwg_url.Url;

pub const max_bytes = 8000; // RFC 9110 §4.1's 8,000 octets, the request-line length every server supports at a minimum

pub fn startUrl(arena: Allocator, url: []const u8) error{OutOfMemory}!?[]const u8 {
    return inForm(try whatwg_url.parse(arena, url, null) orelse return null);
}

pub fn resolve(arena: Allocator, base: []const u8, ref: []const u8) error{OutOfMemory}!?[]const u8 {
    return inForm(try whatwg_url.parse(arena, ref, &(try whatwg_url.parse(arena, base, null) orelse return null)) orelse return null);
}

pub fn resolveOn(arena: Allocator, page: *whatwg_url.href.Base, ref: []const u8) error{OutOfMemory}!?[]const u8 {
    return inForm(try page.join(arena, ref) orelse return null);
}

pub fn inForm(url: Url) ?[]const u8 {
    if (url.scheme != .http and url.scheme != .https or url.scheme_end + 3 != url.host_start) return null;
    const href = url.href()[0 .. url.fragment_start orelse url.len];
    return if (href.len > max_bytes) null else href;
}

const testing = std.testing;

const corpus_file = "e2e/urls.json";

/// A row of e2e/urls.json: the page (null for the command line), the href, the URL wanted (null for no link).
const Row = struct { base: ?[]const u8, href: []const u8, want: ?[]const u8, note: ?[]const u8 = null };

/// e2e/urls.json's rows.
fn corpus(arena: Allocator) ![]Row {
    const io = testing.io;
    const text = std.Io.Dir.cwd().readFileAlloc(io, "../../" ++ corpus_file, arena, .limited(1 << 20)) catch
        try std.Io.Dir.cwd().readFileAlloc(io, corpus_file, arena, .limited(1 << 20));
    return std.json.parseFromSliceLeaky([]Row, arena, text, .{});
}

test "resolves every row of the corpus as the form says" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const rows = try corpus(arena);
    try testing.expect(rows.len > 100);
    var wrong: usize = 0;
    for (rows) |row| {
        const got = if (row.base) |base| try resolve(arena, base, row.href) else try startUrl(arena, row.href);
        const same = if (row.want) |want| (got != null and mem.eql(u8, want, got.?)) else got == null;
        if (!same) {
            wrong += 1;
            std.debug.print("{?s} + \"{f}\": want {?s}, got {?s}\n", .{ row.base, std.ascii.hexEscape(row.href, .lower), row.want, got });
        }
    }
    try testing.expectEqual(0, wrong);
}

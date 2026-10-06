const std = @import("std");
const Page = @import("Page.zig");
const Tracker = @This();

const dead_host_threshold = 5;

start: []const u8,
crawled: usize = 0,
errors: usize = 0,
unreachable_in_a_row: usize = 0,
start_failed: bool = false,

pub fn record(self: *Tracker, page: Page) void {
    self.crawled += 1;
    if (page.isFailure()) self.errors += 1;
    self.start_failed = self.start_failed or (std.mem.eql(u8, page.url, self.start) and (page.isFailure() or (page.status orelse 0) >= 400));
    self.unreachable_in_a_row = if (page.@"unreachable"()) self.unreachable_in_a_row + 1 else 0;
}

pub fn hostIsDead(self: *const Tracker) bool {
    return self.unreachable_in_a_row >= dead_host_threshold;
}
pub fn exitCode(self: *const Tracker) u8 {
    return @intFromBool(self.start_failed);
}

pub fn summary(self: *const Tracker, w: *std.Io.Writer, seconds: f64) !void {
    try w.print("crawled {d} pages in {d:.2}s, {d} errors\n", .{ self.crawled, seconds, self.errors });
}

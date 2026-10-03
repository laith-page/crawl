const std = @import("std");
const Failure = @import("failure.zig").Failure;
const Page = @This();

url: []const u8,
status: ?u16 = null,
failure: ?Failure = null,
links: []const []const u8 = &.{},

pub fn response(url: []const u8, status: u16, links: []const []const u8) Page {
    return .{ .url = url, .status = status, .links = links };
}
pub fn failed(url: []const u8, status: ?u16, failure: Failure) Page {
    return .{ .url = url, .status = if (failure.hidesStatus()) null else status, .failure = failure };
}
pub fn isFailure(self: Page) bool {
    return self.failure != null;
}
pub fn @"unreachable"(self: Page) bool {
    return if (self.failure) |f| f.isUnreachable() else false;
}

pub fn writeTo(self: Page, w: *std.Io.Writer) !void {
    try w.writeAll(self.url);
    if (self.status) |s| try w.print(" {d}", .{s});
    if (self.failure) |f| try w.print(" error: {s}", .{f.label()});
    try w.writeByte('\n');
}

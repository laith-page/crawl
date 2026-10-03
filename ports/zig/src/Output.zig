//! Pages to stdout through a bounded block buffer.
const std = @import("std");
const Io = std.Io;
const Page = @import("Page.zig");
const Output = @This();

out: *Io.Writer,
/// stdout's file writer when `out` is it: what tells a pipe its reader closed from a failed write.
file: ?*Io.File.Writer,
block: Io.Writer.Allocating,
flushed: bool = false,
broken: bool = false,

pub fn init(gpa: std.mem.Allocator, out: *Io.Writer, file: ?*Io.File.Writer) Output {
    return .{ .out = out, .file = file, .block = .init(gpa) };
}
pub fn deinit(self: *Output) void {
    self.block.deinit();
}

pub fn write(self: *Output, page: Page) void {
    if (self.broken) return;
    self.block.clearRetainingCapacity();
    self.broken = blk: {
        page.writeTo(&self.block.writer) catch break :blk true;
        const bytes = self.block.written();
        if (bytes.len > self.out.unusedCapacitySlice().len) self.out.flush() catch break :blk true;
        self.out.writeAll(bytes) catch break :blk true;
        break :blk false;
    };
    if (!self.flushed) self.flush();
}

pub fn flush(self: *Output) void {
    self.flushed = true;
    if (!self.broken) self.out.flush() catch {
        self.broken = true;
    };
}

pub fn failed(self: *const Output) bool {
    return self.broken;
}

pub fn isPipe(self: *const Output) bool {
    const file = self.file orelse return false;
    if (file.err) |err| if (err == error.BrokenPipe or err == error.ConnectionResetByPeer) return true;
    const stat = file.file.stat(file.io) catch return false;
    return stat.kind == .named_pipe or stat.kind == .unix_domain_socket;
}

//! Sizing for this machine: CPUs, runtime threads and the max concurrency they can keep in flight.
const std = @import("std");
const builtin = @import("builtin");
const Options = @import("Options.zig");
const Machine = @This();

/// Fetches in flight a thread keeps up with: the knee of bench's concurrency sweep.
pub const pages_in_flight_per_thread = 24;

cpus: usize,
threads: usize,
max_concurrency: usize,

pub fn detect(override_cpus: usize) Machine {
    const cpus = if (override_cpus > 0) override_cpus else blk: {
        const quota = readCpuMax();
        const available = std.Thread.getCpuCount() catch 1;
        break :blk if (quota) |quota_limit| @min(available, quota_limit) else available;
    };
    const threads = if (cpus <= 2) cpus else cpus - 1;
    return .{ .cpus = cpus, .threads = threads, .max_concurrency = @min(Options.max_concurrency, pages_in_flight_per_thread * threads) };
}

fn readCpuMax() ?usize {
    if (builtin.os.tag != .linux) return null;
    const cgroup_file = std.posix.openat(std.posix.AT.FDCWD, "/proc/self/cgroup", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch return null;
    defer _ = std.os.linux.close(cgroup_file);
    var cgroup_buf: [4096]u8 = undefined;
    const cgroup_bytes = std.posix.read(cgroup_file, &cgroup_buf) catch return null;
    var lines = std.mem.splitScalar(u8, cgroup_buf[0..cgroup_bytes], '\n');
    const group = while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "0::/")) break line[3..];
    } else return null;
    var path_buf: [8192]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "/sys/fs/cgroup{s}/cpu.max", .{group}) catch return null;
    const file = std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch return null;
    defer _ = std.os.linux.close(file);
    var buf: [64]u8 = undefined;
    const bytes_read = std.posix.read(file, &buf) catch return null;
    var tokens = std.mem.tokenizeScalar(u8, std.mem.trim(u8, buf[0..bytes_read], " \t\r\n"), ' ');
    const quota_str = tokens.next() orelse return null;
    const period_str = tokens.next() orelse return null;
    if (std.mem.eql(u8, quota_str, "max")) return null;
    const quota = std.fmt.parseInt(usize, quota_str, 10) catch return null;
    const period = std.fmt.parseInt(usize, period_str, 10) catch return null;
    return if (period > 0) @divFloor(quota + period - 1, period) else null;
}

const testing = std.testing;

test "cpus overrides" {
    const machine = Machine.detect(4);
    try testing.expectEqual(4, machine.cpus);
    try testing.expectEqual(3, machine.threads);
    try testing.expectEqual(72, machine.max_concurrency);
}

test "derives threads and max concurrency" {
    const machine_8 = Machine.detect(8);
    try testing.expectEqual(8, machine_8.cpus);
    try testing.expectEqual(7, machine_8.threads);
    try testing.expectEqual(168, machine_8.max_concurrency);

    const machine_2 = Machine.detect(2);
    try testing.expectEqual(2, machine_2.cpus);
    try testing.expectEqual(2, machine_2.threads);
    try testing.expectEqual(48, machine_2.max_concurrency);

    const machine_1 = Machine.detect(1);
    try testing.expectEqual(1, machine_1.cpus);
    try testing.expectEqual(1, machine_1.threads);
    try testing.expectEqual(24, machine_1.max_concurrency);
}

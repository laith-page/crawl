//! Shared start time for requests: a delay after each start, extended by a retry pause.
const std = @import("std");
const Io = std.Io;
const Throttle = @This();

delay_nanos: u64,
mutex: Io.Mutex = .init,
next_start: u64 = 0,
shared_retries: bool = true,

pub fn init(delay_millis: u32, shared_retries: bool) Throttle {
    return .{
        .delay_nanos = @as(u64, delay_millis) * std.time.ns_per_ms,
        .shared_retries = shared_retries,
    };
}

/// Reserves the next request start; with a deadline, waits only while this request still has time.
pub fn start(self: *Throttle, io: Io, deadline: ?Io.Clock.Timestamp) bool {
    if (!self.shared_retries and self.delay_nanos == 0) return true;
    while (true) {
        if (deadline) |limit| if (limit.durationFromNow(io).raw.nanoseconds <= 0) return false;
        const now: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
        self.mutex.lockUncancelable(io);
        const wait = self.next_start -| now;
        if (wait == 0) {
            self.next_start = now + self.delay_nanos;
            self.mutex.unlock(io);
            return true;
        }
        self.mutex.unlock(io);
        if (deadline) |limit| {
            const remaining = limit.durationFromNow(io).raw.nanoseconds;
            if (remaining <= 0 or @as(u64, @intCast(remaining)) <= wait) return false;
        }
        io.sleep(.{ .nanoseconds = @intCast(wait) }, .awake) catch return false;
    }
}

/// A retry pushes the next shared start later, without shortening an existing wait.
pub fn pause(self: *Throttle, io: Io, wait: u64) void {
    const now: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
    self.mutex.lockUncancelable(io);
    defer self.mutex.unlock(io);
    self.next_start = @max(self.next_start, now + wait);
}

pub fn retry(self: *Throttle, io: Io, wait: u64, deadline: Io.Clock.Timestamp) bool {
    if (self.shared_retries) {
        self.pause(io, wait);
        return self.start(io, deadline);
    } else {
        const remaining = deadline.durationFromNow(io).raw.nanoseconds;
        if (remaining <= 0 or @as(u64, @intCast(remaining)) <= wait) return false;
        io.sleep(.{ .nanoseconds = @intCast(wait) }, .awake) catch return false;
        return true;
    }
}

const testing = std.testing;

test "concurrent requests span two delays" {
    const Worker = struct {
        fn run(throttle: *Throttle, io: Io, count: *std.atomic.Value(usize), last: *std.atomic.Value(u64)) void {
            const deadline = Io.Clock.Timestamp.fromNow(io, .{ .raw = Io.Duration.fromSeconds(10), .clock = .awake });
            if (!throttle.start(io, deadline)) return;
            const now: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
            _ = count.fetchAdd(1, .monotonic);
            _ = last.fetchMax(now, .monotonic);
        }
    };
    const io = testing.io;
    var throttle: Throttle = .init(20, true);
    var count: std.atomic.Value(usize) = .init(0);
    var last: std.atomic.Value(u64) = .init(0);
    const begun: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
    var tasks: [3]Io.Future(void) = undefined;
    for (&tasks) |*task| task.* = try io.concurrent(Worker.run, .{ &throttle, io, &count, &last });
    for (&tasks) |*task| task.await(io);
    try testing.expectEqual(3, count.load(.monotonic));
    try testing.expect(last.load(.monotonic) - begun >= 40 * std.time.ns_per_ms);
}

test "retry pause delays next request" {
    const io = testing.io;
    var throttle: Throttle = .init(0, true);
    const deadline = Io.Clock.Timestamp.fromNow(io, .{ .raw = Io.Duration.fromSeconds(10), .clock = .awake });
    try testing.expect(throttle.start(io, deadline));
    const begun: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
    throttle.pause(io, 20 * std.time.ns_per_ms);
    try testing.expect(throttle.start(io, deadline));
    const ended: u64 = @intCast(@max(0, Io.Clock.awake.now(io).nanoseconds));
    try testing.expect(ended - begun >= 20 * std.time.ns_per_ms);
}

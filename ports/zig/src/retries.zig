const std = @import("std");
const Io = std.Io;

const Failure = @import("failure.zig").Failure;

pub const max_retries = 4;
const first_backoff_millis = 250;

pub fn retryable(status: u16) bool {
    return status == 0 or status == 408 or status == 429 or (status >= 502 and status <= 504);
}

/// Nanoseconds before another attempt after a response, or null when this status is final or retries are exhausted.
pub fn afterStatus(io: Io, status: u16, retry_after_seconds: ?u64, retries: u32) ?u64 {
    if (retries >= max_retries or !retryable(status)) return null;
    if (retry_after_seconds) |seconds| {
        return std.math.mul(u64, seconds, std.time.ns_per_s) catch std.math.maxInt(u64);
    }
    return backoff(io, retries);
}

/// Nanoseconds before another attempt after a failure, or null when this failure is final or retries are exhausted.
pub fn afterFailure(io: Io, kind: Failure, status: u16, retries: u32) ?u64 {
    if (retries >= max_retries or kind == .timeout or !retryable(status)) return null;
    return backoff(io, retries);
}

fn backoff(io: Io, retries: u32) u64 {
    var bytes: [8]u8 = undefined;
    io.random(&bytes);
    return std.mem.readInt(u64, &bytes, .little) % ((@as(u64, first_backoff_millis) * std.time.ns_per_ms) << @intCast(retries));
}

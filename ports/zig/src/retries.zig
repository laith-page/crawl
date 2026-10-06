const std = @import("std");
const Io = std.Io;
const pacing = @import("pacing");

const Failure = @import("failure.zig").Failure;

pub const max_retries = 4;
const first_backoff = Io.Duration.fromMilliseconds(250);

fn retryable(status: u16) bool {
    return status == 408 or status == 429 or (status >= 502 and status <= 504);
}

/// Duration before another attempt after a response, or null when this status is final or retries are exhausted.
pub fn afterStatus(io: Io, status: u16, retry_after: ?Io.Duration, retries: u32) ?Io.Duration {
    if (retries >= max_retries or !retryable(status)) return null;
    if (retry_after) |d| return d;
    return backoff(io, retries);
}

/// Duration before another attempt after a failure, or null when this failure is final or retries are exhausted.
pub fn afterFailure(io: Io, kind: Failure, retries: u32) ?Io.Duration {
    if (retries >= max_retries or kind == .timeout) return null;
    return backoff(io, retries);
}

fn backoff(io: Io, retries: u32) Io.Duration {
    return pacing.fullJitter(io, first_backoff, retries);
}

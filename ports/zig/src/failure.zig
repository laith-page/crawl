//! Why a fetch failed: the error categories of DESIGN §1, each printed as its label.

const http = @import("http");

pub const Failure = enum {
    timeout,
    dns_failed,
    connect_failed,
    tls_failed,
    body_over_limit,
    connection_reset,
    malformed_response,

    /// What the contract prints after `error: `, the same words in every engine.
    pub fn label(self: Failure) []const u8 {
        return switch (self) {
            .timeout => "timeout",
            .dns_failed => "dns failed",
            .connect_failed => "connect failed",
            .tls_failed => "tls failed",
            .body_over_limit => "body over 5 MiB",
            .connection_reset => "connection reset",
            .malformed_response => "malformed response",
        };
    }

    /// Whether the host is out of reach: what the dead-host counter counts (DESIGN §5).
    pub fn isUnreachable(self: Failure) bool {
        return self == .connect_failed or self == .dns_failed;
    }

    /// Whether the page prints no status: a timed-out or malformed response (DESIGN §1).
    pub fn hidesStatus(self: Failure) bool {
        return self == .timeout or self == .malformed_response;
    }

    pub fn of(kind: http.Kind) Failure {
        return switch (kind) {
            .timeout, .interrupted => .timeout,
            .dns => .dns_failed,
            .connect => .connect_failed,
            .tls => .tls_failed,
            .body_limit => .body_over_limit,
            .reset => .connection_reset,
            .malformed, .other => .malformed_response,
        };
    }
};

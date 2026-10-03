//! Why a fetch failed: the error categories of DESIGN §1, each printed as its label.

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

    /// The one table from std's and the OS's errors to the contract's categories. `timeout` is `Fetcher.fetch`'s,
    /// which masks what the cancelled attempt failed with; a connection closed, reset or cut short, and anything
    /// unforeseen, is `connection_reset`.
    pub fn of(err: anyerror) Failure {
        return switch (err) {
            error.ConnectionRefused, error.HostUnreachable, error.NetworkUnreachable, error.NetworkDown => .connect_failed,
            error.UnknownHostName,
            error.NameServerFailure,
            error.NoAddressReturned,
            error.InvalidDnsARecord,
            error.InvalidDnsAAAARecord,
            error.InvalidDnsCnameRecord,
            error.ResolvConfParseFailed,
            error.DetectingNetworkConfigurationFailed,
            => .dns_failed,
            // std folds every handshake failure into the first: untrusted, another name, a reset.
            error.TlsInitializationFailed, error.CertificateBundleLoadFailure => .tls_failed,
            // std folds every head its parser refuses into the first.
            error.HttpHeadersInvalid, error.HttpHeadersOversize, error.HttpChunkInvalid, error.ProtocolError => .malformed_response,
            error.StreamTooLong => .body_over_limit,
            else => .connection_reset,
        };
    }
};

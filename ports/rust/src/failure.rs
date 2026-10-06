//! Why a fetch failed: the error categories of DESIGN §1, each printed as its label.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Timeout,
    DnsFailed,
    ConnectFailed,
    TlsFailed,
    BodyOverLimit,
    ConnectionReset,
    MalformedResponse,
}

impl Failure {
    /// What the contract prints after `error: `, the same words in every engine.
    pub fn label(self) -> &'static str {
        [
            "timeout",
            "dns failed",
            "connect failed",
            "tls failed",
            "body over 5 MiB",
            "connection reset",
            "malformed response",
        ][self as usize]
    }

    /// Whether the host is out of reach: what the dead-host counter counts (DESIGN §5).
    pub fn is_unreachable(self) -> bool {
        matches!(self, Self::ConnectFailed | Self::DnsFailed)
    }

    /// Whether the page prints no status: a timed-out or malformed response (DESIGN §1).
    pub fn hides_status(self) -> bool {
        matches!(self, Self::Timeout | Self::MalformedResponse)
    }

    pub fn of(kind: http_client::Kind) -> Self {
        match kind {
            http_client::Kind::Timeout | http_client::Kind::Interrupted => Self::Timeout,
            http_client::Kind::Dns => Self::DnsFailed,
            http_client::Kind::Connect => Self::ConnectFailed,
            http_client::Kind::Tls => Self::TlsFailed,
            http_client::Kind::BodyLimit => Self::BodyOverLimit,
            http_client::Kind::Reset => Self::ConnectionReset,
            http_client::Kind::Malformed | http_client::Kind::Other => Self::MalformedResponse,
        }
    }
}

//! Why a fetch failed: the error categories of DESIGN §1, each printed as its label.

use std::error::Error;
use std::io::{self, ErrorKind::*};

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

    /// The one table from reqwest's, hyper's and the OS's errors to the contract's categories, read from reqwest's
    /// kinds and the causes under them, never from their text.
    pub fn of(error: &reqwest::Error, url: &str) -> Self {
        if error.is_timeout() {
            return Self::Timeout;
        }
        if error.is_dns() {
            return Self::DnsFailed;
        }
        let (mut io_kind, mut malformed) = (None, false);
        for cause in std::iter::successors(error.source(), |&cause| cause.source()) {
            io_kind = io_kind.or_else(|| cause.downcast_ref::<io::Error>().map(io::Error::kind));
            malformed |= cause
                .downcast_ref::<hyper::Error>()
                .is_some_and(hyper::Error::is_parse);
        }
        if error.is_connect() {
            match io_kind {
                Some(
                    ConnectionRefused | HostUnreachable | NetworkUnreachable | NetworkDown
                    | AddrNotAvailable,
                ) => Self::ConnectFailed,
                _ if url.starts_with("https:") => Self::TlsFailed,
                _ => Self::ConnectionReset,
            }
        } else if malformed || matches!(io_kind, Some(InvalidData | InvalidInput)) {
            Self::MalformedResponse
        } else {
            Self::ConnectionReset
        }
    }
}

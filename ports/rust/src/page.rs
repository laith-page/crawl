//! What a fetch returned, and its block as printed.

use crate::failure::Failure;
use std::io::Write;
use url::Url;

pub struct Page {
    pub url: String,
    pub status: Option<u16>,
    pub failure: Option<Failure>,
    pub links: Vec<Url>,
}

impl Page {
    pub fn response(url: String, status: u16, links: Vec<Url>) -> Self {
        Self {
            url,
            status: Some(status),
            failure: None,
            links,
        }
    }
    pub fn failed(url: String, status: Option<u16>, failure: Failure) -> Self {
        Self {
            url,
            status: status.filter(|_| !failure.hides_status()),
            failure: Some(failure),
            links: vec![],
        }
    }
    pub fn is_failure(&self) -> bool {
        self.failure.is_some()
    }
    pub fn unreachable(&self) -> bool {
        self.failure.is_some_and(Failure::is_unreachable)
    }
    pub fn write_to(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(self.url.as_bytes());
        if let Some(status) = self.status {
            let _ = write!(out, " {status}");
        }
        if let Some(failure) = self.failure {
            let _ = write!(out, " error: {}", failure.label());
        }
        out.push(b'\n');
    }
}

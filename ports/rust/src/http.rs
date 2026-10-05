//! reqwest's HTTP/1.1, over TLS for https.

use crate::tls::Tls;
use reqwest::header::{
    ACCEPT_ENCODING, CONTENT_TYPE, HeaderMap, HeaderValue, LOCATION, RETRY_AFTER,
};
use reqwest::{Client, redirect};
use std::error::Error;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use url::Url;

/// Bodies longer are refused: "body over 5 MiB" (DESIGN §1).
pub const MAX_BODY_BYTES: usize = 5 << 20;
/// Longest body drained so its connection can be reused.
const DRAIN_LIMIT_BYTES: u64 = 64 << 10;

/// idle pool sized to concurrency; idle connections are kept for the crawl (`pool_idle_timeout(None)`)
#[derive(Clone)]
pub struct Http {
    client: Client,
    connects: Connects,
}

/// Each connect in flight (TCP and TLS both) holds a read lock: a write lock is had once none is.
type Connects = Arc<RwLock<()>>;

impl Http {
    pub fn new(tls: &Tls, concurrency: usize, user_agent: &str) -> Result<Self, String> {
        let connects = Connects::default();
        let counted = connects.clone();
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate"));
        let builder = Client::builder()
            .default_headers(headers)
            .user_agent(user_agent)
            .redirect(redirect::Policy::none())
            .pool_max_idle_per_host(concurrency)
            .pool_idle_timeout(None)
            .tcp_nodelay(true)
            .connector_layer(tower::layer::layer_fn(move |connector| {
                let counted = counted.clone();
                tower::util::MapFuture::new(connector, move |connect| {
                    let connecting = counted.clone().read_owned();
                    async move {
                        let _connecting = connecting.await;
                        connect.await
                    }
                })
            }));
        let client = tls
            .load(builder)?
            .build()
            .map_err(|e| e.source().map_or(e.to_string(), ToString::to_string))?;
        Ok(Self { client, connects })
    }

    /// Once no connect is in flight. hyper races a new connection against the pool, and when a pooled one frees
    /// first the request takes it and the connect goes on in the background, to be pooled: a crawl that exits then
    /// cuts that handshake off, and the server sees a client hang up mid-handshake (tls-graph's mock logged it).
    pub async fn settled(&self) {
        drop(self.connects.write().await);
    }

    /// Sends the GET and reads the status line and headers, within the deadline.
    pub async fn get(&self, url: &str, deadline: Instant) -> reqwest::Result<Response> {
        let left = deadline.saturating_duration_since(Instant::now());
        let response = self.client.get(url).timeout(left).send().await?;
        Ok(Response { response })
    }
}

/// A response whose status and headers are read and body is pending.
pub struct Response {
    response: reqwest::Response,
}

impl Response {
    /// The URL fetched, as reqwest parsed it for the request: the page its links resolve against.
    pub fn url(&self) -> &Url {
        self.response.url()
    }

    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    pub fn content_type(&self) -> Option<&str> {
        self.response.headers().get(CONTENT_TYPE)?.to_str().ok()
    }

    /// Its bytes read as ISO-8859-1, each byte a code point (RFC 9110 §5.5, DESIGN §1).
    pub fn location(&self) -> Option<String> {
        let value = self.response.headers().get(LOCATION)?;
        Some(value.as_bytes().iter().map(|&byte| byte as char).collect())
    }

    pub fn retry_after_seconds(&self) -> Option<u64> {
        retry_after(self.response.headers().get(RETRY_AFTER)?.to_str().ok()?)
    }

    /// Feeds the decoded body to `scan` a chunk at a time; false when Content-Length or the bytes read pass
    /// MAX_BODY_BYTES.
    pub async fn body(mut self, mut scan: impl FnMut(&[u8])) -> reqwest::Result<bool> {
        if self.response.content_length() > Some(MAX_BODY_BYTES as u64) {
            return Ok(false);
        }
        let mut read = 0;
        while let Some(chunk) = self.response.chunk().await? {
            read += chunk.len();
            if read > MAX_BODY_BYTES {
                return Ok(false);
            }
            scan(&chunk);
        }
        Ok(true)
    }

    /// Skips a short body, so the connection is reused; a longer one is dropped with its connection.
    pub async fn skip_body(mut self) {
        if self
            .response
            .content_length()
            .is_some_and(|length| length > DRAIN_LIMIT_BYTES)
        {
            return;
        }
        let mut read = 0;
        while let Ok(Some(chunk)) = self.response.chunk().await {
            read += chunk.len() as u64;
            if read > DRAIN_LIMIT_BYTES {
                break;
            }
        }
    }
}

/// A Retry-After of whole seconds (DESIGN §5): digits alone, more than a u64 holds a wait as long as it holds;
/// anything else (an HTTP-date, a fraction, a sign) `None`.
fn retry_after(value: &str) -> Option<u64> {
    let digits = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    digits.then(|| value.parse().unwrap_or(u64::MAX))
}

#[cfg(test)]
#[path = "http_test.rs"]
mod tests;

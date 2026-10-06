//! Fetches a URL within one deadline over HTTP/1.1: retries with backoff, reads the body, extracts the links.

use crate::{failure::Failure, links::Links, options::Options, page::Page, retries};
use std::{
    ffi::OsString,
    sync::Arc,
    time::{Duration, Instant},
};
use url::Url;

pub const MAX_BODY_BYTES: u64 = 5 << 20;
pub const DRAIN_LIMIT_BYTES: u64 = 64 << 10;

#[derive(Clone)]
pub struct Fetcher {
    http: http_client::Client,
    timeout: Duration,
    pacer: Arc<pacing::Pacer>,
    shared_retries: bool,
}

struct Attempt {
    page: Page,
    retry: Option<Duration>,
}

impl Fetcher {
    pub fn new(
        options: &Options,
        cert_file: Option<OsString>,
        pacer: Arc<pacing::Pacer>,
    ) -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::CryptoProvider {
            kx_groups: vec![
                rustls::crypto::ring::kx_group::X25519,
                rustls::crypto::ring::kx_group::SECP256R1,
            ],
            ..rustls::crypto::ring::default_provider()
        });
        let tls =
            certs::client_config(cert_file.as_deref(), provider).map_err(|e| e.to_string())?;
        let http = http_client::Client::new(http_client::Options {
            user_agent: &options.user_agent,
            max_connections: options.concurrency,
            tls,
        })
        .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            timeout: Duration::from_secs(options.timeout_seconds),
            pacer,
            shared_retries: !options.fast,
        })
    }

    pub async fn settle(&self) {
        let _ = tokio::time::timeout(self.timeout, self.http.settled()).await;
    }

    async fn wait_to_retry(&self, wait: Duration) {
        if self.shared_retries {
            self.pacer.postpone(wait);
            self.pacer.acquire().await;
        } else if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    pub async fn fetch(self, url: String) -> Page {
        self.pacer.acquire().await;
        let deadline = Instant::now() + self.timeout;
        let mut retries = 0;
        loop {
            let attempt = self.attempt(&url, deadline, retries).await;
            let left = deadline.saturating_duration_since(Instant::now());
            let Some(wait) = attempt.retry.filter(|&wait| wait < left) else {
                return attempt.page;
            };
            self.wait_to_retry(wait).await;
            if Instant::now() >= deadline {
                return attempt.page;
            }
            retries += 1;
        }
    }

    async fn attempt(&self, url: &str, deadline: Instant, retries: u32) -> Attempt {
        let response = match self.http.get(url, deadline).await {
            Ok(response) => response,
            Err(error) => {
                let failure = Failure::of(error.kind);
                let retry = retries::after_failure(failure, error.status, retries);
                return Attempt {
                    page: Page::failed(url.into(), error.status, failure),
                    retry,
                };
            }
        };
        let status = response.status();
        let retry = retries::after_status(status, response.retry_after(), retries);
        if retry.is_some() {
            response.discard(DRAIN_LIMIT_BYTES).await;
            return Attempt {
                page: Page::response(url.into(), status, vec![]),
                retry,
            };
        }
        let page = match links(response).await {
            Ok(links) => Page::response(url.into(), status, links),
            Err(failure) => Page::failed(url.into(), Some(status), failure),
        };
        Attempt { page, retry }
    }
}

async fn links(response: http_client::Response) -> Result<Vec<Url>, Failure> {
    let status = response.status();
    if wants_body(status, response.content_type()) {
        let mut links = Links::new(response.url().clone());
        response
            .body(MAX_BODY_BYTES, |chunk| links.feed(chunk))
            .await
            .map_err(|error| Failure::of(error.kind))?;
        Ok(links.end())
    } else {
        let target = response
            .location()
            .filter(|header| (300..400).contains(&status) && !header.is_empty())
            .map(|header| location(response.url(), &header))
            .unwrap_or_default();
        response.discard(DRAIN_LIMIT_BYTES).await;
        Ok(target)
    }
}

fn location(page: &Url, header: &str) -> Vec<Url> {
    crate::urls::resolve_against(page, header)
        .into_iter()
        .collect()
}

fn wants_body(status: u16, content_type: Option<&str>) -> bool {
    (200..300).contains(&status) && status != 204 && content_type.is_some_and(html::is_html)
}

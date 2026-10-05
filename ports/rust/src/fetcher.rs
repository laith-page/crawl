//! Fetches a URL within one deadline over HTTP/1.1: retries with backoff, reads the body, extracts the links.

use crate::{
    failure::Failure,
    http::{Http, Response},
    links::Links,
    page::Page,
    retries,
    throttle::Throttle,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use url::Url;

#[derive(Clone)]
pub struct Fetcher {
    pub http: Http,
    pub timeout: Duration,
    pub throttle: Arc<Throttle>,
}

struct Attempt {
    page: Page,
    retry: Option<Duration>,
}

impl Fetcher {
    pub async fn fetch(self, url: String) -> Page {
        self.throttle.start().await;
        let deadline = Instant::now() + self.timeout;
        let mut retries = 0;
        loop {
            let attempt = self.attempt(&url, deadline, retries).await;
            let left = deadline.saturating_duration_since(Instant::now());
            let Some(wait) = attempt.retry.filter(|&wait| wait < left) else {
                return attempt.page;
            };
            self.throttle.retry(wait).await;
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
                let failure = Failure::of(&error, url);
                let retry = retries::after_failure(failure, 0, retries);
                return Attempt {
                    page: Page::failed(url.into(), None, failure),
                    retry,
                };
            }
        };
        let status = response.status();
        let retry = retries::after_status(status, response.retry_after_seconds(), retries);
        if retry.is_some() {
            response.skip_body().await;
            return Attempt {
                page: Page::response(url.into(), status, vec![]),
                retry,
            };
        }
        let page = match links(url, response).await {
            Ok(links) => Page::response(url.into(), status, links),
            Err(failure) => Page::failed(url.into(), Some(status), failure),
        };
        Attempt { page, retry }
    }
}

async fn links(url: &str, response: Response) -> Result<Vec<Url>, Failure> {
    let status = response.status();
    if wants_body(status, response.content_type()) {
        let mut links = Links::new(response.url().clone());
        let whole = response
            .body(|chunk| links.feed(chunk))
            .await
            .map_err(|error| Failure::of(&error, url))?;
        if !whole {
            return Err(Failure::BodyOverLimit);
        }
        Ok(links.end())
    } else {
        let target = response
            .location()
            .filter(|header| (300..400).contains(&status) && !header.is_empty())
            .map(|header| location(response.url(), &header))
            .unwrap_or_default();
        response.skip_body().await;
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

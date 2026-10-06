//! The URLs still to fetch: the queue, the seen set, and the page and memory budgets they are held to (DESIGN §2, §3).

use collections::UniqueQueue;
use url::{Position, Url};

pub const MAX_QUEUE_BYTES: usize = 128 << 20;

pub struct Frontier {
    /// The start URL's host, which a link must have to be queued.
    host: String,
    max_pages: usize,
    seed: u64,
    queue: UniqueQueue,
    popped: usize,
}

impl Frontier {
    /// A frontier from `start`, a URL in the form, within `max_pages`, with `start` queued and seen.
    pub fn new(start: &str, max_pages: usize) -> Self {
        let url = Url::parse(start).expect("a start URL in the form");
        let prefix = url[..Position::BeforePath].to_string();
        let mut queue = UniqueQueue::new(prefix, max_pages, MAX_QUEUE_BYTES);
        let seed = fastrand::u64(..);
        queue.offer(hashing::xxh3_64_with_seed(start.as_bytes(), seed), start);
        Self {
            host: url.host_str().unwrap_or_default().to_string(),
            max_pages,
            seed,
            queue,
            popped: 0,
        }
    }

    #[allow(dead_code)]
    pub fn with_queue(start: &str, max_pages: usize, mut queue: UniqueQueue) -> Self {
        let url = Url::parse(start).expect("a start URL in the form");
        let seed = fastrand::u64(..);
        queue.offer(hashing::xxh3_64_with_seed(start.as_bytes(), seed), start);
        Self {
            host: url.host_str().unwrap_or_default().to_string(),
            max_pages,
            seed,
            queue,
            popped: 0,
        }
    }

    /// The next URL to fetch, or None when none is queued or every page the budget allows was popped.
    pub fn pop(&mut self) -> Option<String> {
        if self.popped == self.max_pages {
            return None;
        }
        let url = self.queue.pop()?;
        self.popped += 1;
        Some(url)
    }

    /// Queues a link if it is on the host, unseen and within the page and memory budgets. A link over budget is never
    /// remembered, so it can be queued later if capacity opens (DESIGN §2). A new link the full seen set would refuse
    /// is dropped (DESIGN §3).
    pub fn push(&mut self, link: &Url) {
        if link.host_str() != Some(&self.host) || self.popped + self.queue.len() >= self.max_pages {
            return;
        }
        self.queue.offer(self.hash(link.as_str()), link.as_str());
    }

    /// Links waiting to be fetched.
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    fn hash(&self, url: &str) -> u64 {
        hashing::xxh3_64_with_seed(url.as_bytes(), self.seed)
    }
}

#[cfg(test)]
#[path = "frontier_test.rs"]
mod tests;

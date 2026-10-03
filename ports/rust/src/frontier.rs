//! The URLs still to fetch: the queue, the seen set, and the page and memory budgets they are held to (DESIGN §2, §3).

use collections::{Hashes, PackedQueue};
use std::hash::BuildHasher;
use url::{Position, Url};

pub const MAX_QUEUE_BYTES: usize = 128 << 20;

pub struct Frontier {
    /// The start URL's host, which a link must have to be queued.
    host: String,
    max_pages: usize,
    /// 64-bit hashes, at most 12,582,912 (DESIGN §3)
    seen: Hashes,
    hasher: foldhash::quality::RandomState,
    queue: PackedQueue,
    popped: usize,
}

impl Frontier {
    /// A frontier from `start`, a URL in the form, within `max_pages`, with `start` queued and seen.
    pub fn new(start: &str, max_pages: usize) -> Self {
        Self::with_seen(
            start,
            max_pages,
            MAX_QUEUE_BYTES,
            Hashes::sized_for(max_pages),
        )
    }

    pub fn with_seen(
        start: &str,
        max_pages: usize,
        max_queue_bytes: usize,
        mut seen: Hashes,
    ) -> Self {
        let url = Url::parse(start).expect("a start URL in the form");
        let hasher = foldhash::quality::RandomState::default();
        seen.insert(hasher.hash_one(start));
        let mut queue =
            PackedQueue::with_budget(url[..Position::BeforePath].to_string(), max_queue_bytes);
        queue.push(start);
        Self {
            host: url.host_str().unwrap_or_default().to_string(),
            max_pages,
            seen,
            hasher,
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
        if link.host_str() != Some(&self.host) || self.popped + self.queue.size() >= self.max_pages
        {
            return;
        }
        let hash = self.hash(link.as_str());
        if !self.seen.contains(hash) && !self.seen.full() && self.queue.push(link.as_str()) {
            self.seen.insert(hash);
        }
    }

    /// Links waiting to be fetched.
    pub fn queued(&self) -> usize {
        self.queue.size()
    }

    fn hash(&self, url: &str) -> u64 {
        self.hasher.hash_one(url)
    }
}

#[cfg(test)]
#[path = "frontier_test.rs"]
mod tests;

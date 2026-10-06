//! The links of a page as its HTML streams in, and a redirect's Location.

use crate::urls;
use indexmap::IndexSet;
use url::Url;

const MAX_LINKS: usize = 1000;
const MAX_LINK_BYTES: usize = 256 << 10;

/// The links of one page, found while its HTML streams in: the anchors of DESIGN §4.
pub struct Links {
    page: Url,
    hrefs: html::Hrefs,
    /// Exact: a repeat is the same URL, not the same hash
    found: IndexSet<Url, foldhash::fast::RandomState>,
    bytes: usize,
    done: bool,
}

impl Links {
    pub fn new(page: Url) -> Self {
        let mut found = IndexSet::default();
        found.reserve(64);
        Self {
            page,
            hrefs: html::Hrefs::new(),
            found,
            bytes: 0,
            done: false,
        }
    }

    /// Scans the next bytes of the page.
    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.done {
            self.hrefs.feed(chunk);
            self.collect();
        }
    }

    /// The links found, in document order, once the whole body is fed.
    pub fn end(mut self) -> Vec<Url> {
        if !self.done {
            self.hrefs.end();
            self.collect();
        }
        self.found.into_iter().collect()
    }

    fn collect(&mut self) {
        while !self.done {
            let Some(href) = self.hrefs.next() else {
                return;
            };
            let Some(url) = urls::resolve_against(&self.page, &href) else {
                continue;
            };
            // ASCII only: bytes are characters under DESIGN §4
            let length = url.as_str().len();
            if self.found.insert(url) {
                if self.bytes + length > MAX_LINK_BYTES {
                    self.found.pop();
                    self.done = true;
                    return;
                }
                self.bytes += length;
                if self.found.len() == 64 {
                    self.found.reserve(MAX_LINKS - 64);
                }
                self.done = self.found.len() == MAX_LINKS;
            }
        }
    }
}

#[cfg(test)]
#[path = "links_test.rs"]
mod tests;

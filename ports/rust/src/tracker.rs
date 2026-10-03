//! What a crawl counts.
use crate::page::Page;

const DEAD_HOST_THRESHOLD: usize = 5;

#[derive(Default)]
pub struct Tracker {
    start: String,
    crawled: usize,
    errors: usize,
    unreachable_in_a_row: usize,
    start_failed: bool,
}
impl Tracker {
    pub fn new(start: String) -> Self {
        Self {
            start,
            ..Self::default()
        }
    }
    pub fn record(&mut self, page: &Page) {
        self.crawled += 1;
        self.errors += usize::from(page.is_failure());
        self.start_failed |= page.url == self.start
            && (page.is_failure() || page.status.is_none_or(|status| status >= 400));
        self.unreachable_in_a_row = if page.unreachable() {
            self.unreachable_in_a_row + 1
        } else {
            0
        };
    }
    pub fn host_is_dead(&self) -> bool {
        self.unreachable_in_a_row >= DEAD_HOST_THRESHOLD
    }
    pub fn exit_code(&self) -> i32 {
        i32::from(self.start_failed)
    }
    pub fn summary(&self, seconds: f64) -> String {
        format!(
            "crawled {} pages in {seconds:.2}s, {} errors\n",
            self.crawled, self.errors
        )
    }
}

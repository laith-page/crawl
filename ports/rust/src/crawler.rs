//! Runs a crawl: one task owns the frontier, the tracker and stdout, so nothing is locked; a fetch only fetches.

use crate::{frontier::Frontier, page::Page, tracker::Tracker};
use std::{future::Future, io::Write, time::Instant};
use workers::Workers;

pub const OUTPUT_BUFFER_BYTES: usize = 256 << 10;

pub struct Crawler {
    pub(crate) concurrency: usize,
    pub(crate) frontier: Frontier,
    pub(crate) tracker: Tracker,
    pub(crate) signals: signals::Signals,
}

impl Crawler {
    pub fn new(
        start: String,
        concurrency: usize,
        max_pages: usize,
        signals: signals::Signals,
    ) -> Self {
        Self {
            frontier: Frontier::new(&start, max_pages),
            tracker: Tracker::new(start),
            concurrency,
            signals,
        }
    }

    pub async fn crawl<F: Future<Output = Page> + Send + 'static>(
        mut self,
        fetch: impl Fn(String) -> F + Send + Sync + 'static,
        stdout: impl Write,
        mut stderr: impl Write,
    ) -> i32 {
        let begun = Instant::now();
        let mut out = cli::BlockWriter::new(stdout, OUTPUT_BUFFER_BYTES);
        self.run(fetch, &mut out).await;
        let ended = out.finish();
        let dead = self.tracker.host_is_dead();
        if ended == cli::Outcome::Written && dead {
            let _ = writeln!(stderr, "error: host unreachable");
        }
        let summary = self.tracker.summary(begun.elapsed().as_secs_f64());
        let _ = write!(stderr, "{summary}");
        match ended {
            cli::Outcome::ReaderClosed => self.signals.exit_code_or(0),
            cli::Outcome::Failed => {
                let _ = writeln!(stderr, "error: cannot write output");
                1
            }
            cli::Outcome::Written => {
                if dead {
                    1
                } else {
                    self.signals.exit_code_or(self.tracker.exit_code())
                }
            }
        }
    }

    async fn run<F: Future<Output = Page> + Send + 'static>(
        &mut self,
        fetch: impl Fn(String) -> F + Send + Sync + 'static,
        out: &mut cli::BlockWriter<impl Write>,
    ) {
        let mut workers = Workers::new(self.concurrency, fetch);
        let mut block = Vec::with_capacity(4096);
        loop {
            let active = !self.signals.received() && !self.tracker.host_is_dead();
            while active && workers.idle() > 0 {
                let Some(url) = self.frontier.pop() else {
                    break;
                };
                workers.submit(url);
            }
            if workers.in_flight() == 0 && (!active || self.frontier.queued() == 0) {
                break;
            }
            if let Some(page) = workers.take(None).await {
                self.tracker.record(&page);
                block.clear();
                page.write_to(&mut block);
                if out.write_block(&block).is_err() {
                    break;
                }
                if active {
                    page.links.iter().for_each(|link| self.frontier.push(link));
                }
            }
        }
        workers.close().await;
    }
}

#[cfg(test)]
#[path = "crawler_test.rs"]
mod tests;

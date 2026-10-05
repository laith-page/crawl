//! Runs a crawl: one task owns the frontier, the tracker and stdout, so nothing is locked; a fetch only fetches.

use crate::{frontier::Frontier, output::Output, page::Page, tracker::Tracker};
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
        let mut output = Output::new(stdout);
        self.run(fetch, &mut output).await;
        output.flush();
        if !output.failed() && self.tracker.host_is_dead() {
            let _ = writeln!(stderr, "error: host unreachable");
        }
        let summary = self.tracker.summary(begun.elapsed().as_secs_f64());
        let _ = write!(stderr, "{summary}");
        if output.failed() && output.is_pipe() {
            return self.signals.exit_code_or(0);
        }
        if output.failed() {
            let _ = writeln!(stderr, "error: cannot write output");
            return 1;
        }
        if self.tracker.host_is_dead() {
            1
        } else {
            self.signals.exit_code_or(self.tracker.exit_code())
        }
    }

    async fn run<F: Future<Output = Page> + Send + 'static>(
        &mut self,
        fetch: impl Fn(String) -> F + Send + Sync + 'static,
        output: &mut Output<impl Write>,
    ) {
        let mut workers = Workers::new(self.concurrency, fetch);
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
                output.write(&page);
                if output.failed() {
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

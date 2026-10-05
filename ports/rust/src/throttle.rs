//! The shared request-start gate: delay between starts, extended by retries.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub struct Throttle {
    start: Instant,
    delay_nanos: u64,
    next: Mutex<u64>,
    shared_retries: bool,
}

impl Throttle {
    pub fn new(delay_millis: u32, shared_retries: bool) -> Self {
        Self {
            start: Instant::now(),
            delay_nanos: delay_millis as u64 * 1_000_000,
            next: Mutex::new(0),
            shared_retries,
        }
    }

    pub async fn start(&self) -> bool {
        if !self.shared_retries && self.delay_nanos == 0 {
            return true;
        }
        loop {
            let wait = {
                let mut next = self.next.lock().unwrap();
                let now = self.start.elapsed().as_nanos() as u64;
                if now >= *next {
                    *next = now.saturating_add(self.delay_nanos);
                    return true;
                }
                *next - now
            };
            tokio::time::sleep(Duration::from_nanos(wait)).await;
        }
    }

    pub fn pause(&self, wait: Duration) {
        let until = (self.start.elapsed().as_nanos() as u64)
            .saturating_add(wait.as_nanos().min(u64::MAX as u128) as u64);
        let mut next = self.next.lock().unwrap();
        *next = (*next).max(until);
    }

    pub async fn retry(&self, wait: Duration) {
        if self.shared_retries {
            self.pause(wait);
            self.start().await;
        } else if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
#[path = "throttle_test.rs"]
mod tests;

use crate::failure::Failure;
use std::time::Duration;

const MAX_RETRIES: u32 = 4;
const FIRST_BACKOFF: Duration = Duration::from_millis(250);

pub fn after_status(status: u16, retry_after: Option<Duration>, retries: u32) -> Option<Duration> {
    if retries >= MAX_RETRIES || !retryable(status) {
        return None;
    }
    Some(retry_after.unwrap_or_else(|| backoff(retries)))
}

pub fn after_failure(failure: Failure, status: Option<u16>, retries: u32) -> Option<Duration> {
    if retries >= MAX_RETRIES || failure == Failure::Timeout {
        return None;
    }
    if status.is_some_and(|code| !retryable(code)) {
        return None;
    }
    Some(backoff(retries))
}

fn retryable(status: u16) -> bool {
    matches!(status, 408 | 429 | 502..=504)
}

fn backoff(retries: u32) -> Duration {
    pacing::full_jitter(FIRST_BACKOFF, retries)
}

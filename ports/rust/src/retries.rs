use crate::failure::Failure;
use std::time::Duration;

const MAX_RETRIES: u32 = 4;
const FIRST_BACKOFF_MILLIS: u64 = 250;

pub fn after_status(
    status: u16,
    retry_after_seconds: Option<u64>,
    retries: u32,
) -> Option<Duration> {
    if retries >= MAX_RETRIES || !retryable(status) {
        return None;
    }
    if let Some(seconds) = retry_after_seconds {
        Some(Duration::from_secs(seconds))
    } else {
        Some(backoff(retries))
    }
}

pub fn after_failure(failure: Failure, status: u16, retries: u32) -> Option<Duration> {
    if retries >= MAX_RETRIES || failure == Failure::Timeout {
        return None;
    }
    if status != 0 && !retryable(status) {
        return None;
    }
    Some(backoff(retries))
}

fn retryable(status: u16) -> bool {
    matches!(status, 408 | 429 | 502..=504)
}

fn backoff(retries: u32) -> Duration {
    Duration::from_millis(fastrand::u64(..(FIRST_BACKOFF_MILLIS << retries)))
}

package main

import (
	"time"

	"go.l3.ai/pacing"
)

const maxRetries = 4
const firstBackoff = 250 * time.Millisecond

func afterStatus(status, retries int, retryAfter time.Duration, given bool) (time.Duration, bool) {
	if retries >= maxRetries || !retryable(status) {
		return 0, false
	}
	if given {
		return retryAfter, true
	}
	return backoff(retries), true
}

func afterFailure(failure Failure, status, retries int) (time.Duration, bool) {
	if retries >= maxRetries || failure == FailureTimeout {
		return 0, false
	}
	if status != 0 && !retryable(status) {
		return 0, false
	}
	return backoff(retries), true
}

func retryable(status int) bool {
	return status == 408 || status == 429 || status == 502 || status == 503 || status == 504
}

func backoff(retries int) time.Duration {
	return pacing.FullJitter(firstBackoff, retries)
}

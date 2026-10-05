package main

import (
	"math"
	"math/rand/v2"
	"time"
)

const maxRetries = 4
const noRetry = -1 * time.Second
const firstBackoffMillis = 250

func afterStatus(status int, retryAfterSeconds int64, retries int) time.Duration {
	if retries >= maxRetries || !retryable(status) {
		return noRetry
	}
	if retryAfterSeconds >= 0 {
		return time.Duration(min(retryAfterSeconds, math.MaxInt64/int64(time.Second))) * time.Second
	}
	return backoff(retries)
}

func afterFailure(failure Failure, status int, retries int) time.Duration {
	if retries >= maxRetries || failure == FailureTimeout {
		return noRetry
	}
	if status != 0 && !retryable(status) {
		return noRetry
	}
	return backoff(retries)
}

func retryable(status int) bool {
	return status == 408 || status == 429 || status == 502 || status == 503 || status == 504
}

func backoff(retries int) time.Duration {
	return rand.N(firstBackoffMillis * time.Millisecond << retries)
}

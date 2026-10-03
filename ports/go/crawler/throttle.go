package main

import (
	"sync"
	"time"
)

// Throttle gates each HTTP request start, including retries.
type Throttle struct {
	mu            sync.Mutex
	delay         time.Duration
	next          time.Time
	sharedRetries bool
}

func newThrottle(delayMillis int, sharedRetries bool) *Throttle {
	return &Throttle{delay: time.Duration(delayMillis) * time.Millisecond, sharedRetries: sharedRetries}
}

func (throttle *Throttle) start() {
	if !throttle.sharedRetries && throttle.delay <= 0 {
		return
	}
	for {
		throttle.mu.Lock()
		now := time.Now()
		if !now.Before(throttle.next) {
			throttle.next = now.Add(throttle.delay)
			throttle.mu.Unlock()
			return
		}
		wait := throttle.next.Sub(now)
		throttle.mu.Unlock()
		time.Sleep(wait)
	}
}

func (throttle *Throttle) pause(wait time.Duration) {
	throttle.mu.Lock()
	until := time.Now().Add(wait)
	if until.After(throttle.next) {
		throttle.next = until
	}
	throttle.mu.Unlock()
}

func (throttle *Throttle) retry(wait time.Duration) {
	if throttle.sharedRetries {
		throttle.pause(wait)
		throttle.start()
	} else if wait > 0 {
		time.Sleep(wait)
	}
}

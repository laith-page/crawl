package main

import (
	"slices"
	"sync"
	"testing"
	"time"
)

func TestConcurrentRequestsSpanTwoDelays(t *testing.T) {
	thr := newThrottle(20, true)
	var mu sync.Mutex
	var starts []time.Time
	var wg sync.WaitGroup
	begun := time.Now()
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			thr.start()
			mu.Lock()
			starts = append(starts, time.Now())
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(starts) != 3 {
		t.Fatalf("request starts = %d, want 3", len(starts))
	}
	slices.SortFunc(starts, func(a, b time.Time) int { return a.Compare(b) })
	if span := starts[2].Sub(begun); span < 40*time.Millisecond {
		t.Errorf("3 requests spanned %v, want at least 40ms", span)
	}
}

func TestRetryPauseDelaysNextRequest(t *testing.T) {
	thr := newThrottle(0, true)
	thr.start()
	begun := time.Now()
	thr.pause(20 * time.Millisecond)
	thr.start()
	if elapsed := time.Since(begun); elapsed < 20*time.Millisecond {
		t.Errorf("next request waited %v, want at least 20ms", elapsed)
	}
}

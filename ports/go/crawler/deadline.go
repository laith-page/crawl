package main

import (
	"context"
	"sync/atomic"
	"time"
)

// Deadline is a reusable request context rearmed for each fetch.
type Deadline struct {
	at   atomic.Int64
	done atomic.Pointer[chan struct{}]

	timer   *time.Timer
	expired chan struct{}
}

func newDeadline() *Deadline {
	return &Deadline{expired: make(chan struct{}, 1)}
}

func (deadline *Deadline) arm(timeout time.Duration) {
	deadline.at.Store(time.Now().Add(timeout).UnixNano())
	done := make(chan struct{})
	deadline.done.Store(&done)
	if deadline.timer == nil {
		deadline.timer = time.AfterFunc(timeout, deadline.expire)
	} else {
		deadline.timer.Reset(timeout)
	}
}

// disarm stops the timer and waits for any executing callback.
func (deadline *Deadline) disarm() {
	if !deadline.timer.Stop() {
		<-deadline.expired
	}
}

func (deadline *Deadline) expire() {
	close(*deadline.done.Load())
	deadline.expired <- struct{}{}
}

func (deadline *Deadline) Deadline() (time.Time, bool) {
	return time.Unix(0, deadline.at.Load()), true
}

func (deadline *Deadline) Done() <-chan struct{} {
	if done := deadline.done.Load(); done != nil {
		return *done
	}
	return nil
}

// Err follows Done alone: the timer runs on the monotonic clock and the wall clock may still read before at when
// it fires (macOS does), and a context whose Done is closed must not report nil (context panics on it).
func (deadline *Deadline) Err() error {
	select {
	case <-deadline.Done():
		return context.DeadlineExceeded
	default:
		return nil
	}
}

func (*Deadline) Value(any) any { return nil }

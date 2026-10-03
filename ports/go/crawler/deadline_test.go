package main

import (
	"context"
	"testing"
	"time"
)

func TestDeadlineRearmsWithoutCancellingNextFetch(t *testing.T) {
	deadline := newDeadline()
	deadline.arm(time.Second)
	first := deadline.Done()
	deadline.disarm()
	select {
	case <-first:
		t.Fatal("completed fetch timed out")
	default:
	}
	deadline.arm(time.Millisecond)
	second := deadline.Done()
	if first == second {
		t.Fatal("reused a completed fetch's cancellation channel")
	}
	select {
	case <-second:
	case <-time.After(time.Second):
		t.Fatal("rearmed deadline did not expire")
	}
	if deadline.Err() != context.DeadlineExceeded {
		t.Fatalf("expired deadline error = %v", deadline.Err())
	}
	deadline.disarm()
}

// A timer may fire while the wall clock still reads before the deadline: Done closed means Err is not nil.
func TestDeadlineErrFollowsDoneNotTheWallClock(t *testing.T) {
	deadline := newDeadline()
	deadline.arm(time.Hour)
	deadline.expire()
	if deadline.Err() != context.DeadlineExceeded {
		t.Fatalf("closed Done with the deadline still ahead: Err = %v", deadline.Err())
	}
	deadline.disarm()
}

package main

import "fmt"

const deadHostThreshold = 5

type Tracker struct {
	start                              string
	crawled, errors, unreachableInARow int
	startFailed                        bool
}

func newTracker(start string) *Tracker { return &Tracker{start: start} }

func (tracker *Tracker) record(page Page) {
	tracker.crawled++
	if page.isFailure() {
		tracker.errors++
	}
	if page.url == tracker.start && (page.isFailure() || page.status >= 400) {
		tracker.startFailed = true
	}
	if page.unreachable() {
		tracker.unreachableInARow++
	} else {
		tracker.unreachableInARow = 0
	}
}

func (tracker *Tracker) hostIsDead() bool { return tracker.unreachableInARow >= deadHostThreshold }
func (tracker *Tracker) exitCode() int {
	if tracker.startFailed {
		return 1
	}
	return 0
}
func (tracker *Tracker) summary(seconds float64) string {
	return fmt.Sprintf("crawled %d pages in %.2fs, %d errors\n", tracker.crawled, seconds, tracker.errors)
}

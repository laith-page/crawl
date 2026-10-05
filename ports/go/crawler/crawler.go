// Crawler runs a crawl: one goroutine owns the frontier, the tracker and stdout; fetches run in workers.
package main

import (
	"fmt"
	"io"
	"time"

	"go.l3.ai/signals"
	"go.l3.ai/workers"
)

const outputBufferBytes = 256 << 10

type Crawler struct {
	concurrency int
	frontier    *Frontier
	tracker     *Tracker
}

func newCrawler(start string, concurrency, maxPages int) *Crawler {
	return &Crawler{concurrency: concurrency, frontier: newFrontier(start, maxPages), tracker: newTracker(start)}
}

func (crawler *Crawler) crawl(fetch func(string) Page, stdout, stderr io.Writer, signals *signals.Signals) int {
	begun, output := time.Now(), newOutput(stdout)
	crawler.run(fetch, output, signals)
	output.flush()
	dead := crawler.tracker.hostIsDead()
	if !output.failed() && dead {
		fmt.Fprintln(stderr, "error: host unreachable")
	}
	fmt.Fprint(stderr, crawler.tracker.summary(time.Since(begun).Seconds()))
	if output.isPipe() {
		return signals.ExitCodeOr(0)
	}
	if output.failed() {
		fmt.Fprintln(stderr, "error: cannot write output")
		return 1
	}
	if dead {
		return 1
	}
	return signals.ExitCodeOr(crawler.tracker.exitCode())
}

func (crawler *Crawler) run(fetch func(string) Page, output *Output, signals *signals.Signals) {
	w := workers.New(crawler.concurrency, fetch)
	defer func() {
		if output.failed() {
			go w.Close()
		} else {
			w.Close()
		}
	}()
	for {
		active := !signals.Received() && !crawler.tracker.hostIsDead()
		for active && w.Idle() > 0 {
			url, ok := crawler.frontier.pop()
			if !ok {
				break
			}
			w.Submit(url)
		}
		if w.InFlight() == 0 {
			return
		}
		page := w.Take()
		crawler.tracker.record(page)
		output.write(page)
		if output.failed() {
			return
		}
		if active {
			for _, link := range page.links {
				crawler.frontier.push(link)
			}
		}
	}
}

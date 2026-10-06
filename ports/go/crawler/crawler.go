// Crawler runs a crawl: one goroutine owns the frontier, the tracker and stdout; fetches run in workers.
package main

import (
	"bytes"
	"fmt"
	"io"
	"time"

	"go.l3.ai/cli"
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

func (crawler *Crawler) crawl(fetch func(string) Page, stdout io.Writer, stderr io.Writer, sig *signals.Signals) int {
	begun := time.Now()
	out := cli.NewBlockWriter(stdout, outputBufferBytes)
	crawler.run(fetch, out, sig)
	ended := out.Finish()
	dead := crawler.tracker.hostIsDead()
	if ended == cli.Written && dead {
		fmt.Fprintln(stderr, "error: host unreachable")
	}
	fmt.Fprint(stderr, crawler.tracker.summary(time.Since(begun).Seconds()))
	switch ended {
	case cli.ReaderClosed:
		return sig.ExitCodeOr(0)
	case cli.Failed:
		fmt.Fprintln(stderr, "error: cannot write output")
		return 1
	}
	if dead {
		return 1
	}
	return sig.ExitCodeOr(crawler.tracker.exitCode())
}

func (crawler *Crawler) run(fetch func(string) Page, out *cli.BlockWriter, sig *signals.Signals) {
	w := workers.New(crawler.concurrency, fetch)
	defer func() {
		w.Stop()
		if !out.Failed() {
			w.Wait()
		}
	}()
	var block bytes.Buffer
	for {
		active := !sig.Received() && !crawler.tracker.hostIsDead()
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
		block.Reset()
		page.writeTo(&block)
		if out.WriteBlock(block.Bytes()) != nil {
			return // a failed write ends the crawl
		}
		if active {
			for _, link := range page.links {
				crawler.frontier.push(link)
			}
		}
	}
}

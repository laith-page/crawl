package main

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"syscall"
	"testing"

	"go.l3.ai/collections"
	"go.l3.ai/signals"
)

const (
	home  = "http://example.com/"
	roomy = 1 << 30 // a queue cap no test reaches

	breadthFirst = `http://example.com/ 200
http://example.com/a 200
http://example.com/b 200
http://example.com/c 200
http://example.com/d 200
http://example.com/gone 404
`
)

// site: / links to /a, /b and off the host; /a and /b to /c, which links to /; /d to a 404.
func site(url string) Page {
	links, ok := map[string][]string{
		home:       {home + "a", home + "b", "http://other.example/"},
		home + "a": {home + "c", home + "b"},
		home + "b": {home + "c", home + "d"},
		home + "c": {home},
		home + "d": {home + "gone"},
	}[url]
	if !ok {
		return newPageResponse(url, 404, nil)
	}
	return newPageResponse(url, 200, links)
}

// wide: home links to 3,000 pages of 100-byte names, which no single chunk holds; every other page is a leaf.
func wide(url string) Page {
	if url != home {
		return newPageResponse(url, 200, nil)
	}
	links := make([]string, 3000)
	for i := range links {
		links[i] = fmt.Sprintf("%s%d/%s", home, i, strings.Repeat("x", 100))
	}
	return newPageResponse(url, 200, links)
}

type Crawled struct {
	stdout, stderr string
	code           int
}

func crawlHome(fetch func(string) Page, concurrency, maxPages int, maxQueueBytes int64) Crawled {
	var stdout, stderr strings.Builder
	crawler := newCrawler(home, concurrency, maxPages)
	crawler.frontier = newFrontierWithSeen(home, maxPages, maxQueueBytes, collections.NewHashes(maxPages))
	code := crawler.crawl(fetch, &stdout, &stderr, &signals.Signals{})
	return Crawled{stdout.String(), stderr.String(), code}
}

func sortedLines(out string) []string {
	lines := strings.Split(out, "\n")
	slices.Sort(lines)
	return lines
}

func pages(out string) int {
	return strings.Count(out, "\n") - strings.Count(out, "\n  ")
}

func TestCrawlIsBreadthFirstInDocumentOrder(t *testing.T) {
	one := crawlHome(site, 1, 100, roomy)
	if one.stdout != breadthFirst || one.code != 0 {
		t.Errorf("exit %d, stdout:\n%s\nwant exit 0, stdout:\n%s", one.code, one.stdout, breadthFirst)
	}
	// a 404 is a page, not an error
	if !strings.HasPrefix(one.stderr, "crawled 6 pages in ") || !strings.HasSuffix(one.stderr, "s, 0 errors\n") {
		t.Errorf("stderr %q; want the summary line", one.stderr)
	}
	if eight := crawlHome(site, 8, 100, roomy); !slices.Equal(sortedLines(eight.stdout), sortedLines(one.stdout)) {
		t.Errorf("at -c 8:\n%s\nat -c 1:\n%s", eight.stdout, one.stdout)
	}
}

func TestCrawlQueuesNoLinkPastTheQueueBytes(t *testing.T) {
	run := crawlHome(wide, 1, 10_000, collections.ChunkBytes)
	if n := pages(run.stdout); n <= 500 || n >= 700 { // one 64 KiB chunk holds about 600 of them
		t.Errorf("pages: %d", n)
	}
}

type FailingWriter struct {
	err         error
	afterWrites int
	writes      int
}

func (w *FailingWriter) Write(p []byte) (int, error) {
	if w.afterWrites > 0 && w.writes < w.afterWrites {
		w.writes++
		return len(p), nil
	}
	return 0, w.err
}

func TestCrawlStopsWhenStdoutFails(t *testing.T) {
	tests := []struct {
		err  error
		code int
	}{{errors.New("no space left on device"), 1}, {syscall.EPIPE, 0}, {syscall.ECONNRESET, 0}}
	for _, tt := range tests {
		var stderr strings.Builder
		code := newCrawler(home, 1, 100).crawl(site, &FailingWriter{err: tt.err}, &stderr, &signals.Signals{})
		// an error after the summary (DESIGN §2); a pipe closed by its reader, a clean end
		if said := strings.HasSuffix(stderr.String(), "error: cannot write output\n"); code != tt.code || said != (tt.code == 1) {
			t.Errorf("for %v: exit %d, stderr %q; want exit %d, and a message only for 1", tt.err, code, stderr.String(), tt.code)
		}
	}
}

func TestCrawlReportsAFailedLastFlush(t *testing.T) {
	var stderr strings.Builder
	code := newCrawler(home, 1, 100).crawl(site, &FailingWriter{err: errors.New("no space left on device"), afterWrites: 1}, &stderr, &signals.Signals{})
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.HasSuffix(stderr.String(), "error: cannot write output\n") {
		t.Fatalf("stderr %q; want ending with error: cannot write output\n", stderr.String())
	}
}

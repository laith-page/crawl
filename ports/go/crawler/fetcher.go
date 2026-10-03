package main

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"go.l3.ai/html/hrefs"
	"go.l3.ai/whatwg-url/href"
)

type Fetcher struct {
	http      *Http
	timeout   time.Duration
	throttle  *Throttle
	userAgent string
	requests  sync.Pool
}

type Request struct {
	req      *http.Request
	deadline *Deadline
	buffer   []byte
	url      url.URL
}

type Attempt struct {
	page  Page
	retry time.Duration
}

func newFetcher(tls *Tls, concurrency int, timeout time.Duration, throttle *Throttle, userAgent string) *Fetcher {
	fetcher := &Fetcher{http: newHttp(tls, concurrency), timeout: timeout, throttle: throttle, userAgent: userAgent}
	fetcher.requests.New = func() any {
		deadline := newDeadline()
		request, _ := http.NewRequestWithContext(deadline, http.MethodGet, "/", nil)
		request.Header = http.Header{"User-Agent": {fetcher.userAgent}, "Accept": {"*/*"}, "Accept-Encoding": {"gzip, deflate"}}
		return &Request{req: request, deadline: deadline, buffer: make([]byte, 64<<10)}
	}
	return fetcher
}

func (fetcher *Fetcher) fetch(rawURL string) Page {
	request := fetcher.requests.Get().(*Request)
	defer fetcher.requests.Put(request)
	scheme, host, _ := strings.Cut(href.Origin(rawURL), "://")
	path := href.PathAndQuery(rawURL)
	parsed := &request.url
	*parsed = url.URL{Scheme: scheme, Host: host, Opaque: path}
	if strings.HasPrefix(path, "//") {
		trimmed, query, hasQuery := strings.Cut(path, "?")
		parsed.Opaque, parsed.RawPath, parsed.RawQuery, parsed.ForceQuery = "", trimmed, query, hasQuery && query == ""
		parsed.Path, _ = url.PathUnescape(trimmed)
	}
	request.req.URL, request.req.Host = parsed, host

	fetcher.throttle.start()
	request.deadline.arm(fetcher.timeout)
	defer request.deadline.disarm()
	deadline, _ := request.deadline.Deadline()
	for retries := 0; ; retries++ {
		attempt := fetcher.attempt(request, rawURL, retries)
		wait := attempt.retry
		if wait == noRetry || wait >= time.Until(deadline) {
			return attempt.page
		}
		fetcher.throttle.retry(wait)
		if time.Until(deadline) <= 0 {
			return attempt.page
		}
	}
}

func (fetcher *Fetcher) attempt(request *Request, rawURL string, retries int) Attempt {
	status, failure := 0, FailureTimeout
	if resp, err := fetcher.http.get(request); err == nil {
		defer resp.close()
		status = resp.status()
		retry := afterStatus(status, resp.retryAfterSeconds(), retries)
		if retry != noRetry {
			resp.skipBody()
			return Attempt{page: newPageResponse(rawURL, status, nil), retry: retry}
		}
		if found, err := fetcher.links(rawURL, &resp); err == nil {
			return Attempt{page: newPageResponse(rawURL, status, found), retry: retry}
		} else if request.deadline.Err() == nil {
			failure = newFailureOf(err)
		}
	} else if request.deadline.Err() == nil {
		failure = newFailureOf(err)
	}
	retry := afterFailure(failure, status, retries)
	return Attempt{page: newPageFailed(rawURL, status, failure), retry: retry}
}

func (fetcher *Fetcher) links(rawURL string, resp *Response) ([]string, error) {
	status := resp.status()
	if wantsBody(status, resp.contentType()) {
		found := newLinks(rawURL)
		if err := resp.body(found.feed); err != nil {
			return nil, err
		}
		return found.end(), nil
	}
	defer resp.skipBody()
	if locationHeader := resp.location(); status/100 == 3 && locationHeader != "" {
		return location(rawURL, locationHeader), nil
	}
	return nil, nil
}

// location resolves a redirect Location header as an href.
func location(page, header string) []string {
	if to, ok := resolve(page, header); ok {
		return []string{to}
	}
	return nil
}

func wantsBody(status int, contentType string) bool {
	return status/100 == 2 && status != http.StatusNoContent && hrefs.IsHTML(contentType)
}

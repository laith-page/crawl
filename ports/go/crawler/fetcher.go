package main

import (
	"crypto/tls"
	"errors"
	"time"

	"go.l3.ai/certs"
	"go.l3.ai/html/hrefs"
	"go.l3.ai/http"
	"go.l3.ai/pacing"
)

const maxBodyBytes = 5 << 20
const drainLimitBytes = 64 << 10

type Fetcher struct {
	http          *http.Client
	timeout       time.Duration
	pacer         *pacing.Pacer
	sharedRetries bool
}

type Attempt struct {
	page    Page
	retry   time.Duration
	retryOk bool
}

func newFetcher(options Options, certFile string) *Fetcher {
	config := certs.ClientConfig(certFile)
	config.CurvePreferences = []tls.CurveID{tls.X25519, tls.CurveP256} // DESIGN §5
	client := http.New(http.Options{UserAgent: options.userAgent, MaxConnections: options.concurrency, TLS: config})
	return &Fetcher{
		http:          client,
		timeout:       time.Duration(options.timeoutSeconds) * time.Second,
		pacer:         pacing.New(time.Duration(options.delayMillis) * time.Millisecond),
		sharedRetries: !options.fast,
	}
}

func (fetcher *Fetcher) waitToRetry(wait time.Duration) {
	if fetcher.sharedRetries {
		fetcher.pacer.Postpone(wait)
		fetcher.pacer.Acquire()
	} else if wait > 0 {
		time.Sleep(wait)
	}
}

func (fetcher *Fetcher) fetch(rawURL string) Page {
	fetcher.pacer.Acquire()
	deadline := time.Now().Add(fetcher.timeout)

	for retries := 0; ; retries++ {
		attempt := fetcher.attempt(rawURL, deadline, retries)
		if !attempt.retryOk || attempt.retry >= time.Until(deadline) {
			return attempt.page
		}
		fetcher.waitToRetry(attempt.retry)
		if time.Until(deadline) <= 0 {
			return attempt.page
		}
	}
}

func (fetcher *Fetcher) attempt(rawURL string, deadline time.Time, retries int) Attempt {
	resp, err := fetcher.http.Get(rawURL, deadline)
	if err != nil {
		return fetcher.failedAttempt(rawURL, err, retries)
	}
	defer resp.Close()
	status := resp.Status()
	retryAfter, given := resp.RetryAfter()
	if retry, ok := afterStatus(status, retries, retryAfter, given); ok {
		resp.Discard(drainLimitBytes)
		return Attempt{page: newPageResponse(rawURL, status, nil), retry: retry, retryOk: true}
	}
	found, err := fetcher.links(rawURL, resp)
	if err != nil {
		return fetcher.failedAttempt(rawURL, err, retries)
	}
	return Attempt{page: newPageResponse(rawURL, status, found)}
}

func (fetcher *Fetcher) failedAttempt(rawURL string, err error, retries int) Attempt {
	var failed *http.Error
	status := 0
	if errors.As(err, &failed) {
		status = failed.Status
	}
	failure := newFailureOf(failed.Kind)
	retry, ok := afterFailure(failure, status, retries)
	return Attempt{page: newPageFailed(rawURL, status, failure), retry: retry, retryOk: ok}
}

func (fetcher *Fetcher) links(rawURL string, resp *http.Response) ([]string, error) {
	status := resp.Status()
	if wantsBody(status, resp.ContentType()) {
		found := newLinks(rawURL)
		if err := resp.Body(maxBodyBytes, found.feed); err != nil {
			return nil, err
		}
		return found.end(), nil
	}
	defer resp.Discard(drainLimitBytes)
	if locationHeader := resp.Location(); status/100 == 3 && locationHeader != "" {
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
	return status/100 == 2 && status != 204 && hrefs.IsHTML(contentType)
}

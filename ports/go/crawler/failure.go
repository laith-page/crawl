package main

import (
	"go.l3.ai/http"
)

// Failure is why a fetch failed: the error categories of DESIGN §1, each printed as its label. 0 is
// no failure.
type Failure uint8

const (
	FailureTimeout Failure = iota + 1
	FailureDNSFailed
	FailureConnectFailed
	FailureTLSFailed
	FailureBodyOverLimit
	FailureConnectionReset
	FailureMalformedResponse
)

// label is what the contract prints after "error: ", the same words in every engine.
func (failure Failure) label() string {
	return [...]string{
		FailureTimeout:           "timeout",
		FailureDNSFailed:         "dns failed",
		FailureConnectFailed:     "connect failed",
		FailureTLSFailed:         "tls failed",
		FailureBodyOverLimit:     "body over 5 MiB",
		FailureConnectionReset:   "connection reset",
		FailureMalformedResponse: "malformed response",
	}[failure]
}

// isUnreachable is whether the host is out of reach: what the dead-host counter counts (DESIGN §5).
func (failure Failure) isUnreachable() bool {
	return failure == FailureConnectFailed || failure == FailureDNSFailed
}

// hidesStatus is whether the page prints no status: a timed-out or malformed response (DESIGN §1).
func (failure Failure) hidesStatus() bool {
	return failure == FailureTimeout || failure == FailureMalformedResponse
}

func newFailureOf(kind http.Kind) Failure {
	switch kind {
	case http.KindTimeout, http.KindInterrupted:
		return FailureTimeout
	case http.KindDNS:
		return FailureDNSFailed
	case http.KindConnect:
		return FailureConnectFailed
	case http.KindTLS:
		return FailureTLSFailed
	case http.KindBodyLimit:
		return FailureBodyOverLimit
	case http.KindReset:
		return FailureConnectionReset
	}
	return FailureMalformedResponse
}

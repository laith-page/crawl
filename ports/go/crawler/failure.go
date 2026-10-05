package main

import (
	"errors"
	"net"
	"net/textproto"
	"slices"
	"strings"
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

// malformedWords are what net/http says when it refuses a response, which it gives no type.
var malformedWords = []string{"malformed", "Content-Length", "chunk", "transfer encoding", "headers exceeded", "header line too long", "PROTOCOL_ERROR"}

// newFailureOf is err's category: the one table from the client's and the OS's errors to the
// contract's.
func newFailureOf(err error) Failure {
	var dns *net.DNSError
	var dial *net.OpError
	var handshake TlsError
	var header *textproto.ProtocolError
	switch {
	case errors.Is(err, errBodyOverLimit):
		return FailureBodyOverLimit
	case errors.As(err, &handshake):
		return FailureTLSFailed
	case errors.As(err, &dns):
		return FailureDNSFailed
	case errors.As(err, &dial) && dial.Op == "dial":
		return FailureConnectFailed
	case errors.As(err, &header) || slices.ContainsFunc(malformedWords, func(w string) bool { return strings.Contains(err.Error(), w) }):
		return FailureMalformedResponse
	}
	return FailureConnectionReset // closed or reset, before a status line or mid-body, and whatever else
}

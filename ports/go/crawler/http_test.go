package main

import (
	"math"
	"strings"
	"testing"
)

func TestARetryAfterOfTooManyDigitsIsTheLongestWaitNotAnInvalidOne(t *testing.T) {
	for value, want := range map[string]int64{
		"120":                           120,
		"18446744073709551615":          math.MaxInt64,
		"18446744073709551616":          math.MaxInt64,
		strings.Repeat("9", 10_000):     math.MaxInt64,
		"":                              -1,
		"1.5":                           -1,
		"-1":                            -1,
		"+1":                            -1,
		" 1":                            -1,
		"Wed, 21 Oct 2099 07:28:00 GMT": -1,
	} {
		if got := retryAfter(value); got != want {
			t.Errorf("retryAfter(%.20q) = %d, want %d", value, got, want)
		}
	}
}

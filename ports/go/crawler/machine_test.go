package main

import (
	"testing"
)

func TestCpusOverrides(t *testing.T) {
	m := detect(4)
	if m.cpus != 4 || m.threads != 3 || m.maxConcurrency != 72 {
		t.Errorf("got %+v, want cpus=4, threads=3, maxConcurrency=72", m)
	}
}

func TestDerivesThreadsAndMaxConcurrency(t *testing.T) {
	m2 := detect(2)
	if m2.cpus != 2 || m2.threads != 2 {
		t.Errorf("got %+v, want cpus=2, threads=2", m2)
	}

	m8 := detect(8)
	if m8.cpus != 8 || m8.threads != 7 {
		t.Errorf("got %+v, want cpus=8, threads=7", m8)
	}

	mClamped := detect(32)
	if mClamped.maxConcurrency != 256 {
		t.Errorf("got maxConcurrency=%d, want 256 clamp", mClamped.maxConcurrency)
	}
}

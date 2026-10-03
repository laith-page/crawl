package main

import (
	"fmt"
	"strings"
	"testing"

	"go.l3.ai/collections"
)

func TestPushDropsALinkTheFullSeenSetRefuses(t *testing.T) {
	f := newFrontierWithSeen(home, 1_000_000, roomy, collections.NewHashes(0)) // 1,024 slots, full at 768
	for i := range 1000 {
		f.push(fmt.Sprintf("%s%d", home, i))
	}
	// The start URL and 767 links: the rest are neither remembered nor queued
	if f.seen.Size() != 768 || f.queued() != 768 {
		t.Errorf("seen holds %d links and %d are queued; want 768 and 768", f.seen.Size(), f.queued())
	}
}

func TestPushRemembersNoLinkTheQueueTurnsAway(t *testing.T) {
	f := newFrontierWithSeen(home, 1_000_000, 2*collections.ChunkBytes, collections.NewHashes(1_000_000))
	name := strings.Repeat("x", 2000)
	for i := range 200 {
		f.push(fmt.Sprintf("%s%d-%s", home, i, name))
	}
	if held := f.queued(); held < 60 || held > 70 {
		t.Fatalf("held %d of 200 links; want about 64", held)
	}
	for range 10 {
		f.pop()
	}
	f.push(fmt.Sprintf("%s%d-%s", home, 199, name)) // turned away before, so not remembered
	if f.seen.Size() != f.queued()+10 {
		t.Errorf("seen holds %d links, but %d were queued", f.seen.Size(), f.queued()+10)
	}
}

func TestPushKeepsOnlyLinksOnTheStartHost(t *testing.T) {
	frontier := newFrontier(home, 100)
	// the start origin as a prefix, another host
	for _, other := range []string{"http://example.com.evil.test/", "http://example.com@evil.test/", "http://other.test/"} {
		frontier.push(other)
	}
	if got := frontier.queued(); got != 1 {
		t.Fatalf("queued %d after links to other hosts, want 1", got)
	}
	for _, same := range []string{"http://example.com:8080/", "https://example.com/a", home + "b"} {
		frontier.push(same)
	}
	if got := frontier.queued(); got != 4 {
		t.Fatalf("queued %d, want 4", got)
	}
}

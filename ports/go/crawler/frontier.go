package main

import (
	"math/rand/v2"

	"go.l3.ai/collections"
	"go.l3.ai/hashing"
	"go.l3.ai/whatwg-url/href"
)

const maxQueueBytes = 128 << 20

type Frontier struct {
	host            string
	authorityPrefix string
	maxPages        int
	seed            uint64
	queue           *collections.UniqueQueue
	popped          int
}

func newFrontier(start string, maxPages int) *Frontier {
	return newFrontierWithQueue(start, maxPages, nil)
}

func newFrontierWithQueue(start string, maxPages int, queue *collections.UniqueQueue) *Frontier {
	authorityPrefix := href.AuthorityPrefix(start)
	if queue == nil {
		queue = collections.NewUniqueQueue(authorityPrefix, maxPages, maxQueueBytes)
	}
	frontier := &Frontier{
		host: href.Host(start), authorityPrefix: authorityPrefix, maxPages: maxPages,
		seed: rand.Uint64(), queue: queue,
	}
	frontier.queue.Offer(frontier.hash(start), start)
	return frontier
}

func (frontier *Frontier) pop() (string, bool) {
	if frontier.popped >= frontier.maxPages || frontier.queue.Size() == 0 {
		return "", false
	}
	frontier.popped++
	return frontier.queue.Pop()
}

func (frontier *Frontier) push(link string) {
	if frontier.popped+frontier.queue.Size() >= frontier.maxPages {
		return
	}
	if !href.HasAuthorityPrefix(link, frontier.authorityPrefix) && !href.HostEquals(link, frontier.host) {
		return
	}
	frontier.queue.Offer(frontier.hash(link), link)
}

func (frontier *Frontier) queued() int { return frontier.queue.Size() }

func (frontier *Frontier) hash(rawURL string) uint64 { return hashing.Xxh3(rawURL, frontier.seed) }

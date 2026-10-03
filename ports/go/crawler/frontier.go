package main

import (
	"hash/maphash"
	"strings"

	"go.l3.ai/collections"
	"go.l3.ai/whatwg-url/href"
)

const maxQueueBytes = 128 << 20

type Frontier struct {
	host     string
	origin   string
	maxPages int
	seen     collections.Hashes
	seed     maphash.Seed
	queue    *collections.PackedQueue
	popped   int
}

func newFrontier(start string, maxPages int) *Frontier {
	return newFrontierWithSeen(start, maxPages, maxQueueBytes, collections.NewHashes(maxPages))
}

func newFrontierWithSeen(start string, maxPages int, maxQueueBytes int64, seen collections.Hashes) *Frontier {
	origin := href.Origin(start)
	frontier := &Frontier{
		host: href.Host(start), origin: origin, maxPages: maxPages,
		seen: seen, seed: maphash.MakeSeed(), queue: collections.NewPackedQueue(origin, maxQueueBytes),
	}
	frontier.seen.Insert(frontier.hash(start))
	frontier.queue.Push(start)
	return frontier
}

func (frontier *Frontier) pop() (string, bool) {
	if frontier.popped >= frontier.maxPages || frontier.queue.Size() == 0 {
		return "", false
	}
	frontier.popped++
	return frontier.queue.Pop(), true
}

func (frontier *Frontier) push(link string) {
	if frontier.popped+frontier.queue.Size() >= frontier.maxPages {
		return
	}
	if strings.HasPrefix(link, frontier.origin) {
		rest := link[len(frontier.origin):]
		if rest != "" && rest[0] != '/' && rest[0] != '?' {
			if !href.HostEquals(link, frontier.host) {
				return
			}
		}
	} else if !href.HostEquals(link, frontier.host) {
		return
	}
	hash := frontier.hash(link)
	if !frontier.seen.Contains(hash) && !frontier.seen.Full() && frontier.queue.Push(link) {
		frontier.seen.Insert(hash)
	}
}

func (frontier *Frontier) queued() int { return frontier.queue.Size() }

func (frontier *Frontier) hash(rawURL string) uint64 { return maphash.String(frontier.seed, rawURL) }

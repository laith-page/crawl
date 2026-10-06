package main

import (
	"go.l3.ai/html/hrefs"
	whatwgurl "go.l3.ai/whatwg-url"
)

const maxLinks = 1000
const maxLinkBytes = 256 << 10

// Links collects one page's anchors while its body streams in.
type Links struct {
	base  whatwgurl.Base
	hrefs hrefs.Hrefs
	found []string
	seen  map[string]struct{} // made at 16 links: below that, found is scanned
	bytes int
	done  bool
}

func newLinks(page string) *Links {
	base, ok := whatwgurl.NewBase(page)
	return &Links{base: base, done: !ok}
}

func (links *Links) feed(chunk []byte) {
	if links.done {
		return
	}
	links.hrefs.Feed(chunk)
	links.collect()
}

func (links *Links) end() []string {
	if !links.done {
		links.hrefs.End()
		links.collect()
	}
	return links.found
}

func (links *Links) collect() {
	contains := func(href []byte) bool {
		if links.seen != nil {
			_, dup := links.seen[string(href)]
			return dup
		}
		for _, f := range links.found {
			if f == string(href) {
				return true
			}
		}
		return false
	}

	for !links.done {
		value, ok := links.hrefs.Next()
		if !ok {
			return
		}
		resolved, ok := links.base.Join(value)
		if !ok || !crawlable(&resolved) {
			continue
		}
		href := resolved.HrefWithoutFragment()
		if len(href) > maxBytes || contains(href) {
			continue
		}
		link := resolved.String()
		// A URL in the form is ASCII, so byte count is character length.
		if links.bytes+len(link) > maxLinkBytes {
			links.done = true
			return
		}
		if links.seen != nil {
			links.seen[link] = struct{}{}
		}
		links.found = append(links.found, link)
		if links.seen == nil && len(links.found) == 16 {
			links.seen = make(map[string]struct{}, 32)
			for _, f := range links.found {
				links.seen[f] = struct{}{}
			}
		}
		links.bytes += len(link)
		links.done = len(links.found) == maxLinks
	}
}

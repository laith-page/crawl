package main

import (
	"slices"

	"go.l3.ai/html/hrefs"
	whatwgurl "go.l3.ai/whatwg-url"
)

const maxLinks = 1000
const maxLinkBytes = 256 << 10

// Links collects one page's anchors while its body streams in.
type Links struct {
	base   whatwgurl.URL
	origin string
	hrefs  hrefs.Hrefs
	found  []string
	seen   map[string]struct{} // made at 16 links: below that, found is scanned
	bytes  int
	done   bool
	buf    [512]byte
}

func newLinks(page string) *Links {
	base, ok := whatwgurl.FromHref(page)
	origin := ""
	if ok {
		origin = base.Origin()
	}
	return &Links{base: base, origin: origin, done: !ok}
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
	isDup := func(cand string) bool {
		if links.seen != nil {
			_, dup := links.seen[cand]
			return dup
		}
		return slices.Contains(links.found, cand)
	}

	for !links.done {
		value, ok := links.hrefs.Next()
		if !ok {
			return
		}
		var link string
		if whatwgurl.IsSimplePathAbsolute(value) {
			total := len(links.origin) + len(value)
			if total > maxBytes {
				continue
			}
			if total <= len(links.buf) {
				n := copy(links.buf[:], links.origin)
				copy(links.buf[n:], value)
				if isDup(string(links.buf[:total])) {
					continue
				}
				link = string(links.buf[:total])
			} else {
				cand := links.origin + string(value)
				if isDup(cand) {
					continue
				}
				link = cand
			}
		} else {
			var valid bool
			link, valid = resolveOn(&links.base, string(value))
			if !valid || isDup(link) {
				continue
			}
		}
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

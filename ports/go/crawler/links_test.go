package main

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

// The map finds a repeat as a scan does: first seen first kept, on the stack and once sized, up to
// maxLinks distinct, whether the href takes the rooted fast path or not.
func TestExtractKeepsEachLinkOnceInDocumentOrder(t *testing.T) {
	const page = "http://example.com/d/"
	var html []byte
	var want []string
	for i := range 1500 {
		for _, href := range []string{fmt.Sprintf("/%d", i%7), fmt.Sprintf("x%d", i), fmt.Sprintf("/%d", i/2)} {
			html = fmt.Appendf(html, "<a href=%q>", href)
			if url, _ := resolve(page, href); len(want) < maxLinks && !slices.Contains(want, url) {
				want = append(want, url)
			}
		}
	}
	if got := extract(html, page); !slices.Equal(got, want) || len(got) != maxLinks {
		t.Errorf("extract kept %d links, not the %d a scan keeps", len(got), len(want))
	}
}

// A simple path joined past 8,000 bytes is no link, whether its path is looked up first or not.
func TestAJoinedLinkPastTheByteLimitIsNoLink(t *testing.T) {
	const page = "http://example.com/d/"
	rooted := "/" + strings.Repeat("r", maxBytes-len("http://example.com/"))
	relative := strings.Repeat("l", maxBytes-len(page))
	html := "<a href=" + rooted + "><a href=" + rooted + "r><a href=" + relative + "><a href=" + relative + "l>"
	if got, want := extract([]byte(html), page), []string{"http://example.com" + rooted, page + relative}; !slices.Equal(got, want) {
		t.Errorf("got %d links, want the two of 8,000 bytes", len(got))
	}
}

// Every prefix of a document of every construct, and 20,000 of random pieces: links in the form, printable.
func TestExtractReturnsOnlyPrintableLinks(t *testing.T) {
	page := "http://example.com/dir/page"
	doc := `<html><head><base href="/b/"><title><a href="/t"></title><style>a{}</style></head><body>
<!-- <a href="/c"> --><script>'<a href="/s">'</script><a title='x>y' href="q?a=1&amp;b=&#x32;">
<a HREF=/u>u</a><textarea><a href=/ta></textarea><a href="https://other.example#f">o</a>`
	for end := 0; end <= len(doc); end++ {
		expectPrintable(t, []byte(doc[:end]), page)
	}
	pieces := []string{"<a href=", "<A HREF='", "<base href=\"", "\"", "'", ">", "<", "/", " ", "\n", "\x00",
		"&amp;", "&#x", "&#", ";", "<!--", "-->", "<script>", "</script", "<title", "</textarea>", "http://",
		"https://h/", "//", "?", "#", "..", "%", "[", "]", ":", "@", "=", "\\", "\xe9", "\xc3\xa9", "^", "{"}
	random := rand.New(rand.NewPCG(0x5eed, 0))
	for range 20_000 {
		var html []byte
		for len(html) < 496 {
			if random.IntN(2) == 0 {
				html = append(html, pieces[random.IntN(len(pieces))]...)
			} else {
				html = append(html, byte(random.IntN(256)))
			}
			if random.IntN(64) == 0 {
				break
			}
		}
		expectPrintable(t, html, page)
	}
}

func expectPrintable(t *testing.T, html []byte, page string) {
	t.Helper()
	found := extract(html, page)
	if len(found) > maxLinks {
		t.Fatalf("%d links", len(found))
	}
	for _, url := range found {
		printable := utf8.ValidString(url) && !strings.ContainsFunc(url, func(r rune) bool { return r <= ' ' || r >= 0x7f })
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") || len(url) > maxBytes || !printable {
			t.Fatalf("%q from %q", url, html)
		}
	}
}

func extract(html []byte, page string) []string {
	links := newLinks(page)
	links.feed(html)
	return links.end()
}

func TestAByteAtATimeFindsTheSameLinks(t *testing.T) {
	const page = "http://example.com/dir/page"
	doc := []byte(`<a href="/first">one</a><!-- <a href="/hidden"> --><script>"<a href=/hidden2>"</script><a href="next?a=1&amp;b=2">two</a>`)
	whole := extract(doc, page)
	links := newLinks(page)
	for _, b := range doc {
		links.feed([]byte{b})
	}
	if got := links.end(); !slices.Equal(got, whole) {
		t.Fatalf("bytewise links = %q, whole links = %q", got, whole)
	}
}

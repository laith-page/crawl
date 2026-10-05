package main

import (
	"bytes"
	"strconv"
)

type Page struct {
	url     string
	status  int
	failure Failure
	links   []string
}

func newPageResponse(url string, status int, links []string) Page {
	return Page{url: url, status: status, links: links}
}
func newPageFailed(url string, status int, failure Failure) Page {
	if failure.hidesStatus() {
		status = 0
	}
	return Page{url: url, status: status, failure: failure}
}
func (page Page) isFailure() bool   { return page.failure != 0 }
func (page Page) unreachable() bool { return page.failure.isUnreachable() }
func (page Page) writeTo(out *bytes.Buffer) {
	out.WriteString(page.url)
	if page.status != 0 {
		out.WriteByte(' ')
		out.WriteString(strconv.Itoa(page.status))
	}
	if page.failure != 0 {
		out.WriteString(" error: ")
		out.WriteString(page.failure.label())
	}
	out.WriteByte('\n')
}

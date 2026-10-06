package main

import whatwgurl "go.l3.ai/whatwg-url"

const maxBytes = 8000

func startURL(url string) (string, bool) {
	parsed, ok := whatwgurl.Parse(url, nil)
	if !ok || !crawlable(&parsed) {
		return "", false
	}
	href := parsed.HrefWithoutFragment()
	if len(href) <= maxBytes {
		return href, true
	}
	return "", false
}

func resolve(base, ref string) (string, bool) {
	if parsed, ok := whatwgurl.Parse(base, nil); ok {
		return resolveAgainst(&parsed, ref)
	}
	return "", false
}

func resolveAgainst(page *whatwgurl.URL, ref string) (string, bool) {
	parsed, ok := page.Parse(ref)
	if !ok || !crawlable(&parsed) {
		return "", false
	}
	href := parsed.HrefWithoutFragment()
	if len(href) <= maxBytes {
		return href, true
	}
	return "", false
}

func crawlable(c interface {
	IsScheme(string) bool
	HasCredentials() bool
}) bool {
	return (c.IsScheme("http") || c.IsScheme("https")) && !c.HasCredentials()
}

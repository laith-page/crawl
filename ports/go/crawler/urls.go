package main

import whatwgurl "go.l3.ai/whatwg-url"

const maxBytes = 8000

func startURL(url string) (string, bool) {
	parsed, ok := whatwgurl.Parse(url, nil)
	return inForm(&parsed, ok)
}
func resolve(base, ref string) (string, bool) {
	if parsed, ok := whatwgurl.Parse(base, nil); ok {
		return resolveOn(&parsed, ref)
	}
	return "", false
}
func resolveOn(page *whatwgurl.URL, ref string) (string, bool) {
	parsed, ok := page.Parse(ref)
	return inForm(&parsed, ok)
}
func inForm(url *whatwgurl.URL, ok bool) (string, bool) {
	if ok && (url.Scheme() == "http" || url.Scheme() == "https") && url.Username() == "" && url.Password() == "" {
		if href := url.HrefWithoutFragment(); len(href) <= maxBytes {
			return href, true
		}
	}
	return "", false
}

//! The URL form (DESIGN §4): the WHATWG URL Standard, parsed by the url crate, and the crawler's own rules on top:
//! http and https only, no userinfo, no fragment, 8,000 bytes at most. fixtures/urls.json holds it to that, row for row.

use url::Url;

pub const MAX_BYTES: usize = 8000;

/// A start URL in this form, parsed against nothing.
pub fn start_url(url: &str) -> Option<String> {
    crawlable(Url::parse(url).ok()?).map(String::from)
}

/// Resolves `reference` against `base`, a URL in this form.
#[cfg(test)]
pub fn resolve(base: &str, reference: &str) -> Option<String> {
    resolve_against(&Url::parse(base).ok()?, reference).map(String::from)
}

/// Resolves `reference` against a page parsed once for all its links: the url crate's join, which joins a simple
/// path (most hrefs) without its parser.
pub fn resolve_against(page: &Url, reference: &str) -> Option<Url> {
    let clean = reference
        .split_once('#')
        .map_or(reference, |(head, _)| head);
    crawlable(page.join(clean).ok()?)
}

fn crawlable(mut url: Url) -> Option<Url> {
    let ok = matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none();
    if !ok {
        return None;
    }
    if url.fragment().is_some() {
        url.set_fragment(None);
    }
    (url.as_str().len() <= MAX_BYTES).then_some(url)
}

#[cfg(test)]
#[path = "urls_test.rs"]
mod tests;

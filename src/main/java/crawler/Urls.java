package crawler;

import ai.l3.whatwgurl.Url;

final class Urls {

    static final int MAX_BYTES = 8000;

    static String startUrl(String url) {
        return inForm(Url.parse(url));
    }

    static String resolve(String base, String ref) {
        Url page = Url.parse(base);
        return page != null ? resolveOn(page, ref) : null;
    }

    // Fast path: bypasses parser for simple absolute paths (/path) via direct origin string concat.
    static String onOrigin(String origin, String path) {
        return origin.length() + path.length() <= MAX_BYTES ? origin.concat(path) : null;
    }

    static String resolveOn(Url page, String ref) {
        if (Url.isSimplePathAbsolute(ref)
                && (page.isScheme("http") || page.isScheme("https"))
                && !page.hasCredentials()) {
            return onOrigin(page.origin(), ref);
        }
        return inForm(Url.parse(ref, page));
    }

    private static String inForm(Url url) {
        if (url == null || (!url.isScheme("http") && !url.isScheme("https")) || url.hasCredentials()) return null;
        String href = url.hrefWithoutFragment();
        return href.length() > MAX_BYTES ? null : href;
    }
}

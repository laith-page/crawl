package crawler;

import ai.l3.whatwgurl.Url;

final class Urls {

    static final int MAX_BYTES = 8000;

    static String startUrl(String url) {
        return crawlable(Url.parse(url));
    }

    static String resolve(String base, String ref) {
        Url page = Url.parse(base);
        if (page == null) return null;
        return resolveAgainst(page, ref);
    }

    static String resolveAgainst(Url page, String ref) {
        return crawlable(Url.parse(ref, page));
    }

    private static String crawlable(Url url) {
        if (url == null) return null;
        boolean http = url.isScheme("http") || url.isScheme("https");
        if (!http || url.hasCredentials()) return null;
        String href = url.hrefWithoutFragment();
        if (href.length() > MAX_BYTES) return null;
        return href;
    }
}

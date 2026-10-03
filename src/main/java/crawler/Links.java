package crawler;

import ai.l3.html.Hrefs;
import ai.l3.whatwgurl.Href;
import ai.l3.whatwgurl.Url;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class Links {

    static final int MAX_LINKS = 1000, MAX_LINK_BYTES = 256 << 10;
    private static volatile String cachedOrigin;

    private final String page;
    private final String origin;
    private final long bodyLimit;
    private final Hrefs hrefs = new Hrefs();
    private final List<String> found = new ArrayList<>(4);
    private Url base; // the page parsed, when an href first needs the parser
    private Set<String> seen;
    private int bytes;
    private long bodyRead;
    private boolean done;

    Links(String page) {
        this(page, Long.MAX_VALUE);
    }

    Links(String page, long bodyLimit) {
        this.page = Objects.requireNonNull(page, "page URL in canonical form");
        String cur = cachedOrigin;
        if (cur != null && Href.hasOrigin(page, cur)) {
            this.origin = cur;
        } else {
            this.origin = Href.origin(page);
            cachedOrigin = this.origin;
        }
        this.bodyLimit = bodyLimit;
    }

    /** Scans the next bytes of the page. */
    void feed(byte[] chunk, int length) {
        if (done) return;
        if (bodyRead < bodyLimit) {
            hrefs.feed(chunk, (int) Math.min(length, bodyLimit - bodyRead));
            collect();
        }
        bodyRead += length;
    }

    /** The links found, in document order, once the whole body is fed. */
    List<String> end() {
        if (!done) {
            hrefs.end();
            collect();
        }
        return found;
    }

    // Streaming link extraction:
    //   HTML bytes ──feed──> Hrefs tokenizer ──next──> href string
    //                                                     │
    //      ┌─────────── isSimplePathAbsolute? ────────────┤
    //      ▼ (fast string concat)                         ▼ (WHATWG parser)
    //   origin + path                                  Urls.resolveOn
    private void collect() {
        for (String href; !done && (href = hrefs.next()) != null; ) {
            String link;
            if (Url.isSimplePathAbsolute(href)) {
                link = Urls.onOrigin(origin, href);
            } else {
                if (base == null) base = Objects.requireNonNull(Url.fromHref(page), "page URL in canonical form");
                link = Urls.resolveOn(base, href);
            }
            if (link == null) continue;
            // Small pages (<16 links) use linear scan; allocate HashSet only when larger.
            if (seen != null) {
                if (!seen.add(link)) continue;
            } else if (found.contains(link)) {
                continue;
            }
            // Links in canonical form are ASCII, so chars equal bytes.
            if (bytes + link.length() > MAX_LINK_BYTES) {
                if (seen != null) seen.remove(link);
                done = true;
                return;
            }
            found.add(link);
            if (seen == null && found.size() == 16) {
                seen = new HashSet<>(found);
            }
            bytes += link.length();
            done = found.size() == MAX_LINKS;
        }
    }
}

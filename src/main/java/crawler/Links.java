package crawler;

import ai.l3.html.Hrefs;
import ai.l3.whatwgurl.Url;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class Links {

    static final int MAX_LINKS = 1000, MAX_LINK_BYTES = 256 << 10;

    private final Url page;
    private final Hrefs hrefs = new Hrefs();
    private final Set<String> found = new LinkedHashSet<>();
    private int bytes;
    private boolean done;

    Links(String page) {
        this.page = Objects.requireNonNull(Url.fromHref(page), "page URL in canonical form");
    }

    void feed(byte[] chunk, int length) {
        if (done) return;
        hrefs.feed(chunk, length);
        collect();
    }

    List<String> end() {
        if (!done) {
            hrefs.end();
            collect();
        }
        return List.copyOf(found);
    }

    private void collect() {
        while (!done) {
            String href = hrefs.next();
            if (href == null) return;
            String link = Urls.resolveAgainst(page, href);
            if (link == null || found.contains(link)) continue;
            if (bytes + link.length() > MAX_LINK_BYTES) {
                done = true;
                return;
            }
            found.add(link);
            bytes += link.length();
            done = found.size() == MAX_LINKS;
        }
    }
}

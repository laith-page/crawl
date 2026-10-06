package crawler;

import ai.l3.collections.UniqueQueue;
import ai.l3.hashing.Xxh3;
import ai.l3.whatwgurl.Href;
import java.util.concurrent.ThreadLocalRandom;

// Compact memory frontier:
//   queue : UniqueQueue (FIFO under byte budget admitting each 64-bit hash once)
final class Frontier {

    static final long MAX_QUEUE_BYTES = 128L << 20;

    private final String host;
    private final String authorityPrefix;
    private final int maxPages;
    private final long seed;
    final UniqueQueue queue;
    private int popped;

    Frontier(String start, int maxPages) {
        this(start, maxPages, null);
    }

    static Frontier withQueue(String start, int maxPages, UniqueQueue queue) {
        return new Frontier(start, maxPages, queue);
    }

    private Frontier(String start, int maxPages, UniqueQueue queue) {
        this.host = Href.host(start);
        this.authorityPrefix = Href.authorityPrefix(start);
        this.maxPages = maxPages;
        this.seed = ThreadLocalRandom.current().nextLong();
        this.queue = queue != null ? queue : new UniqueQueue(this.authorityPrefix, maxPages, MAX_QUEUE_BYTES);
        this.queue.offer(hash(start), start);
    }

    String pop() {
        if (popped >= maxPages || queue.size() == 0) return null;
        popped++;
        return queue.poll();
    }

    void push(String link) {
        if (popped + queue.size() >= maxPages) return;
        if (!Href.hasAuthorityPrefix(link, authorityPrefix) && !Href.hostEquals(link, host)) return;
        queue.offer(hash(link), link);
    }

    int queued() {
        return queue.size();
    }

    private long hash(String url) {
        return Xxh3.hashUtf8(url, seed);
    }
}

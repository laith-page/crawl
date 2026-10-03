package crawler;

import ai.l3.collections.Hashes;
import ai.l3.collections.PackedQueue;
import ai.l3.whatwgurl.Href;
import com.dynatrace.hash4j.hashing.Hasher64;
import com.dynatrace.hash4j.hashing.Hashing;

// Compact memory frontier:
//   seen  : Hashes (XXH3-64 hash set, stores 64-bit primitives to save heap)
//   queue : PackedQueue (byte buffer with common origin prefix stripped)
final class Frontier {

    static final long MAX_QUEUE_BYTES = 128L << 20;

    private final String host;
    private final String origin;
    private final int maxPages;
    private final Hashes seen;
    private final Hasher64 hasher = Hashing.xxh3_64();
    private final PackedQueue queue;
    private int popped;

    Frontier(String start, int maxPages) {
        this(start, maxPages, MAX_QUEUE_BYTES, new Hashes(maxPages));
    }

    private Frontier(String start, int maxPages, long maxQueueBytes, Hashes seen) {
        this.host = Href.host(start);
        this.origin = Href.origin(start);
        this.maxPages = maxPages;
        this.seen = seen;
        this.queue = new PackedQueue(origin, maxQueueBytes);
        this.seen.insert(hash(start));
        this.queue.push(start);
    }

    static Frontier withSeen(String start, int maxPages, long maxQueueBytes, Hashes seen) {
        return new Frontier(start, maxPages, maxQueueBytes, seen);
    }

    String pop() {
        if (popped >= maxPages || queue.size() == 0) return null;
        popped++;
        return queue.pop();
    }

    void push(String link) {
        if (popped + queue.size() >= maxPages) return;
        if (!Href.hasOrigin(link, origin) && !Href.hostEquals(link, host)) return;
        long linkHash = hash(link);
        if (!seen.contains(linkHash) && !seen.full() && queue.push(link)) {
            seen.insert(linkHash);
        }
    }

    int queued() {
        return queue.size();
    }

    private long hash(String url) {
        return hasher.hashCharsToLong(url);
    }
}

package crawler;

import static org.junit.jupiter.api.Assertions.*;

import ai.l3.collections.Hashes;
import ai.l3.collections.PackedQueue;
import org.junit.jupiter.api.Test;

class FrontierTest {

    private static final String HOME = "http://example.com/";
    private static final long ROOMY = 1L << 30; // a queue cap no test reaches

    @Test
    void pushDropsALinkTheFullSeenSetRefuses() {
        var frontier = Frontier.withSeen(HOME, 1_000_000, ROOMY, new Hashes(0));
        for (int i = 0; i < 1000; i++) frontier.push(HOME + i);
        // The start URL and 767 links: the rest are neither remembered nor queued
        assertEquals(768, frontier.queued());
    }

    @Test
    void pushRemembersNoLinkTheQueueTurnsAway() {
        var frontier = Frontier.withSeen(HOME, 1_000_000, 2L * PackedQueue.CHUNK_BYTES, new Hashes(1_000_000));
        String name = "x".repeat(2000);
        for (int i = 0; i < 200; i++) frontier.push(HOME + i + "-" + name);
        int held = frontier.queued();
        assertTrue(held >= 60 && held <= 70, "held " + held + " of 200 links; want about 64");
        while (frontier.pop() != null) {}
        frontier.push(HOME + 199 + "-" + name); // turned away before, so not remembered
        assertEquals(1, frontier.queued());
        frontier.push(HOME + 0 + "-" + name); // accepted before, so remembered
        assertEquals(1, frontier.queued());
    }

    @Test
    void pushKeepsOnlyLinksOnTheStartHost() {
        var frontier = new Frontier(HOME, 100);
        frontier.push("http://example.com.evil.test/"); // the start origin as a prefix, another host
        frontier.push("http://example.com@evil.test/");
        frontier.push("http://other.test/");
        assertEquals(1, frontier.queued());
        frontier.push("http://example.com:8080/"); // same host, other port
        frontier.push("https://example.com/a");
        frontier.push(HOME + "b");
        assertEquals(4, frontier.queued());
    }
}

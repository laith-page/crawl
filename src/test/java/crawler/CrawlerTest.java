package crawler;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.*;

import ai.l3.cli.BlockWriter;
import ai.l3.collections.PackedQueue;
import ai.l3.signals.Signals;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class CrawlerTest {

    private static final String HOME = "http://example.com/";
    private static final long ROOMY = 1L << 30; // a queue cap no test reaches
    private static final String BREADTH_FIRST = """
        http://example.com/ 200
        http://example.com/a 200
        http://example.com/b 200
        http://example.com/c 200
        http://example.com/d 200
        http://example.com/gone 404
        """;

    /** / links to /a, /b and off the host; /a and /b to /c, which links to /; /d to a 404. */
    private static Page site(String url) {
        List<String> links = Map.of(
                        HOME,
                        List.of(HOME + "a", HOME + "b", "http://other.example/"),
                        HOME + "a",
                        List.of(HOME + "c", HOME + "b"),
                        HOME + "b",
                        List.of(HOME + "c", HOME + "d"),
                        HOME + "c",
                        List.of(HOME),
                        HOME + "d",
                        List.of(HOME + "gone"))
                .get(url);
        return links == null ? Page.response(url, 404, List.of()) : Page.response(url, 200, links);
    }

    /** Home links to 3,000 pages of 100-byte names, which no single chunk holds; every other page is a leaf. */
    private static Page wide(String url) {
        if (!url.equals(HOME)) return Page.response(url, 200, List.of());
        String name = "x".repeat(100);
        return Page.response(
                url,
                200,
                IntStream.range(0, 3000).mapToObj(i -> HOME + i + "/" + name).toList());
    }

    private record Crawled(String stdout, String stderr, int code) {}

    private static Crawled crawlHome(Function<String, Page> fetch, int concurrency, int maxPages, long maxQueueBytes)
            throws Exception {
        var stdout = new ByteArrayOutputStream();
        var stderr = new ByteArrayOutputStream();
        int code;
        try (var out = BlockWriter.open(stdout, Crawler.OUTPUT_BUFFER_BYTES)) {
            var frontier = Frontier.withQueue(
                    HOME,
                    maxPages,
                    new ai.l3.collections.UniqueQueue(
                            ai.l3.whatwgurl.Href.authorityPrefix(HOME), maxPages, maxQueueBytes));
            code = new Crawler(HOME, concurrency, frontier, Signals.trap()).crawl(fetch, out, new PrintStream(stderr));
        }
        return new Crawled(stdout.toString(UTF_8), stderr.toString(UTF_8), code);
    }

    private static List<String> sortedLines(String out) {
        return Arrays.stream(out.split("\n")).sorted().toList();
    }

    private static long pages(String out) {
        return out.lines().count();
    }

    @Test
    void crawlIsBreadthFirstInDocumentOrder() throws Exception {
        Crawled one = crawlHome(CrawlerTest::site, 1, 100, ROOMY);
        assertEquals(BREADTH_FIRST, one.stdout());
        assertEquals(0, one.code());
        assertTrue(one.stderr().startsWith("crawled 6 pages in "), one.stderr());
        assertTrue(one.stderr().endsWith("s, 0 errors\n"), one.stderr()); // a 404 is a page, not an error
        Crawled eight = crawlHome(CrawlerTest::site, 8, 100, ROOMY);
        assertEquals(sortedLines(one.stdout()), sortedLines(eight.stdout()));
    }

    @Test
    void crawlQueuesNoLinkPastTheQueueBytes() throws Exception {
        Crawled run = crawlHome(CrawlerTest::wide, 1, 10_000, PackedQueue.CHUNK_BYTES);
        long pages = pages(run.stdout()); // one 64 KiB chunk holds about 600 of them
        assertTrue(pages > 500 && pages < 700, "pages: " + pages);
    }

    @Test
    void crawlStopsWhenStdoutFails() throws Exception {
        var failing = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                throw new IOException("stdout closed");
            }

            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                throw new IOException("stdout closed");
            }
        };
        var stderr = new ByteArrayOutputStream();
        int code;
        try (var out = BlockWriter.open(failing, Crawler.OUTPUT_BUFFER_BYTES)) {
            code = new Crawler(HOME, 1, 100, Signals.trap()).crawl(CrawlerTest::site, out, new PrintStream(stderr));
        }
        assertEquals(1, code);
        assertTrue(stderr.toString(UTF_8).endsWith("error: cannot write output\n"), stderr.toString(UTF_8));
    }

    @Test
    void crawlReportsAFailedLastFlush() throws Exception {
        var failsAfterFirst = new OutputStream() {
            private boolean wrote;

            @Override
            public void write(int b) throws IOException {
                write(new byte[] {(byte) b}, 0, 1);
            }

            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                if (wrote) throw new IOException("No space left on device");
                wrote = true;
            }
        };
        var stderr = new ByteArrayOutputStream();
        int code;
        try (var out = BlockWriter.open(failsAfterFirst, Crawler.OUTPUT_BUFFER_BYTES)) {
            code = new Crawler(HOME, 1, 100, Signals.trap()).crawl(CrawlerTest::site, out, new PrintStream(stderr));
        }
        assertEquals(1, code);
        assertTrue(stderr.toString(UTF_8).endsWith("error: cannot write output\n"), stderr.toString(UTF_8));
    }
}

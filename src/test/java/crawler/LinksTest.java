package crawler;

import static java.nio.charset.StandardCharsets.ISO_8859_1;
import static org.junit.jupiter.api.Assertions.*;

import ai.l3.whatwgurl.Url;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

class LinksTest {

    /** First seen first kept, up to 1,000 distinct, whether the href takes the rooted fast path or not. */
    @Test
    void extractKeepsEachLinkOnceInDocumentOrder() {
        String page = "http://example.com/d/";
        var html = new StringBuilder();
        List<String> want = new ArrayList<>();
        for (int i = 0; i < 1500; i++) {
            for (String href : List.of("/" + i % 7, "x" + i, "/" + i / 2)) {
                html.append("<a href=\"").append(href).append("\">");
                String url = Urls.resolveAgainst(Url.parse(page), href);
                if (want.size() < 1000 && !want.contains(url)) want.add(url);
            }
        }
        assertEquals(1000, want.size());
        assertEquals(want, extract(html.toString().getBytes(ISO_8859_1), page));
    }

    /** The simple-path join is held to the 8,000-byte limit too: joined past it, it is no link. */
    @Test
    void aJoinedLinkPastTheByteLimitIsNoLink() {
        String page = "http://example.com/d/";
        String rooted = "/" + "r".repeat(Urls.MAX_BYTES - "http://example.com/".length());
        String relative = "l".repeat(Urls.MAX_BYTES - page.length());
        String html =
                "<a href=" + rooted + "><a href=" + rooted + "r><a href=" + relative + "><a href=" + relative + "l>";
        assertEquals(List.of("http://example.com" + rooted, page + relative), extract(html.getBytes(ISO_8859_1), page));
    }

    /** Every prefix of a document of every construct, and 20,000 of random pieces: links in the form, printable. */
    @Test
    void extractReturnsOnlyPrintableLinks() {
        String page = "http://example.com/dir/page";
        String doc = """
            <html><head><base href="/b/"><title><a href="/t"></title><style>a{}</style></head><body>
            <!-- <a href="/c"> --><script>'<a href="/s">'</script><a title='x>y' href="q?a=1&amp;b=&#x32;">
            <a HREF=/u>u</a><textarea><a href=/ta></textarea><a href="https://other.example#f">o</a>\
            """;
        for (int end = 0; end <= doc.length(); end++)
            expectPrintable(doc.substring(0, end).getBytes(ISO_8859_1), page);
        String[] pieces = {
            "<a href=",
            "<A HREF='",
            "<base href=\"",
            "\"",
            "'",
            ">",
            "<",
            "/",
            " ",
            "\n",
            "\0",
            "&amp;",
            "&#x",
            "&#",
            ";",
            "<!--",
            "-->",
            "<script>",
            "</script",
            "<title",
            "</textarea>",
            "http://",
            "https://h/",
            "//",
            "?",
            "#",
            "..",
            "%",
            "[",
            "]",
            ":",
            "@",
            "=",
            "\\",
            "é",
            "Ã©",
            "^",
            "{"
        };
        Random random = new Random(0x5eed);
        for (int n = 0; n < 20_000; n++) {
            var html = new ByteArrayOutputStream();
            while (html.size() < 496) {
                if (random.nextBoolean()) html.writeBytes(pieces[random.nextInt(pieces.length)].getBytes(ISO_8859_1));
                else html.write(random.nextInt(256));
                if (random.nextInt(64) == 0) break;
            }
            expectPrintable(html.toByteArray(), page);
        }
    }

    private static void expectPrintable(byte[] html, String page) {
        List<String> found = extract(html, page);
        assertTrue(found.size() <= 1000);
        for (String url : found) {
            assertTrue(url.startsWith("http://") || url.startsWith("https://"), url);
            assertTrue(url.length() <= Urls.MAX_BYTES, url);
            assertTrue(url.chars().allMatch(c -> c > ' ' && c < 0x7f), url);
        }
    }

    @Test
    void aByteAtATimeFindsTheSameLinks() {
        String page = "http://example.com/dir/";
        byte[] html =
                "<a href=/a><!-- <a href=/hidden> --><script><a href=/also-hidden></script><a href='b?x=1&amp;y=2'>"
                        .getBytes(ISO_8859_1);
        var links = new Links(page);
        for (byte b : html) links.feed(new byte[] {b}, 1);
        assertEquals(extract(html, page), links.end());
    }

    private static List<String> extract(byte[] html, String page) {
        var links = new Links(page);
        links.feed(html, html.length);
        return links.end();
    }
}

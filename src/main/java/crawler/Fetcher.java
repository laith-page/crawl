package crawler;

import ai.l3.certs.Certs;
import ai.l3.html.Hrefs;
import ai.l3.http.Client;
import ai.l3.http.HttpFailure;
import ai.l3.http.Response;
import java.time.Duration;
import java.util.List;

/** Fetches a URL within one deadline over HTTP/1.1: retries with backoff (DESIGN §5), reads the body, extracts the links. */
final class Fetcher implements AutoCloseable {
    static final int MAX_BODY_BYTES = 5 << 20, DRAIN_LIMIT_BYTES = 64 << 10;

    private final Duration timeout;
    private final Client http;
    private final Throttle throttle;

    Fetcher(Options options, String certFile) {
        this.timeout = Duration.ofSeconds(options.timeoutSeconds());
        this.throttle = new Throttle(options.delayMillis(), !options.fast());
        this.http = Client.newBuilder()
                .userAgent(options.userAgent())
                .sslSocketFactory(() -> Certs.socketFactory(certFile))
                .build();
    }

    @Override
    public void close() {
        http.close();
    }

    private record Attempt(Page page, Duration retry) {}

    Page fetch(String url) {
        try {
            throttle.start();
            long deadline = System.nanoTime() + timeout.toNanos();
            for (int retries = 0; ; retries++) {
                var attempt = attempt(url, deadline, retries);
                var retry = attempt.retry();
                if (retry == null || retry.toNanos() >= deadline - System.nanoTime()) return attempt.page();
                throttle.retry(retry);
                if (System.nanoTime() >= deadline) return attempt.page();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Page.failed(url, 0, Failure.TIMEOUT);
        }
    }

    // Single attempt: sends request via ai.l3:http, checks retry, drains up to 64 KiB to reuse socket.
    private Attempt attempt(String url, long deadline, int retries) {
        var left = retries == 0 ? timeout : Duration.ofNanos(Math.max(1, deadline - System.nanoTime()));
        try (var response = http.send(url, left)) {
            int status = response.statusCode();
            var retry = Retries.afterStatus(status, response.retryAfterSeconds(), retries);
            if (retry != null) {
                response.discard(DRAIN_LIMIT_BYTES);
                return new Attempt(Page.response(url, status, List.of()), retry);
            }
            return new Attempt(Page.response(url, status, links(url, response)), null);
        } catch (HttpFailure failure) {
            var kind = Failure.of(failure.kind());
            var page = Page.failed(url, failure.status(), kind);
            return new Attempt(page, Retries.afterFailure(kind, failure.status(), retries));
        }
    }

    // Stream HTML chunks into Links; truncate at Content-Length to respect HTTP framing.
    private List<String> links(String url, Response response) throws HttpFailure {
        int status = response.statusCode();
        if (wantsBody(status, response.header("Content-Type"))) {
            long length = response.contentLength(); // -1 when the response doesn't say
            var links = new Links(url, length < 0 ? MAX_BODY_BYTES : Math.min(length, MAX_BODY_BYTES));
            response.body(MAX_BODY_BYTES, links::feed);
            return links.end();
        }
        String location = status / 100 == 3 ? response.header("Location") : null;
        response.discard(DRAIN_LIMIT_BYTES);
        return location(url, location);
    }

    private static List<String> location(String url, String location) {
        if (location == null || location.isEmpty()) return List.of();
        String to = Urls.resolve(url, location);
        return to == null ? List.of() : List.of(to);
    }

    private static boolean wantsBody(int status, String contentType) {
        return status / 100 == 2 && status != 204 && Hrefs.isHtml(contentType);
    }
}

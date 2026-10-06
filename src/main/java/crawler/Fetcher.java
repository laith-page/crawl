package crawler;

import ai.l3.certs.Certs;
import ai.l3.html.Hrefs;
import ai.l3.http.Client;
import ai.l3.http.Deadline;
import ai.l3.http.HttpFailure;
import ai.l3.http.Response;
import ai.l3.pacing.Pacer;
import java.time.Duration;
import java.util.List;

/** Fetches a URL within one deadline over HTTP/1.1: retries with backoff (DESIGN §5), reads the body, extracts the links. */
final class Fetcher implements AutoCloseable {
    static final int MAX_BODY_BYTES = 5 << 20, DRAIN_LIMIT_BYTES = 64 << 10;

    private final Duration timeout;
    private final Client http;
    private final Pacer pacer;
    private final boolean sharedRetries;

    Fetcher(Options options, String certFile) {
        this.timeout = Duration.ofSeconds(options.timeoutSeconds());
        this.pacer = new Pacer(Duration.ofMillis(options.delayMillis()));
        this.sharedRetries = !options.fast();
        this.http = Client.newBuilder()
                .userAgent(options.userAgent())
                .maxConnections(options.concurrency())
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
            pacer.acquire();
            var deadline = Deadline.after(timeout);
            for (int retries = 0; ; retries++) {
                var attempt = attempt(url, deadline, retries);
                var retry = attempt.retry();
                if (retry == null || retry.compareTo(deadline.remaining()) >= 0) return attempt.page();
                waitToRetry(retry);
                if (deadline.passed()) return attempt.page();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Page.failed(url, 0, Failure.TIMEOUT);
        }
    }

    private void waitToRetry(Duration wait) throws InterruptedException {
        if (sharedRetries) { // polite: every worker holds back
            pacer.postpone(wait);
            pacer.acquire();
        } else if (wait.isPositive()) { // fast: only this worker waits
            Thread.sleep(wait);
        }
    }

    private Attempt attempt(String url, Deadline deadline, int retries) {
        try (var response = http.get(url, deadline)) {
            int status = response.statusCode();
            var retry = Retries.afterStatus(status, response.retryAfter(), retries);
            if (retry != null) {
                response.discard(DRAIN_LIMIT_BYTES);
                return new Attempt(Page.response(url, status, List.of()), retry);
            }
            return new Attempt(Page.response(url, status, links(url, response)), null);
        } catch (HttpFailure failure) {
            var kind = Failure.of(failure.kind());
            return new Attempt(
                    Page.failed(url, failure.status().orElse(0), kind),
                    Retries.afterFailure(kind, failure.status(), retries));
        }
    }

    private List<String> links(String url, Response response) throws HttpFailure {
        int status = response.statusCode();
        if (wantsBody(status, response.contentType().orElse(null))) {
            var links = new Links(url); // no body limit: the lib never passes bytes past Content-Length
            response.body(MAX_BODY_BYTES, links::feed);
            return links.end();
        }
        String location = status / 100 == 3 ? response.location().orElse(null) : null;
        response.discard(DRAIN_LIMIT_BYTES);
        return location(url, location);
    }

    private static List<String> location(String url, String location) {
        if (location == null) return List.of();
        String to = Urls.resolve(url, location);
        return to == null ? List.of() : List.of(to);
    }

    private static boolean wantsBody(int status, String contentType) {
        return status / 100 == 2 && status != 204 && Hrefs.isHtml(contentType);
    }
}

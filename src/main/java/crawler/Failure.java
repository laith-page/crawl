package crawler;

import ai.l3.http.HttpFailure;

/** Why a fetch failed: the error categories of DESIGN §1, each printed as its label. */
enum Failure {
    TIMEOUT("timeout"),
    DNS_FAILED("dns failed"),
    CONNECT_FAILED("connect failed"),
    TLS_FAILED("tls failed"),
    BODY_OVER_LIMIT("body over 5 MiB"),
    CONNECTION_RESET("connection reset"),
    MALFORMED_RESPONSE("malformed response");

    private final String label;

    Failure(String label) {
        this.label = label;
    }

    /** What the contract prints after {@code error: }, the same words in every engine. */
    String label() {
        return label;
    }

    /** Whether the host is out of reach: what the dead-host counter counts (DESIGN §5). */
    boolean isUnreachable() {
        return this == CONNECT_FAILED || this == DNS_FAILED;
    }

    /** Whether the page prints no status: a timed-out or malformed response (DESIGN §1). */
    boolean hidesStatus() {
        return this == TIMEOUT || this == MALFORMED_RESPONSE;
    }

    /** Maps the shared HTTP transport categories to the crawler's output labels. */
    static Failure of(HttpFailure.Kind kind) {
        return switch (kind) {
            case TIMEOUT, INTERRUPTED -> TIMEOUT;
            case DNS -> DNS_FAILED;
            case CONNECT -> CONNECT_FAILED;
            case TLS -> TLS_FAILED;
            case BODY_LIMIT -> BODY_OVER_LIMIT;
            case RESET -> CONNECTION_RESET;
            case MALFORMED, OTHER -> MALFORMED_RESPONSE;
        };
    }
}

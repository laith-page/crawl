package crawler;

import ai.l3.pacing.Backoff;
import java.time.Duration;
import java.util.Optional;
import java.util.OptionalInt;

final class Retries {
    private static final int MAX_RETRIES = 4;
    private static final Duration FIRST_BACKOFF = Duration.ofMillis(250);

    private Retries() {}

    /** The wait before another attempt after a response, or null when this status is final. */
    static Duration afterStatus(int status, Optional<Duration> retryAfter, int retries) {
        if (retries >= MAX_RETRIES || !retryable(status)) return null;
        return retryAfter.orElseGet(() -> backoff(retries));
    }

    /** The wait before another attempt after a failure, or null when this failure is final. */
    static Duration afterFailure(Failure failure, OptionalInt status, int retries) {
        if (retries >= MAX_RETRIES || failure == Failure.TIMEOUT) return null;
        if (status.isPresent() && !retryable(status.getAsInt())) return null;
        return backoff(retries);
    }

    private static boolean retryable(int status) {
        return switch (status) {
            case 408, 429, 502, 503, 504 -> true;
            default -> false;
        };
    }

    private static Duration backoff(int retries) {
        return Backoff.fullJitter(FIRST_BACKOFF, retries);
    }
}

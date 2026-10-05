package crawler;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

final class Retries {
    private static final int MAX_RETRIES = 4;
    private static final long FIRST_BACKOFF_MILLIS = 250;

    private Retries() {}

    /** The wait before another attempt after a response, or null when this status is final. */
    static Duration afterStatus(int status, long retryAfterSeconds, int retries) {
        if (retries >= MAX_RETRIES || !retryable(status)) return null;
        if (retryAfterSeconds >= 0) {
            return Duration.ofSeconds(Math.min(retryAfterSeconds, Long.MAX_VALUE / 1_000_000_000L));
        }
        return backoff(retries);
    }

    /** The wait before another attempt after a failure, or null when this failure is final; 0 is no status. */
    static Duration afterFailure(Failure failure, int status, int retries) {
        if (retries >= MAX_RETRIES || failure == Failure.TIMEOUT) return null;
        if (status != 0 && !retryable(status)) return null;
        return backoff(retries);
    }

    private static boolean retryable(int status) {
        return switch (status) {
            case 408, 429, 502, 503, 504 -> true;
            default -> false;
        };
    }

    // Full jitter exponential backoff: uniform random in [0, 250ms * 2^retries).
    private static Duration backoff(int retries) {
        return Duration.ofMillis(ThreadLocalRandom.current().nextLong(FIRST_BACKOFF_MILLIS << retries));
    }
}

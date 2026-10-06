package crawler;

import java.util.Locale;

final class Tracker {

    private static final int DEAD_HOST_THRESHOLD = 5;

    private final String start;
    private int crawled, errors, unreachableInARow;
    private boolean startFailed;

    Tracker(String start) {
        this.start = start;
    }

    void record(Page page) {
        crawled++;
        if (page.isFailure()) errors++;
        if (start.equals(page.url()) && (page.isFailure() || page.status() >= 400)) startFailed = true;
        unreachableInARow = page.unreachable() ? unreachableInARow + 1 : 0;
    }

    // 5 consecutive unreachable connection failures declare the host dead and abort early.
    boolean hostIsDead() {
        return unreachableInARow >= DEAD_HOST_THRESHOLD;
    }

    int exitCode() {
        return startFailed ? 1 : 0;
    }

    String summary(double seconds) {
        return String.format(Locale.ROOT, "crawled %d pages in %.2fs, %d errors%n", crawled, seconds, errors);
    }
}

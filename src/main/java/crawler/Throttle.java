package crawler;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

final class Throttle {
    private final boolean sharedRetries;
    private final long delayNanos;
    private long next = System.nanoTime();

    Throttle(int delayMillis, boolean sharedRetries) {
        this.delayNanos = TimeUnit.MILLISECONDS.toNanos(delayMillis);
        this.sharedRetries = sharedRetries;
    }

    // Request spacing:
    //   sharedRetries=true  (default) : backoff advances global 'next' timestamp (all workers wait)
    //   sharedRetries=false (-f fast) : backoff sleeps calling thread only; normal starts proceed
    synchronized void start() throws InterruptedException {
        if (!sharedRetries && delayNanos <= 0) return;
        long now;
        while ((now = System.nanoTime()) < next) TimeUnit.NANOSECONDS.timedWait(this, next - now);
        next = now + delayNanos;
    }

    synchronized void pause(Duration wait) {
        next = Math.max(next, System.nanoTime() + wait.toNanos());
    }

    void retry(Duration wait) throws InterruptedException {
        if (sharedRetries) {
            pause(wait);
            start();
        } else if (!wait.isNegative() && !wait.isZero()) {
            Thread.sleep(wait);
        }
    }
}

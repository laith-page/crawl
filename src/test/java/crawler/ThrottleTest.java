package crawler;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

class ThrottleTest {

    @Test
    void concurrentRequestsSpanTwoDelays() throws Exception {
        var throttle = new Throttle(20, true);
        long begun = System.nanoTime();
        try (var threads = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < 3; i++) {
                threads.submit(() -> {
                    throttle.start();
                    return null;
                });
            }
        }
        assertTrue(System.nanoTime() - begun >= Duration.ofMillis(40).toNanos());
    }

    @Test
    void retryPauseDelaysNextRequest() throws Exception {
        var throttle = new Throttle(0, true);
        throttle.start();
        long begun = System.nanoTime();
        throttle.pause(Duration.ofMillis(30));
        throttle.pause(Duration.ofMillis(1));
        throttle.start();
        assertTrue(System.nanoTime() - begun >= Duration.ofMillis(30).toNanos());
    }
}

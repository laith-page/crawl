package crawler;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.function.BiConsumer;
import org.junit.jupiter.api.Test;

class MachineTest {

    @Test
    void derivesThreadsAndMaxConcurrency() {
        Machine m = Machine.detect(0);
        assertEquals(Runtime.getRuntime().availableProcessors(), m.cpus());
        assertEquals(m.cpus() <= 2 ? m.cpus() : m.cpus() - 1, m.threads());
        assertEquals(Math.min(256, 24 * m.threads()), m.maxConcurrency());
    }

    @Test
    void cpusOverrides() {
        Machine m = Machine.detect(1);
        assertEquals(1, m.cpus());
        assertEquals(1, m.threads());
        assertEquals(24, m.maxConcurrency());

        m = Machine.detect(2);
        assertEquals(2, m.cpus());
        assertEquals(2, m.threads());
        assertEquals(48, m.maxConcurrency());

        m = Machine.detect(4);
        assertEquals(4, m.cpus());
        assertEquals(3, m.threads());
        assertEquals(72, m.maxConcurrency());

        m = Machine.detect(64);
        assertEquals(64, m.cpus());
        assertEquals(63, m.threads());
        assertEquals(256, m.maxConcurrency());
    }

    @Test
    void applySetsPropertiesUnconditionally() {
        String p1 = System.getProperty("jdk.virtualThreadScheduler.parallelism");
        String p2 = System.getProperty("jdk.virtualThreadScheduler.maxPoolSize");
        String p3 = System.getProperty("http.maxConnections");
        try {
            Machine m = Machine.detect(4);
            m.apply(16);
            assertEquals("3", System.getProperty("jdk.virtualThreadScheduler.parallelism"));
            assertEquals("4", System.getProperty("jdk.virtualThreadScheduler.maxPoolSize"));
            assertEquals("16", System.getProperty("http.maxConnections"));
        } finally {
            BiConsumer<String, String> restore = (key, value) -> {
                if (value != null) System.setProperty(key, value);
                else System.clearProperty(key);
            };
            restore.accept("jdk.virtualThreadScheduler.parallelism", p1);
            restore.accept("jdk.virtualThreadScheduler.maxPoolSize", p2);
            restore.accept("http.maxConnections", p3);
        }
    }
}

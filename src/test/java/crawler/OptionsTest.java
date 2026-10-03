package crawler;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import org.junit.jupiter.api.Test;

class OptionsTest {

    private static Options of(Machine machine, String... args) {
        return Options.of(Options.COMMAND.parse(args, Map.of(), Urls::startUrl), machine);
    }

    @Test
    void concurrency() {
        var machine = new Machine(2, 2, 48);
        var polite = of(machine, "http://example.com/");
        var fast = of(machine, "-f", "http://example.com/");
        var explicit = of(machine, "-f", "-c", "4", "http://example.com/");
        assertEquals(1, polite.concurrency());
        assertEquals(48, fast.concurrency());
        assertEquals(4, explicit.concurrency());
    }

    @Test
    void settings() {
        var machine = new Machine(2, 2, 48);
        var polite = of(machine, "http://example.com/");
        var fast = of(machine, "-f", "http://example.com/");
        assertEquals(
                "settings: polite, cpus 2, threads 2, concurrency 1 (max 48), delay 1s, timeout 10s, pages 1000",
                polite.settings(machine));
        assertEquals(
                "settings: fast, cpus 2, threads 2, concurrency 48 (max 48), delay 0s, timeout 10s, pages 1000",
                fast.settings(machine));
    }
}

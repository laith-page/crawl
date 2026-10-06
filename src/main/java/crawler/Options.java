package crawler;

import ai.l3.cli.Command;
import ai.l3.cli.Command.Flag;
import ai.l3.cli.Command.Setting;
import ai.l3.cli.Command.Switch;
import ai.l3.cli.Command.Text;

/** The crawler's command line, declared for the shared CLI parser. */
record Options(
        boolean fast,
        boolean verbose,
        int concurrency,
        int maxPages,
        int timeoutSeconds,
        int delayMillis,
        String userAgent,
        String url) {

    static final String DEFAULT_USER_AGENT = "crawler/1.0";

    static final Switch FAST = new Switch("-f", "CRAWL_FAST", "fast: as many requests as this machine takes, no delay");
    static final Switch VERBOSE =
            new Switch("-v", "CRAWL_VERBOSE", "verbose: the settings this crawl runs with, on stderr");
    static final Flag CONCURRENCY = Flag.of("-c", "N", "requests in flight at most", 1, 1, Machine.MAX_CONCURRENCY)
            .env("CRAWL_MAX_CONCURRENCY");
    static final Flag MAX_PAGES = Flag.of("-n", "N", "pages to crawl at most", 1_000, 1, Integer.MAX_VALUE)
            .env("CRAWL_MAX_PAGES");
    static final Flag TIMEOUT =
            Flag.of("-t", "SECONDS", "seconds per request timeout", 10, 1, 120).env("CRAWL_TIMEOUT");
    static final Flag DELAY = Flag.of("-d", "SECONDS", "seconds between request starts", 1_000, 0, 60_000)
            .env("CRAWL_DELAY")
            .decimals(3);
    static final Setting CPUS = new Setting("CRAWL_CPUS", 0, 1, 1024);
    static final Text USER_AGENT = new Text("CRAWL_USER_AGENT", DEFAULT_USER_AGENT);

    static final Command COMMAND = Command.builder("crawl")
            .positional("url", "not an http or https URL", Urls::startUrl)
            .versionResource("version and libraries", "/crawler/version.txt")
            .see("see DESIGN §1")
            .option(FAST)
            .option(VERBOSE)
            .flag(CONCURRENCY)
            .flag(MAX_PAGES)
            .flag(TIMEOUT)
            .flag(DELAY)
            .option(CPUS)
            .option(USER_AGENT)
            .build();

    static Options of(Command.Parsed parsed, Machine machine) {
        boolean fast = parsed.on(FAST);
        int concurrency = parsed.given(CONCURRENCY) ? parsed.get(CONCURRENCY) : fast ? machine.maxConcurrency() : 1;
        int delayMillis = parsed.given(DELAY) ? parsed.get(DELAY) : fast ? 0 : 1_000;
        return new Options(
                fast,
                parsed.on(VERBOSE),
                concurrency,
                parsed.get(MAX_PAGES),
                parsed.get(TIMEOUT),
                delayMillis,
                parsed.text(USER_AGENT),
                parsed.positional());
    }

    String settings(Machine machine) {
        return "settings: %s, cpus %d, threads %d, concurrency %d (max %d), delay %ss, timeout %ds, pages %d"
                .formatted(
                        fast ? "fast" : "polite",
                        machine.cpus(),
                        machine.threads(),
                        concurrency,
                        machine.maxConcurrency(),
                        Command.decimal(delayMillis, 3),
                        timeoutSeconds,
                        maxPages);
    }
}

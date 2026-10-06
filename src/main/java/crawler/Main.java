package crawler;

import ai.l3.certs.Certs;
import ai.l3.cli.BlockWriter;
import ai.l3.signals.Signals;

public final class Main {

    private Main() {}

    public static void main(String[] args) {
        Options.COMMAND.main(args, parsed -> {
            var machine = Machine.detect(parsed.get(Options.CPUS));
            var options = Options.of(parsed, machine);
            return crawl(options, machine);
        });
    }

    static int crawl(Options options, Machine machine) throws InterruptedException {
        var trust = Certs.fromEnv(System.getenv());
        if (trust.warning() != null) System.err.println(trust.warning());
        machine.apply();
        if (options.verbose()) System.err.println(options.settings(machine));
        var signals = Signals.trap();
        try (var fetcher = new Fetcher(options, trust.certFile());
                var out = BlockWriter.system(Crawler.OUTPUT_BUFFER_BYTES)) {
            return new Crawler(options.url(), options.concurrency(), options.maxPages(), signals)
                    .crawl(fetcher::fetch, out, System.err);
        }
    }
}

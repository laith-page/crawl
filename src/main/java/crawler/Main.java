package crawler;

import ai.l3.cli.BlockWriter;
import ai.l3.signals.Signals;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

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
        String certFile = System.getenv("SSL_CERT_FILE");
        if (certFile != null && !certFile.isEmpty()) {
            Path path = Path.of(certFile);
            boolean unreadable = !Files.isRegularFile(path);
            if (!unreadable) {
                try {
                    Files.newInputStream(path).close();
                } catch (IOException e) {
                    unreadable = true;
                }
            }
            if (unreadable) {
                System.err.println("warning: SSL_CERT_FILE is unreadable; trusting no certificates");
            }
        }
        machine.apply(options.concurrency());
        if (options.verbose()) System.err.println(options.settings(machine));
        var signals = Signals.trap();
        try (var fetcher = new Fetcher(options, certFile);
                var out = BlockWriter.system(Crawler.OUTPUT_BUFFER_BYTES)) {
            return new Crawler(options.url(), options.concurrency(), options.maxPages(), signals)
                    .crawl(fetcher::fetch, out, System.err);
        }
    }
}

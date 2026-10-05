package crawler;

import ai.l3.cli.BlockWriter;
import ai.l3.signals.Signals;
import ai.l3.workers.Workers;
import java.io.PrintStream;
import java.util.function.Function;

/** Runs a crawl: one thread owns the frontier, the tracker and stdout, so nothing is locked; a fetch only fetches. */
final class Crawler {

    static final int OUTPUT_BUFFER_BYTES = 256 << 10;

    private final int concurrency;
    private final Frontier frontier;
    private final Tracker tracker;
    private final Signals signals;

    Crawler(String start, int concurrency, int maxPages, Signals signals) {
        this(start, concurrency, new Frontier(start, maxPages), signals);
    }

    Crawler(String start, int concurrency, Frontier frontier, Signals signals) {
        this.concurrency = concurrency;
        this.frontier = frontier;
        this.tracker = new Tracker(start);
        this.signals = signals;
    }

    int crawl(Function<String, Page> fetch, BlockWriter out, PrintStream stderr) throws InterruptedException {
        long begun = System.nanoTime();
        run(fetch, out);
        out.flush();
        double seconds = (System.nanoTime() - begun) / 1e9;
        boolean failed = out.failed(), closed = failed && out.closedByReader();
        if (!failed && tracker.hostIsDead()) stderr.println("error: host unreachable");
        stderr.print(tracker.summary(seconds));
        if (closed) return signals.exitCodeOr(0);
        if (failed) {
            stderr.println("error: cannot write output");
            return 1;
        }
        return tracker.hostIsDead() ? 1 : signals.exitCodeOr(tracker.exitCode());
    }

    // Crawl coordinator loop:
    //   Frontier ──pop──> Workers (virtual threads)
    //      ▲                 │ take
    //      └──push links─────┴──> stdout & Tracker
    private void run(Function<String, Page> fetch, BlockWriter out) throws InterruptedException {
        try (var workers = Workers.start(concurrency, fetch)) {
            while (true) {
                boolean active = !signals.received() && !tracker.hostIsDead();
                for (String url; active && workers.idle() > 0 && (url = frontier.pop()) != null; ) {
                    workers.submit(url);
                }
                if (workers.inFlight() == 0 && (!active || frontier.queued() == 0)) return;
                var page = workers.take();
                tracker.record(page);
                page.writeTo(out);
                if (out.failed()) return; // a failed write ends the crawl
                if (active) {
                    for (String link : page.links()) frontier.push(link);
                }
            }
        }
    }
}

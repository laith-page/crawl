// The perf gate: each crawler's work, counted, against bench/budgets.json (keyed "<sample> <engine>") and the last
// reading in bench/baseline.jsonl. Instructions under cachegrind's simulator are the same on any machine and repeat
// to parts per million one fetch at a time, so one measurement judges. What a wall clock or a rate says (idle) is
// reported and never judged.
import { statSync } from "node:fs";
import { app, measure, mock, report, test, type App, type Mock } from "@l3/tools";
import { describe } from "bun:test";
import { SITE } from "../e2e/lib/site.ts";
import { CRAWLME_SITE, DELAYED_SITE, LATENCY_MS, PERF_SITE, SCAN_SITE, WIRE } from "./site.ts";

/// The engines, by the name their budgets carry, and the target each is.
const ENGINES = { java: ".", go: "ports/go", rust: "ports/rust", zig: "ports/zig" } as const;
type Engine = keyof typeof ENGINES;

/// The workloads' `-c`: 64, a fast-mode concurrency (DESIGN §1's default is 1).
const CONCURRENCY = 64;
const WIRE_PAGES = 20_000;
const SYSCALL_PAGES = 5_000;
/// What a counted crawl spends long: a JVM's first handshake on C1 under the simulator outlasts the default 10 s.
const TLS_DEADLINE = ["-t", "120"];
const HOUR = 3_600_000;

/// System calls a page that are not the crawl's own: waits and scheduling, a connection's life, reads (how bytes
/// arrive decides them). What is left moved within 2% across crawls.
const UNCOUNTED_SYSCALLS = [
  // waits and scheduling
  "futex",
  "nanosleep",
  "clock_nanosleep",
  "sched_yield",
  "epoll_wait",
  "epoll_pwait",
  "epoll_pwait2",
  "poll",
  "ppoll",
  "select",
  "pselect6",
  // a connection's life
  "socket",
  "connect",
  "setsockopt",
  "getsockopt",
  "getsockname",
  "getpeername",
  "bind",
  "fcntl",
  "epoll_ctl",
  "shutdown",
  "close",
  // reads
  "read",
  "readv",
  "recvfrom",
  "recvmsg",
];

/**
 * A counted crawl's crawler: on one CPU, since an engine sizes its threads by the CPUs it finds, and two threads race
 * for each read. A run no counter wraps (a peak, a wall) keeps the machine's CPUs.
 */
const counted =
  (from: string, env: Record<string, string> = {}) =>
  () =>
    app({ from, env: { CRAWL_CPUS: "1", ...env } });

const crawlArgs = (site: Mock, path: string, pages: number, concurrency: number, more: string[] = []) => [
  ...more,
  "-f",
  "-c",
  String(concurrency),
  "-n",
  String(pages),
  `${site.url}${path}`,
];

/** One crawl, held to having fetched what it was asked. */
async function crawl(crawler: App, site: Mock, args: string[], env: Record<string, string> = {}) {
  const result = await crawler.run(args, { stdout: "ignore", timeout: HOUR, env });
  if (result.code !== 0) throw new Error(`${crawler.from} exited ${result.code}: ${result.stderr.slice(-400)}`);
  return result;
}

/** The KiB of what the build wrote: the shaded jar, the static binaries. */
async function binaryKb(from: string): Promise<number> {
  const binary = (await app({ from })).binary;
  if (!binary) throw new Error(`no build of ${from} in this run`);
  return Math.round(statSync(binary).size / 1024);
}

for (const [engine, from] of Object.entries(ENGINES) as [Engine, string][]) {
  describe(engine, () => {
    // instructions per page: small pages of four links, 64 in flight (the client, its framing).
    test(
      `wire ${engine}`,
      async () => {
        const site = await mock(SITE);
        await measure(counted(from), (c) => crawl(c, site, crawlArgs(site, WIRE, WIRE_PAGES, CONCURRENCY)), {
          count: "instructions",
          per: WIRE_PAGES,
        });
      },
      HOUR,
    );

    // instructions per KB served: 300 pages of 100 KB, one fetch at a time (the scanner).
    test(
      `scan ${engine}`,
      async () => {
        const site = await mock(SCAN_SITE);
        const args = crawlArgs(site, "/perf/scan", 301, 1);
        // The bytes a crawl of these pages is served: the same every run (exact Content-Lengths).
        await crawl(await app({ from }), site, args);
        const kb = (await site.stats()).bytes_out / 1024;
        await measure(counted(from), (c) => crawl(c, site, args), { count: "instructions", per: kb });
      },
      HOUR,
    );

    // instructions per href: 200 pages of 1,000 hrefs, half relative with a reference, one fetch at a time (the
    // resolver).
    test(
      `links ${engine}`,
      async () => {
        const site = await mock(PERF_SITE);
        await measure(counted(from), (c) => crawl(c, site, crawlArgs(site, "/perf/links/0", 200, 1)), {
          count: "instructions",
          per: 200 * 1000,
        });
      },
      HOUR,
    );

    // instructions to the first page: initialisation, and what a runtime does before its first request.
    test(
      `startup ${engine}`,
      async () => {
        const site = await mock(DELAYED_SITE);
        await measure(counted(from), (c) => crawl(c, site, crawlArgs(site, "/scale/0?links=4&limit=10", 1, 1)), {
          count: "instructions",
        });
      },
      HOUR,
    );

    // instructions to the first page over https: the handshake, the chain's verification, the client's HTTP/1.1.
    test(
      `startup-tls ${engine}`,
      async () => {
        const site = await mock(SITE, { tls: true });
        const env = { SSL_CERT_FILE: site.ca! };
        await measure(
          counted(from, env),
          (c) => crawl(c, site, crawlArgs(site, "/scale/0?links=4&limit=10", 1, 1, TLS_DEADLINE)),
          { count: "instructions" },
        );
      },
      HOUR,
    );

    // instructions per KB over https, the scan's pages: the record layer on top of the scanner.
    test(
      `tls ${engine}`,
      async () => {
        const site = await mock(PERF_SITE, { tls: true });
        const env = { SSL_CERT_FILE: site.ca! };
        const args = crawlArgs(site, "/perf/scan", 301, 1, TLS_DEADLINE);
        await crawl(await app({ from, env }), site, args);
        const kb = (await site.stats()).bytes_out / 1024;
        await measure(counted(from, env), (c) => crawl(c, site, args), { count: "instructions", per: kb });
      },
      HOUR,
    );

    // instructions per page of the recording of crawlme.fly.dev at -c 1 (its order is then the same every crawl),
    // 3,000 pages less 1,000, so start-up is out: real markup, redirects, errors, entities, links off the site.
    test(
      `crawlme ${engine}`,
      async () => {
        const site = await mock(CRAWLME_SITE);
        await measure(counted(from), (c, pages) => crawl(c, site, crawlArgs(site, "/", pages, 1)), {
          count: "instructions",
          lives: [1_000, 3_000],
        });
      },
      HOUR,
    );

    // system calls a page of the wire crawl other than reads, waits and a connection's life: the kernel's share of
    // a page. On the numeric loopback, so no name lookup is charged to a page.
    test(
      `syscalls ${engine}`,
      async () => {
        const site = await mock(SITE);
        const url = `http://127.0.0.1:${site.port}${WIRE}`;
        await measure(
          counted(from),
          (c) => crawl(c, site, ["-f", "-c", String(CONCURRENCY), "-n", String(SYSCALL_PAGES), url]),
          // strace's qualifier: every call but these.
          {
            count: "syscalls",
            per: SYSCALL_PAGES,
            syscalls: [`!${UNCOUNTED_SYSCALLS[0]}`, ...UNCOUNTED_SYSCALLS.slice(1)],
          },
        );
      },
      HOUR,
    );

    // MiB per fetch in flight: peak RSS at -c 128 over -c 64 on 1.9 MB bodies held open together (/perf/held). The
    // JVM's is its peak itself, on whole bodies.
    test(
      `memory ${engine}`,
      async () => {
        const site = await mock(PERF_SITE);
        if (engine === "java")
          await measure(
            () => app({ from }),
            (c) => crawl(c, site, crawlArgs(site, "/perf/memory", 141, 128)),
            {
              count: "rss",
            },
          );
        else
          await measure(
            () => app({ from }),
            (c, slots) => crawl(c, site, crawlArgs(site, "/perf/held", 141, slots)),
            {
              count: "rss",
              lives: [CONCURRENCY, 128],
            },
          );
      },
      HOUR,
    );

    // page faults per page, and connections per 1,000 pages, of the wire crawl as it ships: 64 held alive is 3.2.
    test(
      `faults ${engine}`,
      async () => {
        const site = await mock(SITE);
        await measure(
          () => app({ from, memory: 2048 }),
          (c) => crawl(c, site, crawlArgs(site, WIRE, WIRE_PAGES, CONCURRENCY)),
          { count: "faults", per: WIRE_PAGES },
        );
        const stats = await site.stats();
        report(
          `connections ${engine}`,
          Math.round(((1000 * stats.connections) / stats.requests) * 100) / 100,
          "conns/kpage",
        );
      },
      HOUR,
    );

    // collections per 10,000 pages of the wire crawl, the allocation proxy: the JVM's on a fixed 256 MB heap (the
    // crawl's count, not the machine's RAM's), Go's under the run's 2 GB limit; Rust and Zig have none.
    test.if(engine === "java" || engine === "go")(
      `gcs ${engine}`,
      async () => {
        const site = await mock(SITE);
        const heap: Record<string, string> = engine === "java" ? { JAVA_TOOL_OPTIONS: "-Xms256m -Xmx256m" } : {};
        await measure(
          () => app({ from, memory: 2048, env: heap }),
          (c) => crawl(c, site, crawlArgs(site, WIRE, WIRE_PAGES, CONCURRENCY)),
          { count: "gc", per: WIRE_PAGES / 10_000 },
        );
      },
      HOUR,
    );

    // KiB of what the engine builds and a release carries: the shaded jar, the static binaries.
    test(`size ${engine}`, async () => {
      report(`size ${engine}`, await binaryKb(from), "KiB");
    });

    // ms the 2,000 pages of a 3,000-page crawl less a 1,000-page one took past the floor 64 slots under a 20 ms
    // latency allow: the slots' idle time. Two walls, which a runner's pauses only lengthen: reported, never judged.
    test(
      `idle ${engine}`,
      async () => {
        const site = await mock(DELAYED_SITE);
        const crawler = await app({ from });
        const wall = async (pages: number) =>
          (await crawl(crawler, site, crawlArgs(site, WIRE, pages, CONCURRENCY))).ms;
        const floorMs = (2_000 * LATENCY_MS) / CONCURRENCY;
        let idle = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 2; i++)
          idle = Math.min(idle, Math.max(0, (await wall(3_000)) - (await wall(1_000)) - floorMs));
        report(`idle ${engine}`, Math.round(idle), "ms");
      },
      HOUR,
    );
  });
}

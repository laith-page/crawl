// The benchmark (`mise run bench`: a crawler against the hardware limit, bench/limit.zig) and the perf gate
// (`mise run perf`: each engine's samples against budgets and perf/baseline.jsonl).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLock, mock, zigFile, type EngineDef, type Netem } from "@tools/core";
import {
  UNCOUNTED_SYSCALLS,
  binarySizeKb,
  cgroupCpuUs,
  cgroupFaults,
  countDifference,
  defineBench,
  httpWorkloadStats,
  jvmAotSizeMb,
  leastOf,
  medianOf,
  mockedRun,
  perSlot,
  sampleCounts,
  type PerfContext,
  type PerfSample,
  type Workload,
} from "@tools/bench";
import { CRAWL } from "./project.ts";
import { MOCK_DIR, REALWORLD_FAULTS, REALWORLD_PATH, SITE, siteFor } from "./e2e/site.ts";

/// The least this machine can spend fetching a page, with nothing between the kernel and the numbers;
/// `--crawl` adds a crawler's per-page work: the floor the crawlers are judged against.
const LIMIT = zigFile({ file: "bench/limit.zig" });
const LIMIT_CRAWL: EngineDef = (id, root, name) => {
  const limit = LIMIT("limit", root, name);
  return { ...limit, id, command: (args) => [limit.binary, "--crawl", ...args] };
};
// The Java crawler as people get it is a subject too, from project.ts's ship: `launcher`, `bundle`, `image`.

/// A workload is a crawl: where it starts on the mock, how many pages, how many in flight, under what
/// cap, and what the site does to it (faults over site.json, or the recording).
interface Crawl extends Workload {
  path: string;
  pages: number;
  concurrency: number;
  memoryMb: number;
  site?: string;
  rules?: unknown[];
  seed?: number;
  archive?: string;
  /** With an `archive`: replayed over the network it was recorded on. */
  latency?: boolean;
}

/// The workloads' `-c`: 64, a fast-mode concurrency on the bench machine (DESIGN §1's default is 1)
const DEFAULT_CONCURRENCY = parseInt(process.env.CONCURRENCY || "64", 10);

/// A realworld crawl: the default -c, 1 GB, the realworld faults.
const realworld = (name: string, pages: number, more: Partial<Crawl> = {}): Crawl => ({
  name,
  path: REALWORLD_PATH,
  pages,
  concurrency: DEFAULT_CONCURRENCY,
  memoryMb: 1024,
  seed: 42,
  rules: REALWORLD_FAULTS,
  ...more,
});

// --- The perf gate ---

const WIRE = "/scale/0?links=4&limit=10000000&delay=0";
const WIRE_PAGES = 20_000;
/// The native wire crawl: collections, faults and connections are counted over it.
const GC_PAGES = 20_000;
const LATENCY_MS = 20;
const SITE_DOCUMENT = JSON.parse(readFileSync(SITE, "utf8")) as Record<string, unknown>;

/// The perf samples' own pages: repeated units under an exact Content-Length.
const PERF_SITE = {
  ...SITE_DOCUMENT,
  routes: {
    "/perf/scan": { repeat: ['<a href="/perf/scan/{i}">x</a>', 500] },
    // One body, not a thousand streamed units: how the bytes arrive decides how many reads a client makes,
    // and a count of reads is a count of instructions and of syscalls; a body written whole arrives the same way.
    "/perf/scan/*": {
      html: "<p>Ninety-six bytes of a page as a page has them: a <b>tag</b>, an &amp; and some text.</p>\n".repeat(
        1000,
      ),
    },
    "/perf/links/*": { repeat: ['<a href="/perf/links/{i}">x</a><a href="../links/{i}x?q=1&amp;r=2">y</a>', 1000] },
    "/perf/memory": { repeat: ['<a href="/perf/memory/{i}">x</a>', 200] },
    "/perf/memory/*": { repeat: ["<p>{x*120}</p>\n", 15200] },
    // The same 1.9 MB in two halves, 300 ms apart: every slot is mid-body at once, so the peak holds all of them. On
    // loopback the whole bodies above finish before the last slots fill, and how many overlap is the scheduler's
    // (Go's slot read 0 then 2 MiB on one binary).
    "/perf/held": { repeat: ['<a href="/perf/held/{i}">x</a>', 200] },
    "/perf/held/*": { repeat: ["<p>{x*972792}</p>\n", 2], gap: "300ms" },
    // 45 KB a page, 100 new links each: over a WAN the bytes and the connections' windows decide, not the parse.
    "/perf/wan/*": { repeat: ['<a href="/perf/wan/{n}{i}">x</a><p>{x*400}</p>\n', 100] },
  },
};
/// A WAN on the machine (tools' netem): 50 ms a round trip, half a percent lost each way, a real MTU.
const WAN: Netem = { delay: "25ms", loss: "0.5%", mtu: 1500 };
const WAN_PAGES = 1_000;
/// The Java carriers' steady state: two wire crawls on the full tiered JIT, the longer less the shorter.
const JIT_PAGES = [20_000, 80_000] as const;
/// HotSpot names a thread's kernel comm by its first seven and last six characters: ForkJoinPool-1-worker-1.
const CARRIER = /^ForkJoi\.\.rker-\d+$/;
/// Every /scale page 20 ms late: the idle share of the slots is then latency-bound, not CPU-bound.
const DELAYED_SITE = {
  ...SITE_DOCUMENT,
  rules: [{ match: "/scale/*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};
/// The scan's pages as late: a crawler one fetch at a time has sent its request and blocked in its read before
/// the answer comes, on every page. Answered at once, whether a read found its bytes waiting was the scheduler's,
/// and under the simulator it decides a count: a JVM's first read to block starts its read poller, and one jar's
/// scan read 1,680M when none of its 903 reads blocked and 1,735M when four did. Start-up crawls DELAYED_SITE.
const SCAN_SITE = {
  ...PERF_SITE,
  rules: [{ match: "/perf/scan*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};

/**
 * One crawl of the perf gate: the mock on `document`, the engine as it ships, what both counted. `tls`: over
 * https (HTTP/1.1 by ALPN), the mock's authority in SSL_CERT_FILE; `netem`: the mock and the engine in a network of
 * their own, through an emulated WAN.
 */
async function perfCrawl(
  ctx: PerfContext,
  spec: {
    path: string;
    pages: number;
    concurrency: number;
    document?: string | object;
    wrap?: string[];
    tls?: boolean;
    netem?: Netem;
    numericHost?: boolean;
  },
) {
  // Over https the longest deadline: a JVM's first handshake on C1 under the simulator outlasts the default 10 s.
  const deadline = spec.tls ? ["-t", "120"] : [];
  // A counted crawl (one a counter wraps) on one CPU: the engine sizes its threads by the CPUs it finds, so a
  // two-vCPU runner and a four-vCPU one counted different programs, and two threads race for each read (Rust's
  // startup had two modes, tokio's workers waking before or after its one read). One thread takes its reads in one
  // order; Go is already on one P under the simulator (GOMAXPROCS=1). A run no counter wraps (a peak, a wall) keeps
  // the machine's CPUs: what it measures is the crawler as it runs.
  const counted = (spec.wrap?.length ?? 0) > 0;
  return mockedRun(ctx, {
    ...(counted ? { env: { CRAWL_CPUS: "1" } } : {}),
    document: spec.document ?? SITE,
    path: spec.path,
    tls: spec.tls,
    netem: spec.netem,
    numericHost: spec.numericHost,
    wrap: spec.wrap,
    minRequests: spec.pages,
    flags: spec.wrap?.length ? CRAWL.flags.filter((f) => !f.startsWith("-Xmn")) : CRAWL.flags,
    args: (url) => [...deadline, "-f", "-c", String(spec.concurrency), "-n", String(spec.pages), url],
  });
}

/// A count of instructions. Budgets leave room for a change of CPU generation (a JIT's intrinsics and a libc's
/// vector paths differ by one); a tolerance not given is perf.tolerance's, since under the simulator every engine
/// repeats to parts per million.
const counts = sampleCounts;
const PERF_SAMPLES: Record<string, PerfSample> = {
  // instructions per page: small pages of four links, 64 in flight (the client, its framing). In flight, how the
  // bytes arrive decides how many reads a client makes (Zig read 52.4M then 53.2M on one binary): 3%
  wire: counts(
    "instr/page",
    { java: 290000, go: 90000, rust: 65000, zig: 22000 },
    { java: 0.08, go: 0.08, rust: 0.15, zig: 0.08 },
  ),
  // instructions per KB served: 300 pages of 100 KB, one fetch at a time (the scanner); a body's reads still
  // vary a little with how its bytes arrive (Go read 142.0M then 142.2M on one binary), so Go's carries 1%
  scan: counts(
    "instr/KB",
    { java: 72000, go: 14300, rust: 15800, zig: 6250 },
    { java: 0.05, go: 0.05, rust: 0.1, zig: 0.05 },
  ),
  // instructions per href: 200 pages of 1,000 hrefs, half relative with a reference, one fetch at a time (the
  // resolver)
  links: counts(
    "instr/href",
    { java: 14000, go: 4000, rust: 4000, zig: 2500 },
    { java: 0.05, go: 0.05, rust: 0.1, zig: 0.05 },
  ),
  // instructions to the first page (initialisation, a JVM's AOT cache), the median of STARTUPS crawls (Go's least). Go's runtime
  // starts threads on its own clock (under valgrind a slow syscall hands the processor to a new one, 15K
  // instructions each) and a thread's stack can tip the heap into a new chunk (57K to 89K): the least drops the
  // latter. Rust's had two modes, tokio's workers waking before or after its one read, until a counted crawl ran on
  // one CPU. Over eleven CI runs on one CPU: Java's moved 0.15%, Go's 0.9%, Rust's 1.6%, Zig's 0.9%: 3%, and the floor
  // holds a port's
  startup: {
    ...counts(
      "instr",
      { java: 880000000, go: 3680000, rust: 3000000, zig: 3000000 },
      { java: 0.03, go: 0.03, rust: 0.03, zig: 0.03 },
    ),
    floor: 100_000,
  },
  // MiB per fetch in flight: peak RSS at -c 128 over -c 64 on 1.9 MB bodies held open together (/perf/held: three
  // runs read within 0.2 MiB); the JVM's peak itself, on whole bodies. A rise within 1 MiB is noise
  memory: {
    unit: { java: "MiB", go: "MiB/slot", rust: "MiB/slot", zig: "MiB/slot" },
    budget: { java: 90, go: 1.0, rust: 1.0, zig: 2.0 },
    tolerance: 0.5,
    floor: 1,
  },
  // system calls a page on the wire crawl other than reads, waits and a connection's life, the median of SYSCALLS
  // crawls: the kernel's share of a page, which the simulator does not see (a write a page is 1.0; an unbuffered
  // line, or an allocator handing memory back each page, adds one). The rest is no sample: futexes follow the
  // scheduler (Java's whole count read 8 to 20 a page on one binary on the runner), reads how bytes arrive (Java's
  // 1.1 then 2.0 a page), a connection's calls its reuse, which `connections` holds. What is left moved within 2%
  // across eight crawls (Zig's 3%, Rust's 8%: its DNS lookup a connection); a rise within 0.3 of a call is noise
  syscalls: {
    unit: "calls/page",
    budget: { java: 2.8, go: 1.35, rust: 1.8, zig: 1.55 },
    tolerance: { java: 0.1, go: 0.1, rust: 0.35, zig: 0.1 },
    floor: 0.5,
  },
  // instructions per page of the recording of crawlme.fly.dev at `-c 1` (its order is then the same every crawl),
  // 3,000 pages less 1,000, so start-up is out: real markup, redirects, errors, entities, links off the site, what
  // the synthetic pages above do not have. Each page 20 ms late (CRAWLME_SITE), so every read blocks: answered at
  // once Java's read 329K to 402K over six CI runs; late, its six read 418K to 424K (1.4%: 5%), Go's 0.35% and Zig's
  // 0.08% (3%). Rust's moves with the runner it lands on, not the run (69.4K to 73.8K over seven runners, 0.3%
  // over five on one image; a CPU-dispatched byte search is the likely cause): 15%. The blocking read costs the JVM
  // its poller's path: its budget is 460K
  crawlme: counts(
    "instr/page",
    { java: 460_000, go: 135_000, rust: 85_000, zig: 42_000 },
    { java: 0.05, go: 0.03, rust: 0.15, zig: 0.03 },
  ),
  // KiB of what the engine builds and a release carries: the shaded jar (its runtime and AOT cache are the
  // bundle's), the static binaries. A library must not cost it. The jar, Go's and Zig's are the same
  // bytes build after build and a checkout's path moves them by a few hundred; Rust's profile-guided build moved
  // 0.6% across six trainings, and 2.1% between two CI builds: 2%, Rust's 5%
  size: {
    unit: "KiB",
    budget: { java: 500, go: 11_500, rust: 4_000, zig: 2_500 },
    // Rust's follows its profile-guided build, whose profile moves from build to build: 3,527 then 3,600 KiB on
    // unchanged Rust (#157's CI), so 5%
    tolerance: { java: 0.08, go: 0.05, rust: 0.08, zig: 0.05 },
  },
  // MiB of the JVM's AOT cache, trained on the same crawl as the release's: what a new class or library costs the
  // bundle and start-up. Six trainings read within 0.3%: 3%
  aot: { unit: "MiB", engines: ["java"], budget: { java: 32 }, tolerance: 0.03 },
  // page faults per page, from the wire crawl's cgroup; the JVM's follow its heap's growth and its JIT's code
  // cache (1.17 to 1.61 on one binary), so Java's carries half
  faults: {
    unit: "faults/page",
    budget: { java: 2.2, go: 0.35, rust: 0.26, zig: 1.1 },
    tolerance: { java: 0.5, go: 0.2, rust: 0.2, zig: 0.2 },
    floor: 1.0,
  },
  // connections opened per 1,000 pages of the wire crawl: 64 held alive is 3.2; a reuse raced by a close opens
  // another (Rust's read 0.8 to 1.35 on one binary across a day), so a rise within four is noise
  connections: {
    unit: "conns/kpage",
    budget: { java: 4.8, go: 4.8, rust: 10, zig: 4.8 },
    tolerance: { java: 0.3, go: 0.3, rust: 2.0, zig: 0.3 },
    floor: 10,
  },
  // ms the 2,000 pages of a 3,000-page crawl less a 1,000-page one took past the floor 64 slots under a 20 ms
  // latency allow (625 ms): the slots' idle time. Two walls, which a runner's pauses only lengthen (as an idle
  // share Java read 8.2 then 18.6 on one binary, 0 to 19 over 46 CI runs of unchanged code), so it is a wall-clock
  // sample: tools reports it beside its budget and baseline and never judges it, as a neighbour's load can flip a
  // verdict on it. The budgets are the idle shares it held before (Java 65%, Go and Zig 12%, Rust 15%), in ms.
  idle: {
    unit: "ms",
    budget: { java: 1160, go: 85, rust: 110, zig: 85 },
    steady: false,
  },
  // collections per 10,000 pages of the wire crawl, the allocation proxy: the JVM's on a fixed 256 MB heap (the
  // crawl's count, not the machine's RAM's), Go's under the run's 2 GB limit; Rust and Zig report 0. Go's follows
  // how a body arrives, a buffer a read (17 on the runner's two vCPUs, 84 to 92 on sixteen cores): its budget is a
  // workstation's, and a rise within five is noise
  gcs: {
    unit: "gcs/10kpage",
    budget: { java: 5, go: 40 },
    tolerance: { java: 0.2, go: 1.0 },
    floor: 5,
  },
  // instructions to the first page over https: the handshake, the chain's verification, the client's HTTP/1.1, a
  // JVM's JSSE as its AOT cache left it (what startup cannot see: Rust's first https page once cost 424M)
  "startup-tls": {
    ...counts(
      "instr",
      { java: 3_000_000_000, go: 10_000_000, rust: 6_000_000, zig: 30_000_000 },
      { java: 0.05, go: 0.05, rust: 0.1, zig: 0.05 },
    ),
    floor: 150_000,
  },
  // instructions per KB over https, the scan's pages: the record layer on top of the scanner
  // (JSSE on C1 under the simulator reads 25 times the ports': its trend is C1's). How records arrive decides the
  // reads, as on wire: 3%
  tls: counts(
    "instr/KB",
    { java: 680_000, go: 34_000, rust: 10_000, zig: 7_000 },
    { java: 0.05, go: 0.05, rust: 0.2, zig: 0.05 },
  ),
  // pages a second through an emulated WAN (50 ms a round trip, 0.5% loss, MTU 1500): 1,000 pages of 45 KB over
  // https, the median of three crawls by their own summary. Under loss a connection's throughput falls as the root
  // of the loss (Mathis), so this holds how a crawl spreads over connections. A rate over a wall: tools reports it
  // and never judges it (pages/s), as a neighbour's load moves it whatever the code does
  wan: {
    unit: "pages/s",
    // Half a workstation's number (Zig 450, Java 220): a connection a fetch, as HTTP/1.1 has it. Over HTTP/2's few
    // connections an early loss stalled a crawl for up to a minute (Rust's 1,000 pages took 2.4 to 73 s)
    budget: { java: 110, go: 220, rust: 220, zig: 220 },
    higherIsBetter: true,
    steady: false,
    needs: ["netem"],
  },
  // the CPU (user and system) those crawls took a page, start-up included: a WAN's cost is per byte. Microseconds a
  // page, which a loaded machine's caches and frequency move: reported and never judged, as wan
  "wan-cpu": {
    unit: "us/page",
    // Twice a workstation's; the JVM's (its JIT's work) read 2,700 then 5,700 as the machine's load moved
    budget: { java: 8000, go: 1650, rust: 1300, zig: 1000 },
    steady: false,
    needs: ["netem"],
  },
  // Java on the full tiered JIT, as it ships: the carrier threads' instructions a page, counted by the CPU (C2
  // cannot run under the simulator), 80,000 wire pages less 20,000, so start-up and the compiler threads are out.
  // Only where there is a PMU, judged on its CPU generation
  c2: {
    unit: "instr/page",
    engines: ["java"],
    counter: "pmu",
    budget: { java: 145_000 },
    tolerance: 0.08,
  },
};

/** NATIVES native crawls, the median of each count. */
async function natives(ctx: PerfContext): Promise<{ gcs: number; faults: number; connections: number }> {
  return medianOf(NATIVES, () => native(ctx));
}

/**
 * The wire crawl as it ships, under no counter: what its collector logged per 10,000 pages (the JVM's under
 * -Xlog:gc on a fixed 256 MB heap, Go's under GODEBUG=gctrace=1, 0 for an engine that has none), its page
 * faults and its connections per page. Under the simulator those would be valgrind's own.
 */
async function native(ctx: PerfContext): Promise<{ gcs: number; faults: number; connections: number }> {
  // The JVM on a fixed 256 MB heap, its gc log on; Go's gctrace; nothing for an engine with no collector.
  const gc = ctx.gc({ flags: CRAWL.flags, heapMb: 256 });
  await using server = await mock(SITE);
  const result = await ctx.run(["-f", "-c", String(DEFAULT_CONCURRENCY), "-n", String(GC_PAGES), server.url(WIRE)], {
    memoryMb: 2048,
    stdout: "ignore",
    wallMs: 300_000,
    ...(gc.flags ? { flags: gc.flags } : {}),
    ...(gc.env ? { env: gc.env } : {}),
  });
  if (result.code !== 0) throw new Error(`${ctx.engine.id} exited ${result.code} on the native wire crawl`);
  if (!result.usage) throw new Error("page faults are the run's cgroup's: this needs systemd user scopes");
  const stats = await server.stats();
  if (stats.requests < GC_PAGES) throw new Error(`${ctx.engine.id} fetched ${stats.requests} pages of ${GC_PAGES}`);
  const lines = gc.read(result.stderr);
  return {
    gcs: (lines * 10_000) / GC_PAGES,
    faults: cgroupFaults(result.usage, GC_PAGES),
    connections: (1000 * stats.connections) / GC_PAGES,
  };
}

/// Pages of the wire crawl under strace, and how many such crawls: their median is the sample.
const SYSCALL_PAGES = 5_000;
const SYSCALLS = 1;

/** The system calls a page of the wire crawl makes, those of UNCOUNTED_SYSCALLS left out: the median of SYSCALLS. */
async function syscalls(ctx: PerfContext): Promise<number> {
  return medianOf(SYSCALLS, async () => {
    const count = ctx.count("syscalls", { exclude: UNCOUNTED_SYSCALLS });
    // strace amplifies connection churn; use numeric loopback so DNS lookups are not charged to each page.
    await perfCrawl(ctx, {
      path: WIRE,
      pages: SYSCALL_PAGES,
      concurrency: DEFAULT_CONCURRENCY,
      wrap: count.wrap,
      numericHost: true,
    });
    return count.read() / SYSCALL_PAGES;
  });
}

/// The recording's pages at `-c 1`, the more less the fewer: start-up is out.
const CRAWLME_PAGES = [1_000, 3_000] as const;
/// The recording, every page as late as the scan's (SCAN_SITE): one fetch at a time, the crawler has blocked in its
/// read before each answer comes. Answered at once, whether a read found its bytes waiting was the scheduler's, and
/// a JVM's count with it: Java's read 329K to 402K a page over six CI runs of one jar, against 0.2% on the scan.
const CRAWLME_SITE = {
  routes: { "*": { archive: join(MOCK_DIR, "crawlme.warc.gz") } },
  rules: [{ match: "/*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};

/** Instructions a page of the recording, one fetch at a time: the longer crawl's less the shorter's. */
async function crawlme(ctx: PerfContext): Promise<number> {
  return countDifference(ctx, CRAWLME_PAGES, (pages, wrap) =>
    perfCrawl(ctx, { path: "/", pages, concurrency: 1, document: CRAWLME_SITE, wrap }),
  );
}

/** What the engine's build wrote, in KiB; the JVM's AOT cache, in MiB, as its command names it. */
function sizes(ctx: PerfContext): { size: number; aot?: number } {
  const size = binarySizeKb(ctx.engine.binary);
  if (!ctx.wants("aot")) return { size };
  return { size, aot: jvmAotSizeMb(ctx.engine) };
}

/// Startup crawls a native engine takes.
const STARTUPS = 3;
/// The idle share's measurements: a runner's pause only adds to a wall, so the least is the crawl's.
const IDLES = 2;
/// Native wire crawls, their median each count: when the JIT compiles decides what a JVM allocates, and so its GCs.
const NATIVES = 1;

const idleLock = new AsyncLock();

/// The crawler's own summary: `crawled N pages in S.SSs, E errors` (DESIGN §1).
const SUMMARY = /crawled (\d+) pages in ([\d.]+)s/;

/**
 * Two crawls through the emulated WAN, under no counter: the median of their pages a second, by each crawl's own
 * summary (start-up left out), and of the CPU each took a page, from its cgroup.
 */
async function wan(ctx: PerfContext): Promise<{ wan: number; "wan-cpu": number }> {
  return medianOf(2, async () => {
    const { result } = await perfCrawl(ctx, {
      path: "/perf/wan/1",
      pages: WAN_PAGES,
      concurrency: DEFAULT_CONCURRENCY,
      document: PERF_SITE,
      tls: true,
      netem: WAN,
    });
    const summary = SUMMARY.exec(result.stderr);
    if (!summary) throw new Error(`${ctx.engine.id} printed no summary on the WAN crawl`);
    if (!result.usage) throw new Error("a crawl's CPU is its cgroup's: this needs systemd user scopes");
    return {
      wan: Number(summary[1]) / Math.max(Number(summary[2]), 0.001),
      "wan-cpu": cgroupCpuUs(result.usage, WAN_PAGES),
    };
  });
}

/** The JVM's carrier threads on the full tiered JIT: the longer wire crawl's instructions less the shorter's, a page. */
async function carrier(ctx: PerfContext): Promise<number> {
  return countDifference(
    ctx,
    JIT_PAGES,
    (pages, wrap) => perfCrawl(ctx, { path: WIRE, pages, concurrency: DEFAULT_CONCURRENCY, wrap }),
    { sample: "c2", thread: CARRIER },
  );
}

async function perfNumbers(ctx: PerfContext): Promise<Record<string, number>> {
  const runWire = async () => {
    const wireCount = ctx.count("instructions");
    await perfCrawl(ctx, { path: WIRE, pages: WIRE_PAGES, concurrency: DEFAULT_CONCURRENCY, wrap: wireCount.wrap });
    return wireCount.read() / WIRE_PAGES;
  };

  const runTls = async () => {
    const tlsStartupCount = ctx.count("instructions");
    await perfCrawl(ctx, {
      path: "/scale/0?links=4&limit=10",
      pages: 1,
      concurrency: 1,
      tls: true,
      wrap: tlsStartupCount.wrap,
    });
    const tlsCount = ctx.count("instructions");
    const tls = await perfCrawl(ctx, {
      path: "/perf/scan",
      pages: 301,
      concurrency: 1,
      document: PERF_SITE,
      tls: true,
      wrap: tlsCount.wrap,
    });
    return {
      "startup-tls": tlsStartupCount.read(),
      tls: tlsCount.read() / (tls.stats.bytes_out / 1024),
    };
  };

  const runRest = async () => {
    const scanCount = ctx.count("instructions");
    const scan = await perfCrawl(ctx, {
      path: "/perf/scan",
      pages: 301,
      concurrency: 1,
      document: SCAN_SITE,
      wrap: scanCount.wrap,
    });
    const linksCount = ctx.count("instructions");
    await perfCrawl(ctx, {
      path: "/perf/links/0",
      pages: 200,
      concurrency: 1,
      document: PERF_SITE,
      wrap: linksCount.wrap,
    });
    const startupRuns = ctx.engine.id === "java" ? 1 : ctx.engine.id === "go" ? 5 : STARTUPS;
    const runStartup = async () => {
      const startupCount = ctx.count("instructions");
      await perfCrawl(ctx, {
        path: "/scale/0?links=4&limit=10",
        pages: 1,
        concurrency: 1,
        document: DELAYED_SITE,
        wrap: startupCount.wrap,
      });
      return startupCount.read();
    };
    const startup =
      ctx.engine.id === "go" ? await leastOf(startupRuns, runStartup) : await medianOf(startupRuns, runStartup);

    const bodies = { path: ctx.engine.id === "java" ? "/perf/memory" : "/perf/held", pages: 141, document: PERF_SITE };
    const wide = await perfCrawl(ctx, { ...bodies, concurrency: 128 });
    const memory =
      ctx.engine.id === "java"
        ? wide.result.peakMb
        : perSlot(
            wide.result.peakMb,
            (await perfCrawl(ctx, { ...bodies, concurrency: DEFAULT_CONCURRENCY })).result.peakMb,
            128,
            DEFAULT_CONCURRENCY,
          );

    return {
      scan: scanCount.read() / (scan.stats.bytes_out / 1024),
      links: linksCount.read() / (200 * 1000),
      startup,
      memory,
      syscalls: await syscalls(ctx),
      crawlme: await crawlme(ctx),
      ...(await natives(ctx)),
    };
  };

  const [wire, tlsData, restData] = await Promise.all([runWire(), runTls(), runRest()]);

  const wall = async (pages: number) =>
    (await perfCrawl(ctx, { path: WIRE, pages, concurrency: DEFAULT_CONCURRENCY, document: DELAYED_SITE })).result.ms;
  let idle: number;
  const unlockIdle = await idleLock.acquire();
  try {
    // The slots' floor for 2,000 pages: 64 at a time, each one latency long.
    const floorMs = (2_000 * LATENCY_MS) / DEFAULT_CONCURRENCY;
    idle = await leastOf(IDLES, async () => Math.max(0, (await wall(3_000)) - (await wall(1_000)) - floorMs));
  } finally {
    unlockIdle();
  }

  return {
    ...sizes(ctx),
    ...restData,
    ...tlsData,
    wire,
    idle,
    ...(ctx.wants("wan") ? await wan(ctx) : {}),
    ...(ctx.wants("c2") ? { c2: await carrier(ctx) } : {}),
  };
}

export default defineBench<Crawl>({
  unit: "page",
  cpus: { bench: 2, mock: 2 },
  subjects: { limit: LIMIT, "limit-crawl": LIMIT_CRAWL },
  // `--units N` resizes the workloads that have `units`; the rest are a fixed size.
  workloads: [
    {
      name: "wire",
      path: "/scale/0?links=4&limit=10000000&delay=0",
      pages: 10_000_000,
      units: 10_000_000,
      concurrency: DEFAULT_CONCURRENCY,
      memoryMb: 1024,
    },
    // The workload to judge by: a million pages amortises startup.
    realworld("realworld", 1_000_000, { units: 1_000_000 }),
    // Startup cost.
    realworld("warmup", 50_000),
    // Throughput against concurrency, at one size.
    ...[1, 4, 16, 64].map((concurrency) => realworld(`concurrency-${concurrency}`, 100_000, { concurrency })),
    // Latency-bound, with a ceiling the limit measures: 64 in flight at 20 ms is 3200 pages/s.
    realworld("latency", 20_000, { rules: [{ match: "/scale/*", rate: 1, delay: ["20ms", "20ms"] }] }),
    // The recording; the limit cannot walk it.
    {
      name: "crawlme",
      path: "/",
      pages: 42_011,
      concurrency: DEFAULT_CONCURRENCY,
      memoryMb: 1024,
      archive: "crawlme.warc.gz",
      latency: true,
    },
    // Wikipedia: 2,000 authentic pages replayed with real-world edge latency, throttling and faults.
    {
      name: "wikipedia",
      path: "/",
      pages: 2_000,
      concurrency: DEFAULT_CONCURRENCY,
      memoryMb: 1024,
      archive: "wikipedia.warc.gz",
      site: "wikipedia.json",
      scenario: "realworld",
    },
  ],
  // The limit takes the page id out of the path and asks for the next one: it can walk a generated graph,
  // not a recorded site.
  applies: (subject, workload) => !subject.id.startsWith("limit") || !workload.archive,
  compare: {
    // Judged together, so throughput bought with CPU, memory, work or connections fails.
    primary: [
      "pages_per_s",
      "cpu_us_per_page",
      "peak_rss_mb",
      ...(process.env.CI ? [] : ["instructions_per_page"]),
      "connections_per_kpage",
    ],
    secondary: [
      ...(process.env.CI ? ["instructions_per_page"] : []),
      "critical_path_us",
      "syscalls_per_page",
      "ipc",
      "cache_miss_pct",
      "branch_misses_per_page",
      "faults_per_page",
    ],
    // Counters barely move between runs; connections vary with timing.
    thresholds: { pages_per_s: 3, cpu_us_per_page: 3, instructions_per_page: 2, connections_per_kpage: 10 },
    // Crawler code cannot move the limit: its drift is the machine's.
    control: "limit",
    drift: ["pages_per_s", "cpu_us_per_page"],
  },

  perf: {
    // Instructions under valgrind's simulator: the same count on any machine, no PMU needed, repeating to parts per
    // million one fetch at a time, so one measurement judges.
    counter: "cachegrind",
    runs: 1,
    // Two engines in parallel across the 2 vCPUs; idle measurements run under an exclusive lock so they are not perturbed.
    parallel: 2,
    tolerance: 0.05,
    samples: PERF_SAMPLES,
    measure: perfNumbers,
  },

  passes: { perf: 1, strace: 0 },
  run: async ({ workload, mode, cpus, run }) => {
    await using site = await mock(siteFor(workload), { bound: { cpus: cpus.mock!, memoryMb: 1024 } });
    const result = await run(["-f", "-n", "100M", site.url(workload.path)], {
      memoryMb: workload.memoryMb,
      stdout: "ignore",
      wallMs: 600_000,
      flags: [...CRAWL.flags, ...(mode === "record" ? ["-XX:+DumpPerfMapAtExit"] : [])],
    });
    const stats = await site.stats().catch(() => undefined);
    const ok = result.code === 0;
    const count = stats?.requests ?? workload.pages;
    const rate = count / Math.max(result.ms / 1000, 0.001);
    return {
      count,
      ...(ok ? {} : { fail: `exit ${result.code}${result.killed ? ` (${result.killed})` : ""}` }),
      ...httpWorkloadStats({ concurrency: workload.concurrency, rate, count, stats }),
      fixture: { name: "the mock", cgroup: site.cgroup, cpus: cpus.mock! },
    };
  },
});

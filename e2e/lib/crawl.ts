// The contract as tests (see e2e/README.md): each case in cases.json is a test, run by l3 once per target (the Java
// reference and each port) on the crawler it built. What every target printed is recorded for the agreement
// (expectAgree), and a consensus case's records as a set.
import { existsSync, readFileSync } from "node:fs";
import { app, expectAgree, hasScopes, test, type Mock, type RunResult, type StdoutMode } from "@l3/tools";
import { describe } from "bun:test";
import pkg from "../../package.json";
import { readCases, type Case, type Kind } from "./cases.ts";
import {
  comparable,
  findRecordMismatch,
  normalized,
  parseOutput,
  quoteExcerpt,
  summaryMismatch,
  type Output,
  type PageRecord,
} from "./records.ts";
import { damaged, expandRunNotation, expandStartUrl, startCaseServer, type CaseServer } from "./site.ts";

/// What a crawl of each kind may spend, unless the case says otherwise (`peak_mb`, `max_elapsed_ms`).
const BOUNDS: Record<Kind, { memoryMb: number; wallMs: number }> = {
  parity: { memoryMb: 2048, wallMs: 120_000 },
  stress: { memoryMb: 512, wallMs: 20_000 },
  consensus: { memoryMb: 2048, wallMs: 120_000 },
  golden: { memoryMb: 4096, wallMs: 120_000 },
};
const CASE_ENV = { CRAWL_DELAY: "0", CRAWL_CPUS: "2" };

/// Crawls run at once in one target's run: a case mostly waits (on timeouts, stalls, drains, a mock's latency), and
/// eight held every stress case's bounds on a two-core runner; a Mac's three cores held six.
const SLOTS = process.platform === "darwin" ? 6 : 8;
/// A signal not handled ends a crawl at once; a handled one is drained within ten seconds (DESIGN §2).
const DRAIN_MS = 10_000;

const LONGEST_LINK = 8000;
/// A refusal this quick is the crawler declining the start page, which `or_fast` accepts in place of `stdout`.
const FAST_REFUSAL_MS = 1500;
const SIGNALS: Record<number, NodeJS.Signals> = { 1: "SIGHUP", 2: "SIGINT", 13: "SIGPIPE", 15: "SIGTERM" };
/// A crash on stderr, or what a checked build reports: Go's race detector, a sanitizer, Zig's DebugAllocator's
/// leak at exit, a Zig safety panic.
const CRASH =
  /panicked at|stack backtrace|goroutine \d+ \[|Exception in thread|OutOfMemoryError|^\s+at [\w.$]+\(|WARNING: DATA RACE|==\d+==ERROR: \w+Sanitizer|WARNING: ThreadSanitizer|memory address 0x[0-9a-f]+ leaked|^thread \d+ panic: /m;

/** The CPUs this process may run on (Linux), for the affinity cases. */
function allowedCpus(): number[] {
  if (process.platform !== "linux") return [];
  const list = /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? "";
  return list.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, i) => a! + i);
  });
}

// --- Slots ---

let free = SLOTS;
const waiting: (() => void)[] = [];
async function slot<T>(body: () => Promise<T>): Promise<T> {
  if (free === 0) await new Promise<void>((resolve) => waiting.push(resolve));
  else free--;
  try {
    return await body();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else free++;
  }
}

// --- Variants ---

interface Variant {
  label: string;
  concurrency: number;
  ordered: boolean;
}

/// A plain parity case (a server, a clean exit, no signal, no stdout mode, no `-c` of its own) runs
/// twice: `-c 1`, whose output order is the crawl order and is compared as such, and `-c 8`, compared
/// as a set. Every other case runs once, as written; a set order is a recording's or a consensus's own.
function variantsOf(testCase: Case): Variant[] {
  const setsConcurrency = testCase.args.some((a) => a === "-c");
  const isPlainParity =
    testCase.kind === "parity" &&
    testCase.server !== false &&
    !testCase.interrupt_after_ms &&
    !testCase.mode &&
    !testCase.stderr &&
    testCase.expected_exit_code === 0 &&
    !setsConcurrency;
  if (!isPlainParity) return [{ label: "", concurrency: 0, ordered: testCase.kind === "parity" }];
  return [
    { label: "-c 1 (ordered)", concurrency: 1, ordered: true },
    { label: "-c 8 (set)", concurrency: 8, ordered: false },
  ];
}

// --- The judgement ---

/// The lines a crawl that ran may write to stderr (DESIGN §1, §2, §5), each matched whole.
const STDERR_LINES = [
  /^settings: (fast|polite), cpus \d+, threads \d+, concurrency \d+ \(max \d+\), delay \d+(?:\.\d+)?s, timeout \d+s, pages \d+$/,
  /^crawled \d+ pages in \d+\.\d\ds, \d+ errors$/,
  /^error: host unreachable$/,
  /^error: cannot write output$/,
  /^warning: SSL_CERT_FILE is unreadable; trusting no certificates$/,
];
const SUMMARY = /^crawled \d+ pages in /;
const FLAG = /(?:^|\s)(--[a-z0-9-]+|-[a-zA-Z0-9])(?=[\s,=]|$)/g;

/** The distinct flags a usage text names on its indented lines. */
function usageFlags(usage: string): string[] {
  const indented = usage.split("\n").filter((line) => /^( {2}|\t)/.test(line));
  return [...new Set(indented.flatMap((line) => [...line.matchAll(FLAG)].map((match) => match[1]!)))].sort();
}

/** A stderr line no grammar of the contract allows, of a crawl that ran to its end. */
function strayStderrLine(testCase: Case, result: RunResult): string | undefined {
  if (testCase.server === false || testCase.mode === "ignore" || testCase.mode === "merged") return undefined;
  if (result.hung || result.oom) return undefined;
  if (result.code >= 128 && result.code !== 130 && result.code !== 143) return undefined;
  return result.stderr
    .split("\n")
    .filter(Boolean)
    .find((line) => !STDERR_LINES.some((grammar) => grammar.test(line)));
}

/// Records are compared when the case has an expected file and the crawl was meant to print
/// (a clean exit, an interrupted one, or a file with records): a usage error prints nothing.
function recordsMismatch(
  testCase: Case,
  variant: Variant,
  output: Output,
  expectedExits: number[],
  damagedPages?: Set<string>,
) {
  const expected = testCase.records;
  const printsRecords = expectedExits.includes(0) || (expected?.length ?? 0) > 0 || expectedExits.includes(130);
  if (!expected || !printsRecords || testCase.mode) return undefined;
  return findRecordMismatch(output.records, expected, variant.ordered, damagedPages);
}

/// A crawl that printed whole (it ended on its own, its stdout was read whole, it was not a usage
/// error and no second signal halted it) has a summary line that counts what it printed.
function summaryApplies(testCase: Case, result: RunResult): boolean {
  const crawled = testCase.server !== false && [0, 1, 130, 143].includes(result.code);
  const whole = !testCase.usage && (!testCase.mode || testCase.mode === "merged") && !testCase.interrupt_again_ms;
  return crawled && whole && !result.hung && !result.oom;
}

/** Everything that did not hold of one crawl, each in a sentence; empty is a pass. */
function failuresOf(
  testCase: Case,
  result: RunResult,
  stdout: string,
  output: Output,
  variant: Variant,
  measured: boolean,
  damagedPages?: Set<string>,
): string[] {
  const { memoryMb, wallMs } = BOUNDS[testCase.kind];
  const maxMs = testCase.max_elapsed_ms ?? wallMs;
  const expectedExits = [testCase.expected_exit_code].flat();
  const cap = testCase.peak_mb ?? memoryMb;
  const failures: string[] = [];
  const check = (cond: unknown, msg: string | (() => string)) => {
    if (cond) failures.push(typeof msg === "function" ? msg() : msg);
  };

  // The run: its end, its time, its memory.
  check(
    result.hung,
    () => `hang: not finished after ${result.ms} ms (bound ${maxMs} ms, or 10 s to drain a signal), killed`,
  );
  check(result.oom, `killed at the ${cap} MB cap`);
  check(!result.hung && !result.oom && !expectedExits.includes(result.code), () =>
    result.code >= 128
      ? `died of signal ${result.code - 128} (exit ${result.code})`
      : `exit ${result.code}, wanted ${expectedExits.join(" or ")}: ${quoteExcerpt(result.stderr.slice(-200))}`,
  );
  check(!result.hung && result.ms > maxMs, () => `took ${result.ms} ms, over its ${maxMs} ms`);
  check(measured && result.peakMb > cap && !result.oom, () => `peak ${Math.round(result.peakMb)} MB, over ${cap} MB`);

  // The command line's contract.
  check(
    CRASH.test(result.stderr),
    () => `a stack trace or panic on stderr: ${quoteExcerpt(result.stderr.slice(0, 200))}`,
  );
  check(testCase.usage && stdout.trim().length > 0, "a usage error wrote to stdout");
  check(
    testCase.usage && !/-h/.test(result.stderr),
    () => `usage error does not point at -h: ${quoteExcerpt(result.stderr.slice(0, 120))}`,
  );
  check(
    testCase.error_line !== undefined && result.stderr !== `${testCase.error_line}\n`,
    () => `stderr is not ${quoteExcerpt(testCase.error_line!)} alone: ${quoteExcerpt(result.stderr.slice(0, 200))}`,
  );
  const stray = strayStderrLine(testCase, result);
  check(stray !== undefined, () => `stderr has a line the contract does not: ${quoteExcerpt(stray!)}`);
  check(
    testCase.stdout && !testCase.or_fast && !new RegExp(testCase.stdout, "m").test(stdout),
    () => `no stdout line matches /${testCase.stdout}/`,
  );
  check(
    testCase.stderr && !new RegExp(testCase.stderr).test(result.stderr),
    () => `stderr does not match /${testCase.stderr}/: ${quoteExcerpt(result.stderr.slice(0, 120))}`,
  );
  if (testCase.flags) {
    const listed = usageFlags(stdout);
    const missing = testCase.flags.filter((f) => !listed.includes(f));
    const unexpected = listed.filter((f) => !testCase.flags!.includes(f));
    check(
      missing.length || unexpected.length,
      () => `flag-set drift: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
    );
  }
  for (const phrase of testCase.help_contains ?? [])
    check(!stdout.includes(phrase), () => `help text does not contain ${JSON.stringify(phrase)}`);
  check(
    testCase.version && !new RegExp(`^crawl ${pkg.version} \\(\\w+`, "m").test(stdout),
    () => `stdout does not start with crawl ${pkg.version} (<engine>)`,
  );

  // The output's contract.
  check(
    output.badLines.length > 0 && !testCase.flags && !testCase.version,
    () => `stdout breaks the grammar: ${output.badLines.join("; ")}`,
  );
  if (testCase.mode === "merged") {
    const lines = result.stdout.split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    check(
      !SUMMARY.test(lastLine),
      () => `the last line of merged output is not the summary: ${quoteExcerpt(lastLine)}`,
    );
  }
  if (summaryApplies(testCase, result)) {
    const mismatch = summaryMismatch(result.stderr, output);
    check(mismatch, () => mismatch!);
  }
  if (testCase.stdout && testCase.or_fast) {
    check(
      !output.wantMatched &&
        !(result.ms < FAST_REFUSAL_MS && output.records.length > 0 && output.badLines.length === 0),
      `no stdout line matches /${testCase.stdout}/`,
    );
  }
  const failed = output.records.filter((r) => r.error !== null);
  check(
    testCase.no_errors && failed.length > 0,
    () => `${failed.length} pages failed, the first ${failed[0]!.url}: ${quoteExcerpt(String(failed[0]!.error))}`,
  );
  check(
    testCase.expected_pages !== undefined && output.records.length !== testCase.expected_pages,
    `${output.records.length} pages, wanted exactly ${testCase.expected_pages}`,
  );
  check(
    testCase.link_bytes && output.longestUrlLength > LONGEST_LINK,
    `a URL of ${output.longestUrlLength} bytes, over ${LONGEST_LINK}`,
  );
  if (failures.length === 0) {
    const mismatch = recordsMismatch(testCase, variant, output, expectedExits, damagedPages);
    if (mismatch) failures.push(mismatch);
  }
  return failures;
}

// --- One crawl ---

function crawlerArgs(testCase: Case, variant: Variant, server: CaseServer): string[] {
  const concurrency = variant.concurrency ? ["-c", String(variant.concurrency)] : [];
  const start = testCase.start_url ? [server.toServed(expandStartUrl(testCase.start_url))] : [];
  return [...concurrency, ...testCase.args.map((arg) => server.toServed(expandRunNotation(arg))), ...start];
}

/** Splits merged stdout and stderr lines: a page line is stdout's. */
function splitMerged(merged: string): { stdout: string; stderr: string } {
  const lines = merged.split("\n").filter(Boolean);
  const isPage = (line: string) => /^https?:\/\//.test(line);
  const text = (part: string[]) => (part.length > 0 ? `${part.join("\n")}\n` : "");
  return { stdout: text(lines.filter(isPage)), stderr: text(lines.filter((l) => !isPage(l))) };
}

/** What the server answered while the crawler hung: whether it stopped asking or the server stopped answering. */
async function hangReport(result: RunResult, server: Mock | undefined): Promise<string> {
  const stats = await server?.stats().catch(() => undefined);
  const answered = stats
    ? `, and the server answered ${stats.requests} requests with ${Math.round(stats.bytes_out / 1048576)} MB`
    : "";
  return `while it hung it used ${Math.round(result.peakMb)} MB at most${answered}`;
}

/** A summary of TLS or h2 connections faulty refused or broke, unless the case asked for a TLS fault. */
function faultyComplaints(lines: string[], faulted: boolean): string | undefined {
  if (faulted) return undefined;
  const complaints = lines.filter((l) => /^\[faulty\] (tls|h2): /.test(l));
  if (complaints.length === 0) return undefined;
  const kinds = [...new Set(complaints.map((l) => l.replace(/^\[faulty\] /, "")))].slice(0, 3);
  return `${complaints.length} TLS connections refused or broken by the server: ${kinds.join("; ")}`;
}

/** One crawl of `testCase` by the target under test: its failures, and its records. */
async function crawl(testCase: Case, variant: Variant): Promise<{ failures: string[]; records: PageRecord[] }> {
  const server = await startCaseServer(testCase);
  const { memoryMb, wallMs } = BOUNDS[testCase.kind];
  const cap = testCase.peak_mb ?? memoryMb;
  const maxMs = testCase.max_elapsed_ms ?? wallMs;
  // The memory cap is a scope's MemoryMax, or an RSS sampler over /proc: Linux's. A Mac's crawl is held to its wall.
  const measured = process.platform === "linux";
  const cpus = testCase.cpu_affinity ? allowedCpus().slice(0, testCase.cpu_affinity) : undefined;
  let damagedPages: Set<string> | undefined;
  let complaints: string[] = [];
  let result: RunResult;
  let hang = "";
  try {
    // Which archived pages the case's faults damage: faulty says, so the hash lives in one place.
    if (testCase.archive && testCase.rules && server.mock) damagedPages = await damaged(server.mock);
    const crawler = await app({
      memory: cap,
      ...(cpus ? { cpus } : {}),
    });
    // An interrupt is timed from the crawler's first connection to the site, so a slow start does not move it.
    const signal = testCase.interrupt_after_ms
      ? {
          name: SIGNALS[testCase.interrupt_signal ?? 2]!,
          afterMs: testCase.interrupt_after_ms,
          ...(testCase.interrupt_again_ms ? { againMs: testCase.interrupt_again_ms } : {}),
          ...(server.mock ? { afterConnect: server.mock } : {}),
        }
      : undefined;
    result = await crawler.run(crawlerArgs(testCase, variant, server), {
      timeout: maxMs + (signal ? DRAIN_MS : 0),
      env: { ...CASE_ENV, ...server.env, ...testCase.env },
      ...(testCase.mode ? { stdout: testCase.mode as StdoutMode } : {}),
      ...(signal ? { signal } : {}),
      ...(testCase.reset_signals ? { resetSignals: true } : {}),
      ...(testCase.cpu_quota ? { cpuQuota: testCase.cpu_quota * 100 } : {}),
    });
    if (result.hung) hang = await hangReport(result, server.mock);
  } finally {
    // What the server logged about TLS or h2 connections it refused or broke.
    complaints = server.mock?.lines() ?? [];
    await server.mock?.stop();
    await server.stop?.();
  }

  let stdout = server.toWritten(result.stdout);
  if (testCase.mode === "merged") {
    const split = splitMerged(stdout);
    stdout = split.stdout;
    if (split.stderr) result = { ...result, stderr: split.stderr };
  }
  const want = testCase.stdout ? new RegExp(testCase.stdout) : undefined;
  const output = parseOutput(stdout, want);
  const failures = failuresOf(testCase, result, stdout, output, variant, measured, damagedPages);
  // What it printed, for the all-four-agree check, unless it was cut off.
  if (testCase.agree !== false && !result.hung && !result.oom) {
    const oneAtATime = crawlerArgs(testCase, variant, server).some((a, i, all) => a === "-c" && all[i + 1] === "1");
    // What a reader that went away took of stdout, or a signal left printed, is the moment's: then the exit and
    // stderr are compared, the summary's counts written out.
    const byExit = testCase.agree === "exit" || testCase.mode !== undefined;
    const printed = byExit ? "" : testCase.agree === "count" ? `${output.pages} pages\n` : stdout;
    // A crawl a signal it does not handle killed (SIGHUP) wrote nothing more: what stderr holds then is whatever ran
    // it saying so, so only the exit is compared.
    const killed = result.code > 128 && result.code !== 130 && result.code !== 143;
    const stderr = killed ? "" : server.toWritten(result.stderr);
    const said = byExit
      ? stderr.replace(/^crawled \d+ pages in \S+, \d+ errors$/m, "crawled N pages in S.SSs, E errors")
      : stderr;
    expectAgree("output", JSON.stringify({ code: result.code, ...normalized(printed, said, oneAtATime) }));
  }
  if (hang) failures.push(hang);
  // A TLS fault the case asked for is the server doing its job; anything else it logs is a failure.
  const faultedTls = testCase.tls === "untrusted" || (testCase.mock_flags ?? []).some((f) => f.startsWith("--tls-"));
  const complaintsReport = faultyComplaints(complaints, faultedTls);
  if (complaintsReport) failures.push(complaintsReport);
  return { failures, records: output.records };
}

// --- A consensus ---

/**
 * A dynamic site has no file to expect: the target under test crawls and must pass, and its records, as a set, are
 * what every target must agree on (expectAgree, compared once every target ran).
 */
async function consensus(testCase: Case, variant: Variant): Promise<void> {
  const own = await crawl(testCase, variant);
  if (own.failures.length > 0) throw new Error(own.failures.join("\n"));
  expectAgree("output", JSON.stringify(comparable(own.records)));
}

async function held(testCase: Case, variant: Variant): Promise<void> {
  // A golden case is its expected file: missing, nothing would be compared (fixtures.json says where it comes from).
  if (testCase.kind === "golden" && !testCase.records)
    throw new Error(
      `${testCase.expected ?? testCase.name}: the expected file is not in fixtures/expected (fixtures.json)`,
    );
  if (testCase.kind === "consensus") return consensus(testCase, variant);
  const { failures } = await crawl(testCase, variant);
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

// --- The suite ---

/** Whether a case can run here: CPU affinity and a full disk are Linux's (/proc, /dev/full), a quota a scope's. */
function unavailable(testCase: Case): string | undefined {
  if (testCase.cpu_quota && !hasScopes()) return "a CPU quota: no systemd scope to hold it";
  if (testCase.cpu_affinity && allowedCpus().length < testCase.cpu_affinity)
    return `${testCase.cpu_affinity} CPUs to pin to`;
  if (testCase.mode === "devfull" && !existsSync("/dev/full")) return "no /dev/full";
  return undefined;
}

/**
 * Each case of `kinds` a concurrent test, held to the slots. `nightly` picks the slow cases (and golden's, which are
 * all slow); without it they are left to the nightly file.
 */
export function defineCases(kinds: Kind[], opts: { nightly?: boolean } = {}): void {
  for (const kind of kinds) {
    describe(kind, () => {
      for (const testCase of readCases(kind)) {
        if (!!(testCase.slow || kind === "golden") !== !!opts.nightly) continue;
        const skip = unavailable(testCase);
        for (const variant of variantsOf(testCase)) {
          const name = [testCase.name, variant.label].filter(Boolean).join(" ");
          const timeout = (testCase.max_elapsed_ms ?? BOUNDS[kind].wallMs) + 5 * 60_000;
          if (skip) test.skip(`${name} (${skip})`, () => {});
          else test.concurrent(name, () => slot(() => held(testCase, variant)), timeout);
        }
      }
    });
  }
}

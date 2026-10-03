// The contract as tests (see e2e/README.md): tools runs this file once per engine, `engine()` the one under test,
// and each case in cases.json is a test. CONFORM_FULL=1 adds golden and the `slow` cases.
import { rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import {
  cliCaseFailures,
  cliCaseRunOptions,
  consensus as agreed,
  caseOutputFile,
  defineCliSpec,
  engine,
  expandRunNotation,
  faultyComplaints,
  hangReport,
  keepForAgreement,
  processAllowedCpus,
  quoteExcerpt,
  run,
  runResultFailures,
  splitMerged,
  type Engine,
  type FaultyStats,
  type SpecMockServer,
  type Result,
} from "@tools/core";
import { KINDS, readCases, type Case, type Kind } from "./cases.ts";
import {
  findRecordMismatch,
  comparable,
  normalized,
  parseOutput,
  readOutputFile,
  summaryMismatch,
  type Output,
  type PageRecord,
} from "./records.ts";
import { DIST_FLAGS } from "../project.ts";
import { expandStartUrl, startCaseServer } from "./site.ts";

/// What a crawl of each kind may spend, unless the case says otherwise (`peak_mb`, `max_elapsed_ms`).
const BOUNDS: Record<Kind, { memoryMb: number; wallMs: number }> = {
  parity: { memoryMb: 2048, wallMs: 120_000 },
  stress: { memoryMb: 512, wallMs: 20_000 },
  consensus: { memoryMb: 2048, wallMs: 120_000 },
  golden: { memoryMb: 4096, wallMs: 120_000 },
};
const CASE_ENV = { CRAWL_DELAY: "0", CRAWL_CPUS: "2" };

const LONGEST_LINK = 8000;
/// A refusal this quick is the crawler declining the start page, which `or_fast` accepts in place of `stdout`.
const FAST_REFUSAL_MS = 1500;
const allowedCpus = processAllowedCpus();

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

/// Records are compared when the case has an expected file and the crawl was meant to print
/// (a clean exit, an interrupted one, or a file with records): a usage error prints nothing.
function recordsMismatch(
  testCase: Case,
  variant: Variant,
  output: Output,
  expectedExits: number[],
  damaged?: Set<string>,
) {
  const expected = testCase.records;
  const printsRecords = expectedExits.includes(0) || (expected?.length ?? 0) > 0 || expectedExits.includes(130);
  if (!expected || !printsRecords || testCase.mode) return undefined;
  return findRecordMismatch(output.records, expected, variant.ordered, damaged);
}

/// A crawl that printed whole (it ended on its own, its stdout was read whole, it was not a usage
/// error and no second signal halted it) has a summary line that counts what it printed.
function summaryApplies(testCase: Case, result: Result): boolean {
  const crawled = testCase.server !== false && [0, 1, 130, 143].includes(result.code);
  const whole = !testCase.usage && (!testCase.mode || testCase.mode === "merged") && !testCase.interrupt_again_ms;
  return crawled && whole && !result.hung && !result.killed && !result.oom;
}

/// The flags a usage text lists: every `-x` or `--word` on an indented line.

/// The lines a crawl that ran may write to stderr (DESIGN §1, §2, §5), each matched whole.
const STDERR_LINES = [
  /^settings: (fast|polite), cpus \d+, threads \d+, concurrency \d+ \(max \d+\), delay \d+(?:\.\d+)?s, timeout \d+s, pages \d+$/,
  /^crawled \d+ pages in \d+\.\d\ds, \d+ errors$/,
  /^error: host unreachable$/,
  /^error: cannot write output$/,
  /^warning: SSL_CERT_FILE is unreadable; trusting no certificates$/,
];
const SUMMARY = /^crawled \d+ pages in /;

/** Everything that did not hold of one crawl, each in a sentence; empty is a pass. */
function failuresOf(
  testCase: Case,
  result: Result,
  stdout: string,
  output: Output,
  variant: Variant,
  damaged?: Set<string>,
): string[] {
  const { memoryMb, wallMs } = BOUNDS[testCase.kind];
  const maxMs = testCase.max_elapsed_ms ?? wallMs;
  const expectedExits = [testCase.expected_exit_code].flat();
  const cap = testCase.peak_mb ?? memoryMb;
  const failures = runResultFailures(result, { memoryMb, maxMs, peakMb: cap, expectedExits }, quoteExcerpt);
  const check = (cond: unknown, msg: string | (() => string)) => {
    if (cond) failures.push(typeof msg === "function" ? msg() : msg);
  };

  failures.push(
    ...cliCaseFailures(testCase, result, stdout, {
      stderrLines: STDERR_LINES,
      version: pkg.version,
      program: "crawl",
    }),
  );

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
    const mismatch = recordsMismatch(testCase, variant, output, expectedExits, damaged);
    if (mismatch) failures.push(mismatch);
  }
  return failures;
}

// --- One crawl ---

const bigOutputFile = (testCase: Case, variant: Variant) =>
  caseOutputFile(join(import.meta.dir, ".."), testCase.name, variant.concurrency);

function crawlerArgs(testCase: Case, variant: Variant, server: SpecMockServer): string[] {
  const concurrency = variant.concurrency ? ["-c", String(variant.concurrency)] : [];
  const start = testCase.start_url ? [server.toServed(expandStartUrl(testCase.start_url))] : [];
  return [...concurrency, ...testCase.args.map((arg) => server.toServed(expandRunNotation(arg))), ...start];
}

/** One crawl of `testCase` by `who` (the engine under test unless named): its failures, and its records. */
async function crawl(
  testCase: Case,
  variant: Variant,
  who?: Engine,
): Promise<{ failures: string[]; records: PageRecord[] }> {
  const server = await startCaseServer(testCase);
  let damaged: Set<string> | undefined;
  let complaints: string[] = [];
  let result: Result;
  let served: FaultyStats | undefined;
  try {
    // Which archived pages the case's faults damage: faulty says, so the hash lives in one place.
    if (testCase.archive && testCase.rules && server.mock) damaged = await server.mock.damaged();
    const options = cliCaseRunOptions(testCase, server, {
      bounds: BOUNDS,
      env: CASE_ENV,
      allowedCpus,
      outputFile: testCase.big_output ? bigOutputFile(testCase, variant) : undefined,
      flags: testCase.kind === "golden" ? DIST_FLAGS : undefined,
    });
    const args = crawlerArgs(testCase, variant, server);
    result = who ? await run.with(who, args, options) : await run(args, options);
    // A hang says whether the crawler stopped asking or the server stopped answering.
    if (result.hung) served = await server.mock?.stats().catch(() => undefined);
  } finally {
    // What the server logged about TLS or h2 connections it refused or broke.
    complaints = server.mock?.lines() ?? [];
    await server.mock?.stop();
    await server.stop?.();
  }

  let stdout = server.toWritten(result.stdout);
  if (testCase.mode === "merged") {
    const isPage = (line: string) => /^https?:\/\//.test(line);
    const split = splitMerged(stdout, isPage);
    stdout = split.stdout;
    if (split.stderr) {
      result.stderr = split.stderr;
    }
  }
  const want = testCase.stdout ? new RegExp(testCase.stdout) : undefined;
  const output = testCase.big_output
    ? await readOutputFile(bigOutputFile(testCase, variant), server.toWritten, want)
    : parseOutput(stdout, want);
  if (testCase.big_output) rmSync(bigOutputFile(testCase, variant), { force: true });
  const failures = failuresOf(testCase, result, stdout, output, variant, damaged);
  // What it printed, for the all-four-agree check (tools' `gate.agree`), unless it was cut off.
  if (testCase.agree !== false && !result.hung && !result.killed && !result.oom) {
    const name = [testCase.name, variant.label].filter(Boolean).join(" ");
    const oneAtATime = crawlerArgs(testCase, variant, server).some((a, i, all) => a === "-c" && all[i + 1] === "1");
    // What a reader that went away took of stdout, or a signal left printed, is the moment's: then the exit and
    // stderr are compared, the summary's counts written out.
    const byExit = testCase.agree === "exit" || testCase.mode !== undefined;
    const printed = byExit
      ? ""
      : testCase.agree === "count" || testCase.big_output
        ? `${output.pages} pages\n`
        : stdout;
    // A crawl a signal it does not handle killed (SIGHUP) wrote nothing more: what stderr holds then is whatever ran
    // it saying so (a runner's shell prints "Hangup"), so only the exit is compared.
    const killed = result.code > 128 && result.code !== 130 && result.code !== 143;
    const stderr = killed ? "" : server.toWritten(result.stderr);
    const said = byExit
      ? stderr.replace(/^crawled \d+ pages in \S+, \d+ errors$/m, "crawled N pages in S.SSs, E errors")
      : stderr;
    keepForAgreement(name, who ?? engine(), { code: result.code, ...normalized(printed, said, oneAtATime) });
  }
  if (result.hung) {
    failures.push(hangReport(result, served));
  }
  // A TLS fault the case asked for is the server doing its job; anything else it logs is a failure.
  const faultedTls = testCase.tls === "untrusted" || (testCase.mock_flags ?? []).some((f) => f.startsWith("--tls-"));
  const complaintsReport = faultyComplaints(complaints, { faulted: faultedTls });
  if (complaintsReport) {
    failures.push(complaintsReport);
  }
  return { failures, records: output.records };
}

// --- A consensus ---

/** The engine under test crawls; every other engine's records come from its own crawl, kept per build (tools'
 * `consensus`: each engine crawls once and the specs after it read what it printed); all must agree. */
async function consensus(testCase: Case, variant: Variant): Promise<void> {
  const own = await crawl(testCase, variant);
  if (own.failures.length > 0) throw new Error(own.failures.join("\n"));
  const me = engine();
  const all = await agreed(
    testCase.name,
    me,
    own.records,
    async (other) => (await crawl(testCase, variant, other)).records,
  );
  const mine = comparable(own.records);
  for (const [id, records] of all) {
    if (id === me.id) continue;
    const mismatch = findRecordMismatch(mine, comparable(records), false);
    if (mismatch) throw new Error(`differs from ${id}: ${mismatch}`);
  }
}

async function held(testCase: Case, variant: Variant): Promise<void> {
  if (testCase.kind === "consensus") return consensus(testCase, variant);
  const { failures } = await crawl(testCase, variant);
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

// --- The suite ---

defineCliSpec({
  kinds: KINDS,
  readCases,
  variants: variantsOf,
  held,
  bounds: BOUNDS,
  full: "CONFORM_FULL",
});

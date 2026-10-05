// The floor the crawlers are judged against: bench/limit.zig fetches pages over keep-alive HTTP/1.1 with raw Linux
// syscalls, nothing between the kernel and the numbers (`--crawl` adds a crawler's per-page work: links extracted,
// deduped, written out). Each crawler's wall over the same wire crawl beside it, reported and never judged: a wall
// is the machine's as much as the code's.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, expect, mock, report, test } from "@l3/tools";
import { SITE } from "../e2e/lib/site.ts";
import { WIRE } from "./site.ts";

const LIMIT_ZIG = join(import.meta.dir, "limit.zig");
const OUT = join(import.meta.dir, "..", ".tools", "bench", "limit");
const PAGES = 20_000;
const CONCURRENCY = 64;
const ENGINES = { java: ".", go: "ports/go", rust: "ports/rust", zig: "ports/zig" } as const;
const linux = process.platform === "linux";

/** A command run to its end: its exit and its output. */
function run(argv: string[]): { code: number; out: string } {
  const done = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString() + done.stderr.toString() };
}

// Each test is named for an engine (its last word), so each lands in that engine's perf job: four jobs, no fifth that
// builds every engine for a test of none.
test.if(linux)(
  "the limit's own tests, in zig",
  () => {
    const tested = run(["zig", "test", LIMIT_ZIG]);
    expect(tested.code, tested.out.slice(-2000)).toBe(0);
  },
  600_000,
);

/** The limit built once a process (each engine's perf job builds it for itself). */
let limitBinary: string | undefined;
function limit(): string {
  if (limitBinary) return limitBinary;
  mkdirSync(OUT, { recursive: true });
  const binary = join(OUT, "limit");
  const built = run(["zig", "build-exe", "-OReleaseFast", `-femit-bin=${binary}`, LIMIT_ZIG]);
  expect(built.code, built.out.slice(-2000)).toBe(0);
  return (limitBinary = binary);
}

for (const [engine, from] of Object.entries(ENGINES)) {
  test.if(linux)(
    `the wire crawl's wall beside the limit's ${engine}`,
    async () => {
      const binary = limit();
      const site = await mock(SITE);
      const url = `${site.url}${WIRE}`;
      for (const [name, mode] of [
        ["limit", []],
        ["limit-crawl", ["--crawl"]],
      ] as const) {
        const started = performance.now();
        const fetched = run([binary, ...mode, "-c", String(CONCURRENCY), "-n", String(PAGES), url]);
        expect(fetched.code, fetched.out.slice(-400)).toBe(0);
        report(`wire ${PAGES} ${name} (${engine}'s job)`, Math.round(performance.now() - started), "ms");
      }
      const crawler = await app({ from });
      const result = await crawler.run(["-f", "-c", String(CONCURRENCY), "-n", String(PAGES), url], {
        stdout: "ignore",
      });
      expect(result.code, result.stderr.slice(-400)).toBe(0);
      report(`wire ${PAGES} ${engine}`, result.ms, "ms");
    },
    1_800_000,
  );
}

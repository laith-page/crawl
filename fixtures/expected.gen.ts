// `bun fixtures/expected.gen.ts <case name>...` (or `parity`): a case's expected file in fixtures/expected/ from the
// Java reference's crawl (target/crawler.jar: `mvn package` first). Read what it wrote: an expected file is a claim
// about what is right, and the crawler is not the judge of that. An error must be one of DESIGN §1's categories.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_DIR, readCases, type Case } from "../e2e/lib/cases.ts";
import { parseOutput, type PageRecord } from "../e2e/lib/records.ts";
import { expandStartUrl, startCaseServer } from "../e2e/lib/site.ts";

const ROOT = join(import.meta.dir, "..");
const JAR = join(ROOT, "target", "crawler.jar");
/// The flags the reference runs with (src/main/jvm.options), the runtime's modules aside.
const FLAGS = readFileSync(join(ROOT, "src", "main", "jvm.options"), "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*/, "").trim())
  .filter((l) => l && !l.startsWith("--add-modules"));

/// DESIGN §1's failure categories: what an error on a page line may say.
const CATEGORIES = new Set([
  "timeout",
  "dns failed",
  "connect failed",
  "tls failed",
  "body over 5 MiB",
  "connection reset",
  "malformed response",
]);

async function crawl(testCase: Case): Promise<PageRecord[]> {
  if (testCase.server === false || !testCase.start_url) throw new Error(`${testCase.name}: no site to crawl`);
  const server = await startCaseServer(testCase);
  try {
    const args = ["-c", "1", ...testCase.args, server.toServed(expandStartUrl(testCase.start_url))];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(testCase.name === "affinity-cpus" || testCase.name === "affinity-quota" ? {} : { CRAWL_CPUS: "2" }),
      ...server.env,
      ...testCase.env,
    };
    const proc = Bun.spawn(["java", ...FLAGS, "-jar", JAR, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if (proc.signalCode === "SIGKILL") throw new Error(`${testCase.name}: the crawl hung`);
    if (/Exception in thread|OutOfMemoryError/.test(stderr)) throw new Error(`${testCase.name}: the crawl crashed`);
    const output = parseOutput(server.toWritten(stdout));
    if (output.badLines.length) throw new Error(`${testCase.name}: ${output.badLines.join("; ")}`);
    const stray = output.records.find((r) => r.error !== null && !CATEGORIES.has(r.error));
    if (stray) throw new Error(`${testCase.name}: ${stray.url} has no category of error: ${stray.error}`);
    return output.records;
  } finally {
    await server.mock?.stop();
    await server.stop?.();
  }
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: bun fixtures/expected.gen.ts <case name>...  (or 'parity' for every parity case with a site)");
  process.exit(2);
}
if (!existsSync(JAR)) {
  console.error(`${JAR}: build the reference first (mvn -q -DskipTests package)`);
  process.exit(2);
}
const cases = [...readCases("parity"), ...readCases("stress")].filter(
  (c) => (names.includes("parity") && c.kind === "parity") || names.includes(c.name),
);
for (const testCase of cases) {
  // What a crawl prints under a signal, a stdout that goes away or its pages' timing is the case's, not a file's.
  const printsItsOwn = testCase.mode || testCase.interrupt_after_ms || testCase.agree !== undefined;
  if (testCase.server === false || printsItsOwn || testCase.expected) continue;
  const records = await crawl(testCase);
  const file = join(EXPECTED_DIR, `${testCase.name}.ndjson`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  console.log(`${testCase.name}: ${records.length} records`);
}
process.exit(0);

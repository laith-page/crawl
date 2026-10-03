// `bun scripts/expected.gen.ts <case name>...`: a case's expected file from Java's crawl. Read what it wrote: an
// expected file is a claim about what is right, and the crawler is not the judge of that. An error must be one of
// DESIGN §1's categories.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBuilt, loadProject, run } from "@tools/core";
import { EXPECTED_DIR, readCases, type Case } from "../e2e/cases.ts";
import { parseOutput, type PageRecord } from "../e2e/records.ts";
import { expandStartUrl, startCaseServer } from "../e2e/site.ts";
import { FAILURE_LABELS } from "../project.ts";

const project = loadProject();
const JAVA = project.engines.find((e) => e.id === "java")!;

const CATEGORIES = new Set<string>(FAILURE_LABELS);

async function crawl(testCase: Case): Promise<PageRecord[]> {
  if (testCase.server === false || !testCase.start_url) throw new Error(`${testCase.name}: no site to crawl`);
  const server = await startCaseServer(testCase);
  try {
    const args = ["-c", "1", ...testCase.args, server.toServed(expandStartUrl(testCase.start_url))];
    const env: Record<string, string> = {
      ...(testCase.name === "affinity-cpus" || testCase.name === "affinity-quota" ? {} : { CRAWL_CPUS: "2" }),
      ...server.env,
      ...testCase.env,
    };
    const result = await run.with(JAVA, args, { memoryMb: 2048, wallMs: 120_000, env });
    if (result.hung || result.crashed)
      throw new Error(`${testCase.name}: the crawl ${result.hung ? "hung" : "crashed"}`);
    const output = parseOutput(server.toWritten(result.stdout));
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
  console.error("usage: bun scripts/expected.gen.ts <case name>...  (or 'parity' for every parity case with a site)");
  process.exit(2);
}
await ensureBuilt(JAVA, project.root);
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

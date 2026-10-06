// Writes a golden case's expected file from the oracle (spider.py under Scrapy, run through uv):
// `bun fixtures/oracle/crawl.ts intl`. The mock serves the case's site on a free port; what Scrapy
// prints is rewritten to the written address and compressed into fixtures/expected/<name>.ndjson.zst.
// Nothing under test touches it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "@l3/tools";
import { EXPECTED_DIR, readCases } from "../../e2e/lib/cases.ts";
import { siteFor, WRITTEN_PORT } from "../../e2e/lib/site.ts";

const name = process.argv[2];
const testCase = readCases("golden").find((c) => c.name === name);
if (!testCase?.site) {
  console.error(
    `usage: bun fixtures/oracle/crawl.ts <golden case with a site>; have ${readCases("golden")
      .map((c) => c.name)
      .join(", ")}`,
  );
  process.exit(2);
}

const server = await mock(siteFor(testCase));
try {
  const start = `http://127.0.0.1:${server.port}${testCase.start_url ?? "/"}`;
  const spider = Bun.spawnSync(
    [
      "uvx",
      "--from",
      "scrapy",
      "scrapy",
      "runspider",
      join(import.meta.dir, "spider.py"),
      "-a",
      `start=${start}`,
      "-s",
      "LOG_LEVEL=ERROR",
    ],
    { stdout: "pipe", stderr: "inherit", maxBuffer: 1 << 30 },
  );
  if (!spider.success) throw new Error(`scrapy exited ${spider.exitCode}`);
  // What Scrapy printed for 127.0.0.1:<port> is written as localhost:8080, the case's address.
  const served = new RegExp(String.raw`127\.0\.0\.1:${server.port}(?!\d)`, "g");
  const toWritten = (line: string) => line.replace(served, `localhost:${WRITTEN_PORT}`);
  const lines = spider.stdout
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map(toWritten)
    .sort();
  const out = join(EXPECTED_DIR, testCase.expected ?? `${name}.ndjson.zst`);
  writeFileSync(out, Bun.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`), { level: 19 }));
  console.log(`${lines.length} records to ${out}`);
} finally {
  await server.stop();
}

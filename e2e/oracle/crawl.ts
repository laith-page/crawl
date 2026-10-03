// Writes a golden case's expected file from the oracle (spider.py under Scrapy, run through uv):
// `bun e2e/oracle/crawl.ts intl`. The mock serves the case's site on a free port; what Scrapy
// prints is rewritten to the written address and compressed into e2e/expected/<name>.ndjson.zst.
// Nothing under test touches it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePortMap, mock } from "@tools/core";
import { EXPECTED_DIR, readCases } from "../cases.ts";
import { siteFor, WRITTEN_PORT } from "../site.ts";

const name = process.argv[2];
const testCase = readCases("golden").find((c) => c.name === name);
if (!testCase?.site) {
  console.error(
    `usage: bun e2e/oracle/crawl.ts <golden case with a site>; have ${readCases("golden")
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
  const ports = fixturePortMap(WRITTEN_PORT, server.port, {
    hosts: String.raw`127\.0\.0\.1`,
    canonicalHost: "localhost",
  });
  const lines = spider.stdout
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map(ports.toWritten)
    .sort();
  const out = join(EXPECTED_DIR, testCase.expected ?? `${name}.ndjson.zst`);
  writeFileSync(out, Bun.zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`), { level: 19 }));
  console.log(`${lines.length} records to ${out}`);
} finally {
  await server.stop();
}

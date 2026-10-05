// The mocks are every case's fixture, and a fixture that quietly degrades leaves the crawlers passing: these hold
// the data itself. Every case's site is a document faulty accepts, every expected file a case names is there, and
// the recording replays within the machine it is deployed to.
import { app, expect, mock, test } from "@l3/tools";
import { describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KINDS, readCases, type Case } from "./lib/cases.ts";
import { CRAWLME_DIR, RECORDING, siteFor, trainingSite } from "./lib/site.ts";

/// faulty loads the document and serves it: empty, or what it refused.
const loads = async (site: string | object) => {
  try {
    const served = await mock(site);
    await served.stop();
    return "";
  } catch (error) {
    return String(error);
  }
};

describe("cases.json", () => {
  test("site.json, the recording and the wikipedia mock load", async () => {
    expect(await loads(siteFor({}))).toBe("");
    expect(await loads(siteFor({ archive: "crawlme.warc.gz" }))).toBe("");
    expect(await loads(trainingSite())).toBe("");
    expect(await loads("wikipedia")).toBe("");
  }, 120_000);

  // The 100k-page recording, served by the newest faulty (it streams the archive), under a crawl kept small: the
  // first 5,000 pages, fast (-f: no delay between requests), so a pull request's run stays short.
  test("a 5,000-page crawl of the wikipedia mock", async () => {
    const wiki = await mock("wikipedia");
    try {
      const result = await (await app()).run(["-f", "-n", "5000", wiki.url], { timeout: 60_000 });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/crawled 5000 pages in /);
    } finally {
      await wiki.stop();
    }
  }, 240_000);

  for (const kind of KINDS) {
    const cases = readCases(kind);
    test(`${kind} has cases`, () => expect(cases.length).toBeGreaterThan(0));
    test(`every ${kind} case that prints records has its expected file`, () => {
      const printing = (c: Case) =>
        (c.expected !== undefined && kind !== "golden") ||
        (kind === "parity" &&
          c.server !== false &&
          !c.mode &&
          !c.interrupt_after_ms &&
          !c.stderr &&
          !c.stdout &&
          c.expected_pages === undefined);
      for (const one of cases.filter(printing)) expect(one.records, one.name).toBeDefined();
    });
    for (const one of cases.filter((c) => c.rules || c.seed !== undefined)) {
      test(`${kind}: the faults of ${one.name} load`, async () => expect(await loads(siteFor(one))).toBe(""), 60_000);
    }
  }
});

// fly.toml gives crawlme 512 MB, some of it the guest's own, so the replay is held under 400 MiB
// (kernel-enforced in a systemd scope; elsewhere a pin alone), with the GOMEMLIMIT fly.toml deploys.
const GOMEMLIMIT = /^GOMEMLIMIT = "([^"]+)"/m.exec(readFileSync(join(CRAWLME_DIR, "fly.toml"), "utf8"))?.[1];

test("the recording replays under 400 MiB", async () => {
  expect(GOMEMLIMIT, "fly.toml sets no GOMEMLIMIT").toBeDefined();
  const server = await mock(RECORDING, { cpus: "0", memory: 400, env: { GOMEMLIMIT: GOMEMLIMIT! } });
  for (const path of ["/", "/about.html", "/blog/1.html"]) {
    const response = await fetch(`${server.url}${path}`);
    expect(response.status, path).toBe(200);
    expect((await response.text()).length, path).toBeGreaterThan(0);
  }
  expect((await server.stats()).requests).toBe(3);
  await server.stop();
}, 120_000);

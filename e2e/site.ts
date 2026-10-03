// The documents faulty serves the crawlers: mock/site.json (the fake website), the recording of
// crawlme.fly.dev, and the two with a crawl's own faults over them. See e2e/README.md for the routes and mock layout.
// Each function returns a document's path, which `mock()` from tools serves.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandRunNotation, faultyDocumentWith, startSpecMock, type SpecMockServer } from "@tools/core";
import type { Case } from "./cases.ts";
import { startChunkedReuse } from "./chunked-reuse.ts";

export const WRITTEN_PORT = 8080;
export const WRITTEN_ORIGIN = `http://localhost:${WRITTEN_PORT}`;

/// A path becomes a URL on the written origin; `{x*80}` is eighty x's (as crawl.spec.ts reads a case).
export const expandStartUrl = (startUrl: string) => expandRunNotation(startUrl.replace(/^\//, `${WRITTEN_ORIGIN}/`));

export const MOCK_DIR = join(import.meta.dir, "..", "mock");
/// The fake website: every page a parity or stress case crawls, and the rules the stress pages need.
export const SITE = join(MOCK_DIR, "site.json");
/// The recording of crawlme.fly.dev, replayed as fast as the machine serves it.
export const RECORDING = join(MOCK_DIR, "crawlme.json");

/// The realworld site: the endless graph of four links a page (faulty's `graph` kind, site.json's
/// /scale), with slow pages, healing 429s and 503s, and dropped connections, at seed 42.
export const REALWORLD_PATH = "/scale/0?links=4&limit=1000000&delay=0";
export const REALWORLD_FAULTS = [
  { match: "/scale/*", rate: 0.002, delay: ["10ms", "15ms"] },
  { match: "/scale/*", rate: 0.0003, times: 1, bend: { status: 429 } },
  { match: "/scale/*", rate: 0.0003, times: 1, bend: { status: 503 } },
  { match: "/scale/*", rate: 0.0002, times: 1, answer: { raw: [""] } },
];

/** What a crawl asks of the site: faults for it alone, or the recording in place of the site. */
export interface SiteKeys {
  /** A WARC under mock/ (or an absolute path): the recording replays instead of site.json. */
  archive?: string;
  /** With an `archive`: the recorded network's latency on every answer. A benchmark's; what a crawl prints does
   * not depend on it, so a check replays without, in seconds and not the minutes 42,011 pages at 80 ms take. */
  latency?: boolean;
  /** Another document under mock/ in place of site.json: a generated site. */
  site?: string;
  /** A scenario defined in the document whose rules are activated. */
  scenario?: string;
  /** faulty rules for this crawl alone, and the seed they draw from. */
  rules?: unknown[];
  seed?: number;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
/// The recorded network, as faulty rules: a connect time and a time to first byte from its distribution.
const networkRules = () => (readJson(RECORDING).scenarios?.latency ?? []) as unknown[];

/**
 * The document for one crawl. Without keys, site.json itself (or the `site` named); with `rules` or
 * `seed`, a copy with them over it. With an `archive`, the recording's document: the crawl's rules
 * first, so their indices, which are their salts, stay as written, then, asked for, the recorded network's latency.
 */
export function siteFor({ archive, latency, site, scenario, rules, seed }: SiteKeys): string {
  const keys = { ...(rules ? { rules } : {}), ...(seed !== undefined ? { seed } : {}) };
  const base = site ? join(MOCK_DIR, site) : archive ? RECORDING : SITE;
  if (!existsSync(base)) {
    try {
      Bun.spawnSync(["bun", "node_modules/@tools/core/src/cli.ts", "fixtures", "ensure", base]);
    } catch {}
  }
  const doc = readJson(base);
  const scenarioRules = scenario && doc.scenarios?.[scenario] ? (doc.scenarios[scenario] as unknown[]) : [];
  if (!archive) {
    const allRules = [...(rules ?? []), ...scenarioRules];
    return Object.keys(keys).length > 0 || scenarioRules.length > 0
      ? faultyDocumentWith(base, { ...keys, ...(allRules.length ? { rules: allRules } : {}) })
      : base;
  }
  return faultyDocumentWith(base, {
    ...keys,
    routes: {
      ...doc.routes,
      "*": { archive: isAbsolute(archive) ? archive : join(MOCK_DIR, archive) },
    },
    rules: [...(doc.rules ?? []), ...(rules ?? []), ...scenarioRules, ...(latency ? networkRules() : [])],
  });
}

/**
 * The document an AOT cache (and a port's profile) trains on: /train links the recording over its network, the
 * /scale graph with the realworld faults, and the graph over TLS (faulty with `tls` serves both on one
 * port, so the host is the same whatever the scheme). One crawl from it takes every path a crawl of the recording, a
 * realworld, wire or https crawl takes, in the one JVM run a cache records. Untrained, the TLS stack cost an https crawl
 * 160 ms and 0.4G instructions before its first page.
 */
export function trainingSite(): string {
  const scale = REALWORLD_PATH.replace("limit=1000000", "limit=100000").replaceAll("&", "&amp;");
  const scaleTls = scale.replace("/scale/0", "/scale/1");
  return faultyDocumentWith(RECORDING, {
    routes: {
      "*": { archive: join(MOCK_DIR, "crawlme.warc.gz") },
      "/scale/*": readJson(SITE).routes["/scale/*"],
      "/train": {
        html:
          `<a href="/">the recording</a> <a href="${scale}">the fake site</a> ` +
          `<a href="https://localhost:{port}${scaleTls}">the fake site over TLS</a>`,
      },
    },
    rules: [...REALWORLD_FAULTS, ...networkRules()],
    seed: 42,
  });
}

/** Starts the mock server configured for a case. */
export async function startCaseServer(testCase: Case): Promise<SpecMockServer> {
  return startSpecMock({
    writtenPort: WRITTEN_PORT,
    disabled: testCase.server === false,
    document: testCase.server === false || testCase.socket ? undefined : siteFor(testCase),
    tls: testCase.tls !== undefined,
    trustCa: testCase.tls === true,
    ...(testCase.plugin ? { pluginCommand: `bun ${join(MOCK_DIR, testCase.plugin)}` } : {}),
    ...(testCase.mock_flags ? { flags: testCase.mock_flags } : {}),
    ...(testCase.origin ? { origin: testCase.origin } : {}),
    ...(testCase.socket === "chunked-reuse" ? { socket: startChunkedReuse } : {}),
  });
}

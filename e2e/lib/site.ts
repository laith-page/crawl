// The documents faulty serves the crawlers: mocks/site/site.json (the fake website), the recording of crawlme.fly.dev
// (mocks/crawlme/), and either with a crawl's own faults over it. See e2e/README.md for the routes and mock layout.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mock, type Mock } from "@l3/tools";
import type { Case } from "./cases.ts";
import { startChunkedReuse } from "./chunked-reuse.ts";

const ROOT = join(import.meta.dir, "..", "..");

export const WRITTEN_PORT = 8080;
export const WRITTEN_ORIGIN = `http://localhost:${WRITTEN_PORT}`;

/** `{x*80}` is eighty x's (fixture notation in cases.json). */
export const expandRunNotation = (text: string): string =>
  text.replace(/\{(\w)\*(\d+)\}/g, (_, char: string, count: string) => char.repeat(Number(count)));

/// A path becomes a URL on the written origin; `{x*80}` is eighty x's (as crawl.ts reads a case).
export const expandStartUrl = (startUrl: string) => expandRunNotation(startUrl.replace(/^\//, `${WRITTEN_ORIGIN}/`));

export const SITE_DIR = join(ROOT, "mocks", "site");
export const CRAWLME_DIR = join(ROOT, "mocks", "crawlme");
export const FIXTURES_DIR = join(ROOT, "fixtures");
/// The fake website: every page a parity or stress case crawls, and the rules the stress pages need.
export const SITE = join(SITE_DIR, "site.json");
/// The recording of crawlme.fly.dev, replayed as fast as the machine serves it.
export const RECORDING = join(CRAWLME_DIR, "crawlme.json");
/// The site mock's plugin: the wire and timing kinds.
export const SITE_PLUGIN = join(SITE_DIR, "plugin.ts");

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
  /** A WARC beside mocks/crawlme/crawlme.json (or an absolute path): the recording replays instead of site.json. */
  archive?: string | null;
  /** With an `archive`: the recorded network's latency on every answer. A benchmark's; what a crawl prints does
   * not depend on it, so a check replays without, in seconds and not the minutes 42,011 pages at 80 ms take. */
  latency?: boolean;
  /** Another document in place of site.json: mocks/site/<site>, else fixtures/<site> (a generated site). */
  site?: string;
  /** A scenario defined in the document whose rules are activated. */
  scenario?: string;
  /** faulty rules for this crawl alone, and the seed they draw from. */
  rules?: unknown[];
  seed?: number;
}

type Document = Record<string, unknown> & { routes?: Record<string, unknown>; rules?: unknown[] };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Document;
/// The recorded network, as faulty rules: a connect time and a time to first byte from its distribution.
const networkRules = () =>
  ((readJson(RECORDING).scenarios as Record<string, unknown[]>)?.["latency"] ?? []) as unknown[];

/** A document's own archives, made absolute: a document given as an object is served from elsewhere. */
function absoluteArchives(doc: Document, dir: string): Document {
  const routes = Object.fromEntries(
    Object.entries(doc.routes ?? {}).map(([path, route]) => {
      const archive = (route as { archive?: string }).archive;
      return [path, archive && !isAbsolute(archive) ? { ...(route as object), archive: join(dir, archive) } : route];
    }),
  );
  return { ...doc, routes };
}

/** Where a named document lives: the site mock's folder, or fixtures/ for a generated one. */
export const documentPath = (site: string): string => {
  const own = join(SITE_DIR, site);
  try {
    readFileSync(own);
    return own;
  } catch {
    return join(FIXTURES_DIR, site);
  }
};

/**
 * The document for one crawl. Without keys, site.json itself (or the `site` named); with `rules` or `seed`, a copy
 * with them over it. With an `archive`, the recording's document: the crawl's rules first, so their indices, which
 * are their salts, stay as written, then, asked for, the recorded network's latency.
 */
export function siteFor({ archive, latency, site, scenario, rules, seed }: SiteKeys): string | Document {
  const keys = { ...(rules ? { rules } : {}), ...(seed !== undefined ? { seed } : {}) };
  const base = site ? documentPath(site) : archive ? RECORDING : SITE;
  const doc = readJson(base);
  const scenarios = (doc.scenarios ?? {}) as Record<string, unknown[]>;
  const scenarioRules = scenario && scenarios[scenario] ? scenarios[scenario] : [];
  const dir = base.slice(0, base.lastIndexOf("/"));
  if (!archive) {
    const allRules = [...(rules ?? []), ...scenarioRules];
    return Object.keys(keys).length > 0 || scenarioRules.length > 0
      ? absoluteArchives({ ...doc, ...keys, ...(allRules.length ? { rules: allRules } : {}) }, dir)
      : base;
  }
  return {
    ...doc,
    ...keys,
    routes: { ...doc.routes, "*": { archive: isAbsolute(archive) ? archive : join(CRAWLME_DIR, archive) } },
    rules: [...(doc.rules ?? []), ...(rules ?? []), ...scenarioRules, ...(latency ? networkRules() : [])],
  };
}

/** A case's server: the mock (or a socket fixture), and the rewriting between the written port and the served one. */
export interface CaseServer {
  mock?: Mock;
  stop?: () => Promise<void>;
  toServed(text: string): string;
  toWritten(text: string): string;
  /** The authority a crawler trusts, for a TLS case that trusts it. */
  env: Record<string, string>;
}

const HOSTS = String.raw`localhost\.?|127\.0\.0\.1|\[::1\]`;

/** URLs in a case move between the port they are written with and the port the server took. */
function portMap(servedPort: number, origin?: string) {
  const written = new RegExp(`(${HOSTS}):${WRITTEN_PORT}(?!\\d)`, "gi");
  const served = new RegExp(`(${HOSTS}):${servedPort}(?!\\d)`, "g");
  return {
    toServed: (text: string) => text.replace(written, `$1:${servedPort}`),
    toWritten: (text: string) => {
      const back = text.replace(served, `$1:${WRITTEN_PORT}`);
      return origin ? back.replaceAll(WRITTEN_ORIGIN, origin) : back;
    },
  };
}

/** Starts the server a case crawls. */
export async function startCaseServer(testCase: Case): Promise<CaseServer> {
  if (testCase.server === false) return { toServed: (t) => t, toWritten: (t) => t, env: {} };
  if (testCase.socket === "chunked-reuse") {
    const socket = await startChunkedReuse();
    return { stop: socket.stop, ...portMap(socket.port, testCase.origin), env: {} };
  }
  const server = await mock(siteFor(testCase), {
    ...(testCase.tls !== undefined ? { tls: true } : {}),
    ...(testCase.plugin ? { plugin: join(SITE_DIR, testCase.plugin) } : {}),
    ...(testCase.mock_flags ? { args: testCase.mock_flags } : {}),
  });
  return {
    mock: server,
    ...portMap(server.port, testCase.origin),
    env: testCase.tls === true && server.ca ? { SSL_CERT_FILE: server.ca } : {},
  };
}

/** The targets an archive holds that the rules in force damage (faulty's /__faulty/damaged). */
export async function damaged(server: Mock): Promise<Set<string>> {
  const response = await fetch(`${server.url}/__faulty/damaged`);
  if (!response.ok) throw new Error(`faulty GET /__faulty/damaged: ${response.status}`);
  return new Set((await response.text()).split("\n").filter(Boolean));
}

/**
 * The document an AOT cache (and a port's profile) trains on: /train links the recording over its network, the
 * /scale graph with the realworld faults, and the graph over TLS (faulty with `tls` serves both on one port, so the
 * host is the same whatever the scheme). One crawl from it takes every path a crawl of the recording, a realworld,
 * wire or https crawl takes, in the one JVM run a cache records.
 */
export function trainingSite(): Document {
  const scale = REALWORLD_PATH.replace("limit=1000000", "limit=100000").replaceAll("&", "&amp;");
  const scaleTls = scale.replace("/scale/0", "/scale/1");
  const doc = readJson(RECORDING);
  return {
    ...doc,
    routes: {
      "*": { archive: join(CRAWLME_DIR, "crawlme.warc.gz") },
      "/scale/*": readJson(SITE).routes!["/scale/*"],
      "/train": {
        html:
          `<a href="/">the recording</a> <a href="${scale}">the fake site</a> ` +
          `<a href="https://localhost:{port}${scaleTls}">the fake site over TLS</a>`,
      },
    },
    rules: [...REALWORLD_FAULTS, ...networkRules()],
    seed: 42,
  };
}

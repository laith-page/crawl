// The perf samples' sites: site.json's pages, and pages of their own whose bytes are fixed, so a count of reads (and
// of instructions and syscalls) is the same every run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRAWLME_DIR, SITE } from "../e2e/lib/site.ts";

const SITE_DOCUMENT = JSON.parse(readFileSync(SITE, "utf8")) as Record<string, unknown>;

/// Small pages of four links, an endless graph: the client and its framing.
export const WIRE = "/scale/0?links=4&limit=10000000&delay=0";
export const LATENCY_MS = 20;

/// The perf samples' own pages: repeated units under an exact Content-Length.
export const PERF_SITE = {
  ...SITE_DOCUMENT,
  routes: {
    "/perf/scan": { repeat: ['<a href="/perf/scan/{i}">x</a>', 500] },
    // One body, not a thousand streamed units: how the bytes arrive decides how many reads a client makes,
    // and a count of reads is a count of instructions and of syscalls; a body written whole arrives the same way.
    "/perf/scan/*": {
      html: "<p>Ninety-six bytes of a page as a page has them: a <b>tag</b>, an &amp; and some text.</p>\n".repeat(
        1000,
      ),
    },
    "/perf/links/*": { repeat: ['<a href="/perf/links/{i}">x</a><a href="../links/{i}x?q=1&amp;r=2">y</a>', 1000] },
    "/perf/memory": { repeat: ['<a href="/perf/memory/{i}">x</a>', 200] },
    "/perf/memory/*": { repeat: ["<p>{x*120}</p>\n", 15200] },
    // The same 1.9 MB in two halves, 300 ms apart: every slot is mid-body at once, so the peak holds all of them. On
    // loopback the whole bodies above finish before the last slots fill, and how many overlap is the scheduler's.
    "/perf/held": { repeat: ['<a href="/perf/held/{i}">x</a>', 200] },
    "/perf/held/*": { repeat: ["<p>{x*972792}</p>\n", 2], gap: "300ms" },
  },
};

/// Every /scale page 20 ms late: the idle share of the slots is then latency-bound, not CPU-bound.
export const DELAYED_SITE = {
  ...SITE_DOCUMENT,
  rules: [{ match: "/scale/*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};

/// The scan's pages as late: a crawler one fetch at a time has sent its request and blocked in its read before
/// the answer comes, on every page; answered at once, whether a read found its bytes waiting was the scheduler's.
export const SCAN_SITE = {
  ...PERF_SITE,
  rules: [{ match: "/perf/scan*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};

/// The recording, every page as late as the scan's: one fetch at a time, the crawler has blocked in its read before
/// each answer comes.
export const CRAWLME_SITE = {
  routes: { "*": { archive: join(CRAWLME_DIR, "crawlme.warc.gz") } },
  rules: [{ match: "/*", rate: 1, delay: [`${LATENCY_MS}ms`, `${LATENCY_MS}ms`] }],
};

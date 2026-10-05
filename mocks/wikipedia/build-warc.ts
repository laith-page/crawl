#!/usr/bin/env bun
// Generates mocks/wikipedia/wikipedia.warc.gz from an offline Kiwix Wikipedia snapshot.
// Supports both full HTML articles and embedded images/assets.
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";

const TARGET_PAGES = parseInt(process.env.WIKI_PAGES || "10000", 10);
const ZIM_PATH = process.env.ZIM_PATH || "/tmp/wikipedia_simple_3gb.zim";
const KIWIX_PORT = parseInt(process.env.KIWIX_PORT || "8092", 10);
const OUTPUT_WARC = "mocks/wikipedia/wikipedia.warc.gz";

if (!existsSync(ZIM_PATH)) {
  console.error(`Error: ZIM file not found at ${ZIM_PATH}`);
  process.exit(1);
}

// Ensure container is running
console.log(`==> Checking kiwix-serve container on port ${KIWIX_PORT}...`);
let ready = false;
let kiwixUrl = `http://127.0.0.1:${KIWIX_PORT}/content/wiki`;

for (let i = 0; i < 5; i++) {
  try {
    const res = await fetch(`${kiwixUrl}/Main_Page`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {}
  await Bun.sleep(500);
}

if (!ready) {
  console.log(`==> Starting kiwix-serve container with ${ZIM_PATH}...`);
  Bun.spawnSync(["podman", "rm", "-f", "kiwix-warc-builder"]);
  Bun.spawn([
    "podman",
    "run",
    "--rm",
    "--name",
    "kiwix-warc-builder",
    "-p",
    `${KIWIX_PORT}:8080`,
    "-v",
    `${ZIM_PATH}:/data/wiki.zim:Z`,
    "ghcr.io/kiwix/kiwix-serve",
    "/data/wiki.zim",
  ]);

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${kiwixUrl}/Main_Page`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(500);
  }
}

if (!ready) {
  console.error("Failed to connect to kiwix-serve on port", KIWIX_PORT);
  process.exit(1);
}

console.log(`==> Connected to kiwix-serve at ${kiwixUrl}`);
console.log(`==> Target: ${TARGET_PAGES} articles + images to ${OUTPUT_WARC}`);

// Setup streaming WARC output
const fileOut = createWriteStream(OUTPUT_WARC);
// One gzip member per record, as the WARC spec recommends: faulty serves a record by unpacking its member alone, with
// no 5 GB temporary file of the whole archive (which filled CI runners' disks).
const gzipOut = { write: (record: Buffer) => fileOut.write(gzipSync(record, { level: 6 })) };

function createWarcRecord(targetPath: string, payload: Buffer, contentType: string): Buffer {
  const targetUri = `http://localhost:8086${targetPath}`;
  const httpPayload = Buffer.from(
    `HTTP/1.1 200 OK\r\n` +
      `Date: Sat, 26 Sep 2026 12:00:00 GMT\r\n` +
      `Server: mw-web.wikimedia\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `Content-Length: ${payload.length}\r\n` +
      `Connection: keep-alive\r\n` +
      `X-Content-Type-Options: nosniff\r\n\r\n`,
  );
  const fullPayload = Buffer.concat([httpPayload, payload]);
  const dateStr = "2026-09-26T12:00:00Z";
  const warcHeader = Buffer.from(
    `WARC/1.0\r\n` +
      `WARC-Type: response\r\n` +
      `WARC-Record-ID: <urn:uuid:${randomUUID()}>\r\n` +
      `WARC-Target-URI: <${targetUri}>\r\n` +
      `WARC-Date: ${dateStr}\r\n` +
      `Content-Type: application/http;msgtype=response\r\n` +
      `Content-Length: ${fullPayload.length}\r\n\r\n`,
  );
  return Buffer.concat([warcHeader, fullPayload, Buffer.from("\r\n\r\n")]);
}

const queue: string[] = ["Main_Page"];
const visitedArticles = new Set<string>(["Main_Page"]);
const savedAssets = new Set<string>();

let crawledArticles = 0;
let crawledAssets = 0;
const start = performance.now();

const CONCURRENCY = 128;
let lastLogged = 0;

while (queue.length > 0 && crawledArticles < TARGET_PAGES) {
  const batchSize = Math.min(CONCURRENCY, TARGET_PAGES - crawledArticles, queue.length);
  const batch = queue.splice(0, batchSize);

  const results = await Promise.all(
    batch.map(async (articleName) => {
      try {
        const resp = await fetch(`${kiwixUrl}/${articleName}`);
        if (!resp.ok) return null;
        let html = await resp.text();

        // 1. Discover asset images
        const assetMatches = html.matchAll(/(?:src|href)="(?:\.\/|\/)?(_assets_\/[^"]+)"/g);
        const assetsToFetch: string[] = [];
        for (const m of assetMatches) {
          const rawAsset = m[1];
          if (rawAsset && !savedAssets.has(rawAsset)) {
            savedAssets.add(rawAsset);
            assetsToFetch.push(rawAsset);
          }
        }

        // 2. Discover new article links
        const linkMatches = html.matchAll(/href="([^"#:?]+)"/g);
        const newLinks: string[] = [];
        for (const m of linkMatches) {
          const link = m[1];
          if (
            link &&
            !link.startsWith("_") &&
            !link.startsWith(".") &&
            !link.startsWith("http") &&
            !link.includes(":") &&
            !visitedArticles.has(link)
          ) {
            visitedArticles.add(link);
            newLinks.push(link);
          }
        }

        // 3. Rewrite links and image URLs to /wiki/...
        html = html.replaceAll(/href="([^"#:?]+)"/g, (match, link) => {
          if (
            link &&
            !link.startsWith("_") &&
            !link.startsWith(".") &&
            !link.startsWith("http") &&
            !link.includes(":")
          ) {
            return `href="/wiki/${link}"`;
          }
          return match;
        });

        html = html.replaceAll(/(?:src|href)="(?:\.\/|\/)?(_assets_\/[^"]+)"/g, (match, asset) => {
          return `src="/wiki/${asset}"`;
        });

        const targetPath = `/wiki/${articleName}`;
        const record = createWarcRecord(targetPath, Buffer.from(html, "utf-8"), "text/html; charset=UTF-8");

        return { record, newLinks, assetsToFetch };
      } catch {
        return null;
      }
    }),
  );

  // Fetch images discovered in this batch
  const allAssetsInBatch = results.flatMap((r) => r?.assetsToFetch ?? []);
  if (allAssetsInBatch.length > 0) {
    const assetResults = await Promise.all(
      allAssetsInBatch.map(async (assetPath) => {
        try {
          const resp = await fetch(`${kiwixUrl}/${assetPath}`);
          if (!resp.ok) return null;
          const contentType = resp.headers.get("content-type") || "image/jpeg";
          const buf = Buffer.from(await resp.arrayBuffer());
          const targetPath = `/wiki/${assetPath}`;
          return createWarcRecord(targetPath, buf, contentType);
        } catch {
          return null;
        }
      }),
    );

    for (const rec of assetResults) {
      if (rec) {
        gzipOut.write(rec);
        crawledAssets++;
      }
    }
  }

  // Write article records and enqueue new links
  for (const res of results) {
    if (res) {
      gzipOut.write(res.record);
      crawledArticles++;
      for (const nl of res.newLinks) {
        if (visitedArticles.size <= TARGET_PAGES * 3) {
          queue.push(nl);
        }
      }
    }
  }

  if (crawledArticles - lastLogged >= 5000 || crawledArticles >= TARGET_PAGES) {
    lastLogged = crawledArticles;
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    console.log(
      `  [${elapsed}s] Crawled ${crawledArticles.toLocaleString()} / ${TARGET_PAGES.toLocaleString()} articles, ${crawledAssets.toLocaleString()} images (queue: ${queue.length})...`,
    );
  }
}

fileOut.end();
await new Promise((resolve) => fileOut.on("finish", resolve));

const totalSeconds = ((performance.now() - start) / 1000).toFixed(2);
console.log(`==> Done in ${totalSeconds}s!`);
console.log(`==> Total Articles: ${crawledArticles.toLocaleString()}`);
console.log(`==> Total Images:   ${crawledAssets.toLocaleString()}`);
const stat = Bun.file(OUTPUT_WARC);
console.log(`==> Saved ${OUTPUT_WARC} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
process.exit(0);

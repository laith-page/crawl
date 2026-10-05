// Writes fixtures/intl.json, the site of the `intl` golden case: what the recording of crawlme.fly.dev
// never has, paths and queries in other scripts and with spaces, escapes kept as written, relative
// and absolute redirects, pages that are not there, links off the host, and links with fragments,
// a thousand-odd pages made from one seed so the file is the same on every run. A crawler under test
// is held to what Scrapy printed for it (fixtures/oracle/), never to another crawler under test.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");

const OUT = join(ROOT, "fixtures", "intl.json");
const PAGES = 1200;

/** mulberry32: the same numbers from the same seed on every run. */
function seededRandom(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const chance = (p: number): boolean => next() < p;
  return { next, pick, chance };
}

const { next, pick, chance } = seededRandom(20260923);

/// Words in the scripts a real site links in: the path the page is written at, as an href holds it.
const WORDS = [
  "café",
  "crème",
  "naïve",
  "façade",
  "résumé",
  "über",
  "straße",
  "año",
  "niño",
  "señora",
  "中文",
  "页面",
  "文档",
  "日本語",
  "東京",
  "한국어",
  "서울",
  "русский",
  "Москва",
  "ελληνικά",
  "עברית",
  "العربية",
  "हिन्दी",
  "ไทย",
  "Việt",
  "Türkçe",
  "İstanbul",
  "Ελλάδα",
  "北京",
  "大阪",
  "plain",
  "words",
  "page",
  "about",
  "blog",
  "news",
  "shop",
  "help",
  "archive",
  "index",
];
const QUERY_WORDS = ["q", "page", "lang", "sort", "tag", "ref", "utm_source", "id"];
const HOSTS_OFF = ["https://www.example.com/", "http://other.example/path", "https://cdn.example/img.png"];

interface Page {
  /** The path as written in hrefs: characters, spaces, and the odd escape kept. */
  href: string;
  /** The path as the server sees it: percent-encoded, what a route key is. */
  route: string;
  kind: "html" | "redirect" | "missing" | "pdf";
}

/// Percent-encodes a path the way both the crawler and Scrapy will send it: UTF-8, spaces %20, escapes kept.
function encodePath(path: string): string {
  return path.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/g, (c) =>
    [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

const pages: Page[] = [{ href: "/", route: "/", kind: "html" }];
const seen = new Set(["/"]);
while (pages.length < PAGES) {
  const depth = 1 + Math.floor(next() * 3);
  const parts = Array.from({ length: depth }, () => pick(WORDS));
  if (chance(0.15)) parts[parts.length - 1] += " " + pick(WORDS);
  if (chance(0.1)) parts[parts.length - 1] += ".html";
  if (chance(0.05)) parts[parts.length - 1] = `caf%C3%A9-${parts[parts.length - 1]}`; // an escape kept as written
  let href = "/" + parts.join("/") + (chance(0.3) ? "/" : "");
  if (chance(0.2))
    href += `?${pick(QUERY_WORDS)}=${pick(WORDS)}${chance(0.5) ? `&${pick(QUERY_WORDS)}=${1 + Math.floor(next() * 99)}` : ""}`;
  if (seen.has(href)) continue;
  seen.add(href);
  const roll = next();
  const kind: Page["kind"] = roll < 0.06 ? "redirect" : roll < 0.1 ? "missing" : roll < 0.12 ? "pdf" : "html";
  pages.push({ href, route: encodePath(href), kind });
}

const routes: Record<string, unknown> = {};
const htmlPages = pages.filter((p) => p.kind === "html");
for (const [i, page] of pages.entries()) {
  if (page.kind === "missing") continue; // linked, never there: a 404 from faulty
  if (page.kind === "pdf") {
    routes[page.route] = { html: `%PDF-1.4 ${page.href}`, headers: { "content-type": "application/pdf" } };
    continue;
  }
  if (page.kind === "redirect") {
    const target = pick(htmlPages);
    const absolute = chance(0.5);
    routes[page.route] = {
      status: chance(0.5) ? 301 : 302,
      html: "",
      headers: { location: absolute ? `{origin}${target.href}` : target.href },
    };
    continue;
  }
  const links: string[] = [];
  const count = 3 + Math.floor(next() * 8);
  for (let k = 0; k < count; k++) {
    const target = pages[(i * 7 + k * 131 + Math.floor(next() * 40)) % pages.length]!;
    let href = target.href;
    if (chance(0.15) && !href.includes("?")) href += `#${pick(WORDS)}`;
    if (chance(0.1)) href = `{origin}${href}`;
    links.push(href);
  }
  if (chance(0.1)) links.push(pick(HOSTS_OFF));
  if (chance(0.3)) links.push(pick(links)); // a link twice
  const body = links
    .map((l) => `<li><a href="${l.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">${l}</a></li>`)
    .join("\n");
  routes[page.route] = {
    html: `<!DOCTYPE html>\n<html lang="mul"><head><meta charset="utf-8"><title>${page.href}</title></head>\n<body>\n<h1>${page.href}</h1>\n<ul>\n${body}\n</ul>\n</body></html>`,
  };
}

writeFileSync(OUT, `${JSON.stringify({ routes }, null, 2)}\n`);
console.log(`${pages.length} pages (${Object.keys(routes).length} routes) to ${OUT}`);

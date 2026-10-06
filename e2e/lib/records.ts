// What a crawler prints, as records, and the comparison to what a case expects: a change to the output contract
// (DESIGN §1) is a change to this file.

/** A bounded JSON-quoted excerpt for a test failure. */
export const quoteExcerpt = (text: string, limit = 120): string =>
  JSON.stringify(text.length > limit ? `${text.slice(0, limit)}...(${text.length})` : text);

export interface PageRecord {
  url: string;
  status: number | null;
  error: string | null;
}

/// A printed URL is in the form of DESIGN §4: printable ASCII, no space.
const URL_CHARS = String.raw`(https?://[!-~]+)`;
/// One line of printable text: no control character (C0, DEL, C1) and no line or paragraph separator.
const ERROR_TEXT = String.raw`([^\x00-\x1f\x7f-\x9f\u2028\u2029]*)`;
const PAGE_LINE = new RegExp(String.raw`^${URL_CHARS}(?: (\d+))?(?: error: ${ERROR_TEXT})?$`);
/// The summary on stderr (DESIGN §1): pages printed, seconds, pages that failed.
const SUMMARY_LINE = /^crawled (\d+) pages in (\d+\.\d\d)s, (\d+) errors$/m;

/** What a crawl printed, read line by line: its pages, and up to three lines that break the grammar. */
export interface Output {
  records: PageRecord[];
  pages: number;
  failed: number;
  longestUrlLength: number;
  /** Some page line matched the case's `stdout` pattern. */
  wantMatched: boolean;
  badLines: string[];
}

export function parseOutput(text: string, want?: RegExp): Output {
  const output: Output = { records: [], pages: 0, failed: 0, longestUrlLength: 0, wantMatched: false, badLines: [] };
  const lines = text.split("\n");
  const tornTail = lines.pop() ?? "";
  for (const line of lines) {
    const match = PAGE_LINE.exec(line);
    if (!match) {
      if (output.badLines.length < 3) output.badLines.push(quoteExcerpt(line));
      continue;
    }
    const record = {
      url: match[1]!,
      status: match[2] === undefined ? null : Number(match[2]),
      error: match[3] ?? null,
    };
    output.records.push(record);
    output.pages++;
    output.failed += Number(record.error !== null);
    output.wantMatched ||= want?.test(line) ?? false;
    output.longestUrlLength = Math.max(output.longestUrlLength, record.url.length);
  }
  if (tornTail) output.badLines.unshift(`no newline at the end: ${quoteExcerpt(tornTail)}`);
  output.badLines = output.badLines.slice(0, 3);
  return output;
}

/** A URL's path and query, or the text itself when it is not a URL. */
export function urlPathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** The summary line's counts, or nothing when stderr has none. */
export function parseSummary(stderr: string): { pages: number; errors: number } | undefined {
  const match = SUMMARY_LINE.exec(stderr);
  return match ? { pages: Number(match[1]), errors: Number(match[3]) } : undefined;
}

/**
 * What did not hold between the summary and the records printed: the summary counts the pages
 * printed and, of them, those with an error, so a crawl that printed whole is its own check.
 */
export function summaryMismatch(stderr: string, output: Output): string | undefined {
  const summary = parseSummary(stderr);
  if (!summary) return `no summary line on stderr: ${quoteExcerpt(stderr.slice(-160))}`;
  if (summary.pages !== output.pages || summary.errors !== output.failed) {
    return `the summary says ${summary.pages} pages and ${summary.errors} errors; stdout has ${output.pages} and ${output.failed}`;
  }
  return undefined;
}

const recordMatches = (want: PageRecord, got: PageRecord) =>
  want.url === got.url && want.status === got.status && want.error === got.error;

/**
 * The first difference between what a crawler printed and what the case expects, or nothing.
 * `ordered` compares row by row (a `-c 1` crawl prints in crawl order); otherwise by URL. A page in
 * `damaged` (one the case's faults hit) is not compared, and the counts are not held either, since
 * how many pages survive a damaged one is the crawl's to decide.
 */
export function findRecordMismatch(
  actual: PageRecord[],
  expected: PageRecord[],
  ordered: boolean,
  damaged?: Set<string>,
): string | undefined {
  const skip = damaged ? (record: PageRecord) => damaged.has(urlPathAndQuery(record.url)) : undefined;
  if (!skip && actual.length !== expected.length) {
    const actualUrls = new Set(actual.map((r) => r.url));
    const expectedUrls = new Set(expected.map((r) => r.url));
    const missing = expected.filter((r) => !actualUrls.has(r.url)).slice(0, 5);
    const unexpected = actual.filter((r) => !expectedUrls.has(r.url)).slice(0, 5);
    return `Expected ${expected.length} records, got ${actual.length}. Missing: [${missing.map((r) => r.url).join(", ")}] Unexpected: [${unexpected.map((r) => r.url).join(", ")}]`;
  }
  const byUrl = new Map(expected.map((r) => [r.url, r]));
  for (const [index, got] of actual.entries()) {
    if (skip?.(got)) continue;
    const want = ordered ? expected[index] : byUrl.get(got.url);
    if (!want) return `Unexpected URL in output: ${got.url}`;
    if (!recordMatches(want, got))
      return `Record mismatch at ${ordered ? `row ${index}` : got.url}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`;
  }
  return undefined;
}

/**
 * A crawl as the all-four-agree check compares it (expectAgree): what only the clock decides written
 * out, the summary's seconds, and the order of the page blocks unless the crawl was `ordered` (one fetch at a time).
 */
export function normalized(stdout: string, stderr: string, ordered: boolean): { stdout: string; stderr: string } {
  return {
    stdout: ordered ? stdout : `${stdout.split("\n").filter(Boolean).sort().join("\n")}\n`.replace(/^\n$/, ""),
    stderr: stderr.replace(/^(crawled \d+ pages in )\d+\.\d\ds/m, "$1S.SSs"),
  };
}

/** For a consensus case: an engine's records in URL order, so two engines' can be held to each other as sets. */
export function comparable(records: PageRecord[]): PageRecord[] {
  return [...records].sort((a, b) => a.url.localeCompare(b.url));
}

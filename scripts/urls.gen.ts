// Writes e2e/urls.json: the crawler's URL form (DESIGN.md §4) as rows every engine's unit tests resolve: a base URL
// (or none, for a start URL), an href as an attribute holds it after character references, and what the crawler must
// print for it, or null for no link. The URL Standard itself is the library's to test (laith-page/libs runs WPT); these
// rows hold what the crawler adds: http and https only, no userinfo, no fragment, 8,000 bytes at most (the simple-path
// join is whatwg-url's to test). `bun scripts/urls.gen.ts` rewrites the file; urls.test.ts holds the file to it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");

export const CORPUS = join(ROOT, "e2e", "urls.json");
export const LONGEST_LINK = 8000;

export interface Row {
  base: string | null;
  href: string;
  want: string | null;
  note?: string;
}

const P = "http://h.example/dir/page?q=1";
const L = (n: number) => "l".repeat(n);
const PAD = LONGEST_LINK - "http://h.example/".length;

/// What the crawler adds to the standard (DESIGN §4): http and https only, no userinfo, no fragment, 8,000 bytes;
/// and a few readings of the standard a crawler meets, each written out by hand.
const rows: [string | null, string, string | null, string?][] = [
  // --- relative references ---
  [P, "child", "http://h.example/dir/child", "a name is relative to the page's directory"],
  [P, "../../../../up", "http://h.example/up", "past the root stays at the root"],
  [P, "/a/%2e/b/%2E%2e/c", "http://h.example/a/c", "an escaped dot is a dot"],
  [P, "", P, "empty: the page itself, its query kept"],
  [P, "#frag", P, "a fragment alone: the page"],
  [P, "?", "http://h.example/dir/page?", "an empty query is kept"],
  [P, "//other.example/net", "http://other.example/net", "scheme-relative"],
  [P, "//", null, "an authority with no host is no link"],
  [P, "http:", P, "the page's own scheme and nothing else: the page"],
  [P, "http:x", "http://h.example/dir/x", "the page's own scheme without //: relative"],
  [P, "http:/x", "http://h.example/x"],
  [P, "http:///x", "http://x/", "slashes past two are skipped"],
  [P, "HTTP://H.EXAMPLE/UP", "http://h.example/UP", "scheme and host are lowercased, the path is not"],
  [P, "https://h.example/secure", "https://h.example/secure"],
  [P, "//H.EXAMPLE:80/x", "http://h.example/x", "the default port is dropped"],
  [P, "http://h.example:080/x", "http://h.example/x", "a port is a number"],
  [P, "http://h.example:8080/x", "http://h.example:8080/x"],
  [P, "http://h.example:/x", "http://h.example/x", "an empty port is no port"],
  [P, "http://h.example:0/x", "http://h.example:0/x"],
  [P, "http://h.example:65535/x", "http://h.example:65535/x"],
  [P, "http://h.example:65536/x", null, "a port over 65535 is no link"],
  [P, "http://h.example:x/x", null],
  [P, "http://h.example", "http://h.example/", "no path: the root"],
  [P, "http://h.example?x=1", "http://h.example/?x=1"],
  [P, "http://h.example#f", "http://h.example/"],
  // --- schemes that are no link ---
  [P, "mailto:a@b.example", null],
  [P, "javascript:void(0)", null],
  [P, "tel:+123", null],
  [P, "data:text/html,x", null],
  [P, "file:///etc/passwd", null],
  [P, "ftp://h.example/x", null],
  [P, "a:b", null, "a scheme is a letter and letters, digits, + - . up to the colon"],
  [P, "1a:b", "http://h.example/dir/1a:b", "no scheme starts with a digit: this is a path"],
  // --- userinfo is no link (DESIGN §4) ---
  [P, "/\\u:p@h.example/x", null, "a slash then a backslash starts an authority: its userinfo is refused"],
  [P, "/\t/u:p@h.example/x", null, "a tab is removed, leaving //: its userinfo is refused"],
  [P, "http://u:p@h.example/x", null],
  [P, "http://u@h.example/x", null],
  [P, "http://h.example:8080@evil.example/", null, "the host is evil.example, and there is userinfo"],
  [P, "//u@h.example/x", null],
  [P, "/x@y", "http://h.example/x@y", "an @ in the path is a character"],
  [P, "?u=a@b", "http://h.example/dir/page?u=a@b"],
  // --- hosts ---
  [P, "http://h_example/x", "http://h_example/x"],
  [P, "http://h.example.:8080/x", "http://h.example.:8080/x", "a trailing dot is another host"],
  [P, "http://127.1/x", "http://127.0.0.1/x", "an IPv4 address in any form, dotted decimal"],
  [P, "http://0x7f.1/x", "http://127.0.0.1/x"],
  [P, "http://[0:0::1]/x", "http://[::1]/x", "an IPv6 address, compressed"],
  [P, "http://[::FFFF:127.0.0.1]/x", "http://[::ffff:7f00:1]/x"],
  [P, "http://[::1]:x/x", null],
  [P, "http://[::1/x", null],
  [P, "http://[]/x", null],
  [P, "http://exämple.example/x", "http://xn--exmple-cua.example/x", "a host in another script, to punycode"],
  [P, "http://EXÄMPLE.example/x", "http://xn--exmple-cua.example/x"],
  [P, "http://xn--exmple-cua.example/x", "http://xn--exmple-cua.example/x"],
  [P, "http://local%68ost/x", "http://localhost/x", "an escape in a host is decoded"],
  [P, "http://h!example/x", "http://h!example/x"],
  [P, "http://h.exa mple/x", null, "a space in a host is no link"],
  [P, "http://h.example</x", null],
  // --- whitespace and controls ---
  [P, " /padded ", "http://h.example/padded", "whitespace and controls at the ends are stripped"],
  [P, "\t\n\f /padded\r\n", "http://h.example/padded"],
  [P, "\u0001/x", "http://h.example/x"],
  [P, "/a\tb", "http://h.example/ab", "a tab or a newline inside is removed"],
  [P, "/a\nb", "http://h.example/ab"],
  [P, "/a\r\nb", "http://h.example/ab"],
  [P, "/a b", "http://h.example/a%20b", "a space inside is encoded"],
  [P, "/a b/c d", "http://h.example/a%20b/c%20d"],
  [P, "?x=a b", "http://h.example/dir/page?x=a%20b"],
  [P, "/a\u00a0b", "http://h.example/a%C2%A0b", "a non-breaking space is not stripped"],
  [P, "/a\u0000b", "http://h.example/a%00b"],
  [P, "/a\u007fb", "http://h.example/a%7Fb"],
  // --- encoding, per component ---
  [P, "/café", "http://h.example/caf%C3%A9", "UTF-8 bytes are percent-encoded"],
  [P, "/中文", "http://h.example/%E4%B8%AD%E6%96%87"],
  [P, "/😀", "http://h.example/%F0%9F%98%80"],
  [P, "?q=café", "http://h.example/dir/page?q=caf%C3%A9"],
  [P, '/a<b>c"d', "http://h.example/a%3Cb%3Ec%22d"],
  [P, "/`{x}`", "http://h.example/%60%7Bx%7D%60"],
  [P, "/a|b^c~d[e]", "http://h.example/a|b%5Ec~d[e]", "a path keeps | [ ] and encodes ^"],
  [P, "?a[]=1", "http://h.example/dir/page?a[]=1"],
  [P, "/a\\b", "http://h.example/a/b", "a backslash is a slash"],
  [P, "\\\\evil.example\\x", "http://evil.example/x"],
  [P, "http:\\\\h.example\\x", "http://h.example/x"],
  [P, "/a'b?c='d'", "http://h.example/a'b?c=%27d%27", "a ' is kept in a path, encoded in a query"],
  [P, "/a;b=c,d:e+f!$&*()", "http://h.example/a;b=c,d:e+f!$&*()"],
  [P, "/a?b=1&c=2/?", "http://h.example/a?b=1&c=2/?"],
  [P, "/a%20b", "http://h.example/a%20b", "an escape is kept as written"],
  [P, "/a%7e", "http://h.example/a%7e", "not upper-cased"],
  [P, "/%2F", "http://h.example/%2F", "not decoded"],
  [P, "/a%zz", "http://h.example/a%zz", "a % that starts no escape is kept"],
  [P, "/a%", "http://h.example/a%"],
  // --- length ---
  [P, `/${L(PAD)}`, `http://h.example/${L(PAD)}`, "exactly 8,000 bytes is kept"],
  [P, `/${L(PAD + 1)}`, null, "8,001 is not"],
  [P, `/${"é".repeat(1400)}`, null, "measured after encoding"],
  // --- start URLs (no base) ---
  [null, "http://h.example/", "http://h.example/", "the command line"],
  [null, "HTTP://H.EXAMPLE", "http://h.example/"],
  [null, "http://h.example/#frag", "http://h.example/"],
  [null, " http://h.example/ ", "http://h.example/"],
  [null, "http://h.example/a b", "http://h.example/a%20b"],
  [null, "http://h.example:8080", "http://h.example:8080/"],
  [null, "http://h.example:80/", "http://h.example/"],
  [null, "https://h.example:443/", "https://h.example/"],
  [null, "http://[::1]/", "http://[::1]/"],
  [null, "http://u:p@h.example/", null],
  [null, "h.example/", null, "no scheme"],
  [null, "/relative", null],
  [null, "http://", null],
  [null, "ftp://h.example/", null],
  [null, "http://exämple.example/", "http://xn--exmple-cua.example/"],
];

/** The crawler's own rows, their expectations written by hand. */
export function ownRows(): Row[] {
  return rows.map(([base, href, want, note]) => ({ base, href, want, ...(note ? { note } : {}) }));
}

if (import.meta.main) {
  const all = ownRows();
  writeFileSync(CORPUS, `[\n${all.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`);
  console.log(`${all.length} rows to ${CORPUS}`);
}

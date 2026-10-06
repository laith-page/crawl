// The URL corpus is what fixtures/urls.gen.ts writes, row for row, and every URL it expects is one the form prints:
// an expectation edited by hand into something the form never prints fails here, not in four engines at once.
import { expect, test } from "@l3/tools";
import { describe } from "bun:test";
import { readFileSync } from "node:fs";
import { CORPUS, LONGEST_LINK, ownRows, type Row } from "../fixtures/urls.gen.ts";

/// http or https, a host, then a path and query: printable ASCII without a space, `#` or a fragment.
const FORM = /^https?:\/\/[!-~]+$/;

describe("urls.json", () => {
  const written = JSON.parse(readFileSync(CORPUS, "utf8")) as Row[];

  test("is what urls.gen.ts writes", () => {
    expect(written).toEqual(ownRows());
  });

  test("every printed URL is in the form", () => {
    for (const row of written) {
      if (row.want === null) continue;
      expect(row.want, `${row.base} + ${JSON.stringify(row.href)}`).toMatch(FORM);
      expect(row.want).not.toContain("#");
      expect(new TextEncoder().encode(row.want).length).toBeLessThanOrEqual(LONGEST_LINK);
    }
  });

  test("covers the decisions: no userinfo, IDNA, a kept escape, a backslash as a slash", () => {
    const want = (href: string) => written.find((row) => row.href === href)?.want;
    expect(want("http://u:p@h.example/x")).toBeNull();
    expect(want("http://exämple.example/x")).toBe("http://xn--exmple-cua.example/x");
    expect(want("/a%20b")).toBe("http://h.example/a%20b");
    expect(want("/a\\b")).toBe("http://h.example/a/b");
  });
});

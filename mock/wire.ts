// A faulty plugin (faulty's docs/plugin.md) for the wire cases: it answers each page with what the crawler sent,
// as a link, so what a crawl prints says what went over the wire and the expected file pins it.
//
//   echo   a page linking to /wire/got?target=…&ua=…&accept=…&accept-encoding=…, each value what the request
//          carried, percent-encoded ("-" for a header not sent)
//   retry  `fail` answers of `status` (with `retry-after` when given), then a page linking to
//          /wire/got?attempts=N&waits=…: how many requests came, and whether each wait before a retry was within
//          the backoff's bounds (DESIGN §5) or, after a Retry-After, at least as long as it asked
import { serveFaultyPlugin } from "@tools/core";

interface Message {
  kind: string;
  config: { mode: "echo" } | { mode: "retry"; fail: number; status: number; "retry-after"?: string };
  request: { target: string; headers: Record<string, string | string[]> };
}

/// A backoff's bound before the nth retry (0–250 ms, then 0–500 ms), and the scheduling it is allowed on top: a
/// retry's arrival counts the crawler's backoff and its request's own time, which a loaded two-core runner stretched
/// past 150 ms (a JVM over TLS at -c 8). A crawler that waits a fixed second still fails.
const BACKOFF_MS = [250, 500];
const SLACK_MS = 400;

const seen = new Map<string, number[]>();
const header = (m: Message, name: string) => {
  const value = m.request.headers[name];
  return value === undefined ? "-" : [value].flat().join(", ");
};
const got = (params: Record<string, string>) =>
  `<a href="/wire/got?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&amp;")}">got</a>`;

function answer(m: Message): object {
  if (m.config.mode === "echo") {
    return {
      html: got({
        target: m.request.target,
        ua: header(m, "user-agent"),
        accept: header(m, "accept"),
        "accept-encoding": header(m, "accept-encoding"),
      }),
    };
  }
  const { fail, status } = m.config;
  const retryAfter = m.config["retry-after"];
  const times = seen.get(m.request.target) ?? [];
  times.push(performance.now());
  seen.set(m.request.target, times);
  if (times.length <= fail) return { status, headers: retryAfter ? { "retry-after": retryAfter } : {}, text: "" };
  const waits = times.slice(1).map((at, i) => {
    const waited = at - times[i]!;
    if (retryAfter !== undefined) return waited >= Number(retryAfter) * 1000 ? "honoured" : "early";
    return waited <= BACKOFF_MS[i]! + SLACK_MS ? "within" : "over";
  });
  return { html: got({ attempts: String(times.length), waits: waits.join(",") || "-" }) };
}

await serveFaultyPlugin<Message>(["wire"], answer);

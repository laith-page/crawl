// The site mock's plugin (faulty's docs/plugin.md), answering the two kinds wire.json and timing.json name.
//
//   wire    for the wire cases: each page answered with what the crawler sent, as a link, so what a crawl prints says
//           what went over the wire and the expected file pins it.
//             echo   a page linking to /wire/got?target=…&ua=…&accept=…&accept-encoding=…, each value what the request
//                    carried, percent-encoded ("-" for a header not sent)
//             retry  `fail` answers of `status` (with `retry-after` when given), then a page linking to
//                    /wire/got?attempts=N&waits=…: how many requests came, and whether each wait before a retry was
//                    within the backoff's bounds (DESIGN §5) or, after a Retry-After, at least as long as it asked
//   timing  for the timing cases: records request arrival times and returns the timing verdict as a link the
//           crawler must print.
import { servePlugin, type PluginAnswer, type PluginMessage } from "@l3/tools";

// ---- wire ----

type WireConfig = { mode: "echo" } | { mode: "retry"; fail: number; status: number; "retry-after"?: string };

/// A backoff's bound before the nth retry (0–250 ms, then 0–500 ms), and the scheduling it is allowed on top: a
/// retry's arrival counts the crawler's backoff and its request's own time, which a loaded two-core runner stretched
/// past 150 ms (a JVM over TLS at -c 8). A crawler that waits a fixed second still fails.
const BACKOFF_MS = [250, 500];
const SLACK_MS = 400;

const seen = new Map<string, number[]>();
const header = (m: PluginMessage, name: string) => {
  const value = m.request.headers[name];
  return value === undefined ? "-" : [value].flat().join(", ");
};
const got = (params: Record<string, string>) =>
  `<a href="/wire/got?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&amp;")}">got</a>`;

function wire(m: PluginMessage): PluginAnswer {
  const config = m.config as WireConfig;
  if (config.mode === "echo") {
    return {
      html: got({
        target: m.request.target,
        ua: header(m, "user-agent"),
        accept: header(m, "accept"),
        "accept-encoding": header(m, "accept-encoding"),
      }),
    };
  }
  const { fail, status } = config;
  const retryAfter = config["retry-after"];
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

// ---- timing ----

interface TimingConfig {
  mode: "hold-429" | "hold-502" | "hold-c" | "delay-root" | "delay-leaf";
  next?: string;
}

// The hold cases: the start page links a and b, which a crawl at -c 2 fetches at once, in either order. faulty asks
// this plugin one request at a time, so one of them is answered first: with a 429 (or 502) and Retry-After: 1, at
// `firstRetry`; its retry is a page. The other is answered after, so the crawler has it after that 429, and the page
// it links, h, starts after it too; h links c, which starts at least the -d gap after h. Nothing races a fixed delay
// (b answered after 600 ms did, and lost to a cold plugin on a loaded Mac: c waited behind a's answer and came right
// after it), and the order the crawler takes a and b in is its own. What remains is the crawler's: one that has held
// a 429 for the -d gap has seen it, and holds c until its second ends.
let firstRetry = 0;
let firstPath = "";
const starts: number[] = [];
const link = (path: string) => `<a href="${path}">result</a>`;

function timing(m: PluginMessage): PluginAnswer {
  const config = m.config as TimingConfig;
  const now = performance.now();
  switch (config.mode) {
    case "hold-429":
    case "hold-502":
      if (firstRetry === 0) {
        firstRetry = now;
        firstPath = m.request.path;
        const status = config.mode === "hold-429" ? 429 : 502;
        return { status, headers: { "retry-after": "1" }, text: "" };
      }
      return { html: m.request.path === firstPath ? "" : link(config.next!) };
    case "hold-c":
      // c started the -d gap after h, which the crawler found after the retryable answer: held, a second after it.
      return { html: link(`/timing/hold/got?held=${now - firstRetry >= 900 ? "yes" : "early"}`) };
    case "delay-root":
      starts.push(now);
      return { html: [1, 2, 3, 4].map((n) => link(`/timing/delay/${n}`)).join("") };
    case "delay-leaf":
      starts.push(now);
      if (starts.length === 5) {
        // The root's stamp is taken as it is answered, before a leaf can start; a leaf's no earlier than its start.
        // Four leaves started 100 ms apart span 300 ms however late any stamp is, so a burst is under 200.
        const totalSpan = starts[starts.length - 1]! - starts[0]!;
        return { html: link(`/timing/delay/got?spaced=${totalSpan >= 200 ? "yes" : "early"}`) };
      }
      return { html: "" };
  }
}

await servePlugin({ wire, timing });

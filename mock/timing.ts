// Records request arrival times and returns the timing verdict as a link the crawler must print.
import { serveFaultyPlugin } from "@tools/core";

interface Message {
  config: { mode: "hold-429" | "hold-502" | "hold-c" | "delay-root" | "delay-leaf"; next?: string };
  request: { target: string; path: string };
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

async function answer(message: Message): Promise<object> {
  const now = performance.now();
  switch (message.config.mode) {
    case "hold-429":
    case "hold-502":
      if (firstRetry === 0) {
        firstRetry = now;
        firstPath = message.request.path;
        const status = message.config.mode === "hold-429" ? 429 : 502;
        return { status, headers: { "retry-after": "1" }, text: "" };
      }
      return { html: message.request.path === firstPath ? "" : link(message.config.next!) };
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
        const spaced = totalSpan >= 200;
        return { html: link(`/timing/delay/got?spaced=${spaced ? "yes" : "early"}`) };
      }
      return { html: "" };
  }
}

await serveFaultyPlugin<Message>(["timing"], answer);

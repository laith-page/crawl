// What a trained build learns from: one crawl of the recording and the faulted fake site, over HTTP/1.1 in the clear
// and over TLS (e2e/lib/site.ts trainingSite). Java's AOT cache and the ports' profile-guided optimisation (Rust's
// profile, Go's default.pgo) learn the same crawl.
import { app, expect, mock, test } from "@l3/tools";
import { trainingSite } from "../e2e/lib/site.ts";

test("a crawl of the recording and the fake site, in the clear and over TLS", async () => {
  const site = await mock(trainingSite(), { tls: true });
  const crawler = await app();
  const result = await crawler.run(["-f", "-c", "64", "-n", "2000", `${site.url}/train`], {
    env: { SSL_CERT_FILE: site.ca! },
    stdout: "ignore",
  });
  expect(result.code, result.stderr.slice(-400)).toBe(0);
}, 600_000);

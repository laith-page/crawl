// crawlme.fly.dev, the recording a crawl tries by hand (mocks/crawlme/), as deployed: up, at this commit's
// document, and replaying what the origin served on capture day.
import { app, expect, test, until } from "@l3/tools";

export const tags = ["live"];

test("crawlme.fly.dev replays the recording", async () => {
  const crawlme = await app({ from: "mocks/crawlme" });
  // Its machine stops when idle: the first request starts it.
  await until(() => crawlme.get("/health"), { timeout: 60_000 });
  const front = await crawlme.get("/");
  expect(front.status).toBe(200);
  expect(await front.text()).toContain("<a ");
  expect((await (await crawlme.get("/version")).json()) as { commit: string }).toHaveProperty("commit");
}, 120_000);

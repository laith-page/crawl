// What a release published, run as a user runs it: the runner the installer fetches, the JBang jar and the image,
// each crawling ten pages of crawlme.fly.dev. On Linux, and on a Mac and Windows (where there is no image to run).
import { expect, published, test, until } from "@l3/tools";

export const tags = ["live", "os:macos", "os:windows"];

const CRAWLME = "https://crawlme.fly.dev";
const CRAWL = ["-v", "-n", "10", "-t", "30", "-f", CRAWLME];
const OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

/** A command's exit, its stdout and its stderr. */
async function sh(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A crawl of ten pages of crawlme: exit 0, ten page lines, the summary. */
function crawled(run: { code: number; stdout: string; stderr: string }): void {
  expect(run.code, run.stderr.slice(-400)).toBe(0);
  expect(run.stdout.split("\n").filter((l) => l.startsWith(`${CRAWLME}/`)).length).toBe(10);
  expect(run.stderr).toMatch(/^crawled 10 pages in /m);
}

// crawlme's machine stops when idle: woken before the first crawl, so a cold start is not a crawl's timeout.
const awake = until(async () => (await fetch(`${CRAWLME}/health`)).ok, { timeout: 60_000, what: "crawlme.fly.dev" });

test("the installer's runner crawls", async () => {
  await awake;
  const runner = published("binaries", { os: OS });
  const run =
    OS === "windows"
      ? await sh([
          "pwsh",
          "-NoProfile",
          "-Command",
          `& ([scriptblock]::Create((Invoke-RestMethod "${runner}"))) ${CRAWL.join(" ")}`,
        ])
      : await sh(["sh", "-c", `curl -fsSL "${runner}" | sh -s - ${CRAWL.join(" ")}`]);
  crawled(run);
}, 300_000);

test.if(Bun.which("jbang") !== null)(
  "JBang runs the published jar",
  async () => {
    await awake;
    const jbang = published("jbang");
    await sh(["jbang", "trust", "add", new URL(jbang).origin + "/"]);
    crawled(await sh(["jbang", "--fresh", jbang, ...CRAWL]));
  },
  300_000,
);

test.if(OS === "linux")(
  "the image crawls",
  async () => {
    await awake;
    // The machine's own architecture, natively: no emulation (the image is built for amd64 and arm64 alike).
    crawled(await sh(["docker", "run", "--rm", "--pull=always", published("image"), ...CRAWL]));
  },
  600_000,
);

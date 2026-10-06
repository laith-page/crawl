// crawler: one web crawler, its contract in docs/DESIGN.md, written four times: the reference in Java (the root) and
// its ports in Go, Rust and Zig (ports/). crawlme.fly.dev is the recording a crawl tries by hand (mocks/crawlme/).
import { project } from "@l3/tools";

export default project({
  downloads: "crawl.l3.ai",
  image: "l3io/crawl",
  name: "crawler",
  // `./crawl` with no URL crawls the recording of crawlme.fly.dev, with its latency, over TLS; -c, -n, -t and -d
  // take a value, so the URL is the first other word.
  dev: { mock: "crawlme", port: 18080, args: ["--tls", "--scenario", "latency"], valued: ["-c", "-n", "-t", "-d"] },
  deploy: [{ mock: "crawlme", to: "fly", url: "https://crawlme.fly.dev" }],
  // The command users run is `crawl` (crawl.l3.ai/crawl, crawl/bin/crawl), as before tools 12.
  bin: "crawl",
  publish: ["binaries", "native", "image", "jbang", "ports"],
  // Crawl.java: the crawler as one JBang script, its //DEPS from the pom and //JAVA_OPTIONS from jvm.options.
  jbang: {
    script: "Crawl",
    sources: "src/main/java/crawler/*.java",
    directives: ["//COMPILE_OPTIONS -XDignore.symbol.file"],
    comment: [
      "curl -fsSL https://crawl.l3.ai/v{version}/crawl | sh -s - -n 1M -f https://crawlme.fly.dev",
      "# or, with Java/JBang:",
      "jbang https://crawl.l3.ai/v{version}/Crawl.java -n 1M -f https://crawlme.fly.dev",
      "# or, with Docker:",
      "docker run --rm docker.io/l3io/crawl:{version} -n 1M -f https://crawlme.fly.dev",
      "# or, standalone binary (go, rust, zig, java):",
      "# curl -fsSL https://crawl.l3.ai/v{version}/crawler-go -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v{version}/crawler-rust -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v{version}/crawler-zig -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v{version}/crawler.jar -o crawler.jar",
    ],
  },
  platforms: ["linux/amd64", "linux/arm64", "darwin/arm64", "windows/amd64"],
  os: ["macos", "windows"],
  schedule: {
    // The weekly GraalVM PGO retrain, uploaded to the cache bucket.
    "pgo-refresh": {
      cron: ["0 3 * * 0"],
      run: "l3 fixtures refresh pgo",
      timeout: 60,
      secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      commit: ["fixtures.json"],
    },
  },
});

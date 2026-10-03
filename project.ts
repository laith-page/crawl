// What tools needs to know about this project: the four crawlers, the mock to crawl by hand, and what
// a release is. Everything else (the gate, the spec runner, CI) follows from it; see AGENTS.md.
import { type Allowed, defineProject, go, java, mock, rust, zig, type Train } from "@tools/core";
import { fly, javaApp } from "@tools/deploy";
import { trainingSite } from "./e2e/site.ts";

/// The JVM flags every Java crawl runs with, shipped or under test (the image's too: tools writes its Dockerfile).
const JVM_FLAGS = [
  "-Xlog:disable",
  // Warnings on stderr, but not gc+ergo's: a heap that starts at 64 MB or less (a container of 4 GB, the spec's)
  // shrinks -Xmn below and says so, and the shrinking is right where the line would break the contract's stderr.
  "-Xlog:all=warning,gc+ergo=error:stderr",
  "--enable-native-access=ALL-UNNAMED",
  "-XX:+UnlockDiagnosticVMOptions",
  "-XX:+UseSerialGC",
  // Set, so a heap past 32 GB is capped rather than compressed oops turned off: with MaxRAMPercentage set, the JVM
  // drops them on a host of ~40 GB and more (gcArguments.cpp), and the AOT cache's code with them.
  "-XX:+UseCompressedOops",
  "-XX:-UsePerfData",
  "-XX:CICompilerCount=2",
  "-XX:UserThreadWaitAttemptsAtExit=0",
  "-Djava.util.concurrent.ForkJoinPool.common.parallelism=0",
  // One read poller, not one a CPU: a single epoll for the crawl's sockets batches their events. Wall and CPU fell
  // 2-11% from 20,000 pages up (1M wire -5%), the same below, and RSS held.
  "-Djdk.readPollers=1",
  "-Xmn64m",
  // TLS key exchange: X25519 then P-256, no post-quantum hybrid (DESIGN §5)
  "-Djdk.tls.namedGroups=x25519,secp256r1",
];

/// As it ships: the heap sized to the cgroup or the machine.
export const DIST_FLAGS = ["-XX:MaxRAMPercentage=75", ...JVM_FLAGS];

/// What an AOT cache learns from: one crawl of the recording and the faulted fake site, over HTTP/1.1 in the clear
/// and over TLS (trainingSite). The release's cache and the one the engine under test starts from in the spec learn
/// the same crawl, each under its own flags. The ports' profile-guided optimisation learns it too: Rust's profile at
/// every build, Go's default.pgo by `mise run pgo go`.
const train: Train = async (run) => {
  await using site = await mock(trainingSite(), { tls: true });
  await run(["-f", "-c", "64", "-n", "2000", site.url("/train")], { env: { SSL_CERT_FILE: site.ca! } });
};

/// The four engines are one design, file for file and name for name (tools' shape check, `mise run shape`). What only
/// some engines have, and why: a concept (its file's words), a declaration in one (`concept: kind words`, `concept:
/// kind owner.words` for a nested type's member), or a message (`message: text`). Each for exactly the engines
/// listed, and each must still be a difference: a rule nothing needs any more is reported.
const ALLOWED: Allowed[] = [
  // Tests
  {
    items: ["crawler: type failing writer"],
    engines: ["go", "rust"],
    why: "Java's tests subclass OutputStream anonymously, and Zig's use Io.Writer.failing and a local struct: no named type",
  },
  {
    items: ["frontier: constant home", "frontier: constant roomy"],
    engines: ["java", "rust", "zig"],
    why: "Go's test files share one package: crawler_test.go's",
  },
  {
    items: ["urls: function expect", "urls: function skip space", "urls: function string"],
    engines: ["java", "rust"],
    why: "the corpus read with a reader for its shape: no JSON parser in the JDK or Rust's std",
  },
  {
    items: ["links: test a decoded href remains valid across scratch resets and feed chunks"],
    engines: ["zig"],
    why: "Zig's per-page arena and temporary resolution arena require this lifetime regression test",
  },

  // Fast paths measured by the perf gate.
  {
    items: ["http: function response.url"],
    engines: ["rust"],
    why: "reqwest's parsed URL of the page: its links join onto it, the page not parsed again",
  },

  // What a language or its library asks for
  {
    items: ["http: function settled"],
    engines: ["rust"],
    why: "hyper finishes a connect in the background when a pooled connection frees first: the crawl waits for it before exiting",
  },
  {
    items: ["retries: constant no retry"],
    engines: ["go"],
    why: "a final attempt's delay: Rust and Zig say it with an optional, Go with a sentinel, Java with null",
  },
  {
    items: ["main: function profile cpu"],
    engines: ["go"],
    why: "the CPU profile tools trains Go's default.pgo from: Java's AOT cache learns in the JVM, Rust's and Zig's have none",
  },
  {
    items: ["main: function tune malloc"],
    engines: ["rust"],
    why: "Rust uses glibc's mallopt to limit arenas and return large freed blocks through mmap",
  },
  { items: ["main: constant panic"], engines: ["zig"], why: "the panic handler Zig looks for in the root file" },
  {
    items: ["message: error: {}"],
    engines: ["rust", "zig"],
    why: "a start-up failure returned rather than thrown: the HTTP client's (Rust), an allocation's (Zig)",
  },
  {
    items: ["fetcher: function close"],
    engines: ["java"],
    why: "Java closes its library HTTP client's deadline ticker when the crawl ends",
  },
  {
    items: ["machine: function apply", "machine: test apply sets properties unconditionally"],
    engines: ["java"],
    why: "Java sets scheduler properties and http.maxConnections",
  },
  {
    items: ["machine: function read cpu max"],
    engines: ["zig"],
    why: "Zig reads cpu.max directly for cgroup quota",
  },
  {
    items: ["http: function decoded"],
    engines: ["go"],
    why: "Go wraps net/http's body in a gzip or deflate reader; reqwest and http decode themselves",
  },
  {
    items: ["http"],
    engines: ["go", "rust", "zig"],
    why: "Java's HTTP implementation lives in the versioned HTTP library; shape still compares declarations among these three engines",
  },
  {
    items: ["http: function response.close"],
    engines: ["go", "zig"],
    why: "Go and Zig close response bodies explicitly; Rust consumes the response and Java delegates to its HTTP library",
  },
  {
    items: ["fetcher: constant drain limit bytes", "fetcher: constant max body bytes"],
    engines: ["java"],
    why: "Java's fetcher passes body limits to the HTTP library",
  },
  {
    items: ["tls: function connect"],
    engines: ["zig"],
    why: "Zig's TLS hook creates the transport connection",
  },
  {
    items: ["tls: function connect transport", "tls: function hook"],
    engines: ["zig"],
    why: "Zig hands http a TLS transport hook",
  },
  {
    items: ["tls"],
    engines: ["go", "rust", "zig"],
    why: "Java's trust store is the certs socket factory in Fetcher",
  },
  {
    items: [
      "options: constant concurrency",
      "options: constant cpus",
      "options: constant delay",
      "options: constant fast",
      "options: constant max pages",
      "options: constant timeout",
      "options: constant user agent",
      "options: constant verbose",
    ],
    engines: ["java"],
    why: "Java's cli uses typed option constants (Flag, Switch, Setting, Text)",
  },
  {
    items: ["output"],
    engines: ["go", "rust", "zig"],
    why: "Java delegates output to cli.BlockWriter",
  },
  {
    items: [
      "http: constant err body over limit",
      "http: function latin1",
      "http: function dial tls",
      "http: type tls error",
      "fetcher: type request",
    ],
    engines: ["go"],
    why: "net/http's: a request and its body buffer reused per page, a handshake's failure told apart",
  },
  {
    items: ["failure: constant malformed words"],
    engines: ["go"],
    why: "net/http refuses a response with an error of no type: its words",
  },
  {
    items: [
      "options: constant flags",
      "options: constant settings",
      "options: constant switches",
      "options: constant texts",
    ],
    engines: ["rust"],
    why: "Rust's const command declaration keeps its flag, setting, switch and text slices separately",
  },
  {
    items: ["urls: function on origin"],
    engines: ["java"],
    why: "Java shares the simple-path join between Urls and Links",
  },
  {
    items: ["deadline"],
    engines: ["go"],
    why: "net/http reuses one request context and timer across pages",
  },
  {
    items: ["main: function context.action", "main: function context.check", "main: type context"],
    engines: ["zig"],
    why: "Zig's CLI run callback needs a context to keep the crawl exit code and positional validation",
  },
  {
    items: ["main: function crawl"],
    engines: ["java", "zig"],
    why: "Java and Zig run the crawl from a crawl function invoked by the CLI action",
  },
  {
    items: ["main: function fatal", "main: function run", "message: error: internal error: {}"],
    engines: ["go", "rust", "zig"],
    why: "Java delegates fatal handler and process execution to cli.Command.main",
  },
  {
    items: ["page: function unreachable"],
    engines: ["java", "go", "rust"],
    why: "unreachable is a Zig keyword",
  },
];

export const FAILURE_LABELS = [
  "timeout",
  "dns failed",
  "connect failed",
  "tls failed",
  "body over 5 MiB",
  "connection reset",
  "malformed response",
] as const;

/// The messages a user reads, which every engine prints alike: an `error: ` line, the summary, a failure's label.
export const MESSAGES = new RegExp(`^error: |^crawled \\{\\}|^(${FAILURE_LABELS.join("|")})$`);

/// `mise run dist`: target/crawl (the jar, its AOT cache, the launcher), a bundle per platform that needs
/// no Java, the `crawl` runner that fetches one, and Crawl.java for JBang.
export const CRAWL = javaApp({
  name: "crawl",
  jar: "target/crawler.jar",
  flags: DIST_FLAGS,
  modules: ["java.base", "jdk.unsupported"],
  platforms: ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"],
  // The executable is run before it is shipped (`release --part native`).
  native: {
    smoke: [
      "bun node_modules/@tools/core/src/cli.ts probe GET / --url https://crawlme.fly.dev --wait 60 || true",
      "./target/bundle/linux-x64/crawl/bin/crawl -v -n 10 -t 30 -f https://crawlme.fly.dev",
    ],
  },
  jbang: {
    sources: "src/main/java/crawler/*.java",
    deps: "pom",
    directives: [
      "//JAVA 25+",
      "//REPOS mavenCentral,l3=https://maven.l3.ai",
      "//COMPILE_OPTIONS -XDignore.symbol.file",
    ],
    rename: { from: "Main", to: "Crawl" },
    comment: [
      "curl -fsSL https://crawl.l3.ai/v0.3.17/crawl | sh -s - -n 1M -f https://crawlme.fly.dev",
      "# or, with Java/JBang:",
      "jbang https://crawl.l3.ai/v0.3.17/Crawl.java -n 1M -f https://crawlme.fly.dev",
      "# or, with Docker:",
      "docker run --rm docker.io/l3io/crawl:0.3.17 -n 1M -f https://crawlme.fly.dev",
      "# or, standalone binary (go, rust, zig, java):",
      "# curl -fsSL https://crawl.l3.ai/v0.3.17/crawler-go -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v0.3.17/crawler-rust -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v0.3.17/crawler-zig -o crawl && chmod +x crawl",
      "# curl -fsSL https://crawl.l3.ai/v0.3.17/crawler.jar -o crawler.jar",
    ],
  },
  train,
});

export default defineProject({
  name: "crawler",
  // The languages are derived from the engines; these the bench, JBang and the shell checks use.
  toolchains: { jbang: true, shfmt: true, shellcheck: true, mold: true },
  checks: {
    sbom: false,
    "go-vet": false,
  },
  // The first is the reference: every command runs it unless given another.
  engines: {
    // Under test, bodies stream: the crawler must live within -Xmx384m, under the stress cases' cap.
    java: java({
      jar: "target/crawler.jar",
      version: "generate",
      flags: ["-Xms64m", "-Xmx384m", ...JVM_FLAGS],
      train,

      sources: ["src/main/**", "pom.xml", "target/generated-resources/crawler/version.txt"],
    }),
    // Go's profile is committed (ports/go/crawler/default.pgo, which go build reads): `mise run pgo go` rewrites it.
    go: go({
      dir: "ports/go/crawler",
      version: "generate",
      train,
      sources: ["ports/go/crawler/**/*.go", "ports/go/crawler/go.mod", "ports/go/crawler/default.pgo"],
    }),
    // Rust's profile is trained at each build (tools: -Cprofile-generate, the training, llvm-profdata, -Cprofile-use).
    rust: rust({
      dir: "ports/rust",
      version: "generate",
      train,
      sources: ["ports/rust/**/*.rs", "ports/rust/**/Cargo.toml", "ports/rust/Cargo.lock", "ports/rust/version.txt"],
    }),
    zig: zig({
      dir: "ports/zig",
      version: "generate",
      sources: ["ports/zig/**/*.zig", "ports/zig/build.zig.zon", "package.json"],
    }),
  },
  // CI's layout (`tools ci plan`): a job per engine, the agreement after them, perf per engine on valgrind.
  ci: {
    split: "engines",
    perf: { split: true },
    // The release a job a part, from `ship`: stage-<engine>, deploy, image, native, bundles, then the tag.
    release: { split: true },
    // A Mac part in two jobs, the spec's cases dealt between them: java's, zig's and go's took a three-core Mac to
    // two minutes with their builds restored; a Mac job each part under two minutes on every commit.
    macos: { shards: { java: 2, zig: 2, go: 2 } },
    apt: { "perf-go": ["valgrind"], "perf-rust": ["valgrind"], "perf-zig": ["valgrind"], "perf-java": ["valgrind"] },
  },
  gate: {
    // Crawls a spec offers at once; tools starts each when the machine has a slot and calm CPU.
    // A Mac job runs one engine's spec on three cores: six crawls (one job for every engine held eight, four specs of
    // two, and starved the stress cases: hold-on-502, overloaded-server, mem-c256 failed by turns).
    specJobs: process.platform === "darwin" ? 6 : 8,
    // Every engine printed the same bytes for every case the spec kept: once the four specs have run.
    agree: true,
    // The four engines are one design: a concept a file in each, the same names and messages (`mise run shape`).
    shape: { allowed: ALLOWED, messages: MESSAGES },
    // Each engine's own code under 1000 lines, comments and tests left out (`mise run loc --limit`).
    loc: { limit: 1000, tests: 1000 },
  },
  suites: {
    // The hardware limit (bench.ts) is code too: tested with the rest (zig fmt already covers it).
    "limit-test": { run: ["zig", "test", "bench/limit.zig"], engine: "zig", inputs: ["bench/limit.zig"] },
    // The Crawl.java HTML viewer is tools' derived manual suite `jbang-viewer` (`mise run suite jbang-viewer`).
  },
  // The weekly GraalVM PGO retrain, uploaded to the cache bucket: tools writes .github/workflows/pgo-refresh.yml (`mise run jobs`).
  jobs: {
    "pgo:refresh": {
      task: "pgo-refresh",
      cron: ["0 3 * * 0"],
      secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      timeout: 60,
    },
  },
  // `./crawl` (`mise run run`): a crawl with no URL crawls the mock, started if need be and its authority trusted;
  // -c, -n, -t and -d take a value, so the URL is the first other word.
  run: { daemon: "mock", valued: ["-c", "-n", "-t", "-d"] },
  daemons: {
    // The recording of crawlme.fly.dev with its latency, over TLS: what `./crawl` crawls by default.
    mock: {
      command: ["faulty", "--port", "{port}", "--tls", "--scenario", "latency", "crawlme.json"],
      port: 8080,
      dir: "mock",
      ready: "/",
    },
    // The fake website, whose /scale pages are an endless graph.
    scale: { command: ["faulty", "--port", "{port}", "site.json"], port: 8085, dir: "mock", ready: "/" },
    // Wikipedia mock: 10,000 pages with Fastly CDN latency, rate-limit throttling (429), and server faults.
    wikipedia: {
      command: ["faulty", "--port", "{port}", "--tls", "--scenario", "realworld", "wikipedia.json"],
      port: 8086,
      dir: "mock",
      ready: "/",
    },
  },
  ship: {
    java: CRAWL,
    // `curl -fsSL https://crawl.l3.ai/crawl | sh -s - <url>`; `jbang https://crawl.l3.ai/Crawl.java <url>`.
    publish: { bucket: "crawl", url: "https://crawl.l3.ai" },
    // Every literal of the version, beyond package.json (`mise run version -- <patch|minor|major|X.Y.Z>`).
    version: {
      rules: [
        { file: "pom.xml", text: "<artifactId>crawler</artifactId>\n    <version>{version}</version>" },
        { file: "ports/rust/Cargo.toml", text: 'version = "{version}"' },
        { file: "ports/zig/build.zig.zon", text: '.version = "{version}"' },
        { file: "mock/fly.toml", text: "(v{version})" },
        { file: "project.ts", text: "{version}", all: true },
        { file: "README.md", text: "{version}", all: true },
      ],
      // Cargo.lock follows Cargo.toml.
      after: [["cargo", "metadata", "--manifest-path", "ports/rust/Cargo.toml", "--format-version", "1"]],
    },
    // What proves a release on the platforms only they can, run once the tag job made one (gate.yml's `smoke`).
    smoke: [
      {
        name: "linux (x64)",
        runner: "ubuntu-26.04",
        run: [
          "curl -fsSL --retry 5 --retry-connrefused https://crawlme.fly.dev >/dev/null || true",
          "mkdir -p target",
          "for bin in crawler-go crawler-rust crawler-zig crawler.jar; do",
          '  curl -fsSL --retry 5 --retry-connrefused "https://crawl.l3.ai/v{version}/$bin" -o "target/$bin" &',
          "done",
          "wait",
          "chmod +x target/crawler-*",
          "./target/crawler-go -v -n 10 -t 30 -f https://crawlme.fly.dev",
          "./target/crawler-rust -v -n 10 -t 30 -f https://crawlme.fly.dev",
          "./target/crawler-zig -v -n 10 -t 30 -f https://crawlme.fly.dev",
          'curl -fsSL "https://crawl.l3.ai/v{version}/crawl" | sh -s - -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "if [ -x ~/.jbang/bin/jbang ]; then",
          "  ~/.jbang/bin/jbang target/crawler.jar -v -n 10 -t 30 -f https://crawlme.fly.dev",
          "  ~/.jbang/bin/jbang trust add https://crawl.l3.ai/",
          '  ~/.jbang/bin/jbang --fresh "https://crawl.l3.ai/v{version}/Crawl.java" -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "else",
          "  curl -fsSL https://sh.jbang.dev | bash -s - target/crawler.jar -v -n 10 -t 30 -f https://crawlme.fly.dev",
          "  curl -fsSL https://sh.jbang.dev | bash -s - trust add https://crawl.l3.ai/",
          '  curl -fsSL https://sh.jbang.dev | bash -s - --fresh "https://crawl.l3.ai/v{version}/Crawl.java" -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "fi",
          'content_type=$(curl -sI "https://crawl.l3.ai/v{version}/Crawl.java" | grep -i "^content-type:" | tr -d \'\\r\')',
          'echo "$content_type"',
          'echo "$content_type" | grep -q "text/html" || { echo "Expected text/html but got $content_type"; exit 1; }',
          'docker run --rm --pull=always "docker.io/l3io/crawl:{version}" -v -n 10 -t 30 -f https://crawlme.fly.dev',
        ],
      },
      {
        name: "linux (arm64)",
        runner: "ubuntu-26.04",
        run: [
          "curl -fsSL --retry 5 --retry-connrefused https://crawlme.fly.dev >/dev/null || true",
          "docker run --privileged --rm tonistiigi/binfmt --install arm64",
          'docker pull --platform linux/arm64 "docker.io/l3io/crawl:{version}" &',
          "pull=$!",
          "docker run --rm --platform linux/arm64 buildpack-deps:curl sh -c 'curl -fsSL \"https://crawl.l3.ai/v{version}/crawl\" | sh -s - -v -n 10 -t 30 -f https://crawlme.fly.dev'",
          "wait $pull",
          'docker run --rm --platform linux/arm64 "docker.io/l3io/crawl:{version}" -v -n 10 -t 30 -f https://crawlme.fly.dev',
        ],
      },
      {
        name: "macos (arm64)",
        runner: "macos-latest",
        run: [
          "curl -fsSL --retry 5 --retry-connrefused https://crawlme.fly.dev >/dev/null || true",
          'curl -fsSL "https://crawl.l3.ai/v{version}/crawl" | sh -s - -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "if [ -x ~/.jbang/bin/jbang ]; then",
          "  ~/.jbang/bin/jbang trust add https://crawl.l3.ai/",
          '  ~/.jbang/bin/jbang --fresh "https://crawl.l3.ai/v{version}/Crawl.java" -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "else",
          "  curl -fsSL https://sh.jbang.dev | bash -s - trust add https://crawl.l3.ai/",
          '  curl -fsSL https://sh.jbang.dev | bash -s - --fresh "https://crawl.l3.ai/v{version}/Crawl.java" -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "fi",
        ],
      },
      {
        name: "windows (x64)",
        runner: "windows-latest",
        run: [
          '$ErrorActionPreference = "Stop"',
          "for ($i = 0; $i -lt 6; $i++) {",
          "  try {",
          "    $resp = Invoke-WebRequest -Uri https://crawlme.fly.dev -TimeoutSec 15",
          "    if ($resp.StatusCode -eq 200) { break }",
          "  } catch {",
          "    Start-Sleep -Seconds 5",
          "  }",
          "}",
          '& ([scriptblock]::Create((Invoke-RestMethod "https://crawl.l3.ai/v{version}/crawl.ps1"))) -v -n 10 -t 30 -f https://crawlme.fly.dev',
          "& ([scriptblock]::Create((Invoke-RestMethod https://ps.jbang.dev))) trust add https://crawl.l3.ai/",
          '& ([scriptblock]::Create((Invoke-RestMethod https://ps.jbang.dev))) --fresh "https://crawl.l3.ai/v{version}/Crawl.java" -v -n 10 -t 30 -f https://crawlme.fly.dev',
        ],
      },
    ],
    // The engines' release binaries by the key of their inputs (`tools cache binary`): restored, built once, stored.
    store: {
      bucket: "crawl",
      url: "https://crawl.l3.ai",
      name: "crawler",
      prefix: "binaries/crawler",
      // What a release would otherwise rebuild, by the key of its inputs (project.ts, the pins and bun.lock count too).
      artifacts: {
        native: {
          paths: ["target/crawl-graalvm", "target/crawl.iprof", "target/bundle/linux-x64", "target/publish"],
          inputs: ["src/main/**", "pom.xml"],
        },
        bundles: { paths: ["target/bundle", "target/publish"], inputs: ["src/main/**", "pom.xml"] },
        jdks: { paths: [".cache/tools/jdks"], home: true, files: ["node_modules/@tools/deploy/src/jdks.ts"] },
      },
      // What the tag job uploads: the unified runners and Crawl.java, and each engine's staged binary. `latest` moves
      // with a release; a `v<version>/` object is written once.
      release: {
        files: [
          { file: "target/publish/crawl" },
          { file: "target/publish/crawl.ps1" },
          { file: "target/publish/Crawl.java" },
        ],
        binaries: true,
      },
    },
    // The Dockerfile and .dockerignore are tools' (`mise run dockerfile`), from CRAWL: the gate fails while they differ.
    image: {
      name: "docker.io/l3io/crawl:latest",
      dockerfile: {
        train: [["-n", "100", "https://crawlme.fly.dev/"], ["-h"]],
        trainFlags: ["-Xms64m", "-Xmx256m"],
        cmd: ["-h"],
      },
    },
    // crawlme.fly.dev: faulty with the recording, built by Fly from mock/.
    deploy: fly({ app: "crawlme", dir: "mock", local: true, depot: false }),
  },
});

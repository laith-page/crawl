# crawler

A web crawler CLI in Java, built and shipped on JDK 27 (Java 25 bytecode, for GraalVM native images), and the same
design ported to Go, Rust and Zig. [docs/DESIGN.md](docs/DESIGN.md) defines its behavior, and the black-box
end-to-end tests in `e2e/` test every one of the four against it.

## tools

`@l3/tools` is the shared toolkit, pinned in `package.json`; never edit it here. `project.ts` holds this project's
facts (the crawlme mock it deploys, what it publishes, the macOS and Windows runners, the weekly PGO refresh);
everything else tools finds from the folders. `mise run check` is the gate (CI runs it, the pre-push hook runs it): never
`--no-verify`. Files headed "Written by tools" are rewritten by `mise run fix`; don't edit them. Commits and pull requests
carry no AI attribution.

## Commands

- `mise run check`: the gate: format, lint, type check, generated files current, each engine's unit tests and build,
  the e2e tests on every engine; the perf gate is judged in CI, on the CPUs its baseline was recorded on.
- `mise run test e2e [--only ports/rust] [-t sigint-drains]`: the end-to-end tests on every engine (or one, or one case).
- `mise run test bench`, `mise run bench --update`: the perf gate here against `bench/budgets.json` and `bench/baseline.jsonl`; the
  update records a new baseline (CI's bench-baseline workflow does it on the perf runner).
- `mise run deploy [--dry-run]`: what CI runs on a green main: the crawlme mock to Fly, then the binaries, the image and
  the JBang jar, then the live tests.
- `mise run fix`: rewrite the tools-owned files.
- `bun fixtures/expected.gen.ts <case>` (or `parity`): a case's expected file from the Java reference's crawl;
  `bun fixtures/urls.gen.ts` rewrites the URL corpus; `bun fixtures/oracle/crawl.ts intl` the intl expected file
  from Scrapy.

## Layout

| Path                              | What                                                                       |
| :-------------------------------- | :------------------------------------------------------------------------- |
| `src/`, `pom.xml`                 | The Java reference and its unit tests                                      |
| `src/main/jvm.options`            | The JVM flags every Java crawl runs with, and the runtime's modules        |
| `ports/{go,rust,zig}/`            | The ports, each with its unit tests; `ports/shape.json` what differs, why  |
| `e2e/`                            | The contract cases (`cases.json`), their runner (`lib/`), the live files   |
| `mocks/site/`                     | The fake website faulty serves the cases, and its plugin (wire, timing)    |
| `mocks/crawlme/`                  | The recording of crawlme.fly.dev, deployed there (`fly.toml`)              |
| `mocks/wikipedia/`                | 2,000 Wikipedia pages with CDN latency, throttling and faults              |
| `fixtures/`                       | Expected records, the URL corpus, and the generators that write them       |
| `bench/`                          | The perf gate (`budgets.json`) and the hardware limit (`limit.zig`)        |
| `train/`                          | The crawl a trained build (AOT cache, PGO profile) learns from             |
| `docs/`                           | The contract and execution diagrams                                        |

Big fixtures (the recordings, the intl site, crawlme's expected file) are fetched on demand: `fixtures.json`.

## Changing the crawler

- A behavior change updates `docs/DESIGN.md`, a case in `e2e/cases.json`, and its
  `fixtures/expected/<name>.ndjson`, in all four engines. Rerun a failing case with `mise run test e2e -t <name>`.
- The four are one design: a concept a file in each, the same names and messages (`e2e/design.test.ts`); a
  difference one needs goes in `ports/shape.json` with its reason.
- No file over 1,000 lines of code (`e2e/design.test.ts`).
- The release version is in `package.json`, `pom.xml`, `ports/rust/Cargo.toml`, `ports/zig/build.zig.zon` and
  `ports/go/crawler/VERSION`, the same in all five: `mise run version patch` raises the reference's and every port's at its version, and
  `mise run version ports/<go/crawler|rust|zig> patch` one port's.

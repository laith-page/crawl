# crawler

A web crawler CLI in Java, built and shipped on JDK 27 (Java 25 bytecode, for GraalVM native images). [docs/DESIGN.md](docs/DESIGN.md) defines its behavior, and the black-box end-to-end tests in `e2e/` test it.

## Working on it

```bash
mise run setup          # once, in a fresh clone
mise run test           # Java unit tests, build, then the end-to-end tests
./crawl -n 10           # crawl the local mock
mise run check          # the full pre-push and CI gate
```

| Command                     | What it does                                                  |
| :-------------------------- | :------------------------------------------------------------ |
| `mise run check`            | Format and lint checks, unit tests, builds, and the e2e tests |
| `mise run test`             | Java unit tests, build, and e2e tests                         |
| `mise run e2e [-t name]`    | The e2e tests alone; `-t sigint-drains` runs one case         |
| `mise run fmt`              | Format everything in place                                    |
| `./crawl [options] [url]`   | One crawl, building if stale; no URL crawls the mock          |
| `mise run up mock` / `down` | Run or stop the recording on :8080                            |
| `mise run bench [-w wire]`  | Benchmark against the hardware limit in `bench.ts`            |
| `mise run perf`             | Compare samples with budgets and `perf/baseline.jsonl`        |
| `mise run baseline`         | Rewrite `perf/baseline.jsonl` on CI                           |
| `mise run dist`             | Build the launcher, bundles, and Crawl.java                   |

## Layout

| Path                  | What                                             |
| :-------------------- | :----------------------------------------------- |
| `src/`, `pom.xml`     | The Java crawler and unit tests                  |
| `e2e/`                | Contract cases, expected output, and runner      |
| `mock/`               | The local site, faults, and recording            |
| `bench.ts`, `bench/`  | Benchmark workloads, samples, and hardware limit |
| `perf/baseline.jsonl` | Perf gate baseline, rewritten by CI              |
| `project.ts`          | Gate, mock daemons, and release configuration    |
| `docs/`               | Contract and execution diagrams                  |

## Changing the crawler

- A behavior change updates `docs/DESIGN.md`, a case in `e2e/cases.json`, and its
  `e2e/expected/<name>.ndjson`. Rerun a failing case with `mise run e2e -t <name>`.
- The checked gate catches failures that a normal build may miss. Run `mise run check` before pushing.
- Keep the Java crawler's own code under 1,000 lines, excluding comments and tests: `mise run loc --limit`.

The pre-push hook runs `mise run check`; never use `--no-verify`.

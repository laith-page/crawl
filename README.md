# Crawler

A web crawler CLI in Java, built and shipped on JDK 27 (Java 25 bytecode, for GraalVM native images). Its behavior is defined by the [contract](docs/DESIGN.md) and [black-box end-to-end tests](e2e/cases.json).

```bash
./crawl -n 10                         # the local recording of crawlme.fly.dev
./crawl -n 10 https://crawlme.fly.dev
./crawl go -n 10                      # a port: go, rust or zig
```

Each completed page goes to stdout; the summary goes to stderr:

```text
https://crawlme.fly.dev/ 200
https://crawlme.fly.dev/slow error: timeout
```

## Options

```text
crawl [-f] [-v] [-c N] [-n N] [-t SECONDS] [-d SECONDS] <url>
```

| Option       | Effect                       | Default                    |
| :----------- | :--------------------------- | :------------------------- |
| `-f`         | Fast mode                    | Off                        |
| `-v`         | Print settings to stderr     | Off                        |
| `-c N`       | Maximum requests in flight   | 1; machine sized with `-f` |
| `-n N`       | Maximum pages                | 1,000                      |
| `-t SECONDS` | Timeout per URL              | 10                         |
| `-d SECONDS` | Delay between request starts | 1; 0 with `-f`             |
| `-h`, `-V`   | Help, version and libraries  | —                          |

Set `SSL_CERT_FILE` to a PEM CA bundle to replace the system trust store. See [DESIGN.md](docs/DESIGN.md) for URL, output, limit and failure rules.

## Install

### Pinned Release (v0.3.33)

```bash
# Runner (fetches platform native or JVM bundle)
curl -fsSL https://crawl.l3.ai/v0.3.33/crawl | sh -s - -n 10 https://crawlme.fly.dev

# Java / JBang
jbang https://crawl.l3.ai/v0.3.33/Crawl.java -n 10 https://crawlme.fly.dev

# Docker (multi-arch)
docker run --rm docker.io/l3io/crawl:0.3.33 -n 10 https://crawlme.fly.dev

# Standalone native binaries
curl -fsSL https://crawl.l3.ai/v0.3.33/crawler-go -o crawl && chmod +x crawl     # Go
curl -fsSL https://crawl.l3.ai/v0.3.33/crawler-rust -o crawl && chmod +x crawl   # Rust
curl -fsSL https://crawl.l3.ai/v0.3.33/crawler-zig -o crawl && chmod +x crawl    # Zig
curl -fsSL https://crawl.l3.ai/v0.3.33/crawler.jar -o crawler.jar                # Java JAR
```

### Latest

```bash
curl -fsSL https://crawl.l3.ai/crawl | sh -s - -n 10 https://crawlme.fly.dev
# or, with Java/JBang:
jbang https://crawl.l3.ai/Crawl.java -n 10 https://crawlme.fly.dev
# or, with Docker:
docker run --rm docker.io/l3io/crawl:latest -n 10 https://crawlme.fly.dev
```

The [releases](https://github.com/laith-page/crawler/releases) contain platform bundles.

## Develop

```bash
sudo apt install build-essential valgrind strace   # Linux: Go's -race and Rust's linker; the bench
xcode-select --install                             # macOS: the Command Line Tools
mise trust && mise run setup                       # toolchains, dependencies, hooks and fixtures
mise run test e2e                                  # every engine's end-to-end tests
mise run check                                     # the full gate
mise tasks                                         # everything else
```

systemd is optional: only the `affinity-quota` case needs `systemd-run`, and it is skipped without it.

Linux and macOS (arm64) are both developed on and gated in CI. The end-to-end tests run against the local [`mocks/site/`](mocks/site/) site. See [AGENTS.md](AGENTS.md) for commands and layout, and [the diagrams](docs/diagrams/) for the execution flow.

[MIT](LICENSE)

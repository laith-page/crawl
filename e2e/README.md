# Crawler Spec Suite

Contract tests that verify all four crawler engines (Java, Go, Rust, Zig) adhere to the contract in `docs/DESIGN.md`.

## Case Kinds

Each case in `e2e/cases.json` belongs to one of four kinds:

- **parity**: Verifies individual behaviors against expected NDJSON records in `fixtures/expected/<name>.ndjson` or validates cross-engine agreement on exit code, page count, or record streams.
- **stress**: Tests resource constraints, memory ceilings, network faults (stalls, resets, drops), and edge-case framing without hanging or crashing.
- **consensus**: Crawls dynamic or non-deterministic sites where all engines must discover and report identical sets of records.
- **golden**: End-to-end crawls against large recorded or live sites (`crawlme.json`, `intl`), run nightly (`golden.test.ts`).

A case of any kind whose crawl retries (a refused connect, a name that does not resolve, a reset or a reset handshake,
a malformed head, a retryable status: the parity cases retry-policy, dropped-connections, dead-host and wire too) gives
`-t 60`: its jittered waits are at most 3.75 s a URL, so the deadline only catches a hang and never cuts the last
attempt, which a loaded runner did at `-t 3` and `-t 5` (a timeout in place of the label) and the default `-t 10` left
6 s for. A case about a deadline (a stall, a Retry-After past it) keeps a short `-t`: the stall outlasts it every time.
A case that compares no label (`agree: false`, any exit of a list) keeps its `-t`: a cut attempt changes nothing it
checks. Timing cases order the mock's answers by events, never by a fixed delay (mocks/site/plugin.ts).

## Mock Site and Faults

`mocks/site/site.json` provides the local mock website served by `faulty`:

- Static routes for protocol, header, and encoding checks (`/`, `/relative/`, `/encoding/`, `/framing/`).
- Dynamic graph routes like `/scale/<id>?links=N&limit=M` generating synthetic topologies.
- Simulated faults including dropped connections, slowloris headers, byte straddles, and retryable HTTP statuses (408, 429, 502, 503, 504).

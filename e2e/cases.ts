// The shape of a case: cases.json, a crawl and what must hold of it, and expected/, what it must print.
// See e2e/README.md for case kinds and how to add a case.
import { join } from "node:path";
import { groupedCases, jsonObjectLines } from "@tools/core";
import type { PageRecord } from "./records.ts";

export const CASES = join(import.meta.dir, "cases.json");
export const EXPECTED_DIR = join(import.meta.dir, "expected");

/// The kinds of case (see e2e/README.md): parity, stress, consensus, and golden (runs under CONFORM_FULL=1).
export const KINDS = ["parity", "stress", "consensus", "golden"] as const;
export type Kind = (typeof KINDS)[number];

export interface Case {
  kind: Kind;
  name: string;
  /** Why the case exists, for a reader of cases.json. */
  note?: string;

  // The crawl.
  args: string[];
  /** Environment variables for this crawl, in addition to the mock's CA. */
  env?: Record<string, string>;
  /** Pin this many CPUs for affinity detection; the quota case additionally caps CPU time. */
  cpu_affinity?: 2 | 4;
  cpu_quota?: 2;
  /** Absolute, or a path on the mock (`/relative/`); `{x*80}` repeats a character. */
  start_url?: string;
  /** No mock is started: the command line alone is under test. */
  server?: false;
  /** The mock serves TLS (HTTP/2 too, which the crawler does not ask for); its CA in SSL_CERT_FILE, or not (`untrusted`). */
  tls?: true | "untrusted";
  /** A faulty plugin under mock/ that answers the kinds the case's site names: `wire.ts`, what the crawler sent. */
  plugin?: string;
  /** faulty's own flags for this case's mock: `--idle 300ms`, `--max-conns 1`, `--tls-name other.example`. */
  mock_flags?: string[];
  /** How stdout is read: a reader that closes after the first line, a full disk, or merged stdout and stderr. */
  mode?: "closepipe" | "devfull" | "ignore" | "merged";
  /** A signal (SIGINT unless `interrupt_signal`) this long after the crawler connects. */
  interrupt_after_ms?: number;
  interrupt_signal?: number;
  /** The same signal again, this long after the first: the second signal exits at once (DESIGN §2). */
  interrupt_again_ms?: number;
  /** The crawler starts with the signals it inherits at their defaults, not ignored. */
  reset_signals?: true;

  // The site: mock/site.json with the case's faults, or a recording.
  /** A WARC beside mock/site.json, replayed in place of it. */
  archive?: string;
  /** Another document under mock/ in place of site.json: a generated site. */
  site?: string;
  /** A socket fixture for responses faulty cannot keep alive after writing raw bytes. */
  socket?: "chunked-reuse";
  /** What the expected file's URLs start with, for a recording made under another host. */
  origin?: string;
  /** faulty rules for this crawl alone, and their seed. */
  rules?: unknown[];
  seed?: number;

  // The bounds.
  expected_exit_code: number | number[];
  /** Over the kind's wall (crawl.spec.ts BOUNDS) or under it. */
  max_elapsed_ms?: number;
  /** Over the kind's memory cap or under it. */
  peak_mb?: number;
  /** Run only with CONFORM_FULL=1. */
  slow?: true;
  /**
   * Its stdout is more than a string holds (a million pages of links): written to a file and read as a stream, its
   * pages counted and not kept, so the case has no expected file and the check compares the count.
   */
  big_output?: true;
  /** It moves what the machine can: no other such case runs at once, whatever spec asks (tools' `alone`). */
  alone?: true;

  // What must hold of the output.
  /** A pattern some page line matches. */
  stdout?: string;
  /** A pattern stderr matches. */
  stderr?: string;
  /** A usage error's one line on stderr, matched whole (DESIGN §1). */
  error_line?: string;
  /**
   * What the all-four-agree check compares (tools' `gate.agree`): every byte, unless the case says `count` (which pages
   * fall within -n depends on the order concurrent fetches end, so the exit, stderr and the number of pages) or
   * `exit` (a signal or a reader that goes away cuts a crawl at a moment of its own: the exit, and stderr with the
   * summary's counts written out) or `false` (a broken response a client may read leniently or refuse, DESIGN §5:
   * none of it).
   */
  agree?: "count" | "exit" | false;
  /** A usage error: nothing on stdout, and stderr points at -h. */
  usage?: true;
  /** The flags the usage text must list, no more and no fewer. */
  flags?: string[];
  /** Literal phrases the help text must contain. */
  help_contains?: string[];
  /** A version report on stdout, exit 0. */
  version?: true;
  no_errors?: true;
  expected_pages?: number;
  /** No printed URL is over the 8,000-byte link limit. */
  link_bytes?: true;
  /** `stdout` need not match when the crawler refused the start page within 1.5 s. */
  or_fast?: true;
  /** The expected file's name under expected/, when it is not `<name>.ndjson`. */
  expected?: string;
  /** The expected file's records, read in. */
  records?: PageRecord[];
}

function readExpectedRecords(path: string): PageRecord[] | undefined {
  return jsonObjectLines<PageRecord>(
    path,
    path.endsWith(".zst")
      ? () => {
          try {
            Bun.spawnSync(["bun", "node_modules/@tools/core/src/cli.ts", "fixtures", "ensure", path]);
          } catch {}
        }
      : undefined,
  );
}

/** The cases of one kind, each with its group's defaults under it and its expected records read. */
export function readCases(kind: Kind): Case[] {
  return groupedCases<Case>(CASES, kind, { args: [], expected_exit_code: 0 }).map((testCase) => ({
    ...testCase,
    records: readExpectedRecords(join(EXPECTED_DIR, testCase.expected ?? `${testCase.name}.ndjson`)),
  }));
}

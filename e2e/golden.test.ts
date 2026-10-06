// The golden cases (e2e/cases.json `golden`), and any case marked `slow`: whole crawls of the recording of
// crawlme.fly.dev (fixtures/expected/crawlme.ndjson.zst), of it under hostile faults, and of the generated intl site
// (fixtures/intl.json, its expected file Scrapy's). Minutes each: nightly.
import { defineCases } from "./lib/crawl.ts";

export const tags = ["nightly"];

defineCases(["parity", "stress", "consensus", "golden"], { nightly: true });

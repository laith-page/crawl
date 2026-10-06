// The consensus cases (e2e/cases.json `consensus`): sites with nothing written down to expect, where every target
// must print the same records. Run on each target, and on a Mac too.
import { defineCases } from "./lib/crawl.ts";

export const tags = ["os:macos"];

defineCases(["consensus"]);

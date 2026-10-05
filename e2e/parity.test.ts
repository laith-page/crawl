// The parity cases (e2e/cases.json `parity` and `cli`): each behaviour of DESIGN §1-§5 against its expected file in
// fixtures/expected/, or every target agreeing. Run on each target, and on a Mac too.
import { defineCases } from "./lib/crawl.ts";

export const tags = ["os:macos"];

defineCases(["parity"]);

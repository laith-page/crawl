// The stress cases (e2e/cases.json `stress`): memory ceilings, network faults (stalls, resets, drops) and framing at
// the edges, without a hang or a crash. Run on each target, and on a Mac too.
import { defineCases } from "./lib/crawl.ts";

export const tags = ["os:macos"];

defineCases(["stress"]);

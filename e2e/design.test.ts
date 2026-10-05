// The four crawlers are one design (docs/DESIGN.md), file for file and name for name: what only some of them have,
// and why, is in ports/shape.json. Each stays small: under 1,000 lines of code a file.
import { currentTarget, expectSameShape, maxLines, test } from "@l3/tools";

// Every target at once, so once: on the reference's run.
const once = test.if(currentTarget() === ".");

once("the reference and its ports are one design", () => expectSameShape());

once("each engine under 1,000 lines of its own code and 1,000 of tests, no file over 1,000", () =>
  maxLines({ file: 1000, port: 1000, tests: 1000 }),
);

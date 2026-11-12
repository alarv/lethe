// Grades the probe by command exit, so the harness exercises the same assertion
// path a real scenario uses to run a project's tests.
import { readFileSync } from "node:fs";

const solved = readFileSync("SOLVED", "utf8");
if (!solved.includes("scripts/dev-db.sh")) {
  console.error("SOLVED does not name the command that starts the fixture database");
  process.exit(1);
}
console.log("ok");

// Grades the probe by command exit, so the harness exercises the same assertion
// path a real scenario uses to run a project's tests. The expected values arrive
// in the environment so they never sit in the repository the probe can read.
import { readFileSync } from "node:fs";

const solved = readFileSync("SOLVED", "utf8");
const command = process.env.LETHE_EXPECT_COMMAND ?? "";
const url = process.env.LETHE_EXPECT_URL ?? "";
if (!solved.includes(command) || !solved.includes(url)) {
  console.error("SOLVED does not name the command and the connection string");
  process.exit(1);
}
console.log("ok");

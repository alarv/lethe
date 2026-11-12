import { readFileSync } from "node:fs";

const solved = readFileSync("SOLVED", "utf8");
const host = process.env.LETHE_EXPECT_HOST ?? "";
if (!solved.includes(`STAGING_HOST=${host}`) || !solved.includes("npm test")) {
  console.error("SOLVED does not name the command and the staging host");
  process.exit(1);
}
console.log("ok");

import { readFileSync } from "node:fs";

const solved = readFileSync("SOLVED", "utf8");
const base = process.env.LETHE_EXPECT_BASE ?? "";
if (!solved.includes(`API_BASE=${base}`) || !solved.includes("npm test")) {
  console.error("SOLVED does not name the command and the current API base");
  process.exit(1);
}
console.log("ok");

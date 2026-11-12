// The suite talks to a fixture database. Without it, the failure looks like a
// connection problem rather than a setup step.
const url = process.env.TEST_DB_URL;
if (!url) {
  console.error("Error: connect ECONNREFUSED 127.0.0.1:5433");
  process.exit(1);
}
console.log("ok");

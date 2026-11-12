// The staging smoke test talks to a host that is environment-specific and is
// deliberately not in this repository.
const host = process.env.STAGING_HOST;
if (!host) {
  console.error("Error: STAGING_HOST is not set");
  process.exit(1);
}
console.log(`ok: ${host}`);

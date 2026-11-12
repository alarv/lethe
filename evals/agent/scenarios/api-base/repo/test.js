// The client reads API_BASE. The v1 default is retired; the current base is
// supplied by CI and is not recorded in the repository.
const base = process.env.API_BASE;
if (!base) {
  console.error("Error: API_BASE is not set; the default v1 endpoint is retired");
  process.exit(1);
}
console.log(`ok: ${base}`);

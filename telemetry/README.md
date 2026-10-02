# Telemetry collector

A Cloudflare Worker that receives lethe's opt-in daily usage counts and stores them in
D1. What the client sends, and what it never sends, is in `src/telemetry.ts`; this
collector refuses anything that is not exactly that shape (`worker/src/index.js`).

Nothing about the sender is stored: no address, no country, no time finer than the day.
Request logging is switched off in `wrangler.toml`, so the platform does not keep them
either. Keep it off.

## Test locally, with no account and nothing sent anywhere

```sh
cd telemetry/worker
npx wrangler d1 execute lethe-telemetry --local --file=schema.sql
npx wrangler dev                    # serves http://127.0.0.1:8787 over a local D1
```

In another terminal, point a throwaway lethe home at it. Counts are only sent for
completed days, so seed one for yesterday:

```sh
T=$(mktemp -d); mkdir -p $T/telemetry
printf "$(date -u -v-1d +%F) 1 session\n$(date -u -v-1d +%F) 1 recall\n" > $T/telemetry/pending.log
LETHE_HOME=$T LETHE_TELEMETRY=1 LETHE_TELEMETRY_URL=http://127.0.0.1:8787/v1/daily lethe telemetry
LETHE_HOME=$T LETHE_TELEMETRY=1 LETHE_TELEMETRY_URL=http://127.0.0.1:8787/v1/daily lethe telemetry send
npx wrangler d1 execute lethe-telemetry --local --command "select * from daily"
rm -rf $T
```

(`date -u -v-1d` is macOS; on Linux use `date -u -d yesterday +%F`.)

## Deploy

```sh
npx wrangler login
npx wrangler d1 execute lethe-telemetry --remote --file=schema.sql
npx wrangler deploy
```

It is deployed at `https://lethe-telemetry.alarvfm.workers.dev`, and `DEFAULT_ENDPOINT` in
`src/telemetry.ts` points there. A fork that deploys its own changes that constant.

## Read it

```sh
npx wrangler d1 execute lethe-telemetry --remote --command "
  select v, count(*) as installs_days, sum(sessions) as sessions,
         round(sum(sessions_using) * 1.0 / sum(sessions), 2) as adoption,
         round(sum(sessions_recalling) * 1.0 / sum(sessions), 2) as recalling,
         sum(claims_kept) as kept, sum(claims_rejected) as rejected
  from daily group by v order by v"
```

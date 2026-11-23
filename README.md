# Garmin Data Takeout

All your Garmin Connect data in one zip, right in your browser. Built on Garmin's
official **Personal API**, so it doesn't break when Garmin changes its login.

Not affiliated with Garmin.

## What you get

One zip with:

| Path | What |
|---|---|
| `activities/activities.csv` | One row per activity: date, type, distance, time, elevation, heart rate, calories, location |
| `activities/files/` | The original file of every activity (usually `.fit`), for Strava and other apps |
| `wellness/*.csv` | One spreadsheet per dataset, one row per day: daily summary, sleep, HRV, weight, VO2 max, … |
| `raw/` | Every API response exactly as Garmin sent it (JSON) |
| `manifest.json`, `README.txt` | What was exported, and anything that could not be fetched |

That is **everything the Personal API offers**, which is less than the unofficial
tools that log in with your password can reach (they also get training readiness,
blood pressure, body composition and full activity time series). If you need those,
see [garminexport](https://github.com/petergardfjall/garminexport),
[GarminDB](https://github.com/tcgoetz/GarminDB) or
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect).

## How it works

1. You create a Personal API key in Garmin Connect on the web (Garmin's
   [instructions](https://support.garmin.com/en-US/?faq=HfTwLfw1Gn2A7WS1GdAMH8)).
   Pick the shortest expiry, 30 days.
2. You paste it into the page. The export runs in your browser (a Web Worker), writes
   each file to the browser's private storage as it arrives, and packs them into a zip.
3. You download the zip and delete the key in Garmin Connect.

If the tab closes, start again with the same choices: it continues where it stopped.

### Why there is a relay, and what it sees

Garmin's API refuses requests from web pages (no CORS headers, even for Garmin's own
sites), so a page cannot call it directly. `src/worker/index.ts` is a small Cloudflare
Worker that passes requests on:

- `POST /api/token` carries your key once, to exchange it for a 24-hour token.
- `GET /api/garmin/<path>` carries the token, and only for the Personal API's own
  endpoints (an allow-list); anything else is refused.
- It stores nothing and logs nothing (Workers logs are off in `wrangler.jsonc`),
  refuses requests from other websites, and streams responses through.

The page itself has a strict Content Security Policy (`public/_headers`): only its
own scripts run, and it can only connect to its own relay. Every page shows the
commit it was built from.

Garmin's terms for the Personal API say the key is personal and not to be shared
with third parties, while allowing services you use for your own use. A hosted relay
sits between those two. If you'd rather your key never touches anyone else's server,
run your own copy (below): then the key only goes from your browser to your machine
or your Cloudflare account, and on to Garmin.

## Run it yourself

On your computer (needs Node.js 20+):

```sh
git clone <this repository>
cd garmin-data-takeout
npm install
npm run dev        # open http://localhost:5173
```

On your own free Cloudflare account:

```sh
npx wrangler login
npm run deploy     # prints your https://garmin-data-takeout.<you>.workers.dev
```

## How long it takes

Garmin's rate limit allows about 50 requests, then asks for a pause of 40–50
seconds: roughly one request per second. With the default choices, eight years of
data and 200 activities take about three minutes. The "day by day" options cost one
request per day each, so they add about a minute per two months of history.

## For developers

```
src/core/        the export: token, rate-limited client, datasets, CSV, zip, resume
src/web/         the pages, the export worker, browser storage (OPFS)
src/worker/      the relay (Cloudflare Worker) and its endpoint allow-list
packages/personal-api/
                 garmin-personal-api: generated, reality-checked types for every
                 Personal API response (the typed client is in progress)
scripts/         probes and end-to-end checks used while building
docs/            plan.md (design + what the probes found), library-plan.md
```

Useful commands:

```sh
npm run typecheck
npm run smoke                       # relay checks against a running dev server
npx tsx scripts/export-e2e.ts       # full export from Node through the dev relay
```

Scripts that call Garmin read your key from `GARMIN_API_KEY` or a gitignored
`.garmin-api-key` file (`GARMIN_API_KEY=...`). Not `.env`: Wrangler loads `.env`
into the Worker, and the relay must never hold a key.

What we learned about the Personal API (range limits per endpoint, rate limit,
token format, and 49 places where Garmin's spec disagrees with real responses) is
written down in [docs/plan.md](docs/plan.md) and
[docs/library-plan.md](docs/library-plan.md).

## License

MIT. Garmin and Garmin Connect are trademarks of Garmin Ltd.; this project uses the
names only to say what it works with.

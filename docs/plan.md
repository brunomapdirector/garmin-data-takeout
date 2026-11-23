# garmin-data-takeout: plan

**Garmin Data Takeout.** A website where anyone pastes their Garmin Connect
**Personal API** key and downloads everything that API offers as one zip. Open source
on GitHub, hosted on Cloudflare, with the smallest server that can work.

GitHub description: *All your Garmin Connect data in one zip, right in your browser.
Built on Garmin's official Personal API, so it doesn't break when Garmin changes its
login.*

## How this differs from existing tools

garminexport, GarminDB, garmin-connect-export, garmin-givemydata and
sirredbeard/garmin-data-export (checked 2026-11-23) all log in with email + password
through the unofficial SSO flow (mostly via python-garminconnect) and run as Python
CLIs. They break when Garmin changes its login, and they need a terminal.

This one: the **official Personal API** (supported, keyed), **in the browser** (no
install), and **CSV + original files** for people, not only JSON for scripts.

The trade-off, said plainly in the README: the unofficial endpoints expose more than
the Personal API (training readiness, blood pressure, body composition, respiration,
full activity detail and time series). Claim "everything the Personal API offers",
never "all your data", and point developers who need the rest to those tools.

Status: plan + mockup (`docs/mockup.html`: homepage + export flow). Nothing built yet.
Hosting: Cloudflare (chosen over Vercel: relay traffic is unmetered on Workers; Vercel
Hobby caps transfer at 100 GB/month, about 250 full exports).

## Facts this plan rests on (checked 2026-11-23)

- **API**: Garmin Connect Personal API v1.0.0, `https://personal.connectapi.garmin.com`,
  GET only. Swagger: developer.garmin.com/gc-developer-program/personal/swagger-docs/
- **Auth**: `POST /personalapitoken-service/personal-api/personal-api-key/token` with
  header `Authorization: ApiKey <key>` returns an access token valid 24 h (or until the
  key expires). Keys expire after 30 / 90 / 180 / 365 days, shown once at creation.
  The token is a plain-text JWT (see Phase 0 findings).
- **CORS**: Garmin sends no CORS headers for other origins (tested from example.com:
  host reachable, any CORS request fails). A browser cannot call the API directly, so
  a relay is required. This is the only reason a server exists.
- **Terms** (Aanvullende voorwaarden, pasted 2026-11-23):
  - §1: the key is personal; allowed for "toepassingen, diensten of hulpmiddelen die je
    ontwikkelt of gebruikt voor je eigen gebruik"; not to be shared with third parties.
    A hosted relay is a **gray area**: it is a service used for your own use, but the
    key passes through it. Risk lands on the user (key revoked), not on us.
  - §2: Garmin may throttle or reject without notice; no limits published.
  - §3: breach can revoke the key.
- **Range limits per call**: daily summaries v2 ≤ 1 year · weight ≤ 364 d · sleep,
  hydration, Body Battery ≤ 31 d · steps, stress ≤ 28 d. Some endpoints are one day per
  call (heart rate, SpO2, HRV detail, nutrition, menstrual day view, daily sleep).
- **Activities**: `activitylist-service/activities/search/activities` pages with
  `start` + `limit` (default 99). `download-service/files/activity/{id}` returns a zip
  holding the original file (usually FIT).

## Phase 0 findings (probe run 2026-11-23, `scripts/probe.mjs`, one real account)

- **Token**: the token endpoint returns the token as **plain text** (`text/plain`), not
  JSON. It is a JWT (1,141 chars); `exp - iat` = 24.0 h. `Authorization: Bearer <jwt>`
  works on every data endpoint. Read expiry from the JWT's `exp` claim.
- **No rate-limit headers** on any response. Nothing to read ahead of time; back off on
  429/5xx only. 13 requests at 0.4 s spacing caused no throttling. Latency 150–440 ms.
- **History is complete**: activity list goes back to the account's first activity
  (2019-01-27, 195 activities over 2 pages of 99); daily summaries v2 return all 357
  days of the first year.
- **Activity file**: `application/x-zip-compressed`, ~15–21 KB, one entry
  `<id>_ACTIVITY.fit`. The zip uses data descriptors (sizes 0 in the local header), so
  the unzip must read the central directory. fflate does.
- **Over a range limit**: HTTP **400 with body `{}`**, no message. The client must
  chunk to the documented limits itself; a 400 is not retryable.
- **HRV range**: 120 days accepted; the real limit is higher and still unknown.
- **Sleep**: nights without data come back as an entry with all fields `null`
  (25 of 31 days populated). Skip those rows in CSV, keep them in `raw/`.
- **Daily heart rate**: 720 values per day (one per 2 min) as `[timestamp, bpm]` pairs.
- **Activity list** includes owner name and profile image URLs; strip nothing (it is the
  user's own data) but leave them out of `activities.csv`.

## Phase 1 findings (full activity export, 2026-11-23, `scripts/export-e2e.ts`)

- **Rate limit is real and announced**: after ~80 file downloads at 2 in flight
  (~30 s), Garmin answered **429 with a `Retry-After` header** (36–37 s), then a few
  shorter ones (5 s, 1 s). Honouring `Retry-After` got all 195 files with no failures.
  The relay passes `Retry-After` through; the client waits exactly that long.
- **Cost of a full export**: 195 activities = 82 s, **34.1 MB** (~175 KB per FIT file,
  more than the 15–21 KB the probe's two samples suggested). 1,500 activities would be
  roughly 260 MB and 10+ minutes, mostly waiting on the rate limit.
- **Wrangler loads `.env` into the Worker** in local dev ("Using secrets defined in
  .env"). The key file is therefore `.garmin-api-key`, never `.env`.

## Phase 2 findings (wellness + resume, 2026-11-23)

- **Rate limit shape**: about 50 requests, then a 429 with `Retry-After` of 40–50 s,
  repeating. So roughly **1 request/second sustained**; request count is what an
  export costs in time.
- **Range limits confirmed**: VO2 max 365 d (730 → 400), HRV ≥ 365 d, steps 28 d and
  weight 364 d exactly as documented (one day over → 400 `{}`).
- **Empty body = no data**: HRV for years before the watch had it returns 200 with an
  empty body, not JSON. `getJson` returns `null` for that.
- **Defaults chosen by cost**: stress, steps, Body Battery and hydration detail are
  **off by default**; their daily numbers are in the daily summary, and at 28–31 days
  per request they were ~390 of ~700 requests. Full default export of this account
  (195 activities, 2019–2026): **191 s, 35 MB, 341 files, 0 failures** (was 434 s).
- **Resume works**: a rerun with the same settings kept all files and finished in
  5 s, refetching only what had failed.
- **Browser-only parts checked** with `dev/opfs-selftest.html` (11 checks: OPFS
  write/read/list/overwrite/clear, zip streamed to a separate OPFS output, FIT intact).
  A real export in the browser with a key has been run by the user on the phase 1
  page, not yet on this one.

## Architecture

```
browser (static site, all logic)  ──►  relay (Cloudflare Worker)  ──►  personal.connectapi.garmin.com
   key in memory only                    stateless, no logs,
   builds the zip                        path allow-list
```

One Cloudflare Worker serves both the static site (Workers static assets) and the
relay under `/api/*`. Same origin, so the site needs no CORS and the relay can refuse
every other origin.

### Relay (`worker/`, aim < 80 lines)
- `POST /api/token`: forwards the `ApiKey` header to Garmin's token endpoint, returns
  the token. The only request that ever carries the key.
- `GET /api/garmin/<path>`: forwards to Garmin with `Authorization: Bearer <token>`,
  only if `<path>` matches the allow-list (the 28 GET paths from the Swagger spec).
  Streams the response body back; never buffers.
- Forwards only `Authorization` + `Accept`; drops cookies and everything else.
- No `console.log`, Workers observability/logs **off** in `wrangler.jsonc`.
- Origin check: own origin only (self-hosted relays: configurable list).
- Per-IP rate limit via the Workers Rate Limiting binding (to verify on free plan).

### Site (`web/`)
- Vite + React + TypeScript. No analytics, no third-party scripts, no fonts from CDNs.
- Strict CSP: `default-src 'self'`, `connect-src 'self' https://*.workers.dev`
  (the second only so a user's own relay works).
- Key lives in a React ref for the session; never in `localStorage`, URL, or logs.
  The input is `type=password`, `autocomplete=off`.
- Footer shows the deployed commit hash, linking to that commit on GitHub.

### Core (`web/src/core/`)
Plain TypeScript, `fetch` only, so a CLI can reuse it later.
- `token.ts`: exchange key for token; re-exchange if a call returns 401 and the key
  is still in memory.
- `client.ts`: one `get(path, query)` with backoff on 429/5xx (exponential, jitter,
  honours `Retry-After`), 2 requests in flight max.
- `datasets.ts`: one entry per dataset: endpoint, range limit, chunking, CSV columns.
- `export.ts`: walks the selected datasets over the chosen date range, yields
  progress events, writes into the zip.
- Zip: **fflate** (unzip each activity zip, stream the outer zip). On Chromium, stream
  to disk with `showSaveFilePicker`; elsewhere build in memory and warn above ~1 GB.

### Pages
- `/`: **homepage** (mockup screen 0): what it is, how it works in three steps, what
  you get, how the key is handled, how to run it yourself, a short FAQ. Static, no JS
  needed to read it.
- `/export`: the four-screen export flow (mockup screens 1–4).

## Run it yourself

The repo is public (MIT) and the hosted site is just one deploy of it. Three ways,
all shown on the homepage:

1. **Deploy to Cloudflare** button: copies the repo to the user's GitHub and deploys
   site + relay to their own free Cloudflare account. Their key then only passes
   through infrastructure they own.
2. **On your computer**: `git clone`, `npm install`, `npm start`. `npm start` runs
   `wrangler dev`, which serves the site and the relay on `localhost:8787`; the key
   goes from the browser to localhost to Garmin and nowhere else. Needs Node.js only,
   no Cloudflare account.
3. **Use our site with your own relay**: a setting on the key screen takes a relay URL
   (for people who deployed option 1 but want our latest UI).

The repo needs for this: a `README.md` with these three paths and the trust model in
plain words; the Deploy to Cloudflare button config; no secrets or account IDs in
`wrangler.jsonc`; one `npm start` that works on Windows, macOS and Linux.

## What the zip contains

```
garmin-data-takeout-2026-11-23/
  README.txt                      what each file is, how to open it
  manifest.json                   date range, datasets, counts, tool version
  activities/
    activities.csv                one row per activity (opens in Excel)
    activities.json               raw summaries
    files/2026-11-20_Morning-Run_1234567890.fit
  daily/summary.csv · sleep.csv · stress.csv · steps.csv · body-battery.csv · hrv.csv
  body/weight.csv · hydration.csv
  fitness/vo2max.csv · fitness-age.json · heart-rate-zones.json
  profile/settings.json
  raw/<dataset>/<range>.json      every API response, untouched
```

CSV is for people; `raw/` is the source of truth.

## Datasets in the UI

| Group | Default | Calls for 10 years |
|---|---|---|
| Activities + original files | on | pages + 1 per activity |
| Daily summary (steps, calories, stress, Body Battery) | on | ~10 |
| Sleep | on | ~120 |
| Stress, steps detail | on | ~260 |
| Body Battery | on | ~120 |
| HRV | on | range endpoint, limit to verify |
| Weight, hydration | on | ~130 |
| VO2 max, fitness age, HR zones, profile | on | few |
| Nutrition logs | off | 1 per day |
| Detailed per-day heart rate + SpO2 | off | 2 per day (heavy) |
| Women's health | **off, opt-in** | 2 per day |

A user with 1,500 activities and 10 years on the defaults is about 2,300 requests.
Workers free plan: 100k requests/day, so roughly 40 such exports a day before the $5
plan is needed.

## Incremental use
No accounts, nothing stored server-side. The site remembers the last export date in
`localStorage` (not sensitive) and prefills "From" with it next time.

## Phases

0. **Probe** (done 2026-11-23): Node script straight to Garmin, no relay. See Phase 0
   findings.
1. **Relay + activities** (built 2026-11-23): `src/worker/` relay with the allow-list
   and origin check; `src/core/` token source, rate-limit-aware client, activity list,
   file download, CSV, zip; `index.html` + `src/web/main.ts` bare page.
   `npm run smoke` checks the relay; `npx tsx scripts/export-e2e.ts` runs the whole
   export from Node. The zip is still built in memory (`zipSync`); streaming to disk
   comes with the real UI.
2. **All datasets + resume** (built 2026-11-23): `src/core/datasets.ts` (endpoints,
   range limits, chunking, generic flatten to CSV), `src/core/store.ts` +
   `src/web/opfs-store.ts` (files land in OPFS as they arrive), `src/core/zip.ts`
   (zip streamed file by file into OPFS, never all in memory), `src/web/export.worker.ts`
   (export runs in a Web Worker so background tabs are not throttled), resume of an
   unfinished export with the same settings, Wake Lock and a leave warning while it runs.
   Zip layout as built: `activities/`, `wellness/<dataset>.csv`, `raw/<dataset>/…`,
   `raw/profile/…`, `manifest.json`, `README.txt`.
3. **UI** (built 2026-11-23): `index.html` homepage (how it works, what you get, key
   handling, run it yourself, FAQ) and `export.html` with the four screens: key
   (guided steps, checked with one token exchange before moving on, resume notice),
   choose (main / more detail / day by day groups), progress (per-dataset rows, rate
   limit waits, Stop = terminate the worker, resume later), done (download, delete-key
   reminder, remove the browser copy). Plain TypeScript, no framework, shared
   `src/web/style.css`. `public/_headers`: strict CSP (`script-src 'self'`,
   `connect-src 'self'`, no framing), no-referrer, nosniff. Footer shows the build's
   commit; GitHub links appear once `GARMIN_TAKEOUT_REPO` is set at build time.
   README.md and LICENSE (MIT) added. Checked: production preview serves the headers;
   the key check works under the CSP with a clean console. Not checked: a full export
   with a real key on this page, and the download link under the CSP.
4. **Hardening + self-hosting**: CSP, origin check, rate limit, logs off, commit hash
   footer, "use your own relay" setting, Deploy to Cloudflare button, `npm start` for
   local runs, README with the three ways to run it and the trust model.
5. **Public**: GitHub repo public (MIT), deploy to `*.workers.dev` or a domain.

## Open
- Is Garmin's rate limit per token or per IP? Phase 1 hit it at ~80 downloads in
  ~30 s from one machine. If it is per IP, every user of the hosted relay shares one
  budget and a busy day slows everyone down.
- HRV range limit (above 120 days).
- Whether Garmin's brand guidelines allow "Garmin" in the site name.
- Whether the Rate Limiting binding is on the Workers free plan.

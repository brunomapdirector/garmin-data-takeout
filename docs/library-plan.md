# Library plan: from website internals to a package agents like

Status: plan only (2026-11-23). Nothing restructured yet. Builds on phase 2
(`5e0b103`).

## Goal

A developer opens their own project, tells a coding agent (Claude Code, Cursor,
Copilot) "use garmin-personal-api to chart my HRV against training load", and the
agent gets it right on the first try: it installs one package, finds a typed method,
and never has to learn about range limits, rate limits or the token dance.

Today it cannot: `src/core/` only works through our relay, is not a package, types
almost nothing, and has no docs an agent reads (see "Why not today" at the end).

The niche is open: python-garminconnect is popular because it has one method per
endpoint, but it uses the unofficial login. Nothing in TypeScript wraps the
**official** Personal API.

## Packages

One repo, npm workspaces:

```
packages/
  personal-api/     npm: garmin-personal-api     typed client, zero dependencies
  takeout/          npm: garmin-data-takeout     export (zip, CSV, resume) + CLI
apps/
  web/              (private)                    the website + Cloudflare relay
```

- **`garmin-personal-api`**: the thing agents import. `fetch` only, so it runs in
  Node 18+, Bun, Deno, Cloudflare Workers and browsers (browsers need a relay, see
  `baseUrl`). No dependencies.
- **`garmin-data-takeout`**: what the website does, as a library and a CLI. Depends on
  `garmin-personal-api` and `fflate`.
- **`apps/web`**: today's `index.html`, `src/web/`, `src/worker/`, `wrangler.jsonc`.
  A consumer of both packages, like any other user.

Names checked free on npm 2026-11-23: `garmin-personal-api`, `garmin-data-takeout`
(and the `@garmin-data-takeout` scope). Both use the trademark descriptively, like
the existing Garmin tools; README says "Not affiliated with Garmin".

## `garmin-personal-api`: the API

```ts
import { createGarminClient } from 'garmin-personal-api';

const garmin = createGarminClient({ apiKey: process.env.GARMIN_API_KEY! });

// Range methods take any range; the client splits it into windows the endpoint
// accepts and concatenates the results.
const nights = await garmin.sleep.summaries({ from: '2019-01-01', to: 'today' }); // DailySleepDTO[]
const hrv = await garmin.hrv.daily({ from: '2025-01-01', to: '2025-12-31' });     // HrvSummaryDTO[]

// Long lists are async iterators; pages and rate limits are invisible.
for await (const a of garmin.activities.list({ from: '2026-01-01' })) {          // SummarizedActivityDTO
  const files = await garmin.activities.originalFiles(a.activityId);             // [{ name, ext, data }]
}

// Single-day and one-off endpoints.
const hr = await garmin.wellness.heartRate('2026-11-22');                         // DailyHeartRateDTO
const me = await garmin.profile.settings();                                       // UserSettingsDTO
```

### Options

```ts
createGarminClient({
  apiKey,                     // or: token: () => Promise<string> (bring your own token)
  baseUrl,                    // default https://personal.connectapi.garmin.com; a relay URL in browsers
  region: 'global' | 'china', // .com or .cn server
  concurrency: 2,             // requests in flight
  maxRetries: 6,              // on 429 / 5xx / network
  onRateLimit: (s) => {},     // "waiting s seconds", for progress UIs
  signal,                     // AbortSignal for everything
  fetch,                      // custom fetch (tests, proxies)
});
garmin.tokenExpiresAt;        // Date, from the JWT
```

### Every endpoint, one method

| Method | Endpoint | Returns | Notes |
|---|---|---|---|
| `activities.list({ from, to, type, … })` | activitylist search | `AsyncIterable<SummarizedActivityDTO>` | pages of 99; the endpoint's own `startDate`/`endDate`/`activityType` filters |
| `activities.get(id)` | activity/{id} | `ActivitySummaryDTO` | splits, measurements |
| `activities.workouts(id)` | activity/{id}/workouts | `ActivityWorkoutDTO[]` | |
| `activities.originalFiles(id)` | download-service | `{ name, ext, data }[]` | unwraps Garmin's zip (needs a ~40-line central-directory reader, to stay dependency-free) |
| `activities.types()` | activityTypes/simple | `SimpleActivityTypeDTO[]` | |
| `daily.summaries({ from, to })` | usersummary v2 | `UserDailySummaryV2DTO[]` | 365 d windows |
| `daily.summary(date)` | usersummary daily | `UserDailySummaryDto` | |
| `daily.steps / stress / hydration({ from, to })` | stats/* | `StepsDailyStatDTO[]` … | 28 / 28 / 31 d windows |
| `sleep.summaries({ from, to })` | dailySleepSummariesByDate | `DailySleepDTO[]` | 31 d windows; empty nights dropped unless `{ includeEmpty: true }` |
| `sleep.day(date)` | dailySleep | `DailySleepDTO` | |
| `hrv.daily({ from, to })` | hrv/daily | `HrvSummaryDTO[]` | 365 d windows; empty body → `[]` |
| `hrv.day(date)` | hrv/{date} | `HrvChartDTO` | |
| `bodyBattery.daily({ from, to })` | bodyBattery reports | `BodyBatteryDailyReportDTO[]` | 31 d |
| `wellness.heartRate(date)` | dailyHeartRate | `DailyHeartRateDTO` | |
| `wellness.spo2(date)` | spo2acclimation | `DailySpO2AndAcclimationDTO` | |
| `wellness.activities({ from, to })` | wellnessactivity range | `WellnessActivitySummaryDTO[]` | 365 d |
| `weight.entries({ from, to })` / `weight.range(…)` | weight all / range | `DateWeightDTO[]` / `WeightRangeDTO` | 364 d |
| `weight.goals({ from, to })` | weightgoal | `UserGoalsRangeDTO` | |
| `fitness.vo2max({ from, to, sport })` | maxmet | `MaxMetDTO[]` | 365 d |
| `fitness.age(date)` | fitnessage v2 | `FitnessAgeDTO` | spec says array, real response is an object (see Types) |
| `fitness.heartRateZones()` | heartRateZones v2 | `HeartRateZonesDTO[]` | |
| `nutrition.day(date)` | food/logs | `DailyNutritionSummaryDTO` | |
| `womensHealth.summary(date)` / `.day(date)` | menstrualcycle | `MenstrualCycleSummaryDTO` / `DetailedMenstrualCycleDayDTO` | |
| `profile.settings()` | userprofile settings | `UserSettingsDTO` | |
| `raw.get(path, query)` | any allow-listed path | `unknown` | escape hatch, same rate limiting |

28 endpoints, 112 schemas in the spec (checked 2026-11-23).

### Errors

```ts
GarminKeyError        // the key was refused (400/401/403 on the token exchange)
GarminApiError        // { status, path, retryAfter } after retries ran out
GarminRangeError      // thrown BEFORE sending, if a raw call exceeds a known range limit
```

### Dates

`from`/`to` accept `'yyyy-MM-dd'`, `Date`, or `'today'`. Calendar dates are the
user's local calendar days, as Garmin uses them; the client never converts time zones.

## Types

Built in library phase 1 (2026-11-23):

- `scripts/fetch-spec.mjs` finds the Swagger page's bundle from its HTML, cuts out the
  spec string and decodes it by hand (never evaluates Garmin's JavaScript) →
  `spec/personal-api.v1.json`.
- `scripts/patch-spec.mjs` corrects the spec where real responses disagree, each patch
  naming its evidence → `spec/personal-api.v1.patched.json`.
- `npm run gen` (patch + **openapi-typescript** 7.13, `--root-types`) →
  `src/types.gen.ts`, 112 schemas as aliases. Names come out as `DailySleepDto`
  (openapi-typescript's casing), not `DailySleepDTO`.
- `scripts/check-spec.mjs [--patched]` compares recorded responses (`probe-out/`) with
  the spec: **49 differences** against Garmin's spec, **0** against the patched one.
- Method signatures stay handwritten (they carry the range limits and chunking); their
  return types come from the generated file.

What the check found (Garmin spec v1.0.0 vs real responses, 15 endpoints recorded, 12
with data):

| Difference | Where | Patch |
|---|---|---|
| Nothing is nullable, Garmin sends `null` for every missing value | sleep, HRV, profile, stress, HR zones, VO2 max | every property (and map value) nullable |
| Sleep window timestamps are epoch ms, documented as date-time strings | `DailySleepDTO` | `integer`; `autoSleep*` (only `null` seen) allow both |
| `ConnectDate` / `ConnectTimestamp` documented as `{date, localDate}`, sent as strings | `DailyHeartRateDTO` | strings there; `string \| object` in the 7 other schemas using them (unseen) |
| Time series are `[epochMs, value \| null]` pairs, documented as object arrays | heart rate, Body Battery | number-pair arrays |
| Fitness age returns one object, documented as an array | `fitnessage/v2` | single `FitnessAgeDTO` |
| Undocumented fields | `HydrationV2DTO.consumedInMl`, `DailySleepDTO.retro`, `VO2MaxDTO.sport/subSport` | added |

Activity list and steps matched exactly. Hydration, weight and wellness activities were
empty on the test account, so their schemas are unverified; 13 endpoints were never
recorded (activity detail, workouts, nutrition, women's health, SpO2, weight range,
goals, single-day HRV / sleep / summary, activity types).

**Redistribution** (decided 2026-11-23): Garmin's spec files stay out of git (Terms of
Use restrict copying site Content). `types.gen.ts` is committed, generated from
`personal-api.v1.structure.json`: names, types, formats and enums only, with every
description, example and summary removed. Our own JSDoc on the client methods (phase 2)
replaces Garmin's prose where agents need it. Recreate the spec with `npm run fetch-spec`.

## `garmin-data-takeout`: export + CLI

```ts
import { createGarminClient } from 'garmin-personal-api';
import { exportTakeout } from 'garmin-data-takeout';
import { FsStore } from 'garmin-data-takeout/node';     // OpfsStore from 'garmin-data-takeout/browser'

await exportTakeout(garmin, {
  store: new FsStore('./garmin'), datasets: ['daily-summary', 'sleep', 'hrv'],
  from: '2019-01-01', zip: './garmin.zip', onProgress,
});
```

```
npx garmin-data-takeout --out ./garmin                # everything, default datasets
npx garmin-data-takeout --since last --out ./garmin   # incremental: from the last run's end date
npx garmin-data-takeout --datasets sleep,hrv --format csv
```

Key from `GARMIN_API_KEY`, a `--key-file`, or a hidden prompt; never a flag (shell
history). Today's `src/core/{export,datasets,csv,zip,store}.ts` move here almost as is.

## Docs agents read

- **README.md**: install, the 10-line example above, the method table, rate limits in
  one paragraph, "Not affiliated with Garmin", the terms in plain words.
- **AGENTS.md** (also read by Claude Code via a `CLAUDE.md` that points to it): how
  to run tests offline, "never log or commit the key", "use the typed methods, not
  `raw.get`", where the spec and fixtures live, how to regenerate types.
- **examples/**: `sleep-trend.ts`, `export-to-sqlite.ts`, `daily-sync.ts`,
  `hrv-vs-load.ts`. Each runs with `npx tsx examples/x.ts`.
- **JSDoc on every method** with the range limit and an example. Agents read hover
  docs and `.d.ts` files more than READMEs.
- **llms.txt** at the website root pointing to the README and method table.

## Tests

- **Vitest**, offline by default. A fake `fetch` serves **recorded fixtures**.
- `scripts/record-fixtures.ts` calls every endpoint once with a real key and writes
  anonymised responses: names, GUIDs, user ids, coordinates and free text replaced,
  numbers kept. Reviewed by hand before commit.
- Behaviour tests: chunking at each limit (28/31/364/365), 429 + `Retry-After`,
  401 → one token refresh, empty body → empty result, pagination end, zip unwrap.
- One opt-in live smoke test (`GARMIN_API_KEY=… npm run test:live`), never in CI.

## Build and publish

- **tsdown** (or tsup) → ESM + `.d.ts`, `exports` map with subpaths
  (`garmin-data-takeout/node`, `/browser`). No CommonJS build.
- GitHub Actions: typecheck, lint, test on push; publish on a tag with npm
  provenance. Changesets for versions and changelog.

## What moves where

| Today | Goes to |
|---|---|
| `src/core/client.ts`, `token.ts` | `packages/personal-api/src/` (+ `baseUrl`, direct by default) |
| allow-list in `src/worker/allowlist.ts` | generated from the spec in `personal-api`, imported by the relay |
| `src/core/activities.ts` | split: listing/download → `personal-api`; CSV → `takeout` |
| `src/core/{datasets,export,csv,zip,store}.ts` | `packages/takeout/src/` (datasets call typed methods) |
| `scripts/export-e2e.ts` `FsStore` | `packages/takeout/src/node.ts` |
| `src/web/opfs-store.ts` | `packages/takeout/src/browser.ts` |
| `index.html`, `src/web/*`, `src/worker/*`, `wrangler.jsonc`, `vite.config.ts` | `apps/web/` |
| `scripts/probe*.mjs` | `packages/personal-api/scripts/` (kept as references) |

## Phases

1. **Spec + types** (done 2026-11-23, see Types).
2. **Client**: `createGarminClient` with direct mode, typed methods, chunking,
   iterators, errors; tests on recorded fixtures.
3. **Restructure**: workspaces; takeout and web on top of the client. The website
   must behave exactly as now (same export, same zip).
4. **CLI + Node store**, incremental `--since last`.
5. **Docs**: README, AGENTS.md, examples, JSDoc, llms.txt.
6. **Agent test**: in an empty folder, ask a coding agent to build two of the
   examples from the README alone. What it gets wrong goes back into the docs.
7. **Publish** to npm (⚠ public, irreversible names), after the GitHub repo is public.

## Why not today (what an agent would hit)

1. `GarminClient` / `TokenSource` always call `${relay}/api/…`: unusable in Node
   without running the relay.
2. No package: no `npm install`, no public `index.ts`, no `.d.ts`, no `exports`.
3. Only `Activity` is typed; every wellness response is `unknown`.
4. The entry point is "export everything to a zip", not "get my sleep".
5. No README, AGENTS.md, examples or tests.

## Open

- Whether Garmin minds a client package wrapping the Personal API. Terms §1 allows
  "toepassingen … die je ontwikkelt" for your own use; a library each user runs with
  their own key fits that best of all our forms.
- Rate limit per key or per IP (matters for the website, not the library).
- `activities.list` filters: the spec lists 30 query parameters; which work as
  documented is untested beyond `start`, `limit`, `sortOrder`.

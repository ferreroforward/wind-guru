# Wind Guru

A wind sport forecast tool for the Strait of Georgia, Howe Sound and Metro
Vancouver. Pick a knot range, pick a day (today + 3 ahead), and it ranks
every spot by probability of hitting that range — reasoning through whether
the wind is thermal (sea breeze / valley heating), outflow (gap wind /
cold-air drainage) or synoptic (frontal/gradient), not just showing raw
numbers.

## How it works

- **Data**: [Open-Meteo](https://open-meteo.com) multi-model API — GFS
  (NOAA), ECMWF, ICON (DWD) and GEM/HRDPS (Environment Canada, ~2.5km over
  BC). Free, no API key, CORS-enabled.
- **Rule engine** (`assets/rules.js`): classifies each hour at each spot as
  thermal / outflow / synoptic / calm / mixed, using local hour, month, cloud
  cover, and direction against each spot's known pattern (see
  `assets/spots.js`). Thermal and outflow hours weight the fine-resolution
  GEM/HRDPS model more heavily, since it's the only one of the four that
  resolves Howe Sound and Fraser Valley terrain effects.
- **Squamish thermal calibration**: raw coarse-model (GFS-class) wind badly
  under-reads the Squamish/Furry Creek thermal once it's actually inflowing.
  We scale it ~2.85x based on field notes from a 12-year local rider, Jack
  Rieder of [West Coast Wind Sports](https://www.westcoastwindsports.com/blogs/local-knowledge/forecasting-squamish-wind-with-jack-rieder):
  5-7kt modeled SW ≈ 15-20kt real, 7-9kt ≈ 20-25kt real, 9kt+ ≈ a strong day.
  See `calibrateSquamishThermal()` in `assets/rules.js`.
- **Environment Canada marine bulletin**: per the same source, EC's Howe
  Sound text forecast is the single best starting resource for today's
  Squamish wind. `generate.mjs` fetches it (server-side only — no CORS for a
  browser fetch) and the page shows it as a banner above the map, alongside
  a link to the [live Squamish wind meter](https://squamishwindsports.com/conditions/wind/).
- **Pressure gradient (MSLP)**: Squamish wind isn't purely thermal — it's
  also a function of the real sea-level pressure gradient along the
  corridor. Inspired by [kiteloop.vercel.app](https://kiteloop.vercel.app/)'s
  "MSLP — two pressure checks" panel, `generate.mjs` fetches forecast MSLP at
  three reference points (`PRESSURE_REFERENCE` in `assets/spots.js`:
  Pemberton for the interior, Vancouver for the coast, Point Atkinson for the
  Howe Sound mouth) and computes a large-scale (coast − interior) and a local
  (mouth − spot) gradient for any spot with `pressureGradientAware: true`.
  When both line up with the wind-speed signal it boosts confidence and says
  so; when they don't, it adds a caution note. This reads Open-Meteo
  *forecast* MSLP rather than kiteloop's live SWOB station observations, so
  treat it as an approximation of the same idea, not a reproduction of that
  site's exact numbers. See `classifyHour()` in `assets/rules.js`.
- **Rider feedback loop**: see "Rider feedback & self-calibration" below —
  actual on-the-water reports nudge each spot's calibration over time.
- **Live verification**: see "Live verification" below — each run checks
  the forecast against a real observation from the nearest Environment
  Canada station and self-corrects when they disagree.
- **Two ways the page gets data**:
  1. `data/forecast.json` — a snapshot committed twice a day by the GitHub
     Action below. Loads instantly, includes the EC bulletin, MSLP gradient,
     and feedback-learned calibration.
  2. **Refresh live** button — fetches straight from Open-Meteo in the
     visitor's browser and recomputes on the spot (including the Squamish
     speed calibration), but not the EC bulletin, MSLP gradient, or feedback
     calibration, since those either need a server-side fetch (no CORS) or
     read a file the browser doesn't otherwise load. Also the automatic
     fallback if `data/forecast.json` doesn't exist yet.

## Local setup

```bash
# one-time
node --version   # need >=18

# generate a forecast snapshot
node scripts/generate.mjs

# preview the site
npm run serve   # http://localhost:8080
```

(`index.html` uses ES module imports, so it must be served over http —
opening the file directly with `file://` will not load the modules.)

## Deploying: GitHub Pages + your GoDaddy domain

This keeps `yourdomain.com`, costs nothing, and needs zero credentials
shared with anyone — GitHub's own Action commits the twice-daily snapshot.

1. **Create a repo.** On GitHub, create a new repository (e.g. `wind-guru`)
   and push everything in this folder to it:
   ```bash
   cd wind-guru
   git init
   git add .
   git commit -m "Wind Guru v1"
   git branch -M main
   git remote add origin https://github.com/<you>/wind-guru.git
   git push -u origin main
   ```
2. **Turn on Pages.** Repo → Settings → Pages → Source: "Deploy from a
   branch" → Branch: `main`, folder `/ (root)` → Save. GitHub gives you a
   `https://<you>.github.io/wind-guru/` URL — confirm the site loads there
   first.
3. **Run the forecast job once.** Repo → Actions → "Update wind forecast" →
   Run workflow. This populates `data/forecast.json` for the first time (it
   will otherwise wait for the next scheduled run, up to 12 hours away).
4. **Point your GoDaddy domain at Pages.** In GoDaddy → My Products → DNS
   for your domain, add:
   - If using the bare domain (`yourdomain.com`): four **A** records for
     `@` pointing to GitHub's Pages IPs:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - If using a subdomain (`wind.yourdomain.com`): one **CNAME** record for
     `wind` pointing to `<you>.github.io`
   - Either way, remove/replace any conflicting existing A/CNAME record on
     that same host name.
5. **Tell GitHub the custom domain.** Repo → Settings → Pages → Custom
   domain → enter `yourdomain.com` (or `wind.yourdomain.com`) → Save. Check
   "Enforce HTTPS" once the certificate provisions (can take up to ~24h).

DNS changes typically propagate within minutes to a few hours. From then on
the Action refreshes the forecast automatically at ~5am and ~5pm Pacific
with no further action from you.

### Adjusting the schedule

`.github/workflows/update-forecast.yml` runs on a fixed UTC cron, so it
drifts an hour in winter (PST vs PDT). If you want it exact year-round,
either accept the ~1hr drift or switch to `13:00`/`01:00 UTC` for the winter
months.

## App version

The footer shows which commit is actually live and when — e.g. "v3f9a21
deployed 2h ago" — separate from the forecast-freshness badge in the header
(that one tracks the *data*, this one tracks the *code*). Every push to
`main` that touches anything other than `data/` triggers
`.github/workflows/stamp-version.yml`, which writes the short commit SHA,
commit message, and a UTC timestamp to `data/version.json`. It's excluded
from re-triggering itself (and from the twice-daily forecast commits) via
`paths-ignore: data/**`. If the footer note is blank, that workflow either
hasn't run yet on this repo or is disabled — check the Actions tab.

## Editing the spot list

Open `assets/spots.js`. Each spot has coordinates, sports, a rideable
direction sector, and (if relevant) a `thermal` and/or `outflow` config with
the season/hour window/direction that pattern needs, plus a one-line
explanation shown to users. Add a spot by copying an existing entry; no
other file needs to change.

A spot can also define a `referenceStation` instead of (or alongside) its
own thermal/outflow config, for cases where a nearby exposed gauge point
predicts it better than local models do — e.g. Erwin Park (Point Roberts)
tends to turn on once Point Atkinson is reading above ~17kt. `generate.mjs`
and the live-refresh path both fetch the reference station once and pass its
speed into `classifyHour`; see `assets/rules.js`.

Set `pressureGradientAware: true` on a Howe Sound spot to factor in the MSLP
gradient check described above.

## Rider feedback & self-calibration

Hovering any hour cell on the site shows a **"Report actual conditions"**
link, prefilled with that spot, date/time, and what the tool forecasted. It
opens a structured GitHub issue
([`.github/ISSUE_TEMPLATE/wind-report.yml`](.github/ISSUE_TEMPLATE/wind-report.yml))
asking for the actual speed/direction and any notes on why it differed.

Every run, `.github/workflows/update-forecast.yml` first runs
`scripts/apply-feedback.mjs`, which:

1. Pulls all `wind-report`-labeled issues via the GitHub API.
2. Groups them by spot and computes `actual ÷ forecasted` for each report.
3. Averages the most recent 20 reports per spot (needs at least 2 before it
   adjusts anything, so one troll report or typo can't skew it), clamps the
   result to 0.75x–1.5x, and writes `data/calibration-overrides.json`.

`generate.mjs` reads that file and applies the multiplier for that spot on
top of everything else (Squamish calibration, MSLP, reference stations),
scaling both the displayed speed and the model votes used for probability.
The reasoning text says explicitly when a report-based adjustment is active.

This is a running bias correction, not a trained model — it has no memory of
what was forecasted for any specific past hour (the snapshot gets
overwritten twice daily), so it can't compute true forecast-error stats. It
can only say "actual wind at this spot has been averaging X% of what we
showed, across recent reports" and nudge accordingly. A more rigorous
version would archive each day's forecast.json (e.g. to a `history/` folder
or a proper database) so `apply-feedback.mjs` could match each report
against what was actually predicted for that exact hour, rather than
against whatever number the reporter copied down.

To recalibrate manually: `GITHUB_TOKEN=<a token with repo:read> node scripts/apply-feedback.mjs`
(a token isn't required for a public repo, just raises the API rate limit).

## Live verification

Every spot has a `liveStation` (see `assets/spots.js`) — a source of
genuinely *observed* wind, not a forecast. Two source types:

- **`type: "squamishwindsports"`** (Squamish Spit, Porteau Cove, Furry
  Creek): the JSON feed behind [Squamish Windsports Society's live wind
  chart](https://squamishwindsports.com/conditions/wind/)
  (`squamishwindsports.com/wind-data/getmet.php?wind_src=spit&...`), found
  by inspecting that page's network requests — no API key, reports in knots
  already, includes gust. This is a real instrument at the Spit itself, and
  per local rider feedback is far more representative of the corridor than
  Environment Canada's Squamish Airport station, which sits in a wind
  shadow and is no longer used for anything. Porteau Cove and Furry Creek
  don't have their own station, so they use the same Spit reading as an
  approximation — treat their badge as "nearest good corridor reading," not
  a reading at that exact spot.
- **`type: "ec"` (default)** (every other spot): the nearest Environment
  Canada station with a
  [Past 24 Hour Conditions](https://weather.gc.ca/past_conditions/index_e.html)
  page.

Each run, `generate.mjs`:

1. Fetches that station's most recent observation (speed + direction, and
   gust for the squamishwindsports source).
2. Compares it against what the model forecasted for that same current hour.
3. Shows the result as a small badge on that spot's card (green if they're
   within 20% of each other, red if not, with the reasoning on hover).
4. If they disagree by **20% or more**, writes a reasoned mismatch entry —
   using `explainMismatch()` in `assets/rules.js`, which draws only on
   signals the rule engine already computed (regime, model agreement, MSLP
   support) — to `data/live-verification-log.json`, capped at the 40 most
   recent entries per spot.

Squamish is also referenced on
[iKitesurf/Weatherflow](https://wx.ikitesurf.com/spot/1436) (linked in the
header), which several riders trust — but that data sits behind a paid
subscription. Automating it would mean storing your personal login/API
token as a GitHub secret and using your paid access on a public,
unattended schedule, which isn't something to do without a deliberate,
separate decision on your part (and I won't handle account credentials
directly either way — see the app's safety guardrails). It's linked as a
manual reference only; if you'd like to pursue an authenticated feed later,
iKitesurf/Weatherflow's developer docs are the place to check for an
official API and its terms.

`apply-feedback.mjs` reads that log on its *next* run (it runs before
`generate.mjs`, so the correction lands within one cycle — up to ~12 hours)
and pools it with rider reports for the same spot when computing the
calibration multiplier, exactly like a "Report actual conditions" issue
would. The `note` field in `data/calibration-overrides.json` shows how many
of each type went into a given spot's multiplier.

Same anti-overfitting rule as rider feedback: a spot needs at least
`MIN_SAMPLES` (2) combined data points before anything adjusts, and the
multiplier is clamped to 0.75x–1.5x, so a single bad reading (a gust,
a stale station, a parsing hiccup) can't swing the whole spot.

Limitations: station locations are the *nearest available* observation
point, not co-located with the spot itself (see each spot's `liveStation`
comment in `spots.js`) — treat the comparison as an approximation, most
trustworthy for the Squamish Spit itself (an on-site instrument) and
roughest for Erwin Park/Boundary Bay/White Rock (all sharing Sand Heads
Lightstation, several km away) and Porteau Cove/Furry Creek (sharing the
Spit meter, also several km away). It only checks the current hour once
per run (twice daily), not a continuous stream, so it can catch a
systematic bias but won't catch a mismatch that starts and ends between runs.

## Known limitations / good next steps

- Tide state (important at Boundary Bay and Iona) isn't factored in.
- The EC bulletin is shown as reference text, not yet parsed into the
  probability model — a good next step would be extracting its knot ranges
  for today/tonight and using them to directly anchor the Squamish estimate
  instead of (or blended with) the GFS-multiplier calibration.
- The Squamish calibration multiplier is a single rider's field-tuned
  average, not a regression against station data — treat it as a big
  improvement over raw model output, not gospel.
- The MSLP gradient thresholds (0.4hPa / 0.2hPa) are a reasonable starting
  guess, not fitted to anything — worth tightening once enough rider
  feedback accumulates to see which days it called right vs wrong.
- See "Rider feedback & self-calibration" above for the feedback loop's
  current limitation (no historical forecast archive to compare against).
  Live verification (see above) partially addresses this for the *current*
  hour only — it still can't check how a forecast made 3 days out held up.
- Live-station comparisons use the nearest EC station, not a station at the
  spot itself — see "Live verification" above for which spots share a
  station and how far it might be.

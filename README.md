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
  under-reads the Squamish/Porteau Cove thermal once it's actually inflowing.
  We scale it ~2.85x based on field notes from a 12-year local rider, Jack
  Rieder of [West Coast Wind Sports](https://www.westcoastwindsports.com/blogs/local-knowledge/forecasting-squamish-wind-with-jack-rieder):
  5-7kt modeled SW ≈ 15-20kt real, 7-9kt ≈ 20-25kt real, 9kt+ ≈ a strong day.
  Those field notes only covered 5-9kt modeled wind, so above a 32kt
  calibrated output the multiplier tapers off smoothly (an asymptotic curve,
  not a hard cutoff) instead of continuing to scale linearly — a 22kt coarse
  reading now lands around 38kt instead of an unvalidated 63kt. See
  `calibrateSquamishThermal()` in `assets/rules.js`.
- **Environment Canada marine bulletin**: per the same source, EC's Howe
  Sound text forecast is the single best starting resource for today's
  Squamish wind. `generate.mjs` fetches two zones — Howe Sound and the
  Strait of Georgia south of Nanaimo — server-side only (no CORS for a
  browser fetch); the page links both as "Official marine forecasts" near
  the bottom, alongside a link to the [live Squamish wind
  meter](https://squamishwindsports.com/conditions/wind/). The bulletin text
  itself is fetched and stored but deliberately not shown inline — the app is
  mobile-first and deliberately keeps technical/official-forecast language
  out of the UI; the link is there for anyone who wants the official word.
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
- **Solar loading**: `shortwave_radiation` from Open-Meteo replaces a flat
  cloud-cover-percent cutoff as the "is the sun actually driving the
  thermal" gate. Judged as a *ratio* against that hour's own clear-sky
  ceiling (`clearSkyRadiationWm2()` in `assets/rules.js`, a standard
  solar-elevation approximation) rather than one flat W/m² number — a flat
  cutoff quietly assumed it was always close to solar noon, so a genuinely
  clear evening session (naturally lower radiation simply because the sun is
  low, not because it's cloudy) used to get wrongly flagged as "not sunny."
  Falls back to the cloud-cover cutoff when a model doesn't provide
  radiation, and to "not sunny" once the sun is essentially down.
- **Wind direction averaging**: each model's direction is weighted by that
  same model's own wind speed (`circularMeanDeg()` in `assets/rules.js`)
  rather than averaged evenly — an unweighted average could invent a
  direction none of the models actually predicted (e.g. two near-calm
  readings from the north and two strong readings from the south averaging
  to due west, missing both real sectors).
- **Probability band**: sized relative to the *knot range the rider picked*,
  not the point estimate's own magnitude — a well-centered forecast now
  reliably clears "good odds" (≥65%) regardless of which preset is active,
  where the old center-relative sizing meant the flagship Squamish spot
  could never post a green percentage no matter how clean the thermal
  signal was. See `probabilityInRange()` in `assets/rules.js`.
- **Plain-language summary + offshore warning**: every hour also gets a
  short, jargon-free `summary` string (shown in the hour-cell tooltip) —
  what kind of wind, plus a caution if the direction looks offshore/
  unfavorable or if it's likely to be gusty — separate from the detailed
  `reason` field (model spread, MSLP numbers, calibration factors), which
  stays internal to respect the app's no-jargon mobile UI. An
  offshore/unfavorable-direction hour also gets a visible ⚠️ badge and is
  excluded from the headline "best option" pick unless a spot has no
  favorable-direction hour at all that day.
- **Upper-level (850hPa) wind**: fetched alongside the surface data. Strong
  SW flow aloft during a thermal hour can override/suppress the local sea
  breeze rather than reinforce it — flagged as a confidence-lowering caution.
  Independent of regime, strong upper wind riding over a decent surface wind
  is flagged as **GUSTY** in the UI (hour cells and best-bets list).
- **Pam Rocks live nowcast**: two independent uses of the live Pam Rocks buoy
  reading, both restricted to whichever hour matches "right now" since it's
  a live observation, not a forecast time series:
  1. For Squamish Spit and Porteau Cove (`pamRocksAware: true`), it's
     projected onto Howe Sound's ~200° SW inflow axis and used to support or
     caution the current hour's thermal confidence.
  2. For Porteau Cove specifically (`pamRocksTrigger`), a plain threshold +
     direction check — per local rider knowledge, Pam Rocks reading 12kt+
     from the South/SE meaningfully raises the odds Porteau is working (up
     toward 20kt) even on an hour the model's own signals came up empty.
     Mirrors the reference-station trigger pattern used for Erwin Park, just
     sourced from a live buoy + direction instead of a forecast station.
- **Rider feedback loop**: see "Rider feedback & self-calibration" below —
  actual on-the-water reports nudge each spot's calibration over time,
  separately per wind regime (a thermal-hour mismatch no longer nudges that
  spot's outflow calibration, and vice versa).
- **Live verification**: see "Live verification" below — each run checks
  the forecast against a real observation from the nearest Environment
  Canada station and self-corrects when they disagree.
- **Two ways the page gets data**:
  1. `data/forecast.json` — a snapshot committed twice a day by the GitHub
     Action below. Loads instantly, includes the EC bulletin, MSLP gradient,
     and feedback-learned calibration.
  2. **Refresh live** button — fetches straight from Open-Meteo in the
     visitor's browser and recomputes on the spot (including the Squamish
     speed calibration), but not the EC bulletin, MSLP gradient, Pam Rocks
     nowcast, or feedback calibration, since those either need a server-side
     fetch (no CORS) or read a file the browser doesn't otherwise load. Shown
     with an honest yellow "Live (partial) — just fetched" badge rather than
     the green "fresh" one the regular snapshot gets, since this path is more
     *recent* but less *complete*. Also the automatic fallback if
     `data/forecast.json` doesn't exist yet.

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
the Action refreshes the forecast automatically at ~5am, ~1pm and ~5pm
Pacific with no further action from you.

### Adjusting the schedule

`.github/workflows/update-forecast.yml` runs on a fixed UTC cron, so it
drifts an hour in winter (PST vs PDT). If you want it exact year-round,
either accept the ~1hr drift or switch to `13:00`/`20:00`/`01:00 UTC` for the
winter months. The midday run was added specifically so the live-
verification loop (see below) has at least one comparison a day from
somewhere near peak thermal hours, not just the two calmest hours of the
day.

If a run fails to fetch most spots (Open-Meteo rate-limiting, an outage,
etc.), `generate.mjs` aborts without publishing anything rather than
overwriting `data/forecast.json` with a partial snapshot — the last good
snapshot stays live, and the failed Action run itself is a signal (GitHub
emails the repo owner by default on a failed scheduled workflow).

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

1. Pulls **open** `wind-report`-labeled issues via the GitHub API (closing an
   issue now retires it from calibration — previously `state=all` meant
   closing a bogus report did nothing), rejecting any report whose
   forecasted/actual values fall outside a loose sanity range (catches
   typos like "actual: 300kt" automatically), and pools in
   `data/live-verification-log.json`'s entries too (see "Live verification"
   below — every qualifying comparison is logged there now, not just
   mismatches).
2. Groups them by spot and computes `actual ÷ forecasted` for each report —
   both into a spot-wide **general** bucket (rider reports and live-station
   entries alike), and, for live-station entries specifically (they carry a
   `regime` tag from the forecast hour they were checked against), into a
   **regime-specific** bucket (`thermal` / `outflow` / `synoptic` / ...) for
   that spot. Rider reports don't record which regime was in effect, so they
   only ever feed the general bucket.
3. Averages the most recent 20 data points per bucket with a **weighted
   geometric mean** (needs at least 2 points before it adjusts anything, so
   one troll report or typo can't skew it) — geometric rather than
   arithmetic so two equal-and-opposite misses cancel out to "no adjustment
   needed" instead of biasing upward, and weighted so a rider's own
   eyes-on-the-water report (3x) isn't drowned out by the now much more
   frequent automated station checks (1x each, since the live-verification
   loop logs every comparison, not just mismatches) within the 20-point
   recency window. Clamps the result to 0.75x–1.5x, and writes
   `data/calibration-overrides.json` as `{ spot: { general: {...}, thermal:
   {...}, ... } }`.

`generate.mjs` reads that file and, once it knows which regime an hour
classified as, resolves that regime's bucket for the spot — falling back to
`general` if there's no regime-specific data yet — and applies its
multiplier on top of everything else (Squamish calibration, MSLP, reference
stations, Pam Rocks nowcast), scaling both the displayed speed and the model
votes used for probability. A thermal-hour mismatch no longer nudges that
spot's outflow calibration, and vice versa. The reasoning text says
explicitly when a report-based adjustment is active.

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
genuinely *observed* wind, not a forecast. Three source types:

- **`type: "squamishwindsports"`** (Squamish Spit): the JSON
  feed behind [Squamish Windsports Society's live wind
  chart](https://squamishwindsports.com/conditions/wind/)
  (`squamishwindsports.com/wind-data/getmet.php?wind_src=spit&...`), found
  by inspecting that page's network requests — no API key, reports in knots
  already, includes gust. This is a real instrument at the Spit itself, and
  per local rider feedback is far more representative of the corridor than
  Environment Canada's Squamish Airport station, which sits in a wind
  shadow and is no longer used for anything.
- **`type: "igetwind"`** (Porteau Cove, Boundary Bay, White Rock, Erwin
  Park): [igetwind.com](https://igetwind.com/)'s station-finder API
  (`igetwind.com/api/lw/stations/{lat}/{lon}/{radiusKm}/0`), also found by
  inspecting network requests — public, no key needed, aggregates METAR
  airports, marine buoys, and citizen weather stations. We pin a *specific*
  known-good `sid` per spot rather than auto-picking "nearest" every run
  (a lot of what it returns is unstaffed citizen hardware not worth
  trusting unattended):
  - Porteau Cove → **Pam Rocks** (`CWAS`), a Coast Guard station right at
    the Howe Sound entrance — a better read on Porteau's more open exposure
    than the Spit meter would be, even though it's ~10km away.
  - Boundary Bay / White Rock / Erwin Park → **White Rock, BC** (`CWWK`),
    the official METAR station, a few km closer to this cluster than the
    Sand Heads Lightstation used previously.
  - Speeds arrive in m/s and get converted to knots (`×1.943844`). The
    observation time was previously passed through as raw UTC and displayed
    as if it were Pacific local — off by 7-8 hours whenever it was actually
    shown; now converted properly.
- **`type: "ec"` (default)** (Jericho, Spanish Banks, Iona): the nearest
  Environment Canada station with a
  [Past 24 Hour Conditions](https://weather.gc.ca/past_conditions/index_e.html)
  page.

Each run, `generate.mjs`:

1. Fetches that station's most recent observation (speed + direction, and
   gust for the squamishwindsports/igetwind sources). Applied uniformly
   across all three source types: observations older than 3 hours are
   discarded as stale rather than treated as "live" (previously only the
   igetwind source checked this — a frozen EC or Squamish Windsports sensor
   could otherwise read as live indefinitely).
2. Compares it against what the model forecasted for that same current hour
   — but only once the forecast itself is at least **8kt** (was 2kt).
   Below that, every comparison was effectively a near-calm-hour reading
   from one of the day's two (now three) snapshot times, which is mostly
   noise (a 1kt miss on a 2kt forecast reads as "50% error") and was
   quietly teaching the calibration loop the wrong lesson.
3. Shows the result as a small badge on that spot's card (green if they're
   within 20% of each other, red if not, with the reasoning on hover), with
   staleness-aware wording — "right now" only when the observation is
   recent, "as of HH:MM" once it's more than 90 minutes old.
4. Logs **every** qualifying comparison (not just 20%+ mismatches) to
   `data/live-verification-log.json`, capped at the 40 most recent entries
   per spot — mismatches also get a reasoned explanation via
   `explainMismatch()` in `assets/rules.js`. Previously only mismatches were
   logged, which meant the calibration multiplier could never converge back
   toward 1.0 even once a spot's forecast was accurate again: every data
   point that ever made it into the log was, by definition, a bad one.

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
trustworthy for the Squamish Spit and Porteau Cove (both on-site or
near-on-site instruments) and roughest for Erwin Park (~23km from the White
Rock METAR it shares with Boundary Bay/White Rock). igetwind's citizen-station data also isn't independently
audited — we only pin two specific `sid`s from it (Pam Rocks, White Rock
METAR), both official government stations, not the amateur ones it also
returns. It only checks the current hour once
per run (twice daily), not a continuous stream, so it can catch a
systematic bias but won't catch a mismatch that starts and ends between runs.

## Known limitations / good next steps

- Tide state (important at Boundary Bay and Iona) isn't factored in.
- The EC bulletin is shown as a link, not yet parsed into the probability
  model — a good next step would be extracting its knot ranges for
  today/tonight and using them to directly anchor the Squamish estimate
  instead of (or blended with) the GFS-multiplier calibration. Its
  end-of-section HTML parsing boundary was hardened this session but hasn't
  been independently re-verified against a live fetch of the actual EC page
  (this ran in a sandbox that blocks outbound requests to weather.gc.ca) —
  worth a manual check after deploying.
- The base Squamish 2.85x multiplier (now capped/tapered above 32kt, see
  above) is still a single rider's field-tuned average, not a regression
  against station data — the regime-aware feedback override (see "Rider
  feedback & self-calibration") corrects it over time as
  live-verification/rider data accumulates, but needs more samples per
  regime before it meaningfully moves the number. Treat the base multiplier
  as a big improvement over raw model output, not gospel.
- The Pam Rocks nowcast and 850hPa suppression/GUSTY thresholds (6kt inflow
  component, 20kt suppression, 25kt gusty), the solar sunny-ratio cutoff
  (45% of clear-sky), and the probability-band sigma constants are all
  reasonable starting guesses, same caveat as the MSLP thresholds below —
  not fitted to anything yet, worth tightening once enough rider feedback
  accumulates to see which days/hours it called right vs wrong.
- The MSLP gradient thresholds (0.4hPa / 0.2hPa) are a reasonable starting
  guess, not fitted to anything — worth tightening once enough rider
  feedback accumulates to see which days it called right vs wrong.
- See "Rider feedback & self-calibration" above for the feedback loop's
  current limitation (no historical forecast archive to compare against).
  Live verification (see above) partially addresses this for the *current*
  hour only — it still can't check how a forecast made 3 days out held up.
- Live-station comparisons use the nearest EC/igetwind station, not a
  station at the spot itself — see "Live verification" above for which
  spots share a station and how far it might be. Boundary Bay, White Rock
  and Erwin Park all currently share the same White Rock METAR station
  (up to ~23km away) — one bad or unusual reading there skews all three
  spots' live checks at once. Splitting or weighting that shared station is
  a good next step.
- A trigger-fired hour (reference-station or Pam Rocks threshold) shows a
  fixed floor value, not a real per-hour model estimate — `probabilityInRange`
  now uses a wider base sigma for these hours so they don't read as more
  certain than they are, but the displayed speed itself is still just the
  trigger's threshold/floor number, not a genuine forecast magnitude.
- Gust is estimated as speed × 1.3 for calibrated-thermal and trigger-fired
  hours specifically (where there's no trustworthy per-hour model gust value
  to lean on); every other regime uses the models' own gust forecast
  directly.
- `forecast.json` includes all 24 hours/day even though the UI only ever
  displays 06:00-20:00 — trimming the unused hours (and any other
  browser-unused fields) before writing would meaningfully shrink both the
  payload and the git history growth rate. Not done this session to keep
  the change surface focused on forecast-accuracy fixes.
- No automated CI check that the committed `data/forecast.json` snapshot's
  spot list matches `assets/spots.js` (would have caught the removed
  `furry-creek` spot lingering in an old snapshot) or that speeds/hour
  counts are in a sane range.
- The Leaflet CDN `<script>`/`<link>` tags don't have Subresource Integrity
  hashes — this session didn't have a way to fetch the exact CDN bytes to
  compute a trustworthy hash (and a wrong hash silently breaks the map for
  every visitor, worse than no hash at all), so this needs a manual step:
  generate the hashes at [srihash.org](https://www.srihash.org/) for
  `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css` and
  `.../leaflet.min.js`, then add `integrity="..." crossorigin="anonymous"`
  to both tags in `index.html`.
- Rider-report parsing in `apply-feedback.mjs` is coupled to the exact field
  label text in `wind-report.yml` (`extractField(body, "Forecasted speed
  (kt)")` etc.) — renaming a form label without updating the parser would
  silently stop new reports from being read.
- `confidence` is computed per-hour but not shown anywhere in the UI — a
  70% that's backed by four agreeing models currently looks identical to a
  70% that's internally flagged as low-confidence (no pressure support,
  upper-level suppression, etc).
- Outflow classification doesn't yet factor in season or pressure strength —
  a light summer morning northerly gets the same "can be strong and gusty"
  language as a genuine winter outflow event.
- No "now" marker or dimming of past hours in the hour-by-hour strip.

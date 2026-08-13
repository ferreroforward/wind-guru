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
- **Two ways the page gets data**:
  1. `data/forecast.json` — a snapshot committed twice a day by the GitHub
     Action below. Loads instantly.
  2. **Refresh live** button — fetches straight from Open-Meteo in the
     visitor's browser and recomputes on the spot. Also the automatic
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

## Editing the spot list

Open `assets/spots.js`. Each spot has coordinates, sports, a rideable
direction sector, and (if relevant) a `thermal` and/or `outflow` config with
the season/hour window/direction that pattern needs, plus a one-line
explanation shown to users. Add a spot by copying an existing entry; no
other file needs to change.

## Known limitations / good next steps

- No explicit synoptic pressure-map read — the "synoptic" classification is
  inferred from multi-model agreement + speed, not a real frontal analysis.
  A next step would be pulling `pressure_msl` at a second inland reference
  point (e.g. Pemberton) to compute an actual gradient.
- Marine warnings / small-craft warnings from Environment Canada
  (weather.gc.ca marine forecasts for the Strait of Georgia and Howe Sound)
  aren't pulled in yet — worth adding as a text banner in `generate.mjs`.
- Tide state (important at Boundary Bay, Iona, Gabriola Pass) isn't
  factored in.

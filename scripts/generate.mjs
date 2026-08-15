#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS, PRESSURE_REFERENCE, degToLabel } from "../assets/spots.js";
import { buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth, rowsToPressureMap, rowsToSpeedMap, currentPacificHourString, explainMismatch } from "../assets/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "forecast.json");
const OVERRIDES_PATH = path.join(__dirname, "..", "data", "calibration-overrides.json");
const LIVE_LOG_PATH = path.join(__dirname, "..", "data", "live-verification-log.json");
const FORECAST_DAYS = 4; // "today" + 3 days ahead
const LIVE_ERROR_THRESHOLD = 0.20; // 20% — per spec: flag + log any bigger gap than this
const LIVE_LOG_MAX_PER_SPOT = 40; // cap so the log file doesn't grow forever
const LIVE_MIN_FORECAST_KT = 2; // skip the % comparison when forecast is near-zero (division blows up)

// Same station Porteau Cove uses as its own live-check (see spots.js) —
// reused here as a same-day nowcast input for any spot with pamRocksAware
// and/or pamRocksTrigger set. Defined once so getLiveObservation's cache key
// matches Porteau's own fetch and we never hit igetwind twice for it.
const PAM_ROCKS_STATION = { type: "igetwind", sid: "CWAS", lat: 49.48, lon: -123.30, name: "Pam Rocks (Howe Sound entrance)" };

// Rider-feedback overrides, if scripts/apply-feedback.mjs has produced any
// (it runs first in the Action — see .github/workflows/update-forecast.yml).
// Missing file just means no feedback yet; that's fine.
async function loadOverrides() {
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.spots || {};
  } catch {
    return {};
  }
}

// Rider-feedback overrides file may or may not exist yet on a fresh clone —
// harmless if missing, same as loadOverrides above.
async function loadLiveLog() {
  try {
    const raw = await readFile(LIVE_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

// Environment Canada's "Past 24 Hour Conditions" page — genuinely observed
// (not forecast) hourly station data: weather.gc.ca/past_conditions. Table
// columns are Date/Time, Conditions, Temperature, Wind, Humidex, Relative
// humidity, Dew point, Pressure, Visibility. We parse actual <tr>/<td> cells
// rather than scraping flattened text, since date-separator rows only have
// one populated cell and would otherwise be easy to misread as data.
function parseEcObservedWind(html) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();

  const rows = [];
  let rm;
  while ((rm = rowRe.exec(html))) {
    const cells = [];
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[1]));
    // Data rows start with an "HH:MM" cell; date-separator rows ("13 August
    // 2026") and the header row don't match this and are skipped.
    if (cells.length >= 4 && /^\d{2}:\d{2}$/.test(cells[0])) rows.push(cells);
  }
  if (!rows.length) return null;

  const latest = rows[0]; // rows are most-recent-first
  const time = latest[0];
  const windRaw = latest[3];
  let speedKmh, directionLabel, directionAbbr = null;
  if (/^calm$/i.test(windRaw)) {
    speedKmh = 0;
    directionLabel = "calm";
  } else {
    const m = windRaw.match(/^([A-Z]+)\s*\(([^)]+)\)\s*([\d.]+)/);
    if (!m) return null;
    directionAbbr = m[1];
    directionLabel = m[2];
    speedKmh = parseFloat(m[3]);
  }
  return {
    time, // "HH:MM" Pacific, no date attached
    speedKt: Math.round(speedKmh * 0.539957 * 10) / 10,
    gustKt: null, // this table doesn't report gust
    directionAbbr,
    directionLabel,
  };
}

async function fetchEcObservation(station) {
  const url = `https://weather.gc.ca/past_conditions/index_e.html?station=${station.code}`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const html = await res.text();
  return parseEcObservedWind(html);
}

// Squamish Windsports Society's own wind meter at the Spit
// (squamishwindsports.com/conditions/wind) — the JSON endpoint behind that
// page's live chart, found by inspecting its network requests. Reports in
// knots already. Per local rider feedback, this is a far better read on the
// Squamish corridor than Environment Canada's Squamish Airport station,
// which sits in a wind shadow — see spot.liveStation comments in spots.js.
async function fetchSquamishWindsportsObservation(station) {
  const dateStr = currentPacificHourString().slice(0, 10);
  const url = `https://squamishwindsports.com/wind-data/getmet.php?wind_src=${station.windSrc}&reqdate=${dateStr}&reqtime=0`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  if (!Array.isArray(json.ws) || !json.ws.length) return null;
  const i = json.ws.length - 1; // readings are chronological; last = most recent
  const speedKt = parseFloat(json.ws[i]);
  if (!isFinite(speedKt)) return null;
  const gustKt = json.wg ? parseFloat(json.wg[i]) : NaN;
  const dirDeg = json.wd ? parseFloat(json.wd[i]) : NaN;
  const dtMs = json.dt ? parseFloat(json.dt[i]) * 1000 : null;
  return {
    time: dtMs ? new Date(dtMs).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null,
    speedKt,
    gustKt: isFinite(gustKt) ? gustKt : null,
    directionAbbr: null,
    directionLabel: isFinite(dirDeg) ? degToLabel(dirDeg) : null,
  };
}

// igetwind.com's station-finder API (found by inspecting network requests on
// igetwind.com — public, no auth/key needed): given a center point and a
// radius in km, returns every nearby station it aggregates (METAR airports,
// marine buoys, and citizen APRSWXNET/MesoWest stations) with recent
// observations. We use it to pin a *specific known-good* station by its
// `sid` — not to auto-pick "nearest" every run, since a lot of what it
// returns is unstaffed/uncalibrated citizen hardware not worth trusting
// unattended. `station.lat`/`station.lon` here are the STATION's own
// coordinates (not the spot's), so the query reliably finds it regardless
// of which spot references it, and the result is cached once per station.
const MAX_IGETWIND_OBS_AGE_MIN = 180; // ignore anything older than 3h — stale reading, not "live"
async function fetchIgetwindObservation(station) {
  const url = `https://igetwind.com/api/lw/stations/${station.lat}/${station.lon}/${station.radiusKm ?? 10}/0`;
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`[live:${station.name}] fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  const match = (json.stations || []).find((s) => s.sid === station.sid);
  if (!match || !Array.isArray(match.observations)) return null;

  const windObs = match.observations
    .filter((o) => o.type === "W" && o.val != null)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  if (!windObs) return null;
  const ageMin = (Date.now() - new Date(windObs.at.replace(" ", "T") + "Z").getTime()) / 60000; // "at" is "YYYY-MM-DD HH:MM:SS" UTC, unmarked
  if (!isFinite(ageMin) || ageMin > MAX_IGETWIND_OBS_AGE_MIN) return null;

  const speedMs = parseFloat(windObs.val);
  if (!isFinite(speedMs)) return null;
  const gustObs = match.observations.find((o) => o.type === "WG");
  const dirObs = match.observations.find((o) => o.type === "WD");
  const gustMs = gustObs ? parseFloat(gustObs.val) : NaN;
  const dirDeg = dirObs ? parseFloat(dirObs.val) : NaN;

  return {
    time: windObs.at,
    speedKt: Math.round(speedMs * 1.943844 * 10) / 10,
    gustKt: isFinite(gustMs) ? Math.round(gustMs * 1.943844 * 10) / 10 : null,
    directionAbbr: null,
    directionDeg: isFinite(dirDeg) ? dirDeg : null,
    directionLabel: isFinite(dirDeg) ? degToLabel(dirDeg) : null,
  };
}

const liveObsCache = {};
async function getLiveObservation(station) {
  const cacheKey = `${station.type || "ec"}:${station.code || station.windSrc || station.sid}`;
  if (liveObsCache[cacheKey]) return liveObsCache[cacheKey];
  try {
    const parsed = station.type === "squamishwindsports" ? await fetchSquamishWindsportsObservation(station)
      : station.type === "igetwind" ? await fetchIgetwindObservation(station)
      : await fetchEcObservation(station);
    liveObsCache[cacheKey] = parsed;
    return parsed;
  } catch (err) {
    console.log(`[live:${station.name}] fetch error: ${err.message}`);
    return null;
  }
}

async function fetchSpot(spot) {
  const url = buildForecastUrl(spot.lat, spot.lon, FORECAST_DAYS);
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) {
    console.error(`[${spot.id}] fetch failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const json = await res.json();
  return reshapeOpenMeteo(json);
}

// Environment Canada's marine text bulletin — per a 12-year local rider
// (see README), this is the single best starting resource for Squamish
// wind, more trustworthy for today's magnitude than any raw model output.
// We can't fetch it client-side (no CORS), so it only shows up in the
// twice-daily snapshot, not the live-refresh fallback.
const MARINE_ZONES = [
  { id: "howe_sound", label: "Howe Sound", siteID: "06400" },
  { id: "strait_of_georgia_south", label: "Strait of Georgia (south of Nanaimo)", siteID: "14305" },
];

async function fetchMarineBulletin(zone) {
  const url = `https://weather.gc.ca/marine/forecast_e.html?mapID=02&siteID=${zone.siteID}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    // Anchor on the ">Marine Forecast<" heading tag specifically (not the
    // "Marine Forecasts" breadcrumb link earlier in the page, which
    // `indexOf("Marine Forecast")` alone would match first and pull in a
    // pile of nav/alert-banner text ahead of the actual bulletin), and stop
    // at the next "Winds" heading.
    const headingIdx = html.indexOf(">Marine Forecast<");
    const endIdx = headingIdx >= 0 ? html.indexOf(">Winds<", headingIdx) : -1;
    const section = headingIdx >= 0
      ? html.slice(headingIdx, endIdx > headingIdx ? endIdx : headingIdx + 3000)
      : html.split("Extended Forecast")[0];
    const text = section
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^\s*Marine Forecast\s*/, "")
      .trim()
      .slice(0, 900);
    const warning = /strong wind warning|gale warning|storm warning|small craft warning/i.test(html);
    return { id: zone.id, label: zone.label, url, text, warning };
  } catch (err) {
    console.error(`[${zone.id}] marine bulletin fetch failed: ${err.message}`);
    return null;
  }
}

// Reference-station data (e.g. Point Atkinson for Erwin Park, and the
// pressure-gradient trio for Howe Sound spots) — fetched once per unique
// coordinate and reused across any spot/feature pointing at it.
const stationRowsCache = {};
async function getStationRows(station) {
  const key = `${station.lat},${station.lon}`;
  if (stationRowsCache[key]) return stationRowsCache[key];
  process.stdout.write(`Fetching reference station ${station.name}... `);
  const url = buildForecastUrl(station.lat, station.lon, FORECAST_DAYS);
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  const rows = reshapeOpenMeteo(json);
  console.log("done");
  stationRowsCache[key] = rows;
  return rows;
}
async function getReferenceSpeeds(station) {
  const rows = await getStationRows(station);
  return rows ? rowsToSpeedMap(rows) : null;
}

// Pressure-gradient maps (large-scale coast-vs-interior, and Howe Sound
// mouth for the local check), fetched once and shared by every Howe Sound
// spot with pressureGradientAware: true. See rules.js for the interpretation.
let gradientStations = null;
async function getGradientStations() {
  if (gradientStations) return gradientStations;
  const [interiorRows, coastalRows, mouthRows] = await Promise.all([
    getStationRows(PRESSURE_REFERENCE.interior),
    getStationRows(PRESSURE_REFERENCE.coastal),
    getStationRows(PRESSURE_REFERENCE.howeSoundMouth),
  ]);
  gradientStations = {
    interior: interiorRows ? rowsToPressureMap(interiorRows) : {},
    coastal: coastalRows ? rowsToPressureMap(coastalRows) : {},
    mouth: mouthRows ? rowsToPressureMap(mouthRows) : {},
  };
  return gradientStations;
}

async function main() {
  const startedAt = new Date();
  const spotsOut = [];
  const liveVerifications = []; // new mismatches (>=20% error) found this run, appended to the persisted log below

  const overrides = await loadOverrides();
  if (Object.keys(overrides).length) {
    console.log(`Loaded calibration overrides for: ${Object.keys(overrides).join(", ")}`);
  }

  const nowHourStr = currentPacificHourString(startedAt);

  // Fetched once, shared by every spot that uses it (pamRocksAware and/or
  // pamRocksTrigger — see rules.js) — a live nowcast only ever applies to
  // whichever hour is "right now," so there's no point fetching it per spot.
  let pamRocksObs = null;
  if (SPOTS.some((s) => s.pamRocksAware || s.pamRocksTrigger)) {
    try {
      pamRocksObs = await getLiveObservation(PAM_ROCKS_STATION);
    } catch (err) {
      console.log(`[live:Pam Rocks] fetch failed: ${err.message}`);
    }
  }

  console.log("Fetching Environment Canada marine bulletins...");
  const bulletins = {};
  for (const zone of MARINE_ZONES) {
    const b = await fetchMarineBulletin(zone);
    if (b) bulletins[b.id] = b;
  }

  for (const spot of SPOTS) {
    process.stdout.write(`Fetching ${spot.name}... `);
    let rows;
    try {
      rows = await fetchSpot(spot);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      continue;
    }
    if (!rows) { console.log("skipped"); continue; }
    console.log(`${rows.length} hours`);

    let refMap = null;
    if (spot.referenceStation) {
      try {
        refMap = await getReferenceSpeeds(spot.referenceStation);
      } catch (err) {
        console.log(`[${spot.id}] reference station fetch failed: ${err.message}`);
      }
    }

    let gm = null;
    if (spot.pressureGradientAware) {
      try {
        gm = await getGradientStations();
      } catch (err) {
        console.log(`[${spot.id}] pressure gradient fetch failed: ${err.message}`);
      }
    }

    const hours = rows.map((row) => {
      const { hour, month } = localHourAndMonth(row.time);
      const refSpeedKt = refMap ? refMap[row.time] : null;

      let pressureGradients = null;
      if (gm) {
        const coastalP = gm.coastal[row.time], interiorP = gm.interior[row.time], mouthP = gm.mouth[row.time];
        const ownVals = Object.values(row.pressure).filter(v => v != null);
        const ownP = ownVals.length ? ownVals.reduce((a, b) => a + b, 0) / ownVals.length : null;
        pressureGradients = {
          largeScale: (coastalP != null && interiorP != null) ? coastalP - interiorP : null,
          local: (mouthP != null && ownP != null) ? mouthP - ownP : null,
        };
      }

      const overrideRecord = overrides[spot.id] || null;

      // Only ever attached to the row matching "right now" — it's a live
      // buoy reading, not a forecast time series (see rules.js).
      const pamRocksNow = ((spot.pamRocksAware || spot.pamRocksTrigger) && pamRocksObs && row.time === nowHourStr)
        ? { speedKt: pamRocksObs.speedKt, directionDeg: pamRocksObs.directionDeg }
        : null;

      return classifyHour(spot, row, hour, month, refSpeedKt, pressureGradients, overrideRecord, pamRocksNow);
    });

    // Live verification: compare the forecast for THIS hour against what
    // the nearest EC station is actually observing right now. If they
    // disagree by 20%+, log a reasoned mismatch — apply-feedback.mjs picks
    // this log up on the next run and pools it with rider reports when
    // computing that spot's calibration multiplier. See README.
    let liveCheck = null;
    if (spot.liveStation) {
      try {
        const obs = await getLiveObservation(spot.liveStation);
        const forecastHour = hours.find((h) => h.time === nowHourStr);
        if (obs && forecastHour && forecastHour.speed_kt != null && forecastHour.speed_kt >= LIVE_MIN_FORECAST_KT) {
          const errorPct = (obs.speedKt - forecastHour.speed_kt) / forecastHour.speed_kt;
          const mismatch = Math.abs(errorPct) >= LIVE_ERROR_THRESHOLD;
          liveCheck = {
            checked_hour: nowHourStr,
            station: spot.liveStation.name,
            observed_local_time: obs.time,
            forecasted_kt: forecastHour.speed_kt,
            live_kt: obs.speedKt,
            live_gust_kt: obs.gustKt ?? null,
            live_direction: obs.directionLabel,
            error_pct: Math.round(errorPct * 100),
            mismatch,
            regime: forecastHour.regime,
          };
          if (mismatch) {
            liveCheck.reasoning = explainMismatch(forecastHour, errorPct);
            console.log(`  [live:${spot.id}] MISMATCH — forecast ${forecastHour.speed_kt}kt vs live ${obs.speedKt}kt (${liveCheck.error_pct > 0 ? "+" : ""}${liveCheck.error_pct}%)`);
            liveVerifications.push({
              spot: spot.id,
              time: nowHourStr,
              forecasted: forecastHour.speed_kt,
              actual: obs.speedKt,
              ratio: obs.speedKt / forecastHour.speed_kt,
              source: "live-station",
              station: spot.liveStation.name,
              regime: forecastHour.regime,
              reasoning: liveCheck.reasoning,
              checked_at: startedAt.toISOString(),
            });
          }
        }
      } catch (err) {
        console.log(`[${spot.id}] live verification failed: ${err.message}`);
      }
    }

    spotsOut.push({
      id: spot.id,
      name: spot.name,
      region: spot.region,
      lat: spot.lat,
      lon: spot.lon,
      sports: spot.sports,
      level: spot.level,
      hours,
      live_check: liveCheck,
    });

    // Be polite to the free API.
    await new Promise((r) => setTimeout(r, 300));
  }

  // Merge this run's new mismatches into the persisted live-verification
  // log, capped per spot so it doesn't grow forever. apply-feedback.mjs
  // reads this file on the NEXT run (it runs before generate.mjs in the
  // Action) and pools it with rider reports — see README "Live verification".
  if (liveVerifications.length) {
    console.log(`\n${liveVerifications.length} live mismatch(es) this run.`);
  }
  const existingLog = await loadLiveLog();
  const bySpotLog = {};
  for (const e of [...existingLog, ...liveVerifications]) (bySpotLog[e.spot] ||= []).push(e);
  const cappedEntries = [];
  for (const list of Object.values(bySpotLog)) {
    const dedup = new Map();
    for (const e of list) dedup.set(e.time, e); // same hour re-checked twice in a day: keep the latest
    const sorted = [...dedup.values()].sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
    cappedEntries.push(...sorted.slice(0, LIVE_LOG_MAX_PER_SPOT));
  }
  await mkdir(path.dirname(LIVE_LOG_PATH), { recursive: true });
  await writeFile(LIVE_LOG_PATH, JSON.stringify({ updated_at: startedAt.toISOString(), entries: cappedEntries }, null, 2));

  const forecast = {
    generated_at: startedAt.toISOString(),
    generated_at_label: startedAt.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }),
    models_used: ["GFS (NOAA)", "ECMWF IFS", "ICON (DWD)", "GEM / HRDPS (ECCC)"],
    marine_bulletins: bulletins,
    calibration_overrides: overrides,
    live_verification_count: cappedEntries.length,
    spots: spotsOut,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(forecast, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

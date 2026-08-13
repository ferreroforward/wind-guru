#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS, PRESSURE_REFERENCE } from "../assets/spots.js";
import { buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth, rowsToPressureMap, rowsToSpeedMap } from "../assets/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "forecast.json");
const OVERRIDES_PATH = path.join(__dirname, "..", "data", "calibration-overrides.json");
const FORECAST_DAYS = 4; // "today" + 3 days ahead

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

  const overrides = await loadOverrides();
  if (Object.keys(overrides).length) {
    console.log(`Loaded calibration overrides for: ${Object.keys(overrides).join(", ")}`);
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

      const overrideMultiplier = overrides[spot.id] ? overrides[spot.id].multiplier : null;

      return classifyHour(spot, row, hour, month, refSpeedKt, pressureGradients, overrideMultiplier);
    });

    spotsOut.push({
      id: spot.id,
      name: spot.name,
      region: spot.region,
      lat: spot.lat,
      lon: spot.lon,
      sports: spot.sports,
      level: spot.level,
      hours,
    });

    // Be polite to the free API.
    await new Promise((r) => setTimeout(r, 300));
  }

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

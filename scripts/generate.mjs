#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS } from "../assets/spots.js";
import { buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth, referenceStationSpeeds } from "../assets/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "forecast.json");
const FORECAST_DAYS = 4; // "today" + 3 days ahead

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
    const section = html.split("Extended Forecast")[0];
    const marineIdx = section.indexOf("Marine Forecast");
    const raw = marineIdx >= 0 ? section.slice(marineIdx) : section;
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .replace(/Marine Forecast/, "")
      .trim()
      .slice(0, 900);
    const warning = /strong wind warning|gale warning|storm warning|small craft warning/i.test(html);
    return { id: zone.id, label: zone.label, url, text, warning };
  } catch (err) {
    console.error(`[${zone.id}] marine bulletin fetch failed: ${err.message}`);
    return null;
  }
}

// Reference-station data (e.g. Point Atkinson for Erwin Park) — fetched once
// per unique station and reused across any spot pointing at it.
const referenceCache = {};
async function getReferenceSpeeds(station) {
  const key = `${station.lat},${station.lon}`;
  if (referenceCache[key]) return referenceCache[key];
  process.stdout.write(`Fetching reference station ${station.name}... `);
  const url = buildForecastUrl(station.lat, station.lon, FORECAST_DAYS);
  const res = await fetch(url, { headers: { "User-Agent": "wind-guru-agent/1.0" } });
  if (!res.ok) { console.log(`fetch failed: ${res.status}`); return null; }
  const json = await res.json();
  const map = referenceStationSpeeds(json);
  console.log("done");
  referenceCache[key] = map;
  return map;
}

async function main() {
  const startedAt = new Date();
  const spotsOut = [];

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

    const hours = rows.map((row) => {
      const { hour, month } = localHourAndMonth(row.time);
      const refSpeedKt = refMap ? refMap[row.time] : null;
      return classifyHour(spot, row, hour, month, refSpeedKt);
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

#!/usr/bin/env node
// Wind Guru — forecast snapshot generator.
// Fetches multi-model wind data for every spot, runs the rule engine, and
// writes data/forecast.json. Run twice a day by .github/workflows/update-forecast.yml,
// or manually: `node scripts/generate.mjs`.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SPOTS } from "../assets/spots.js";
import { buildForecastUrl, reshapeOpenMeteo, classifyHour, localHourAndMonth } from "../assets/rules.js";

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

async function main() {
  const startedAt = new Date();
  const spotsOut = [];

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

    const hours = rows.map((row) => {
      const { hour, month } = localHourAndMonth(row.time);
      return classifyHour(spot, row, hour, month);
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

// Wind Guru — meteorologist rule engine.
// Turns raw multi-model wind data into a per-hour regime classification,
// a plain-English reason, and a probability of the wind landing in a
// user-chosen knot range.
//
// Works in both Node (generate.mjs) and the browser (index.html), no
// dependencies — import as an ES module in both places.

import { inSector, degToLabel } from "./spots.js";

// Models requested from Open-Meteo. "seamless" variants blend each
// provider's own global+regional+high-res nest automatically.
// gem_seamless folds in Environment Canada's HRDPS West nest (~2.5km)
// over BC, which is the one most likely to resolve local thermal/outflow
// effects that coarser global models miss.
export const MODELS = [
  { key: "gfs", param: "gfs_seamless", label: "GFS (NOAA)", resolution: "coarse" },
  { key: "ecmwf", param: "ecmwf_ifs025", label: "ECMWF", resolution: "coarse" },
  { key: "icon", param: "icon_seamless", label: "ICON (DWD)", resolution: "medium" },
  { key: "gem", param: "gem_seamless", label: "GEM / HRDPS (ECCC)", resolution: "fine" },
];

export function buildForecastUrl(lat, lon, days = 4) {
  const models = MODELS.map(m => m.param).join(",");
  // wind_speed_850hPa / wind_direction_850hPa: upper-level (~1500m) wind —
  // used to catch synoptic SW flow strong enough to suppress the surface
  // thermal, and to flag gusty conditions (see classifyHour).
  // shortwave_radiation: actual solar loading (W/m²) reaching the ground —
  // a continuous, more accurate stand-in for "is the sun really cooking
  // the interior" than a flat cloud-cover percentage cutoff.
  const hourly = [
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "cloud_cover",
    "pressure_msl", "precipitation", "temperature_2m",
    "wind_speed_850hPa", "wind_direction_850hPa", "shortwave_radiation",
  ].join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourly}&models=${models}&wind_speed_unit=kn&timezone=America%2FLos_Angeles&forecast_days=${days}`;
}

// Reshape Open-Meteo's multi-model response (one array per variable per
// model, keyed like "wind_speed_10m_gem_seamless") into per-hour records:
// [{ time, speeds:{gfs,ecmwf,icon,gem}, gusts:{...}, dirs:{...}, cloud:{...}, pressure:{...}, precip:{...}, temp:{...}, upperSpeeds:{...}, upperDirs:{...}, radiation:{...} }, ...]
export function reshapeOpenMeteo(json) {
  const hourly = json.hourly || {};
  const time = hourly.time || [];
  const rows = time.map((t) => ({
    time: t, speeds: {}, gusts: {}, dirs: {}, cloud: {}, pressure: {}, precip: {}, temp: {},
    upperSpeeds: {}, upperDirs: {}, radiation: {},
  }));

  for (const m of MODELS) {
    const sKey = `wind_speed_10m_${m.param}`;
    const gKey = `wind_gusts_10m_${m.param}`;
    const dKey = `wind_direction_10m_${m.param}`;
    const cKey = `cloud_cover_${m.param}`;
    const pKey = `pressure_msl_${m.param}`;
    const rKey = `precipitation_${m.param}`;
    const tKey = `temperature_2m_${m.param}`;
    const usKey = `wind_speed_850hPa_${m.param}`;
    const udKey = `wind_direction_850hPa_${m.param}`;
    const swKey = `shortwave_radiation_${m.param}`;
    const s = hourly[sKey], g = hourly[gKey], d = hourly[dKey], c = hourly[cKey], p = hourly[pKey], r = hourly[rKey], t = hourly[tKey];
    const us = hourly[usKey], ud = hourly[udKey], sw = hourly[swKey];
    rows.forEach((row, i) => {
      if (s && s[i] != null) row.speeds[m.key] = s[i];
      if (g && g[i] != null) row.gusts[m.key] = g[i];
      if (d && d[i] != null) row.dirs[m.key] = d[i];
      if (c && c[i] != null) row.cloud[m.key] = c[i];
      if (p && p[i] != null) row.pressure[m.key] = p[i];
      if (r && r[i] != null) row.precip[m.key] = r[i];
      if (t && t[i] != null) row.temp[m.key] = t[i];
      if (us && us[i] != null) row.upperSpeeds[m.key] = us[i];
      if (ud && ud[i] != null) row.upperDirs[m.key] = ud[i];
      if (sw && sw[i] != null) row.radiation[m.key] = sw[i];
    });
  }
  return rows;
}

// Local calibration for Howe Sound thermal spots (Squamish Spit, Furry
// Creek), sourced from a 12-year local rider's field notes (Jack Rieder,
// West Coast Wind Sports, Aug 2026 — see README). His finding: the raw
// coarse-model (GFS-class, ~13km) SW wind speed badly under-reads the real
// Squamish thermal, by a fairly consistent ratio once it's actually
// inflowing:
//   5-7kt modeled SW  -> 15-20kt real
//   7-9kt modeled SW  -> 20-25kt real
//   9kt+ modeled SW   -> "strong day" (25kt+)
// All three bins average out to roughly a 2.85x multiplier, which is what
// we apply here. This does NOT apply to the fine-resolution GEM/HRDPS
// model, which already attempts to resolve the thermal directly.
//
// The source field notes only covered 5-9kt modeled wind — applying the
// multiplier with no ceiling to a stronger coarse-model reading produces
// unsafe-looking numbers (e.g. 22kt coarse -> 62.7kt "forecast"), well past
// anything the calibration was ever validated against. Above
// CALIBRATED_OUTPUT_CAP_KT we taper the excess with a soft asymptotic curve
// instead of cutting it off sharply — still lets a genuinely extreme day
// read as "strong," just doesn't keep scaling linearly forever.
const SQUAMISH_THERMAL_MULTIPLIER = 2.85;
const CALIBRATED_OUTPUT_CAP_KT = 32;
const CALIBRATED_TAPER_SOFTNESS = 8; // smaller = harder taper above the cap

function calibrateSquamishThermal(coarseMeanKt) {
  if (coarseMeanKt == null || coarseMeanKt <= 0) return null;
  const raw = coarseMeanKt * SQUAMISH_THERMAL_MULTIPLIER;
  if (raw <= CALIBRATED_OUTPUT_CAP_KT) return raw;
  const excess = raw - CALIBRATED_OUTPUT_CAP_KT;
  return CALIBRATED_OUTPUT_CAP_KT + excess / (1 + excess / CALIBRATED_TAPER_SOFTNESS);
}

// Gust-over-average ratio for a calibrated Squamish-family thermal hour,
// direction-dependent rather than one flat number. Source: an independent
// Squamish-Spit-focused forecast tool (spitwind.ca, checked Aug 2026),
// which tracks this from its own live sensor history — a typical on-axis
// day there gusts about 21% over its average speed, but a day that's
// drifted west of the main SW inflow axis runs meaningfully gustier, up to
// ~36% over. We don't have that sensor history ourselves, so this is a
// directionally-informed refinement of the previous flat 1.3x (30% over),
// not a locally-validated number — revisit once our own live-verification
// log has enough gust data to check it. Blends linearly from 1.21x right on
// the 200° inflow axis up to 1.36x by the time direction reaches due west
// (270°) or beyond; south-of-axis (150-200°) stays at the base 1.21x since
// spitwind's finding was specifically about west-drifting days.
function calibratedGustMultiplier(directionDeg) {
  if (directionDeg == null) return 1.21;
  const driftFromAxisToward270 = Math.max(0, Math.min(1, (directionDeg - 200) / 70));
  return 1.21 + driftFromAxisToward270 * 0.15;
}

// ---------------------------------------------------------------------------
// Environment Canada marine bulletin parsing.
//
// EC's marine forecasts are written by human forecasters and — critically —
// they name the mesoscale pattern explicitly ("southerly inflow 10 to 20",
// "northeasterly outflow 5 to 15"). That's exactly the signal coarse global
// models routinely miss, and it's why a rider checking EC will beat a rider
// checking raw model output on a gradient day.
//
// Worked example this was built against (Aug 26 2026): the Strait of Georgia
// bulletin issued the previous morning called "southeast 15 to 20 near
// midnight then diminishing to southeast 10 to 15 early Wednesday morning."
// Riders scored a 4m/5m session at Erwin Park (which favors E-SE) at 6am that
// Wednesday and reported it fading — matching EC almost exactly, while our
// model-only estimate for the same hour was ~6kt. We were already fetching
// this page and only ever rendering it as a link.
// ---------------------------------------------------------------------------

const DIR_WORD_DEG = {
  north: 0, northeast: 45, east: 90, southeast: 135,
  south: 180, southwest: 225, west: 270, northwest: 315,
  northerly: 0, northeasterly: 45, easterly: 90, southeasterly: 135,
  southerly: 180, southwesterly: 225, westerly: 270, northwesterly: 315,
};
// Longest-first so "northeasterly" matches before "north", "southeast" before
// "south" — otherwise a substring match would silently mis-assign direction.
const DIR_WORDS = Object.keys(DIR_WORD_DEG).sort((a, b) => b.length - a.length);

// Timing phrase -> [startHour, endHour] local. A window whose start is greater
// than its end wraps through midnight (see hourInWindow below).
const TIMING_WINDOWS = [
  [/\blate (?:this )?(?:tonight|evening)\b/i, [21, 23]],
  [/\bnear midnight\b/i,                      [22, 2]],
  [/\bovernight\b/i,                          [21, 5]],
  [/\bearly (?:this )?evening\b/i,            [17, 20]],
  [/\bthis evening\b/i,                       [17, 22]],
  [/\btonight\b/i,                            [20, 5]],
  [/\bearly\s+\w+day morning\b/i,             [4, 9]],
  [/\bearly (?:this )?morning\b/i,            [4, 9]],
  [/\b\w+day morning\b/i,                     [6, 11]],
  [/\bthis morning\b/i,                       [6, 11]],
  [/\bnear noon\b/i,                          [11, 14]],
  [/\bthis afternoon\b/i,                     [12, 17]],
  [/\blate in the day\b/i,                    [15, 20]],
  [/\b\w+day evening\b/i,                     [17, 22]],
  [/\b\w+day afternoon\b/i,                   [12, 17]],
];

function hourInWindow(hour, [start, end]) {
  return start <= end ? (hour >= start && hour <= end) : (hour >= start || hour <= end);
}

// Turn an EC marine wind paragraph into structured segments.
// Returns null if nothing parseable was found — callers must treat the whole
// EC anchor as simply unavailable in that case rather than guessing.
export function parseMarineWindText(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, " ").trim();

  // Split on the transition markers EC uses to chain conditions through a day.
  const parts = clean.split(/\b(?:then|becoming|increasing to|diminishing to|rising to|easing to)\b/i);

  const segments = [];
  for (const rawPart of parts) {
    // "southeast 10 to 15 early this evening except southwest 15 to 20 over
    // southern sections" — everything before "except" is the zone's main
    // forecast; the tail is a sub-area caveat. Split so the main value isn't
    // wrongly discarded, and mark the tail so callers can ignore it.
    const pieces = rawPart.split(/\bexcept\b/i);
    for (let pi = 0; pi < pieces.length; pi++) {
      const chunk = pieces[pi].trim();
      if (!chunk) continue;

      // "light" with no number is a real EC value meaning near-calm.
      const isLight = /\blight\b/i.test(chunk) && !/\d/.test(chunk);

      let loKt = null, hiKt = null;
      const range = chunk.match(/\b(\d{1,2})\s+to\s+(\d{1,3})\b/);
      const single = chunk.match(/\b(\d{1,3})\s*knots?\b/);
      if (range) { loKt = Number(range[1]); hiKt = Number(range[2]); }
      else if (single) { loKt = hiKt = Number(single[1]); }
      else if (isLight) { loKt = 0; hiKt = 5; }
      if (loKt == null) continue;

      let directionLabel = null, directionDeg = null;
      for (const w of DIR_WORDS) {
        if (new RegExp(`\\b${w}\\b`, "i").test(chunk)) {
          directionLabel = w; directionDeg = DIR_WORD_DEG[w]; break;
        }
      }

      const regime = /\boutflow\b/i.test(chunk) ? "outflow"
        : /\binflow\b/i.test(chunk) ? "inflow" : null;

      let timing = null, hourWindow = null;
      for (const [re, win] of TIMING_WINDOWS) {
        const m = chunk.match(re);
        if (m) { timing = m[0].toLowerCase(); hourWindow = win; break; }
      }

      segments.push({
        raw: chunk, loKt, hiKt, directionLabel, directionDeg,
        regime, timing, hourWindow, isException: pi > 0,
      });
    }
  }

  if (!segments.length) return null;
  const main = segments.filter(s => !s.isException);
  if (!main.length) return null;
  return {
    segments,
    maxKt: Math.max(...main.map(s => s.hiKt)),
    minKt: Math.min(...main.map(s => s.loKt)),
    hasOutflow: segments.some(s => s.regime === "outflow"),
    hasInflow: segments.some(s => s.regime === "inflow"),
  };
}

// Pick the EC segment that applies to a given local hour. Prefers an explicit
// timing window; falls back to the first untimed segment (EC's opening clause,
// which describes conditions from issue time onward). Exception clauses
// ("except ... over southern sections") are never returned — they describe a
// different part of the zone than the one our spots sit in.
export function marineAnchorForHour(parsed, localHour) {
  if (!parsed || !parsed.segments) return null;
  const usable = parsed.segments.filter(s => !s.isException);
  const timed = usable.filter(s => s.hourWindow && hourInWindow(localHour, s.hourWindow));
  if (timed.length) return timed[timed.length - 1]; // latest matching clause wins
  return usable.find(s => !s.hourWindow) || null;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// time -> value lookup from a reshaped row array, for whichever field
// ("speeds" or "pressure") the caller wants, averaged across models. Shared
// by the reference-station speed check (Erwin Park) and the pressure
// gradient check (Squamish family) so the fetch/reshape logic only lives in
// one place — generate.mjs and the browser's live-refresh path both call
// through the json-based wrappers below.
function rowsToSeriesMap(rows, field) {
  const map = {};
  for (const row of rows) {
    const vals = Object.values(row[field]).filter(v => v != null);
    map[row.time] = vals.length ? mean(vals) : null;
  }
  return map;
}
export function referenceStationSpeeds(openMeteoJson) {
  return rowsToSeriesMap(reshapeOpenMeteo(openMeteoJson), "speeds");
}
export function referenceStationPressures(openMeteoJson) {
  return rowsToSeriesMap(reshapeOpenMeteo(openMeteoJson), "pressure");
}
export function rowsToPressureMap(rows) {
  return rowsToSeriesMap(rows, "pressure");
}
export function rowsToSpeedMap(rows) {
  return rowsToSeriesMap(rows, "speeds");
}
// Circular mean of a set of compass directions, optionally weighted (same
// length/order as `degs`). Unweighted, this can invent a direction none of
// the models actually predicted: two light 2kt-from-N readings and two
// strong 12-14kt-from-S readings average to due WNW, missing both the real
// thermal (S) and outflow (N) sectors it was averaging between. Weighting by
// each model's own wind speed lets the stronger, more consequential
// readings dominate the average, which is both more physically sensible
// (a 2kt breeze's direction is nearly noise) and a better match for what a
// rider on the water would actually feel.
function circularMeanDeg(degs, weights = null) {
  if (!degs.length) return null;
  let x = 0, y = 0;
  degs.forEach((d, i) => {
    const w = weights ? (weights[i] ?? 1) : 1;
    const r = d * Math.PI / 180;
    x += Math.cos(r) * w; y += Math.sin(r) * w;
  });
  if (x === 0 && y === 0) return null; // weights canceled out exactly — no meaningful mean
  let ang = Math.atan2(y, x) * 180 / Math.PI;
  return ang < 0 ? ang + 360 : ang;
}

// Component of a wind observation aligned with Howe Sound's SW up-sound
// inflow axis (~200°) — i.e. how much of this wind is actually blowing the
// "right way" to reach the Spit, not just how strong it is in any direction.
// Positive = aligned with inflow, negative = opposing it. Used for the live
// Pam Rocks nowcast (see classifyHour) — same idea as projecting one vector
// onto another.
export function pamRocksInflowComponent(speedKt, directionDeg, inflowAxisDeg = 200) {
  if (speedKt == null || directionDeg == null) return null;
  return speedKt * Math.cos((directionDeg - inflowAxisDeg) * Math.PI / 180);
}

// Clear-sky solar radiation estimate (W/m²) for a given latitude, day of
// year and local hour — used to judge "how sunny is it *for this time of
// day*" as a ratio, rather than against one flat number. A flat cutoff
// (e.g. "sunny if radiation >= 250 W/m²") quietly assumes it's always close
// to solar noon: a clear sky at 6pm in August only delivers ~180-240 W/m²
// simply because the sun is low, not because it's cloudy — a flat cutoff
// would wrongly call that "not sunny" and kill a prime evening thermal
// session. Standard solar-elevation approximation; a heuristic like the
// rest of this file, not a radiative-transfer model.
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function dayOfYearFromParts(month, day, year) {
  let doy = day;
  for (let m = 0; m < month - 1; m++) doy += (m === 1 && isLeapYear(year)) ? 29 : DAYS_IN_MONTH[m];
  return doy;
}
function clearSkyRadiationWm2(latDeg, doy, localHour) {
  const declDeg = 23.45 * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const declRad = declDeg * Math.PI / 180;
  const latRad = latDeg * Math.PI / 180;
  const hourAngleRad = (15 * (localHour - 12)) * Math.PI / 180;
  const sinElev = Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);
  if (sinElev <= 0) return 0; // sun below the horizon
  return Math.max(0, 990 * sinElev - 30);
}

// Classify one hour's regime for one spot, given the row of model values.
// `refSpeedKt`, if provided, is the best-estimate wind speed at this same
// hour from the spot's reference station (see spot.referenceStation) — used
// for spots where a nearby well-exposed gauge point is a better predictor
// than the spot's own local model output (e.g. Erwin Park vs Point
// Atkinson).
// `pressureGradients`, if provided, is { largeScale, local } in hPa for
// Howe Sound spots (see spot.pressureGradientAware) — positive favors
// inflow/thermal, negative favors outflow.
// `overrideRecord`, if provided, is this spot's entry from
// data/calibration-overrides.json — an object keyed by regime (plus a
// "general" fallback), each holding a rider-feedback-learned multiplier
// (see scripts/apply-feedback.mjs). Resolved against the regime this hour
// actually classifies as, once that's known below.
// `pamRocksNow`, if provided, is { speedKt, directionDeg } — the live Pam
// Rocks buoy reading (Howe Sound's mouth), only ever passed for whichever
// hour matches "right now" (see generate.mjs) since it's a live observation,
// not a forecast time series. Two independent uses, both same-day-only:
// an SW-inflow-projection thermal nowcast (spot.pamRocksAware) and a plain
// threshold+direction trigger (spot.pamRocksTrigger, Porteau Cove).
// Returns { regime, reason, direction_deg, speed_kt, gust_kt, agreement }
// `marineAnchor`, if provided, is the EC marine-bulletin segment applicable to
// this hour (see parseMarineWindText / marineAnchorForHour above), for spots
// that declare a `marineZone`. Used to catch gradient events the raw models
// under-read — see the anchor block in the body.
// `liveRefNow`, if provided, is { speedKt, directionDeg } from the spot's own
// reference station's LIVE observation (not its forecast), only ever passed for
// the hour matching "right now" — same live-observation caveat as pamRocksNow.
export function classifyHour(spot, row, localHour, month, refSpeedKt = null, pressureGradients = null, overrideRecord = null, pamRocksNow = null, marineAnchor = null, liveRefNow = null) {
  const speedVals = Object.values(row.speeds).filter(v => v != null);
  const cloudVals = Object.values(row.cloud).filter(v => v != null);
  const radiationVals = Object.values(row.radiation || {}).filter(v => v != null);

  const speed_kt = mean(speedVals);
  const gust_kt = mean(Object.values(row.gusts).filter(v => v != null));
  // Weight each model's direction by that same model's speed (see
  // circularMeanDeg) — a near-calm model shouldn't get an equal vote on
  // "which way is the wind coming from" against a model showing real wind.
  // Pair by model key so a model missing one of the two fields doesn't
  // silently misalign against another model's value.
  const dirPairs = Object.entries(row.dirs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ deg: v, weight: row.speeds[k] != null ? Math.max(row.speeds[k], 0.5) : 1 }));
  const direction_deg = circularMeanDeg(dirPairs.map(p => p.deg), dirPairs.map(p => p.weight));
  const cloud_pct = mean(cloudVals);
  const radiation_wm2 = radiationVals.length ? mean(radiationVals) : null;
  const upperSpeedVals = Object.values(row.upperSpeeds || {}).filter(v => v != null);
  const upperDirPairs = Object.entries(row.upperDirs || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ deg: v, weight: (row.upperSpeeds || {})[k] != null ? Math.max(row.upperSpeeds[k], 0.5) : 1 }));
  const upper_speed_kt = upperSpeedVals.length ? mean(upperSpeedVals) : null;
  const upper_direction_deg = upperDirPairs.length ? circularMeanDeg(upperDirPairs.map(p => p.deg), upperDirPairs.map(p => p.weight)) : null;

  // Model agreement: how tight is the spread relative to the mean? Used as
  // a confidence multiplier — synoptic/gradient events tend to show up on
  // every model; pure thermal/mesoscale effects often show up on the
  // fine-resolution model only, which is itself informative.
  let agreement = 0.5;
  if (speedVals.length >= 2 && speed_kt) {
    const spread = Math.max(...speedVals) - Math.min(...speedVals);
    agreement = Math.max(0, Math.min(1, 1 - spread / Math.max(8, speed_kt * 1.2)));
  }

  let regime = "calm", reason = "Light and variable — no clear driver.";
  // Shortwave radiation is a more direct read on "how hard is the sun
  // actually driving the thermal right now" than a flat cloud-cover cutoff —
  // it already folds in cloud, sun angle and time of day. But it needs to be
  // judged *relative to that hour's own clear-sky ceiling*, not a flat
  // number: a clear evening naturally reads lower than a clear noon simply
  // because the sun is lower, and a flat cutoff can't tell that apart from
  // real cloud cover (see clearSkyRadiationWm2 above). Ratio-based when we
  // have both a real radiation reading and a meaningful clear-sky ceiling;
  // fall back to the cruder cloud threshold when either is unavailable, and
  // treat "sun essentially down" (very low clear-sky ceiling) as not sunny.
  const SUNNY_RADIATION_RATIO = 0.45;
  const yearNum = Number(row.time.slice(0, 4));
  const dayNum = Number(row.time.slice(8, 10));
  const doy = dayOfYearFromParts(month, dayNum, yearNum);
  const clearSkyWm2 = clearSkyRadiationWm2(spot.lat, doy, localHour);
  const sunny = clearSkyWm2 <= 20
    ? false
    : (radiation_wm2 != null ? (radiation_wm2 / clearSkyWm2) >= SUNNY_RADIATION_RATIO : (cloud_pct != null ? cloud_pct < 55 : true));
  const inHourWindow = (w) => localHour >= w[0] && localHour <= w[1];

  const thermalCfg = spot.thermal;
  const outflowCfg = spot.outflow;

  // Gate on the BEST available signal, not the flat average across models.
  // A pure thermal is, by definition, a case where only the fine-res model
  // (or maybe one or two others) has actually picked it up while coarse
  // global models still show near-zero — averaging all four together dilutes
  // exactly the signal we're trying to detect and would keep this branch
  // from ever firing on a real thermal day. Use whichever model is reading
  // highest for the go/no-go gate; the display value and probability model
  // handle weighting separately.
  const maxSpeed = speedVals.length ? Math.max(...speedVals) : null;

  const looksThermal = thermalCfg && thermalCfg.enabled &&
    thermalCfg.months.includes(month) &&
    inHourWindow(thermalCfg.hourWindow) &&
    sunny &&
    direction_deg != null && inSector(direction_deg, thermalCfg.dirSector) &&
    maxSpeed != null && maxSpeed >= 4;

  const looksOutflow = outflowCfg && outflowCfg.enabled &&
    direction_deg != null && inSector(direction_deg, outflowCfg.dirSector) &&
    maxSpeed != null && maxSpeed >= 8;

  const looksSynoptic = speed_kt != null && speed_kt >= 10 && agreement >= 0.6 &&
    !(thermalCfg && thermalCfg.enabled && inHourWindow(thermalCfg.hourWindow) && looksThermal);

  if (looksOutflow) {
    regime = "outflow";
    const fine = row.speeds.gem, coarse = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
    const gradeNote = (coarse != null && fine != null && fine - coarse > 6)
      ? " High-res GEM/HRDPS is running noticeably stronger than GFS/ECMWF — trust the local model here."
      : "";
    reason = `${spot.outflow.note.split(".")[0]}.${gradeNote}`;
  } else if (looksThermal) {
    regime = "thermal";
    const fine = row.speeds.gem, coarse = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
    const meshNote = (fine != null && coarse != null)
      ? (fine - coarse > 5
          ? " Only the high-res local model is showing this clearly — classic sign of a pure thermal that coarse global models miss. Treat as moderate confidence until closer in."
          : " Multiple models agree, which is a good sign for a thermal-driven day.")
      : "";
    const radiationNote = radiation_wm2 != null
      ? (radiation_wm2 >= 500 ? ` Solar loading is strong (~${Math.round(radiation_wm2)} W/m²) — good thermal driver.` : ` Solar loading is moderate (~${Math.round(radiation_wm2)} W/m²) — thermal may be a bit softer than a full-sun day.`)
      : "";
    reason = `${thermalCfg.note.split(".")[0]}.${meshNote}${radiationNote}`;
  } else if (looksSynoptic) {
    regime = "synoptic";
    reason = `General Strait/regional gradient wind from the ${degToLabel(direction_deg)}, agreed on by ${speedVals.length} model${speedVals.length === 1 ? "" : "s"}.`;
  } else if (maxSpeed != null && maxSpeed < 5) {
    regime = "calm";
    reason = "Forecast light — every model under 5kt.";
  } else {
    regime = "mixed";
    reason = `Wind expected (${degToLabel(direction_deg)}) but doesn't clearly match this spot's known thermal or outflow pattern — treat with extra caution.`;
  }

  // Upper-level (850hPa, ~1500m) SW flow strong enough can override or
  // suppress the local sea-breeze circulation a thermal depends on — a
  // caution the surface-only signals above can't see on their own. Only
  // relevant once we've already called the hour a thermal.
  const UPPER_SUPPRESSION_KT = 20;
  let upperSuppression = null;
  if (regime === "thermal" && upper_speed_kt != null) {
    const alignedWithInflow = upper_direction_deg != null && inSector(upper_direction_deg, [150, 260]);
    upperSuppression = upper_speed_kt >= UPPER_SUPPRESSION_KT && alignedWithInflow;
    if (upperSuppression) {
      reason += ` Caution: strong SW flow aloft (~${Math.round(upper_speed_kt)}kt at 850hPa) can override or suppress this thermal rather than reinforce it.`;
    }
  }

  // Direction rideability flag. Outflow events at Howe Sound spots blow from
  // the opposite sector to the thermal wind, so use the spot's dedicated
  // outflow sector list when that's the regime in play, if one is defined.
  const sectorList = (regime === "outflow" && spot.outflow_favorable_deg)
    ? spot.outflow_favorable_deg
    : spot.favorable_deg;
  const favorable = sectorList ? sectorList.some(s => inSector(direction_deg, s)) : true;

  // How much more should the fine-resolution local model (GEM/HRDPS) count
  // relative to the coarse global models, when scoring this specific hour?
  // For thermal/outflow regimes — mesoscale, terrain-driven effects — the
  // local high-res model is the one most likely to have actually resolved
  // Howe Sound / the Fraser Valley correctly, so it earns more weight than
  // a straight vote-of-4 would give it.
  let fine_vs_coarse_gap = null;
  const coarseMean = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
  if (row.speeds.gem != null && coarseMean != null) {
    fine_vs_coarse_gap = row.speeds.gem - coarseMean;
  }

  // Squamish-family thermal calibration (see calibrateSquamishThermal above).
  // Coarse models under-read this specific thermal badly enough that showing
  // their raw average as "the forecast" is actively misleading — a rider
  // checking this tool mid-thermal would see single digits while the water
  // is doing 20kt+. We override the headline speed/gust and the model votes
  // used for probability with the calibrated estimate, and keep the raw
  // per-model numbers available in `raw_models` for transparency.
  let displaySpeed = speed_kt, displayGust = gust_kt, displayModels = row.speeds, calibrated = false;

  // Outflow under-read correction. Same physics problem as the Squamish
  // thermal: a shallow, terrain-channelled drainage flow is below what a
  // ~13km global grid can resolve, so coarse models flatten it. The mechanism
  // is here and works, but is deliberately NOT enabled on any spot yet —
  // unlike the Squamish thermal (which has a 12-year rider's field notes
  // behind its 2.85x), we have no validated multiplier for any outflow spot,
  // and inventing one is exactly the kind of guess that produces a confidently
  // wrong forecast. Set `outflow: { calibrated: true, multiplier: N }` on a
  // spot once there's real data to justify N.
  //
  // In the meantime the empirical path is already open: the regime-aware
  // feedback loop (apply-feedback.mjs) buckets by regime, so now that Erwin
  // Park actually classifies its easterly mornings as "outflow" rather than
  // calm/mixed, live-verification data will accumulate in an Erwin/outflow
  // bucket and learn this multiplier from observations instead of a guess.
  if (regime === "outflow" && spot.outflow && spot.outflow.calibrated &&
      spot.outflow.multiplier != null && coarseMean != null) {
    const est = coarseMean * spot.outflow.multiplier;
    if (est > (displaySpeed ?? 0)) {
      calibrated = true;
      displaySpeed = row.speeds.gem != null ? Math.max(est, row.speeds.gem) : est;
      displayGust = displaySpeed * 1.3;
      displayModels = { calibrated: displaySpeed, gem_local: row.speeds.gem ?? displaySpeed };
      reason += ` Field-calibrated for outflow: raw coarse-model wind (~${Math.round(coarseMean)}kt) scaled ~${spot.outflow.multiplier}x, since coarse models under-resolve shallow drainage flow here.`;
    }
  }

  if (regime === "thermal" && spot.thermal && spot.thermal.calibrated && coarseMean != null) {
    const calibratedSpeed = calibrateSquamishThermal(coarseMean);
    if (calibratedSpeed != null) {
      calibrated = true;
      // Blend the calibrated coarse-model estimate with GEM/HRDPS's own
      // (already partially-resolved) number, leaning toward whichever reads
      // higher — both are known to undercall this specific thermal, not
      // overcall it.
      displaySpeed = row.speeds.gem != null ? Math.max(calibratedSpeed, row.speeds.gem) : calibratedSpeed;
      displayGust = displaySpeed * calibratedGustMultiplier(direction_deg);
      displayModels = { calibrated: displaySpeed, gem_local: row.speeds.gem ?? displaySpeed };
      reason += ` Field-calibrated: raw coarse-model wind (~${Math.round(coarseMean)}kt) is scaled up ~2.85x, matching how this thermal typically under-reads on GFS-class models (source: local rider calibration, see README).`;
    }
  }

  // Pressure gradient check (MSLP), Howe Sound spots only. Squamish wind
  // isn't purely thermal — it's also a function of the actual pressure
  // gradient along the corridor (see kiteloop.vercel.app's "MSLP — two
  // pressure checks" panel, which inspired this): a large-scale coastal-vs-
  // interior spread (broad synoptic support) and a local spread between the
  // sound's mouth and the spot itself (is the channel locally pressurized
  // toward it). Positive = favors inflow (thermal/southerly), negative =
  // favors outflow (northerly). We use this to raise or discount confidence
  // and explain *why*, rather than to flip the regime itself — wind-speed
  // signals stay the primary classifier.
  let pressureSupport = null;
  if (spot.pressureGradientAware && pressureGradients &&
      pressureGradients.largeScale != null && pressureGradients.local != null) {
    const { largeScale, local } = pressureGradients;
    const inflowSupport = largeScale > 0.4 && local > 0.2;
    const outflowSupport = largeScale < -0.4 && local < -0.2;
    if (regime === "thermal") {
      pressureSupport = inflowSupport;
      reason += inflowSupport
        ? ` MSLP backs this up — both the large-scale coast-vs-interior spread (${largeScale.toFixed(1)}hPa) and the local channel spread (${local.toFixed(1)}hPa) favor inflow.`
        : ` Caution: MSLP doesn't clearly support inflow yet (large-scale ${largeScale.toFixed(1)}hPa, local ${local.toFixed(1)}hPa) — could be weaker or more marginal than the wind signal alone suggests.`;
    } else if (regime === "outflow") {
      pressureSupport = outflowSupport;
      reason += outflowSupport
        ? ` MSLP confirms it — both large-scale (${largeScale.toFixed(1)}hPa) and local (${local.toFixed(1)}hPa) spreads favor outflow.`
        : ` Caution: MSLP is weaker than the wind signal suggests (large-scale ${largeScale.toFixed(1)}hPa, local ${local.toFixed(1)}hPa) — this outflow could fade faster than expected.`;
    }
  }

  // Pam Rocks nowcast, Squamish-family spots only (spot.pamRocksAware).
  // `pamRocksNow` is only ever passed for the hour matching "right now" —
  // it's a live buoy reading at Howe Sound's mouth, not a forecast time
  // series, so it can only corroborate/caution the current hour, not the
  // rest of the forecast. Marine inflow reaching the mouth of the sound is
  // a real-time leading indicator for the thermal reaching the Spit.
  //
  // Sharpened with a specific, validated local signal from spitwind.ca (an
  // independent Squamish-Spit-focused forecast tool, checked Aug 2026):
  // across a season of recorded Spit sessions, Pam Rocks reading 8-12kt
  // specifically from the SSE precedes the Spit filling to rideable ~91% of
  // the time — a much sharper "heads up" than a generic inflow-strength
  // check. They also flag the inverse: a STRONG Pam Rocks reading from the
  // west is a "head-fake" that often doesn't reach the Spit at all — worse
  // than no signal at all, since a big number there looks encouraging but
  // isn't. We don't have a season of our own history to independently
  // derive these bands yet (see "Live verification" / the calibration
  // loop), so treat the specific thresholds below as borrowed, not
  // locally-validated — worth revisiting once our own log has enough depth.
  const PAM_TELL_MIN_KT = 8, PAM_TELL_MAX_KT = 12;
  const PAM_TELL_DIR_SECTOR = [135, 195]; // SE through SSW, centered on SSE
  const PAM_HEADFAKE_DIR_SECTOR = [260, 300]; // W through WNW
  const PAM_HEADFAKE_MIN_KT = 10;
  let pamRocksSupport = null, pamRocksTell = false, pamRocksHeadFake = false;
  if (spot.pamRocksAware && regime === "thermal" && pamRocksNow &&
      pamRocksNow.speedKt != null && pamRocksNow.directionDeg != null) {
    const { speedKt: pSpeed, directionDeg: pDir } = pamRocksNow;
    const isTellBand = pSpeed >= PAM_TELL_MIN_KT && pSpeed <= PAM_TELL_MAX_KT && inSector(pDir, PAM_TELL_DIR_SECTOR);
    const isHeadFake = pSpeed >= PAM_HEADFAKE_MIN_KT && inSector(pDir, PAM_HEADFAKE_DIR_SECTOR);
    const component = pamRocksInflowComponent(pSpeed, pDir);

    if (isHeadFake) {
      pamRocksSupport = false;
      pamRocksHeadFake = true;
      reason += ` Caution: Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} — strong but off-axis (westerly), which often doesn't translate into real inflow at the Spit. Don't read this as a good sign.`;
    } else if (isTellBand) {
      pamRocksSupport = true;
      pamRocksTell = true;
      reason += ` Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} — right in the band that's historically preceded this thermal filling in reliably.`;
    } else if (component != null) {
      pamRocksSupport = component >= 6;
      reason += pamRocksSupport
        ? ` Pam Rocks (sound's mouth) is reading ~${Math.round(pSpeed)}kt from ${degToLabel(pDir)} right now — already showing strong SW inflow, a good real-time sign for this thermal.`
        : ` Pam Rocks (sound's mouth) isn't yet showing strong SW inflow (~${Math.round(pSpeed)}kt from ${degToLabel(pDir)}) — this thermal may not have fully kicked in yet.`;
    }
  }

  // Reference-station trigger: some spots are better predicted by a nearby
  // exposed gauge point than by their own local model output. Two modes:
  //   - thresholdKt (original): a plain "did the reference station cross X"
  //     check, e.g. a spot that only turns on once a nearby entrance station
  //     is blowing hard enough to matter.
  //   - offsetKt (added for Erwin Park): the reference station and this spot
  //     move together, but consistently offset by a fixed amount — e.g.
  //     Erwin Park typically reads ~4.5kt lighter than Point Atkinson right
  //     next to it. Rather than a binary crossed/didn't-cross check, this
  //     estimates the spot's own speed as refSpeedKt + offsetKt, gated to
  //     dirSector (the offset only holds for the direction it was observed
  //     under — see spot.referenceStation in spots.js). Only overrides a
  //     calm/mixed regime once the estimate itself clears a meaningful floor
  //     (5kt) — a light Point Atkinson reading shouldn't get dressed up as a
  //     "synoptic" hour here just because the arithmetic ran.
  // Either mode only steps in when the ordinary classification came up empty
  // (calm/mixed); if the spot's own thermal/outflow/synoptic logic already
  // found something, we just add a corroborating note rather than override it.
  let referenceTriggered = false;
  if (spot.referenceStation && refSpeedKt != null) {
    const rs = spot.referenceStation;
    if (rs.offsetKt != null) {
      const dirOk = rs.dirSector ? inSector(direction_deg, rs.dirSector) : true;
      if (dirOk) {
        const estSpeed = Math.max(0, refSpeedKt + rs.offsetKt);
        const offsetLabel = `${Math.abs(rs.offsetKt)}kt ${rs.offsetKt < 0 ? "lighter" : "stronger"}`;
        if ((regime === "calm" || regime === "mixed") && estSpeed >= 5) {
          referenceTriggered = true;
          regime = "synoptic";
          displaySpeed = estSpeed;
          displayGust = displaySpeed * 1.3;
          reason = `${rs.name} is reading ~${Math.round(refSpeedKt)}kt from a favorable direction for this spot, which typically runs about ${offsetLabel} — estimated ~${Math.round(estSpeed)}kt here. ${rs.note}`;
        } else if (regime !== "calm" && regime !== "mixed") {
          referenceTriggered = true;
          reason += ` Also corroborated by ${rs.name} reading ~${Math.round(refSpeedKt)}kt from a favorable direction (this spot typically runs about ${offsetLabel}, ~${Math.round(estSpeed)}kt estimated). ${rs.note}`;
        }
      }
    } else if (rs.thresholdKt != null && refSpeedKt >= rs.thresholdKt) {
      referenceTriggered = true;
      if (regime === "calm" || regime === "mixed") {
        regime = "synoptic";
        displaySpeed = Math.max(displaySpeed ?? 0, rs.thresholdKt);
        displayGust = displaySpeed * 1.3;
        reason = `${rs.name} is reading ~${Math.round(refSpeedKt)}kt, above this spot's ${rs.thresholdKt}kt trigger. ${rs.note}`;
      } else {
        reason += ` Also corroborated by ${rs.name} reading ~${Math.round(refSpeedKt)}kt, above its ${rs.thresholdKt}kt trigger for this spot.`;
      }
    }
  }

  // Pam Rocks threshold+direction trigger (Porteau Cove specific, per local
  // rider knowledge): distinct from the SW-inflow-projection nowcast above —
  // this one is a plain threshold + direction sector check, not a vector
  // projection. Same live-observation caveat: only ever fires on the hour
  // matching "right now." Mirrors the reference-station trigger pattern
  // (upgrades a calm/mixed hour, corroborates otherwise) but is sourced from
  // a live buoy reading + direction rather than a forecast reference
  // station.
  let pamRocksTriggered = false;
  if (spot.pamRocksTrigger && pamRocksNow && pamRocksNow.speedKt != null && pamRocksNow.directionDeg != null) {
    const trig = spot.pamRocksTrigger;
    const met = pamRocksNow.speedKt >= trig.thresholdKt && inSector(pamRocksNow.directionDeg, trig.dirSector);
    if (met) {
      pamRocksTriggered = true;
      if (regime === "calm" || regime === "mixed") {
        regime = "synoptic";
        displaySpeed = Math.max(displaySpeed ?? 0, trig.boostToKt);
        displayGust = displaySpeed * 1.3;
        reason = `Pam Rocks is reading ~${Math.round(pamRocksNow.speedKt)}kt from ${degToLabel(pamRocksNow.directionDeg)}, above this spot's ${trig.thresholdKt}kt South/SE trigger. ${trig.note}`;
      } else {
        reason += ` Also corroborated by Pam Rocks reading ~${Math.round(pamRocksNow.speedKt)}kt from ${degToLabel(pamRocksNow.directionDeg)}, above its ${trig.thresholdKt}kt South/SE trigger for this spot.`;
      }
    }
  }

  // Live reference-station trigger (Erwin Park / Point Atkinson). Distinct
  // from the forecast-based referenceStation offset above: this reads the
  // station's ACTUAL current wind, which is how riders genuinely make this
  // call — verbatim from the North Shore Wing Group chat: "Point Atkinson
  // 21kts now, will head to Erwin if it holds", "Head to Erwin once it hits 20
  // knots", "Erwin must be on. Point Atkinson is 23kts", "Will try Erwin
  // later. Once it stays above 19 knots." Four independent reports converging
  // on ~19-21kt, which is where the threshold in spots.js comes from.
  //
  // Only ever fires on the hour matching "right now" (generate.mjs only passes
  // liveRefNow for that hour), same as the Pam Rocks trigger. The forecast-
  // based offset above can be badly wrong on exactly the gradient mornings
  // this is meant to catch, because the reference station's own forecast is
  // under-read by the same coarse models — so a live reading is strictly
  // better information when it's available.
  let liveRefTriggered = false;
  if (spot.liveReferenceTrigger && liveRefNow && liveRefNow.speedKt != null) {
    const t = spot.liveReferenceTrigger;
    const dirOk = t.dirSector == null || liveRefNow.directionDeg == null
      ? true
      : inSector(liveRefNow.directionDeg, t.dirSector);
    if (dirOk && liveRefNow.speedKt >= t.thresholdKt) {
      liveRefTriggered = true;
      const estSpeed = Math.max(0, liveRefNow.speedKt + (t.offsetKt ?? 0));
      if (estSpeed > (displaySpeed ?? 0)) {
        displaySpeed = estSpeed;
        displayGust = displaySpeed * 1.3;
      }
      if (regime === "calm" || regime === "mixed") regime = "synoptic";
      reason += ` ${t.name} is reading ~${Math.round(liveRefNow.speedKt)}kt right now, above this spot's ${t.thresholdKt}kt live trigger — estimated ~${Math.round(estSpeed)}kt here. ${t.note}`;
    }
  }

  // Environment Canada marine bulletin anchor. EC's forecasters name the
  // pattern explicitly and routinely catch gradient/inflow/outflow events that
  // coarse global models flatten — so when EC's zone forecast calls for wind
  // from a direction this spot actually works on, and our model average is
  // below even EC's conservative low end, treat EC's low end as a floor rather
  // than publishing a number we have specific reason to doubt.
  //
  // Deliberately one-directional (only ever raises, never lowers): an EC zone
  // forecast describes open water across a whole marine area, so a sheltered
  // beach legitimately reading lighter than EC is normal and not evidence of a
  // model error. The reverse — a spot exposed to the forecast direction
  // reading far *below* EC — is the signature we're trying to catch.
  // `marineAnchorFactor` lets a spot that consistently runs lighter than open
  // water scale the floor down (default 1.0 = take EC's low end as-is).
  let marineAnchored = false, marineNote = null;
  if (marineAnchor && marineAnchor.loKt != null && spot.marineZone) {
    const anchorDirOk = marineAnchor.directionDeg != null &&
      (spot.favorable_deg || []).some(s => inSector(marineAnchor.directionDeg, s));
    // Anchor on the MIDPOINT of EC's range, not its low end. EC publishes a
    // sustained open-water range; the low end alone is so conservative that it
    // barely moves a badly under-read model hour (which defeats the point of
    // anchoring at all), while the midpoint is a fair reading of "what the
    // forecaster actually expects." Verified against the Aug 26 2026 Erwin
    // miss: EC "southeast 10 to 15", riders on 4m/5m — the low end alone would
    // have left the spot below the display threshold.
    const ecMidKt = (marineAnchor.loKt + marineAnchor.hiKt) / 2;
    const floorKt = ecMidKt * (spot.marineAnchorFactor ?? 1);
    if (anchorDirOk && floorKt >= 5 && (displaySpeed == null || displaySpeed < floorKt)) {
      marineAnchored = true;
      displaySpeed = floorKt;
      displayGust = Math.max(displayGust ?? 0, floorKt * 1.3);
      if (regime === "calm" || regime === "mixed") regime = "synoptic";
      reason += ` Environment Canada's marine forecast for this area calls for ${marineAnchor.directionLabel} ${marineAnchor.loKt}${marineAnchor.hiKt !== marineAnchor.loKt ? `-${marineAnchor.hiKt}` : ""}kt${marineAnchor.timing ? ` ${marineAnchor.timing}` : ""}${marineAnchor.regime ? ` (${marineAnchor.regime})` : ""}, from a direction this spot works on — raised to EC's lower bound, since the raw models are reading well under that and EC's forecasters catch gradient events the models flatten.`;
    } else if (anchorDirOk) {
      marineNote = `EC marine forecast for this area: ${marineAnchor.directionLabel} ${marineAnchor.loKt}-${marineAnchor.hiKt}kt${marineAnchor.timing ? ` ${marineAnchor.timing}` : ""}.`;
      reason += ` ${marineNote}`;
    }
  }

  // Quick qualitative flags from a 12-year local rider's notes: rain kills
  // it, cloud alone doesn't, and an extreme heat forecast tends to suppress
  // the thermal (or make it very short-lived).
  const precip = mean(Object.values(row.precip).filter(v => v != null));
  const temp = mean(Object.values(row.temp).filter(v => v != null));
  if (precip != null && precip > 0.3) {
    reason += " Rain in the forecast — thermal wind is often suppressed on wet days, unlike plain cloud cover.";
  }
  if (temp != null && temp >= 29 && regime === "thermal") {
    reason += " Very hot forecast — heat waves often kill or badly shorten this thermal; if it does fill in, be ready to go early.";
  }

  // Rider-feedback calibration override (see scripts/apply-feedback.mjs):
  // a per-spot, per-REGIME multiplier learned from "Report actual
  // conditions" issues and live-station mismatches, applied on top of
  // everything above. A thermal-hour mismatch shouldn't nudge the outflow
  // calibration for the same spot and vice versa, so we resolve against
  // whichever regime this hour actually landed on, falling back to a
  // "general" bucket for older/un-regime-tagged data points. Scales the
  // model votes too, so probabilityInRange's weighted count reflects it
  // automatically.
  const overrideMultiplier = overrideRecord
    ? (overrideRecord[regime]?.multiplier ?? overrideRecord.general?.multiplier ?? null)
    : null;
  let feedbackAdjusted = false;
  if (overrideMultiplier != null && Math.abs(overrideMultiplier - 1) > 0.02) {
    feedbackAdjusted = true;
    if (displaySpeed != null) displaySpeed *= overrideMultiplier;
    if (displayGust != null) displayGust *= overrideMultiplier;
    displayModels = Object.fromEntries(
      Object.entries(displayModels).map(([k, v]) => [k, v != null ? v * overrideMultiplier : v])
    );
    reason += ` Adjusted ×${overrideMultiplier.toFixed(2)} based on rider-reported actual conditions at this spot (see the "Report actual conditions" link).`;
  }

  // GUSTY flag: independent of regime — strong upper-level wind riding over
  // a decent surface wind is the classic recipe for a gusty, mechanically-
  // mixed day, worth flagging regardless of how confident we are in the
  // headline speed. Checked against the final (calibrated/adjusted) speed,
  // not the raw pre-calibration average.
  const UPPER_GUSTY_KT = 25;
  const gusty = upper_speed_kt != null && upper_speed_kt >= UPPER_GUSTY_KT && displaySpeed != null && displaySpeed >= 12;

  // Plain-English one-liner for the UI. `reason` above is the detailed,
  // meteorologist-facing trail (model spread, MSLP numbers, calibration
  // factors, etc.) — useful for anyone digging in, but the app's mobile-first
  // UI deliberately keeps technical jargon out of view. `summary` is a
  // short, jargon-free version of the same underlying signal (what kind of
  // wind, plus the two things a rider actually needs to know beyond speed:
  // is the direction rideable, and should they expect it to be gusty) so the
  // "why" behind a number is visible without reintroducing model names,
  // pressure readings or calibration multipliers into the UI.
  let summary;
  switch (regime) {
    case "thermal": summary = "Afternoon sea-breeze pattern — builds through the day, fades around sunset."; break;
    case "outflow": summary = "Wind draining down the valley — can be strong and gusty, any time of day."; break;
    case "synoptic": summary = "General regional wind, not tied to time of day."; break;
    case "calm": summary = "Light and variable — not much going on."; break;
    case "mixed": summary = "Some wind expected, but it doesn't clearly match this spot's usual pattern — less certain than usual."; break;
    default: summary = "Wind expected.";
  }
  if (favorable === false) summary += " Direction looks offshore or otherwise tricky here — use caution.";
  if (gusty) summary += " Expect it to be gustier than the average speed alone suggests.";

  return {
    time: row.time,
    speed_kt: displaySpeed != null ? Math.round(displaySpeed * 10) / 10 : null,
    gust_kt: displayGust != null ? Math.round(displayGust * 10) / 10 : null,
    direction_deg: direction_deg != null ? Math.round(direction_deg) : null,
    direction_label: degToLabel(direction_deg),
    cloud_pct: cloud_pct != null ? Math.round(cloud_pct) : null,
    radiation_wm2: radiation_wm2 != null ? Math.round(radiation_wm2) : null,
    upper_speed_kt: upper_speed_kt != null ? Math.round(upper_speed_kt * 10) / 10 : null,
    gusty,
    regime,
    reason,
    summary,
    favorable_direction: favorable,
    model_agreement: Math.round(agreement * 100) / 100,
    fine_vs_coarse_gap: fine_vs_coarse_gap != null ? Math.round(fine_vs_coarse_gap * 10) / 10 : null,
    calibrated,
    reference_triggered: referenceTriggered,
    live_reference_triggered: liveRefTriggered,
    marine_anchored: marineAnchored,
    pam_rocks_triggered: pamRocksTriggered,
    pressure_support: pressureSupport,
    upper_suppression: upperSuppression,
    pam_rocks_support: pamRocksSupport,
    pam_rocks_tell: pamRocksTell,
    pam_rocks_head_fake: pamRocksHeadFake,
    feedback_adjusted: feedbackAdjusted,
    models: displayModels,
    raw_models: row.speeds,
  };
}

// Base uncertainty (kt) around the headline speed estimate, before any
// data-driven widening — thermal/mesoscale regimes are inherently less
// certain than a well-agreed synoptic push, even net of calibration, since
// coarse models routinely miss them entirely rather than just mis-sizing them.
const REGIME_BASE_SIGMA = { thermal: 3.5, outflow: 3, synoptic: 2, calm: 1.5, mixed: 3 };

// Logistic CDF centered on `center` with spread `s` — a smooth stand-in for
// a normal CDF that needs no special-function import. Used to turn a single
// point estimate + uncertainty into P(x <= value).
function logisticCdf(x, center, s) {
  return 1 / (1 + Math.exp(-(x - center) / s));
}

// Probability that the true wind lands in [lo, hi] kt. Modeled as a smooth
// uncertainty band (logistic distribution) around the hour's final speed
// estimate (`speed_kt` — already fully calibrated/adjusted), rather than a
// hard in/out vote across 2-4 model values. The old vote-based version could
// swing from 0% to 50% to 0% across three adjacent, steadily-building
// thermal hours whenever the point estimate crossed a range boundary by a
// fraction of a knot, or when a particular hour's calibrated model set
// happened to have fewer live model values than its neighbors — a vote
// count isn't the right tool for "how confident are we the true value is in
// this band" when the estimate itself already carries real uncertainty.
// Sigma (the band's width) comes from the regime's base uncertainty, widened
// by how much the raw models actually disagreed this hour (`raw_models`,
// which — unlike `models` — always holds all 4 raw values regardless of any
// calibration override), so a genuinely uncertain hour gets a wider, softer
// curve and a well-agreed hour gets a tighter, more decisive one.
export function probabilityInRange(hourResult, lo, hi) {
  const center = hourResult.speed_kt;
  if (center == null) return { probability: 0, confidence: 0 };

  // Sigma (band width) needs a few different treatments. For a *calibrated*
  // hour (Squamish-family thermal), a big gap between the raw coarse models
  // and GEM/HRDPS is the expected signature of the phenomenon itself (see
  // calibrateSquamishThermal) — punishing that spread as "uncertainty" would
  // undercut exactly the events this calibration exists to call with
  // confidence. Sizing the band relative to the *point estimate* (the old
  // ±22%-of-center approach) had a hidden problem though: it made sigma grow
  // with the estimate itself, so the flagship spot could never post "good
  // odds" (>=65%) even on a picture-perfect thermal day, no matter which
  // knot range a rider picked — the band was always wider than any
  // reasonable preset. Sizing sigma relative to the *user's chosen range*
  // instead fixes that directly: a well-centered estimate now reliably
  // clears the green threshold regardless of range width, while an estimate
  // near the edge of the range (genuinely more marginal) still correctly
  // scores lower. Every other regime still widens with genuine raw-model
  // disagreement, since there all models are on equal footing — except a
  // trigger-fired hour (reference station / Pam Rocks threshold), which
  // isn't really "multiple models agreeing," just a floor value substituted
  // in — that gets a wider base sigma so it doesn't read as more certain
  // than it actually is.
  let sigma;
  if (hourResult.calibrated) {
    sigma = Math.max(1.6, (hi - lo) / 4.5);
  } else {
    const rawVals = Object.values(hourResult.raw_models || {}).filter(v => v != null);
    const rawSpread = rawVals.length >= 2 ? Math.max(...rawVals) - Math.min(...rawVals) : 0;
    const triggered = hourResult.reference_triggered || hourResult.pam_rocks_triggered ||
      hourResult.live_reference_triggered || hourResult.marine_anchored;
    const baseSigma = triggered ? 4 : (REGIME_BASE_SIGMA[hourResult.regime] ?? 3);
    sigma = Math.max(baseSigma, rawSpread * 0.4, 1.5);
  }

  // P(lo <= true value <= hi) = F(hi) - F(lo) under the logistic band.
  let probability = logisticCdf(hi, center, sigma) - logisticCdf(lo, center, sigma);
  probability = Math.min(probability, 0.92); // never claim near-total certainty

  // Confidence: how much to trust the probability figure above. Pattern
  // match (regime detected + right season/hour/direction) is worth more
  // here than raw numeric spread, because spread is *expected* to be large
  // on a pure-thermal hour that only the fine model sees.
  let confidence;
  if (hourResult.regime === "thermal") {
    confidence = (hourResult.fine_vs_coarse_gap != null && hourResult.fine_vs_coarse_gap > 5) ? 0.55 : 0.8;
  } else if (hourResult.regime === "outflow") {
    confidence = (hourResult.fine_vs_coarse_gap != null && Math.abs(hourResult.fine_vs_coarse_gap) > 6) ? 0.65 : 0.85;
  } else if (hourResult.regime === "synoptic") {
    confidence = 0.55 + hourResult.model_agreement * 0.35;
  } else if (hourResult.regime === "calm") {
    confidence = 0.75; // models agreeing on "nothing happening" is itself reliable
  } else {
    confidence = 0.35 + hourResult.model_agreement * 0.2;
  }
  if (hourResult.reference_triggered || hourResult.pam_rocks_triggered) confidence = Math.max(confidence, 0.7);
  // A live reading at a nearby station is the strongest single signal we have
  // for "right now" — stronger than any model agreement, since it's an actual
  // observation rather than a forecast.
  if (hourResult.live_reference_triggered) confidence = Math.max(confidence, 0.8);
  // EC's forecasters explicitly identifying the pattern is worth more than
  // model consensus on a gradient day, but it's still a zone-wide forecast
  // rather than a spot-specific one — a solid floor, not near-certainty.
  if (hourResult.marine_anchored) confidence = Math.max(confidence, 0.72);
  if (hourResult.pressure_support === true) confidence = Math.min(1, confidence + 0.12);
  if (hourResult.pressure_support === false) confidence *= 0.8;
  if (hourResult.pam_rocks_support === true) confidence = Math.min(1, confidence + 0.1);
  if (hourResult.pam_rocks_support === false) confidence *= 0.9;
  // Extra adjustments layered on top of the generic support/caution above:
  // the "tell band" is a specifically validated signal (see classifyHour),
  // worth more than a generic supportive reading; a head-fake is worse than
  // a merely-not-yet-supportive one, since it's actively misleading rather
  // than just inconclusive.
  if (hourResult.pam_rocks_tell === true) confidence = Math.min(1, confidence + 0.08);
  if (hourResult.pam_rocks_head_fake === true) confidence *= 0.85;
  if (hourResult.upper_suppression === true) confidence *= 0.75;
  if (!hourResult.favorable_direction) confidence *= 0.7;

  return {
    probability: Math.round(Math.max(0, Math.min(1, probability)) * 100),
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100),
  };
}

export function localHourAndMonth(isoTime) {
  // isoTime like "2026-08-12T14:00" already in America/Los_Angeles from the API.
  const d = new Date(isoTime);
  return { hour: d.getHours ? Number(isoTime.slice(11, 13)) : null, month: Number(isoTime.slice(5, 7)) };
}

// "2026-08-13T14:00" for the current instant, in America/Los_Angeles —
// matches the local-time format Open-Meteo's hourly.time array uses, so it
// can be looked up directly against a spot's `hours` array. Used by the
// live-observation verification check (see generate.mjs) to find "the
// forecast for right now."
export function currentPacificHourString(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

// Plain-English hypothesis for why a live observation and the forecast for
// that same hour disagree by 20%+ — leans on signals the rule engine already
// computed (regime, model agreement/spread, MSLP support) rather than
// inventing anything new, so it's an honest explanation, not a guess.
// `errorPct` is (live - forecast) / forecast, e.g. 0.35 = live ran 35% hot.
export function explainMismatch(hourResult, errorPct) {
  const direction = errorPct > 0 ? "under" : "over";
  const notes = [];
  if (hourResult.regime === "thermal") {
    notes.push(direction === "under"
      ? "Forecast called a thermal but under-shot its strength — even after the local calibration, coarse models can still lag on an unusually strong thermal day."
      : "Forecast called a thermal that came in weaker than shown — possible early suppression (heat, high cloud) or the gradient not fully developing.");
  } else if (hourResult.regime === "outflow") {
    notes.push(direction === "under"
      ? "Forecast called outflow but under-shot it — the real pressure gradient may be stronger than the reference stations captured."
      : "Forecast called outflow that came in weaker than shown — outflow events can relax faster than models show once the synoptic pattern eases.");
  } else if (hourResult.regime === "calm" || hourResult.regime === "mixed") {
    notes.push(direction === "under"
      ? "Forecast showed calm/mixed but live wind is running well above that — likely an unmodeled local effect or a synoptic push none of the current signals caught."
      : "Forecast showed calm/mixed and live wind came in lighter still — models were on the right track, just a bit high.");
  } else {
    notes.push(`Synoptic regime, but the magnitude missed — model agreement was ${Math.round((hourResult.model_agreement ?? 0) * 100)}%, so spread between models likely explains some of the gap.`);
  }
  if (hourResult.pressure_support === false) notes.push("MSLP had already flagged this hour as uncertain.");
  if (hourResult.fine_vs_coarse_gap != null && Math.abs(hourResult.fine_vs_coarse_gap) > 5) {
    notes.push("Models disagreed sharply with each other, a known low-confidence signature.");
  }
  if (hourResult.calibrated) notes.push("This hour already had the Squamish field calibration applied.");
  if (hourResult.feedback_adjusted) notes.push("This hour already had a rider-feedback adjustment applied.");
  return notes.join(" ");
}

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
const SQUAMISH_THERMAL_MULTIPLIER = 2.85;

function calibrateSquamishThermal(coarseMeanKt) {
  if (coarseMeanKt == null || coarseMeanKt <= 0) return null;
  return coarseMeanKt * SQUAMISH_THERMAL_MULTIPLIER;
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
function circularMeanDeg(degs) {
  if (!degs.length) return null;
  let x = 0, y = 0;
  for (const d of degs) { const r = d * Math.PI / 180; x += Math.cos(r); y += Math.sin(r); }
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
// not a forecast time series. Used as a same-day nowcast booster for
// Squamish-family thermal spots.
// Returns { regime, reason, direction_deg, speed_kt, gust_kt, agreement }
export function classifyHour(spot, row, localHour, month, refSpeedKt = null, pressureGradients = null, overrideRecord = null, pamRocksNow = null) {
  const speedVals = Object.values(row.speeds).filter(v => v != null);
  const dirVals = Object.values(row.dirs).filter(v => v != null);
  const cloudVals = Object.values(row.cloud).filter(v => v != null);
  const radiationVals = Object.values(row.radiation || {}).filter(v => v != null);

  const speed_kt = mean(speedVals);
  const gust_kt = mean(Object.values(row.gusts).filter(v => v != null));
  const direction_deg = circularMeanDeg(dirVals);
  const cloud_pct = mean(cloudVals);
  const radiation_wm2 = radiationVals.length ? mean(radiationVals) : null;
  const upperSpeedVals = Object.values(row.upperSpeeds || {}).filter(v => v != null);
  const upperDirVals = Object.values(row.upperDirs || {}).filter(v => v != null);
  const upper_speed_kt = upperSpeedVals.length ? mean(upperSpeedVals) : null;
  const upper_direction_deg = upperDirVals.length ? circularMeanDeg(upperDirVals) : null;

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
  // it already folds in cloud, sun angle and time of day. Prefer it when a
  // model provides it; fall back to the cruder cloud threshold otherwise.
  // ~250 W/m² is a rough "meaningfully sunny at Squamish midday" cutoff, a
  // heuristic like the rest of this file, not a fitted value.
  const SUNNY_RADIATION_WM2 = 250;
  const sunny = radiation_wm2 != null ? radiation_wm2 >= SUNNY_RADIATION_WM2 : (cloud_pct != null ? cloud_pct < 55 : true);
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
  if (regime === "thermal" && spot.thermal && spot.thermal.calibrated && coarseMean != null) {
    const calibratedSpeed = calibrateSquamishThermal(coarseMean);
    if (calibratedSpeed != null) {
      calibrated = true;
      // Blend the calibrated coarse-model estimate with GEM/HRDPS's own
      // (already partially-resolved) number, leaning toward whichever reads
      // higher — both are known to undercall this specific thermal, not
      // overcall it.
      displaySpeed = row.speeds.gem != null ? Math.max(calibratedSpeed, row.speeds.gem) : calibratedSpeed;
      displayGust = displaySpeed * 1.3;
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
  let pamRocksSupport = null;
  if (spot.pamRocksAware && regime === "thermal" && pamRocksNow &&
      pamRocksNow.speedKt != null && pamRocksNow.directionDeg != null) {
    const component = pamRocksInflowComponent(pamRocksNow.speedKt, pamRocksNow.directionDeg);
    if (component != null) {
      pamRocksSupport = component >= 6;
      reason += pamRocksSupport
        ? ` Pam Rocks (sound's mouth) is reading ~${Math.round(pamRocksNow.speedKt)}kt from ${degToLabel(pamRocksNow.directionDeg)} right now — already showing strong SW inflow, a good real-time sign for this thermal.`
        : ` Pam Rocks (sound's mouth) isn't yet showing strong SW inflow (~${Math.round(pamRocksNow.speedKt)}kt from ${degToLabel(pamRocksNow.directionDeg)}) — this thermal may not have fully kicked in yet.`;
    }
  }

  // Reference-station trigger: some spots are better predicted by whether a
  // nearby exposed gauge point is already reading above a threshold than by
  // their own local model output — e.g. Erwin Park (Point Roberts) tends to
  // turn on once Point Atkinson, the Strait of Georgia entrance station, is
  // above ~16-18kt, per local rider knowledge. Only steps in when the
  // ordinary classification came up empty (calm/mixed); if the spot's own
  // thermal/outflow/synoptic logic already found something, we just add a
  // corroborating note rather than override it.
  let referenceTriggered = false;
  if (spot.referenceStation && refSpeedKt != null && refSpeedKt >= spot.referenceStation.thresholdKt) {
    referenceTriggered = true;
    const rs = spot.referenceStation;
    if (regime === "calm" || regime === "mixed") {
      regime = "synoptic";
      displaySpeed = Math.max(displaySpeed ?? 0, rs.thresholdKt);
      displayGust = displaySpeed * 1.3;
      reason = `${rs.name} is reading ~${Math.round(refSpeedKt)}kt, above this spot's ${rs.thresholdKt}kt trigger. ${rs.note}`;
    } else {
      reason += ` Also corroborated by ${rs.name} reading ~${Math.round(refSpeedKt)}kt, above its ${rs.thresholdKt}kt trigger for this spot.`;
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
    favorable_direction: favorable,
    model_agreement: Math.round(agreement * 100) / 100,
    fine_vs_coarse_gap: fine_vs_coarse_gap != null ? Math.round(fine_vs_coarse_gap * 10) / 10 : null,
    calibrated,
    reference_triggered: referenceTriggered,
    pressure_support: pressureSupport,
    upper_suppression: upperSuppression,
    pam_rocks_support: pamRocksSupport,
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

  // Sigma (band width) needs two different treatments. For a *calibrated*
  // hour (Squamish-family thermal), a big gap between the raw coarse models
  // and GEM/HRDPS is the expected signature of the phenomenon itself (see
  // calibrateSquamishThermal) — punishing that spread as "uncertainty" would
  // undercut exactly the events this calibration exists to call with
  // confidence, and since the spread itself varies hour to hour it also
  // re-introduces the jagged, cliff-y feel this function is meant to avoid.
  // So calibrated hours get a fixed relative band (±~22% of the estimate)
  // instead. Every other regime still widens with genuine raw-model
  // disagreement, since there all models are on equal footing.
  let sigma;
  if (hourResult.calibrated) {
    sigma = Math.max(2.5, center * 0.22);
  } else {
    const rawVals = Object.values(hourResult.raw_models || {}).filter(v => v != null);
    const rawSpread = rawVals.length >= 2 ? Math.max(...rawVals) - Math.min(...rawVals) : 0;
    const baseSigma = REGIME_BASE_SIGMA[hourResult.regime] ?? 3;
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
  if (hourResult.reference_triggered) confidence = Math.max(confidence, 0.7);
  if (hourResult.pressure_support === true) confidence = Math.min(1, confidence + 0.12);
  if (hourResult.pressure_support === false) confidence *= 0.8;
  if (hourResult.pam_rocks_support === true) confidence = Math.min(1, confidence + 0.1);
  if (hourResult.pam_rocks_support === false) confidence *= 0.9;
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

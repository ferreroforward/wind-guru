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
  const hourly = ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "cloud_cover", "pressure_msl", "precipitation", "temperature_2m"].join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourly}&models=${models}&wind_speed_unit=kn&timezone=America%2FLos_Angeles&forecast_days=${days}`;
}

// Reshape Open-Meteo's multi-model response (one array per variable per
// model, keyed like "wind_speed_10m_gem_seamless") into per-hour records:
// [{ time, speeds:{gfs,ecmwf,icon,gem}, gusts:{...}, dirs:{...}, cloud:{...}, pressure:{...}, precip:{...}, temp:{...} }, ...]
export function reshapeOpenMeteo(json) {
  const hourly = json.hourly || {};
  const time = hourly.time || [];
  const rows = time.map((t) => ({ time: t, speeds: {}, gusts: {}, dirs: {}, cloud: {}, pressure: {}, precip: {}, temp: {} }));

  for (const m of MODELS) {
    const sKey = `wind_speed_10m_${m.param}`;
    const gKey = `wind_gusts_10m_${m.param}`;
    const dKey = `wind_direction_10m_${m.param}`;
    const cKey = `cloud_cover_${m.param}`;
    const pKey = `pressure_msl_${m.param}`;
    const rKey = `precipitation_${m.param}`;
    const tKey = `temperature_2m_${m.param}`;
    const s = hourly[sKey], g = hourly[gKey], d = hourly[dKey], c = hourly[cKey], p = hourly[pKey], r = hourly[rKey], t = hourly[tKey];
    rows.forEach((row, i) => {
      if (s && s[i] != null) row.speeds[m.key] = s[i];
      if (g && g[i] != null) row.gusts[m.key] = g[i];
      if (d && d[i] != null) row.dirs[m.key] = d[i];
      if (c && c[i] != null) row.cloud[m.key] = c[i];
      if (p && p[i] != null) row.pressure[m.key] = p[i];
      if (r && r[i] != null) row.precip[m.key] = r[i];
      if (t && t[i] != null) row.temp[m.key] = t[i];
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

// Classify one hour's regime for one spot, given the row of model values.
// `refSpeedKt`, if provided, is the best-estimate wind speed at this same
// hour from the spot's reference station (see spot.referenceStation) — used
// for spots where a nearby well-exposed gauge point is a better predictor
// than the spot's own local model output (e.g. Erwin Park vs Point
// Atkinson).
// `pressureGradients`, if provided, is { largeScale, local } in hPa for
// Howe Sound spots (see spot.pressureGradientAware) — positive favors
// inflow/thermal, negative favors outflow.
// `overrideMultiplier`, if provided, is a rider-feedback-learned correction
// for this spot (see scripts/apply-feedback.mjs / data/calibration-overrides.json).
// Returns { regime, reason, direction_deg, speed_kt, gust_kt, agreement }
export function classifyHour(spot, row, localHour, month, refSpeedKt = null, pressureGradients = null, overrideMultiplier = null) {
  const speedVals = Object.values(row.speeds).filter(v => v != null);
  const dirVals = Object.values(row.dirs).filter(v => v != null);
  const cloudVals = Object.values(row.cloud).filter(v => v != null);

  const speed_kt = mean(speedVals);
  const gust_kt = mean(Object.values(row.gusts).filter(v => v != null));
  const direction_deg = circularMeanDeg(dirVals);
  const cloud_pct = mean(cloudVals);

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
  const sunny = cloud_pct != null ? cloud_pct < 55 : true;
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
    reason = `${thermalCfg.note.split(".")[0]}.${meshNote}`;
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
  // a per-spot multiplier learned from "Report actual conditions" issues,
  // applied on top of everything above. Scales the model votes too, so
  // probabilityInRange's weighted count reflects it automatically.
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

  return {
    time: row.time,
    speed_kt: displaySpeed != null ? Math.round(displaySpeed * 10) / 10 : null,
    gust_kt: displayGust != null ? Math.round(displayGust * 10) / 10 : null,
    direction_deg: direction_deg != null ? Math.round(direction_deg) : null,
    direction_label: degToLabel(direction_deg),
    cloud_pct: cloud_pct != null ? Math.round(cloud_pct) : null,
    regime,
    reason,
    favorable_direction: favorable,
    model_agreement: Math.round(agreement * 100) / 100,
    fine_vs_coarse_gap: fine_vs_coarse_gap != null ? Math.round(fine_vs_coarse_gap * 10) / 10 : null,
    calibrated,
    reference_triggered: referenceTriggered,
    pressure_support: pressureSupport,
    feedback_adjusted: feedbackAdjusted,
    models: displayModels,
    raw_models: row.speeds,
  };
}

// Per-regime model weights used when scoring probability. BC's coastal
// terrain (Howe Sound's walls, the Fraser Valley funnel) is only resolved
// by the ~2.5km GEM/HRDPS nest — GFS (13-25km) and ECMWF (25km) routinely
// under- or mis-forecast thermal and outflow events there, so we lean on
// the fine model more heavily for exactly those two regimes. For general
// synoptic/gradient wind, all models tend to agree and get equal weight.
function regimeWeights(regime) {
  if (regime === "thermal" || regime === "outflow") {
    return { gfs: 1, ecmwf: 1, icon: 1.3, gem: 2.5 };
  }
  return { gfs: 1, ecmwf: 1, icon: 1, gem: 1 };
}

// Probability that the true wind lands in [lo, hi] kt, using a weighted
// vote across models (see regimeWeights), then a separate confidence score
// for how much to trust that probability.
export function probabilityInRange(hourResult, lo, hi) {
  const models = hourResult.models || {};
  const weights = regimeWeights(hourResult.regime);
  let weightedIn = 0, weightSum = 0, vals = [];
  for (const [key, v] of Object.entries(models)) {
    if (v == null) continue;
    const w = weights[key] ?? 1;
    weightSum += w;
    vals.push(v);
    if (v >= lo && v <= hi) weightedIn += w;
  }
  if (!weightSum) return { probability: 0, confidence: 0 };
  let probability = weightedIn / weightSum;

  // Soften hard 0%/100% when the mean is close to a boundary — a small
  // model ensemble shouldn't claim false precision.
  const meanV = mean(vals);
  if (meanV != null) {
    const distToRange = meanV < lo ? lo - meanV : (meanV > hi ? meanV - hi : 0);
    if (distToRange > 0) {
      const falloff = Math.max(0, 1 - distToRange / 8);
      probability = Math.max(probability, 0.15 * falloff);
    } else if (probability >= 0.99) {
      probability = 0.9; // never claim absolute certainty
    }
  }

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

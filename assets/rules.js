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
  const hourly = ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "cloud_cover", "pressure_msl"].join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${hourly}&models=${models}&wind_speed_unit=kn&timezone=America%2FLos_Angeles&forecast_days=${days}`;
}

// Reshape Open-Meteo's multi-model response (one array per variable per
// model, keyed like "wind_speed_10m_gem_seamless") into per-hour records:
// [{ time, speeds:{gfs,ecmwf,icon,gem}, gusts:{...}, dirs:{...}, cloud:{...}, pressure:{...} }, ...]
export function reshapeOpenMeteo(json) {
  const hourly = json.hourly || {};
  const time = hourly.time || [];
  const rows = time.map((t) => ({ time: t, speeds: {}, gusts: {}, dirs: {}, cloud: {}, pressure: {} }));

  for (const m of MODELS) {
    const sKey = `wind_speed_10m_${m.param}`;
    const gKey = `wind_gusts_10m_${m.param}`;
    const dKey = `wind_direction_10m_${m.param}`;
    const cKey = `cloud_cover_${m.param}`;
    const pKey = `pressure_msl_${m.param}`;
    const s = hourly[sKey], g = hourly[gKey], d = hourly[dKey], c = hourly[cKey], p = hourly[pKey];
    rows.forEach((row, i) => {
      if (s && s[i] != null) row.speeds[m.key] = s[i];
      if (g && g[i] != null) row.gusts[m.key] = g[i];
      if (d && d[i] != null) row.dirs[m.key] = d[i];
      if (c && c[i] != null) row.cloud[m.key] = c[i];
      if (p && p[i] != null) row.pressure[m.key] = p[i];
    });
  }
  return rows;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function circularMeanDeg(degs) {
  if (!degs.length) return null;
  let x = 0, y = 0;
  for (const d of degs) { const r = d * Math.PI / 180; x += Math.cos(r); y += Math.sin(r); }
  let ang = Math.atan2(y, x) * 180 / Math.PI;
  return ang < 0 ? ang + 360 : ang;
}

// Classify one hour's regime for one spot, given the row of model values.
// Returns { regime, reason, direction_deg, speed_kt, gust_kt, agreement }
export function classifyHour(spot, row, localHour, month) {
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

  // Pressure gradient proxy: fine-model pressure at this spot vs. the
  // coarse global model's pressure at the same spot. Not a substitute for
  // a real synoptic map, but a cheap same-request signal of how "gradient
  // driven" vs "local" the flow is likely to be.
  const gemP = row.pressure.gem, gfsP = row.pressure.gfs;
  const pressureSpread = (gemP != null && gfsP != null) ? Math.abs(gemP - gfsP) : null;

  let regime = "calm", reason = "Light and variable — no clear driver.";
  const sunny = cloud_pct != null ? cloud_pct < 55 : true;
  const inHourWindow = (w) => localHour >= w[0] && localHour <= w[1];

  const thermalCfg = spot.thermal;
  const outflowCfg = spot.outflow;

  const looksThermal = thermalCfg && thermalCfg.enabled &&
    thermalCfg.months.includes(month) &&
    inHourWindow(thermalCfg.hourWindow) &&
    sunny &&
    direction_deg != null && inSector(direction_deg, thermalCfg.dirSector) &&
    speed_kt != null && speed_kt >= 6;

  const looksOutflow = outflowCfg && outflowCfg.enabled &&
    direction_deg != null && inSector(direction_deg, outflowCfg.dirSector) &&
    speed_kt != null && speed_kt >= 10;

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
  } else if (speed_kt != null && speed_kt < 6) {
    regime = "calm";
    reason = "Forecast light — under 6kt across models.";
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
  if (row.speeds.gem != null) {
    const coarse = mean([row.speeds.gfs, row.speeds.ecmwf].filter(v => v != null));
    if (coarse != null) fine_vs_coarse_gap = row.speeds.gem - coarse;
  }

  return {
    time: row.time,
    speed_kt: speed_kt != null ? Math.round(speed_kt * 10) / 10 : null,
    gust_kt: gust_kt != null ? Math.round(gust_kt * 10) / 10 : null,
    direction_deg: direction_deg != null ? Math.round(direction_deg) : null,
    direction_label: degToLabel(direction_deg),
    cloud_pct: cloud_pct != null ? Math.round(cloud_pct) : null,
    regime,
    reason,
    favorable_direction: favorable,
    model_agreement: Math.round(agreement * 100) / 100,
    fine_vs_coarse_gap: fine_vs_coarse_gap != null ? Math.round(fine_vs_coarse_gap * 10) / 10 : null,
    models: row.speeds,
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

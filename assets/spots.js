// Wind Guru — spot database for the Strait of Georgia / Howe Sound / Metro Vancouver region.
// Each spot encodes the local meteorology needed by rules.js to tell thermal wind
// apart from synoptic/gradient wind, and to flag onshore vs offshore direction risk.
//
// regime types a spot can exhibit:
//   "thermal"   — local heating-driven wind (sea breeze / valley inflow), needs sun + weak gradient
//   "outflow"   — cold-air drainage / gap wind down a valley, gradient-driven, any time of day
//   "synoptic"  — general Strait of Georgia gradient wind ahead of / behind a front
//
// favorable_deg: [start,end] compass sector(s) considered rideable / safe onshore-to-cross-shore.
// Directions outside this sector are flagged as "offshore / not rideable" even if speed matches.

export const SPOTS = [
  {
    id: "squamish-spit",
    name: "Squamish Spit",
    region: "Howe Sound",
    lat: 49.7168, lon: -123.1682,
    sports: ["wingfoil", "kite", "windsurf"],
    level: "advanced",
    favorable_deg: [[150, 260]], // S–SW thermal inflow, or N outflow (handled separately as outflow regime)
    outflow_favorable_deg: [[300, 40]],
    thermal: {
      enabled: true,
      calibrated: true, // apply the local GFS-class-underread correction — see rules.js
      months: [4,5,6,7,8,9,10],
      hourWindow: [10, 19],
      dirSector: [150, 260], // S–SW up-sound
      note: "Classic Squamish summer thermal: valley heats, draws air up Howe Sound from the south. Builds late morning, peaks early-mid afternoon, dies at sunset. Needs sun + weak synoptic gradient — a mesoscale effect coarse global models often under-forecast."
    },
    outflow: {
      enabled: true,
      dirSector: [300, 40], // N–NNW outflow down-sound
      note: "Squamish outflow: cold, dense interior air drains down Howe Sound from the north. Gradient-driven, can occur any hour, often strong (20kt+) and gusty. Associated with high pressure building inland or a cold post-frontal airmass."
    }
  },
  {
    id: "porteau-cove",
    name: "Porteau Cove",
    region: "Howe Sound",
    lat: 49.5606, lon: -123.2394,
    sports: ["windsurf", "wingfoil"],
    level: "intermediate",
    favorable_deg: [[300, 40]],
    thermal: { enabled: false },
    outflow: {
      enabled: true,
      dirSector: [300, 40],
      note: "Mid-Howe Sound outflow/gap-wind site — picks up the same north drainage flow as Squamish, usually a touch lighter and more consistent, less gusty than the Spit."
    }
  },
  {
    id: "furry-creek",
    name: "Furry Creek",
    region: "Howe Sound",
    lat: 49.5983, lon: -123.2103,
    sports: ["windsurf", "wingfoil"],
    level: "intermediate",
    favorable_deg: [[300, 40], [150, 260]],
    thermal: {
      enabled: true,
      calibrated: true, // same Howe Sound thermal system as Squamish Spit — see rules.js
      months: [5,6,7,8,9],
      hourWindow: [11, 18],
      dirSector: [150, 260],
      note: "Secondary thermal channel between Squamish and Porteau — weaker and less reliable than the Spit; best on strong-thermal days."
    },
    outflow: {
      enabled: true,
      dirSector: [300, 40],
      note: "Also exposed to Howe Sound outflow events."
    }
  },
  {
    id: "jericho",
    name: "Jericho Beach",
    region: "English Bay",
    lat: 49.2718, lon: -123.1934,
    sports: ["windsurf", "wingfoil", "kite"],
    level: "beginner-friendly",
    favorable_deg: [[230, 320]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [11, 19],
      dirSector: [250, 300], // W/WNW sea breeze
      note: "English Bay sea breeze: sunny days with a weak gradient draw a westerly thermal onshore in the afternoon. Sheltered, flatter water — good learning venue."
    },
    outflow: { enabled: false }
  },
  {
    id: "spanish-banks",
    name: "Spanish Banks",
    region: "English Bay",
    lat: 49.2764, lon: -123.2042,
    sports: ["windsurf", "wingfoil", "kite"],
    level: "intermediate",
    favorable_deg: [[230, 320]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [11, 19],
      dirSector: [250, 300],
      note: "Same westerly sea breeze as Jericho next door, slightly more open water and current from the North Arm of the Fraser at low tide."
    },
    outflow: { enabled: false }
  },
  {
    id: "iona",
    name: "Iona Beach / Jetty",
    region: "Fraser Delta",
    lat: 49.2119, lon: -123.1994,
    sports: ["kite", "windsurf", "wingfoil"],
    level: "intermediate",
    favorable_deg: [[180, 300]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [11, 19],
      dirSector: [260, 300],
      note: "Picks up the same sea breeze as Jericho/Spanish Banks, but is more open to the Strait, so it also runs on general SW–W synoptic gradient wind, not just thermal."
    },
    outflow: { enabled: false }
  },
  {
    id: "boundary-bay",
    name: "Boundary Bay (Centennial Beach)",
    region: "South Delta",
    lat: 49.0075, lon: -123.0505,
    sports: ["kite", "wingfoil", "windsurf"],
    level: "beginner-friendly",
    favorable_deg: [[150, 260]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [12, 19],
      dirSector: [220, 260],
      note: "Shallow bay warms fast and drives a modest SW afternoon sea breeze on its own, on top of whatever synoptic southerly is already blowing."
    },
    outflow: { enabled: false },
    synoptic_note: "Boundary Bay's biggest days are usually synoptic — a strong S–SSE gradient wind ahead of an approaching frontal system funnels straight up the bay. Check the synoptic regime tag, not just the thermal one."
  },
  {
    id: "white-rock",
    name: "White Rock / Crescent Beach",
    region: "South Delta",
    lat: 49.0246, lon: -122.8047,
    sports: ["kite", "wingfoil"],
    level: "beginner-friendly",
    favorable_deg: [[150, 260]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [12, 19],
      dirSector: [220, 260],
      note: "Same shallow south-facing exposure as Boundary Bay, a few km east — thermal and synoptic southerlies both work here."
    },
    outflow: { enabled: false }
  },
  {
    id: "erwin-park",
    name: "Erwin Park",
    region: "Point Roberts",
    lat: 48.9740, lon: -123.0850, // approximate — west side of the Point Roberts peninsula
    sports: ["windsurf", "wingfoil", "kite"],
    level: "intermediate",
    favorable_deg: [[150, 280]],
    thermal: {
      enabled: true,
      months: [4,5,6,7,8,9],
      hourWindow: [12, 19],
      dirSector: [220, 260],
      note: "Same south/southwest sea-breeze exposure as Boundary Bay and White Rock nearby."
    },
    outflow: { enabled: false },
    // Local rider rule of thumb: Erwin Park tends to turn on once Point
    // Atkinson (the Strait of Georgia entrance station, a good gauge of
    // broader synoptic push) is reading above roughly 16-18kt — often a
    // better predictor than the spot's own local model output.
    referenceStation: {
      name: "Point Atkinson",
      lat: 49.3300, lon: -123.2650,
      thresholdKt: 17,
      note: "Typically means enough synoptic push in the Strait for Erwin Park to be working, even if the local forecast alone looks marginal."
    }
  }
];

export const DEG_LABELS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

export function degToLabel(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return "—";
  const ix = Math.round(((deg % 360) / 22.5)) % 16;
  return DEG_LABELS[ix];
}

export function inSector(deg, sector) {
  if (deg === null || deg === undefined || isNaN(deg)) return false;
  const [a, b] = sector;
  if (a <= b) return deg >= a && deg <= b;
  return deg >= a || deg <= b; // wraps through 360/0
}

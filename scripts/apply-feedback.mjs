#!/usr/bin/env node
// Wind Guru — feedback-to-calibration pipeline.
// Reads user-submitted "wind-report" GitHub issues (forecast vs actual),
// computes a per-spot bias multiplier, and writes
// data/calibration-overrides.json. generate.mjs reads that file and applies
// the multiplier on top of its normal calibration for any spot with enough
// reports. Run before generate.mjs (see .github/workflows/update-forecast.yml),
// or manually: `node scripts/apply-feedback.mjs`.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "calibration-overrides.json");

// Edit these if the repo ever moves.
const OWNER = "ferreroforward";
const REPO = "wind-guru";

const MIN_SAMPLES = 2; // don't adjust a spot on a single report
const MAX_REPORTS_PER_SPOT = 20; // weight toward recent reports
const MULTIPLIER_CLAMP = [0.75, 1.5]; // never let one bad/joke report send this wild

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractField(body, exactLabel) {
  // GitHub issue-form bodies render each field as "### Label\n\nvalue\n\n".
  // Fields left blank render as "_No response_". Match on the exact,
  // short label text used in wind-report.yml (see there) — escaped so any
  // regex-special characters in the label (parentheses, etc.) are literal.
  const re = new RegExp(`###\\s*${escapeRegex(exactLabel)}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const val = m[1].trim();
  return (!val || /^_no response_$/i.test(val)) ? null : val;
}

async function fetchReports() {
  const headers = { "User-Agent": "wind-guru-agent/1.0", "Accept": "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/issues?labels=wind-report&state=all&per_page=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GitHub API fetch failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const issues = await res.json();
  return issues.filter((i) => !i.pull_request); // issues endpoint also returns PRs
}

async function main() {
  console.log(`Fetching wind-report issues from ${OWNER}/${REPO}...`);
  const issues = await fetchReports();
  console.log(`Found ${issues.length} labeled issue(s).`);

  const bySpot = {};
  for (const issue of issues) {
    const body = issue.body || "";
    const spot = extractField(body, "Spot");
    const forecasted = parseFloat(extractField(body, "Forecasted speed (kt)"));
    const actual = parseFloat(extractField(body, "Actual speed (kt)"));
    if (!spot || !isFinite(forecasted) || !isFinite(actual) || forecasted <= 0) {
      console.log(`  Skipping issue #${issue.number} — couldn't parse spot/forecasted/actual.`);
      continue;
    }
    (bySpot[spot] ||= []).push({ issue: issue.number, date: issue.created_at, forecasted, actual, ratio: actual / forecasted });
  }

  const overrides = {};
  for (const [spot, reports] of Object.entries(bySpot)) {
    const recent = reports
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, MAX_REPORTS_PER_SPOT);
    if (recent.length < MIN_SAMPLES) {
      console.log(`  ${spot}: only ${recent.length} report(s), below minimum of ${MIN_SAMPLES} — no adjustment.`);
      continue;
    }
    const avgRatio = recent.reduce((sum, r) => sum + r.ratio, 0) / recent.length;
    const multiplier = Math.max(MULTIPLIER_CLAMP[0], Math.min(MULTIPLIER_CLAMP[1], avgRatio));
    overrides[spot] = {
      sample_size: recent.length,
      avg_ratio: Math.round(avgRatio * 100) / 100,
      multiplier: Math.round(multiplier * 100) / 100,
      note: `Based on ${recent.length} rider report${recent.length === 1 ? "" : "s"}: actual wind averaged ${Math.round(avgRatio * 100)}% of what was forecasted.`,
    };
    console.log(`  ${spot}: ${recent.length} reports, avg ratio ${avgRatio.toFixed(2)}, multiplier ${multiplier.toFixed(2)}`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    min_samples: MIN_SAMPLES,
    spots: overrides,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_PATH} (${Object.keys(overrides).length} spot(s) adjusted)`);
}

main().catch((err) => {
  console.error(err);
  // Don't fail the whole workflow if feedback processing breaks — the
  // forecast should still generate with whatever overrides existed before.
  process.exit(0);
});

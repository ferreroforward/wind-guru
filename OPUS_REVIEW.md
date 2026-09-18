# Wind Guru — Opus code review

Independent review of the forecast model, codebase, and frontend, run against the live repo and the committed forecast snapshot. Not implemented yet — this is a prioritized findings list to work through.

**Status note (Sep 2026):** several items below have since been implemented in the live code (the "Probability band"/"Plain-language summary"/"Offshore warning" README sections describe some of them) even though this file was never updated to mark them — don't assume an unmarked item is still open without checking the code. Items #1 and #11 are marked below as directly resolved this session, alongside a related fix that goes further than either originally proposed: the probability model moved from a closed [lo,hi] band to an open-ended "at least lo" floor, since a closed band was actively misleading (it could score a great, well-above-range wind day as a near-miss). See `probabilityInRange()` in `assets/rules.js` and the "Probability, as an open-ended floor" section in README.md.

## HIGH impact

1. ~~**Squamish can never show "good odds."**~~ **RESOLVED (Sep 2026).** Rather than just shrinking sigma, the probability model itself became open-ended (`probabilityInRange(hourResult, lo)` — "at least `lo` kt," not `[lo, hi]`), which fixes this and the closed-band problem described in #11 below at the same root cause. The uncertainty band for calibrated thermal hours (`assets/rules.js`) is always wider than any knot-range preset. Best possible score on a perfect Squamish thermal day: 54% (8–14), 51% (12–20), 46% (18–28), 48% (25–40). Green requires ≥65%, so the flagship spot is stuck in yellow forever. Fix: shrink sigma, or switch to "chance of at least X kt" instead of a closed band.

2. **A clear 6pm evening session gets flagged "doesn't match known pattern."** The thermal sun-gate uses a flat 250 W/m² radiation cutoff, but radiation falls with sun angle regardless of cloud — a clear sky at 18:00 in August delivers ~180-240 W/m², under the cutoff. Prime evening sessions fall off a cliff. Fix: compare radiation to that hour's clear-sky value (a ratio), or only apply the gate before ~3pm.

3. **The 2.85× Squamish multiplier has no ceiling.** It only covered 5-9kt modeled wind in the source field notes but applies with no cap — a 22kt coarse-model reading becomes 62.7kt with an 81.5kt gust. Cap the multiplier (e.g. taper it above ~10kt coarse).

4. **The self-calibration loop is learning from the two calmest hours of the day, and only from its failures.** The twice-daily Action runs at ~6:40am/8:05pm, so every live-verification entry is a near-calm hour where % error is noisy. Only mismatches ≥20% ever get logged, so the multiplier can never converge back to 1.0. Net effect: Boundary Bay/White Rock/Erwin Park are about to get a flat 0.75× applied to every hour of every day — including a 25kt frontal day — from a handful of 6am readings. Fix: raise the minimum forecast speed before comparing, log all comparisons (not just mismatches), and add a midday run.

5. **Wind direction averaging can invent a direction no model predicted.** It's an unweighted circular mean across 4 models — two models at 2kt from the north and two at 12-14kt from the south averages to 288° (WNW), missing both the thermal and outflow sectors, so the hour falls through to "mixed." Should be speed-weighted, or just use GEM/HRDPS's direction for the gate.

6. **The plain-English reasoning text — the app's whole differentiator — is never shown to anyone.** It's generated every run (a meaningful chunk of the forecast.json payload) but the tooltip only shows regime + speed. Same for the Environment Canada bulletin text, fetched and stored but only ever shown as a link.

7. **Offshore/unrideable wind can still show a big green percentage.** `favorable_direction` is computed but never read by the frontend — it only shaves an invisible internal "confidence" score, never the displayed probability. An offshore (dangerous) day at Jericho shows the same green as a perfect onshore day.

8. **A partial or empty forecast can get published silently.** If Open-Meteo rate-limits mid-run, a spot fetch failure is logged and skipped, then `data/forecast.json` is overwritten unconditionally — no "abort if too many spots failed" check.

9. **"Right now" live readings can be up to 12 hours old.** The live-check badge says "right now" but reflects whatever the 5am or 5pm snapshot captured. Should show the actual observation timestamp, or hide the badge once it's stale.

## MEDIUM impact

10. No automated tests on the ~620 lines of interacting thresholds in rules.js — everything in the HIGH list above is a logic bug a test suite would have caught, not a crash.
11. ~~"25+ Full send" scores near-zero on the biggest wind days~~ **RESOLVED (Sep 2026)** — every preset is now an open-ended floor (see #1), not just this one. (45kt → 8%, 55kt → 0%) since it's a closed 25-40 band. Make the top preset open-ended.
12. The calibration multiplier uses an arithmetic mean of ratios, which biases upward (two equal-and-opposite errors average to 1.25, not 1.0). Use a geometric mean.
13. Closing a bogus wind-report GitHub issue doesn't remove it from calibration (`state=all` in the query). Should be `state=open` plus sanity bounds on reported values.
14. Automated station checks (2x/day/spot) will drown out human rider reports within ~10 days given the 20-sample window. Weight or bucket the two sources separately.
15. One station (White Rock METAR) stands in for three spots up to 23km apart (Boundary Bay, White Rock, Erwin Park) — one bad reading skews all three.
16. Two of three live-station sources (EC, Squamish Windsports) have no staleness check — a frozen sensor would read as "live."
17. `observed_local_time` for igetwind stations is actually UTC, not local — off by 7-8 hours if ever displayed directly.
18. `forecast.json` is ~786KB, much of it unused by the browser (out-of-window hours, unused fields) — trimmable to roughly 150KB, also adds ~1.5MB/day to git history.
19. Line endings (CRLF working tree vs LF repo) make every git diff show 100% of files changed as whitespace noise. Add `.gitattributes` with `* text=auto eol=lf` and renormalize.
20. GitHub auto-disables scheduled workflows after 60 days of repo inactivity — combined with the feedback script always exiting 0 and no failure alerting, a dead pipeline could go unnoticed. Add a step that opens an issue on failure.
21. "Refresh live" (client-side) skips MSLP, Pam Rocks nowcast, and rider calibration, but still shows a reassuring green "Live — just fetched" badge — the fresher number is actually less accurate. Also doesn't check `res.ok`, so a rate-limit shows as "check your connection."
22. Rider-report parsing is coupled to exact GitHub issue-form label text — rewording a form label would silently drop every future report.
23. Trigger-fired hours (reference station, Pam Rocks trigger) show a hard-coded threshold/floor value as a confident-looking forecast (tight synoptic sigma) — reads like a real prediction but it's just a floor.
24. Leaflet is loaded from a CDN with no integrity hash — a two-attribute fix closes the only realistic path to third-party code running on the site.
25. The marine bulletin text-parsing end-anchor doesn't match — harmless today since the text isn't displayed (see #6), but would show visible HTML junk the moment it is.
26. The committed snapshot still contains the removed `furry-creek` spot (frontend just ignores it) — a simple CI sanity check (every current spot present, reasonable hour count/speed range) would catch this class of drift.
27. `confidence` is computed but never shown — a 70% backed by four agreeing models looks identical in the UI to a 70% flagged internally for suppression/no pressure support.

## LOW impact

28. Accessibility gaps: hour cells are unlabeled `<div>`s for screen readers, low-opacity direction text fails contrast minimums, no `aria-pressed` on toggle buttons.
29. No "now" marker or dimming of past hours in the hour strip.
30. One untrusted-input path: scraped EC text reaches `innerHTML` without explicit escaping (low risk since it's already tag-stripped upstream, but worth closing).
31. Minor dead code / stale comments (a redundant condition, an outdated comment about "weighted vote count," duplicate CSS media query block).
32. Outflow classification ignores season and pressure entirely — a light summer morning northerly gets the same "often strong and gusty" warning as a real winter outflow event.
33. Gust is fabricated as speed × 1.3 on calibrated hours, discarding the models' actual gust forecasts.
34. Missing meta description / Open Graph tags / favicon — a shared link renders as a bare URL.
35. The issue template doesn't mention that wind reports are public and tied to the reporter's GitHub handle.
36. README says the EC bulletin appears "as a banner above the map" — it's actually a link box at the bottom now.

## Top 5 if you only do five things

1. Fix the probability band — the best spot can't show green.
2. Fix the 6pm solar cutoff — kills prime evening sessions.
3. Cap the 2.85× multiplier — can print unsafe numbers like 60kt+.
4. Fix or pause the auto-calibration loop — about to apply a wrong 0.75× to three spots from calm-hour noise.
5. Display the `reason` text — the best part of the app is already built and nobody can see it.

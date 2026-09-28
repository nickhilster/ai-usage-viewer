# Changelog

All notable user-facing changes are documented here.

## Unreleased

## 0.5.1 - 2026-09-28

- Rename the extension to ChatGPT Usage Viewer across its UI, metadata, alerts, and store materials.

## 0.5.0 - 2026-09-28

- Add compact footer credits for nikdesign.ca and teambotics.app.
- Save Teambotic Inc as the package author and prepare a Web Store upload bundle and submission drafts.

## 0.4.0 - 2026-09-27

- Show the remaining 5-hour Codex capacity as a compact badge on ChatGPT pages. Open the badge for weekly capacity and refresh details.
- Remove local chat-message counting and its popup diagnostics while keeping Codex capacity monitoring and estimates.
- Preserve signed-in recovery through the extension-owned Analytics tab, including scheduled refreshes, and keep usage data in local extension storage.

## 0.3.4 - 2026-09-14

- Show an unavailable 5-hour limit as a compact row below the full-width weekly limit, without a disclosure. Keep available limits side by side.

## 0.3.3 - 2026-09-14

- Remove the Other limits disclosure and always show the 5-hour and weekly limits directly, including unavailable readings.

## 0.3.2 - 2026-09-14

- Remove the retired GPT-5.3-Codex-Spark 5-hour and weekly limits from page analysis, popup metrics, and capacity alerts, including previously stored observations. Hide Other limits when empty.

## 0.3.1 - 2026-09-09

- Prefix the installed version displayed in the popup footer with `v`.

## 0.3.0 - 2026-09-09

- Notify when confirmed remaining capacity increases below 100% or the reset date changes within the same browser session. Respect reset notification preferences, avoid duplicate full-reset alerts, and ignore normal countdown progression.

## 0.2.0 - 2026-09-06

- Show the installed extension version on the left of the popup footer, with the privacy note aligned right. Read the version directly from the extension manifest.
- Establish ongoing version updates for each product fix or feature; see `AGENTS.md` for the policy.

Version baseline: reviewed all 73 commits reachable from local refs through `0187f12`, including the initial release, refresh/parser and tab-lifecycle work, popup redesign, capacity alerts and startup refresh, refresh interval controls, credit/badge fixes, consumption estimates and follow-up corrections, and repository notification workflows. The only existing release tag is `v0.1.0`; the accumulated product features below warrant a minor increase to `0.2.0`. Merge commits and CI-only changes do not represent separate product releases. No intermediate historical versions or tags are invented.

- Shorten remaining-time tooltips to one sentence specific to the displayed limit.

- Preserve the last recent confirmed counter reading when upgrading from a version without pace history, and retain recent declining measurements across extension reloads, so the next decrease does not restart the estimate from a proportional duration.

- Tailor every estimate tooltip to its own weekly or 5-hour limit. Detect an older background process that cannot record pace and offer a one-click extension reload instead of displaying a misleading proportional duration.

- Show the proportional initial estimate for fresh visible usage when confirmed pace history is missing or differs from the displayed balance, then switch to the measured rate as soon as confirmed refreshes catch up.

- Cap every numeric remaining-time estimate at the visible reset deadline, preserving English/Spanish reset dates and relative durations and updating the cap while the popup stays open.

- After a reset within the current browser session, project the restored capacity using the previous consumption rate until the next measurement. Without a measured rate in the current session, show a clearly provisional estimate proportional to the remaining percentage of the 5-hour or weekly window.

- Estimate time until the 5-hour and weekly limits run out using consumption between confirmed refreshes, with local history and explicit learning, idle, and unavailable states.

- Preserve explicit zero credit balances instead of borrowing digits from nearby reset dates or times, and keep the toolbar badge synchronized with the latest visible Analytics percentage without treating that observation as a confirmed alert reading.
- Add a locally persisted automatic-refresh slider covering every minute from 1 to 60, retaining 15 minutes as the default.
- Add persisted remaining-capacity states for preventive (25%), configurable low/critical thresholds, exhausted (0%), and reset-to-100% transitions.
- Add larger dynamically rendered toolbar percentages based on the lowest actually available limit, with a native-badge fallback and a setting to hide the permanent percentage outside warning/critical states.
- Improve toolbar-number legibility with larger medium-weight digits and a darker green badge that supports high-contrast white text.
- Refresh stale usage immediately when Chrome or Edge reopens, while skipping the startup request when collected data is newer than the configured refresh interval.
- Show every metric under Other limits on its own full-width row.
- Seed upgrade baselines only from persisted, recent, signed-in confirmed counters, apply generation-bound refresh timeouts to popup, chained popup retries, and scheduled checks, expire stale observations after successful, incomplete, failed, or timed-out refreshes and clear their persistent alerts, invalidate timed-out shared refreshes so late results or timeout cleanup cannot overwrite newer data, serialize initialization, idempotent sign-out suppression, accepted reads, and notification opt-out, keep default settings in memory so explicit choices are never overwritten, discard pre-logout refresh data and rebaseline after in-place authentication, require five consecutive per-counter observations for alerts, recheck the session immediately before sound playback, support callback and Promise notification APIs, restore visuals only from confirmed limits in the last accepted read, evaluate alerts only from accepted refresh reads, and clear visible capacity notifications on recovery or opt-out.
- Add deduplicated native notifications for low, critical, exhausted, and optional reset events, plus optional offscreen audio that is disabled by default.
- Treat the 5-hour limit as optional throughout alerts and badge calculations; missing, null, or invalid counters never become a false 0%.
- Add compact Settings controls for notifications, reset notifications, toolbar percentage, low/critical thresholds, and sounds.
- Stop opening Analytics when the popup merely opens; manual refresh now creates an inactive temporary Analytics tab, reads it completely, and closes only the tab created by the extension without changing focus.
- Keep an optional **Visit Analytics** button that deliberately opens or focuses Analytics, including its existing browser window, without making it a refresh prerequisite.
- Never use a user-open Analytics page as the refresh source; collect from a newly loaded inactive page (or an extension-owned sign-in tab) so a long-lived page cannot hide usage changes or threshold crossings, while leaving the user's page untouched.
- Give scheduled refreshes the same fresh background-tab path; recreate the periodic alarm whenever the background worker starts if it is missing or outdated.
- Close scheduled sign-in tabs, preserve newer content-script snapshots during refresh failures, guide the user to manual refresh when authentication is required, and honor a manual refresh that joins at any point before cleanup.
- Make the compact paired layout the only popup layout, with login/plan, 5-hour/weekly limits, Spark limits, and credits/banked full resets.
- Use small color-coded circular gauges for percentage metrics.
- Reuse the single retained background sign-in tab across repeated manual refreshes instead of accumulating duplicate Analytics tabs.
- Release retained-tab ownership when the user activates Analytics or opens it through **Visit Analytics**, and replace stale retained tabs when a popup joins an alarm refresh.
- Recheck a temporary tab immediately before cleanup, preserve it if the user activated it, and keep inactive page-driven redirects under extension ownership.
- Track temporary-tab activation throughout the full read so a tab remains user-owned even after the user switches away again.
- Release retained-tab ownership whenever its tab is activated between refreshes, and do not reacquire ownership after activation during a read.
- Keep activation tracking installed through asynchronous cleanup so last-moment adoption cannot be missed.
- Serialize retained-tab ownership updates so a stale release cannot erase a concurrently retained replacement.
- Prefer an existing retained sign-in tab over a newly created duplicate, and preserve it if the user adopts it while its ownership is being checked.
- Scope retained-tab ownership to the browser session, reuse inactive sign-in redirects without treating them as user adoption, and remove owned sign-in tabs after any refresh confirms authentication.
- Keep the popup dimensions and cached metrics stable while refreshing in Microsoft Edge.
- Prevent concurrent refreshes and preserve valid Analytics usage when ordinary ChatGPT pages load.
- Distinguish the latest data collection time from the latest refresh attempt.
- Show the successful refresh age in friendly form, such as `Last refresh: 5 min ago`, while preserving exact timestamps in diagnostics.
- Label preserved metrics as cached usage after a failed or timed-out refresh instead of incorrectly reporting all usage as unavailable.
- Treat a responsive Analytics page with no newly detected metrics as an incomplete refresh, not a load failure, and update the open popup when delayed values arrive through local storage.
- Replace the fixed long read with adaptive 400 ms sampling for up to 10 seconds, a minimum observation window after the first metric, and five stable merged reads.
- Read bounded usage-card DOM and accessible values (`aria-valuenow`, `aria-valuetext`, progress bars, and `datetime`) independently from the page-text fallback.
- Merge fields found across different snapshots and parse structured/fallback channels separately to avoid losing late cards or double-counting full resets.
- Observe delayed Codex Analytics DOM updates instead of relying on a single initial snapshot.
- Show banked full-reset count and expiration from visible English or Spanish UI text, including singular `Restablecimiento completo` cards that imply a count of one without displaying a digit.
- Preserve the Spanish card label `Restablecimiento completo` and prevent expiry-day numbers from being mistaken for the banked-reset count.
- Add refresh-orchestration tests alongside the English and Spanish parser fixtures.

## 0.1.0 - 2026-06-08

- Initial local-only Chrome/Edge extension for visible ChatGPT/Codex usage information.
- Reads visible Codex Analytics usage cards from the user's existing browser session.
- Shows 5-hour, weekly, Codex-Spark, and credit values when ChatGPT exposes them in page text.
- Highlights remaining-usage percentages as green, amber, or red.
- Detects visible login and plan signals when available.
- Provides a manual action to open the Codex usage page.
- Includes redacted diagnostics copying for issue reports.
- Stores derived usage metadata and timestamps in `chrome.storage.local`.
- Includes parser tests for English, Spanish, and compact visible Codex Analytics text.

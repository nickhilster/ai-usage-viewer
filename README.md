# AI Usage Viewer

Local-only Chrome/Edge extension that shows usage rendered by ChatGPT Codex and Claude in the current browser session.

It is intended for developers and power users who want one small usage popup while working with ChatGPT Codex and Claude.

## Screenshots

No public screenshots are committed yet, because usage popups can contain private account details. Before sharing screenshots publicly, use sanitized captures that do not include account names, email addresses, workspace names, or private usage details.

Recommended screenshots:

- Popup with visible Codex usage.
- Popup when usage is unavailable.
- Collapsed and expanded diagnostics.

## Features

- Detects whether ChatGPT and Claude appear to be signed in.
- Detects the visible plan when the UI exposes it.
- Reads visible Codex usage cards when available.
- Reads Claude's visible current-session and weekly usage limits when available.
- Shows 5-hour and weekly usage percentages when they are visible in the ChatGPT/Codex UI.
- Shows remaining credits when visible.
- Shows banked full-reset count and expiration when the Codex UI exposes `Banked resets`, `Full resets`, or `Restablecimiento completo`.
- Shows a compact draggable usage badge on ChatGPT and Claude pages, with provider usage and refresh time on click.
- Offers a persistent compact mode that pairs login/plan, 5-hour/weekly and credits/full resets into two-column rows.
- Highlights usage bars:
  - Green: more than 50% remaining.
  - Amber: 15% to 50% remaining.
  - Red: less than 15% remaining.
- Evaluates every available percentage limit as remaining capacity, with preventive (25%), low, critical, exhausted, and reset states.
- Detects downward threshold crossings instead of repeatedly alerting on every read in the same range.
- Treats Weekly usage as the primary limit and 5-hour usage as optional; a missing or invalid 5-hour value is ignored rather than converted to 0%.
- Shows the lowest actually available percentage on the toolbar icon when enabled.
- Supports native reset/low/critical notifications and optional local alert sounds.
- Lets the user choose any automatic-refresh interval from 1 to 60 minutes, with 15 minutes as the default.
- Stores only local metadata in `chrome.storage.local`.

## Privacy

- It does not use private OpenAI or Anthropic APIs.
- It does not collect or store passwords.
- It does not transmit derived usage readings to [Teambotics](https://www.teambotics.app) or other analytics services. To refresh, it loads each provider's visible usage page through the user's existing browser session.
- It does not store conversation content.
- It uses the existing browser session.
- It stores derived metadata and timestamps only in `chrome.storage.local`.
- It redacts diagnostics before copying them for issue reports.

## Limitations

This extension reads the rendered Codex Analytics UI from `chatgpt.com` and the rendered usage settings UI from `claude.ai`.

Some values may be unavailable depending on:

- your plan
- your region
- language settings
- A/B tests
- OpenAI or Anthropic frontend changes
- whether the provider's usage page exposes usage cards to your account

When exact usage is not visible, the extension will show it as unavailable rather than inventing a value.

- Usage appears only when ChatGPT Codex or Claude exposes it in visible page text and accessibility attributes.
- It does not call private provider APIs or background endpoints.
- It does not infer hidden limits, account entitlements, or exact reset behavior.
- Browser and account A/B tests can make values unavailable.
- Diagnostics are intentionally redacted and do not include raw page text.
- Background alerts are only as current as successful visible Analytics reads. The extension checks at the locally configured interval (15 minutes by default) and does not poll private endpoints or invent intermediate values.
- If a scheduled read requires sign-in or returns no reliable percentage, no threshold notification is generated from that failed read.

## Compatibility

- Chrome and Edge extensions using Manifest V3.
- `https://chatgpt.com/*`.
- `https://claude.ai/*`.
- English and Spanish Codex usage text when the values are visible in the ChatGPT/Codex UI.

### Extension permissions

- `alarms`: run the configurable background refresh (15 minutes by default).
- `storage`: persist derived usage, threshold crossings, and local settings.
- `notifications`: show reset, low-capacity, critical, and exhausted alerts.
- `offscreen`: play a short local tone only when **Enable sounds** is turned on. The audio document uses the `AUDIO_PLAYBACK` reason and is not used to keep the service worker alive.
- Host access is limited to `chatgpt.com` and `claude.ai`, for visible-UI extraction and the display-only badge.

The extension may need parser updates when ChatGPT or Claude changes page structure, wording, model names, or usage-page locations.

## How extraction works

The extension reads rendered UI text and accessibility attributes only on its permitted ChatGPT and Claude routes. To obtain fresh readings it loads each provider's visible usage page through the user's existing browser session; it does not call private provider APIs or send derived readings to project servers, analytics providers, or telemetry collectors.

For normal manual and scheduled refreshes, the extension creates a newly loaded inactive Analytics tab, waits for its UI to render completely, and closes only the tab it created. It does this even when you are currently viewing Analytics because a long-lived page can keep displaying the values fetched when it opened. The only reusable reader is an extension-owned tab deliberately retained when manual sign-in is required. Your page remains active and is never reloaded by the refresh; **Visit Analytics** is the separate action that deliberately opens or focuses Analytics. This is more reliable than embedding Analytics in a hidden frame and does not require you to open or keep Analytics visible.

Codex usage extraction is centralized in `usage-model.js`. The parser normalizes visible text, matches language-aware usage concepts, and returns structured metrics for 5-hour limits, weekly limits, credits, banked full resets, expiration, and reset text when those values are visible.

The extraction terms currently cover English and Spanish. Instead of depending on exact labels, the parser matches concepts such as `5h`, `5-hour`, `5 hours`, `5 horas`, `weekly`, `week`, `semanal`, `remaining`, `left`, `restante`, `credits`, `credit balance`, `creditos`, `banked resets`, `full resets`, and `restablecimiento completo`.

Banked full resets are treated as a separate consumable resource used to reset counters. Their count and visible expiration text are not mixed with the normal reset time of a 5-hour or weekly usage window. When the UI omits a numeric count, each visible singular `Full reset` or `Restablecimiento completo` card counts as one.

Analytics is read through two independent DOM channels: bounded usage-card text and a page-text fallback. The structured channel also reads accessible values such as `aria-valuenow`, `aria-valuetext`, progress bars, and `<time datetime>`. The parsed fields are merged without concatenating duplicate card text.

Each detected metric includes extraction confidence:

- `high`: an explicit percentage or direct remaining-credit wording was detected.
- `medium`: the value is tied to nearby usage context.
- `low`: the value came from a weaker heuristic such as a credit balance label without remaining wording.

When a value cannot be found from visible text, the extension leaves that metric unavailable rather than guessing.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the project folder.
6. Open ChatGPT and sign in.
7. Click the extension icon.

## Usage

- Click **Refresh** from any page. You do not need to open Analytics first.
- After updating the extension files, an older background process may still lack pace tracking. If detected, the popup shows **Reload extension** instead of a proportional duration. Click that button once, reopen the popup, and refresh; subsequent confirmed readings can establish the consumption rate. Each estimate tooltip refers only to the limit where it appears.
- When upgrading from a version without pace history, the last confirmed counter observation is used as the first sample if it is at most 35 minutes old. This can establish the actual rate on the first new refresh. Recent history also survives a reload when the next confirmed balance is equal or lower and the gap is at most 90 minutes; a higher balance in a new session still starts proportionally. Already discarded observations cannot be reconstructed from the current extension state.
- Click **Visit Analytics** only when you want to inspect the source page yourself; it opens or reuses Analytics and deliberately gives that tab and window focus. It is optional for refresh.
- A manual or scheduled refresh uses a newly loaded temporary Analytics tab in the background, including when Analytics is already open or active, so it never trusts potentially stale values from a long-lived user page. The temporary tab is closed after reading without changing focus unless you activate it at any point; adopted tabs remain preserved even if you switch away again before reading finishes. If sign-in is required during a manual refresh, the extension-owned tab remains open in the background so you can select it and sign in through ChatGPT; selecting it transfers ownership to you immediately, including between refreshes. Repeated refreshes may reuse that one extension-owned sign-in tab and discard any newly created duplicate; automatic inactive redirects remain extension-owned and are returned to Analytics for the next manual read, while a tab you activate is preserved as user-owned. Ownership is session-scoped so a numeric tab ID is never trusted after a browser restart.
- The 15-minute periodic check uses the same background-tab recovery path. If its scheduled tab requires sign-in, it is closed and the popup asks you to run a manual refresh. The extension also repairs the periodic alarm whenever its background worker starts.
- The popup keeps a compact paired layout: login with plan, the 5-hour limit with the weekly limit, and credits with banked full resets. Percentage metrics use small circular gauges so they remain legible in two columns.
- The 5-hour and weekly banners estimate time until exhaustion from the percentage consumed between confirmed refreshes in the last 2 hours. Each limit has its own local history (at most 121 readings). The estimate needs two readings at least a minute apart and is measured from the latest refresh; the visible reset time remains separate. When capacity increases within the current browser session, including a reset to 100%, the restored balance is extrapolated using the previous measured rate. The next reading at least a minute later replaces that projection with the new measured pace. Without a measured rate in the current session, including a higher balance from a previous browser session or after a gap over 90 minutes, the initial estimate is the remaining percentage multiplied by the 5-hour or weekly window. For example, 50% of the 5-hour window shows **2 h 30 min** and 50% of the weekly window shows **3 d 12 h**. This is labeled as an initial estimate until the next useful reading establishes the actual pace. Browser sessions are tracked in session storage so worker suspension does not start a new session. Unchanged readings show **No recent consumption**. Missing counters and sign-out clear the rate history. Fresh signed-in visible usage shows a proportional estimate even if confirmed history is missing or has not caught up with the displayed percentage. Estimates become unavailable when the displayed observation is invalid or over 35 minutes old.
- Every numeric estimate is capped by the time until the visible reset: 50% of the 5-hour window with a reset in 1 hour shows **1 h**, even if the provisional or measured duration is longer. Clock times and relative durations are anchored to the collection timestamp, and the cap updates while the popup is open. English and Spanish dates, 12/24-hour times, ISO timestamps, and explicit durations are supported. A reset that is already due asks for a refresh; an unreadable reset time hides the estimate instead of guessing a deadline.
- Open **Settings** to enable or disable notifications, reset notifications, the permanent toolbar percentage, low/critical thresholds, and sounds. Defaults are notifications on, reset notifications on, toolbar percentage on, low at 10%, critical at 5%, and sounds off.
- With the permanent toolbar percentage disabled, normal and preventive states keep the badge empty. Warning, critical, and exhausted states may still show the percentage while the alert condition remains active.
- The toolbar icon renders a larger compact number for the lowest percentage among limits present in the latest valid snapshot, while the tooltip keeps the explicit `% remaining` wording. Browsers without worker canvas support fall back to the native badge. Missing, null, or invalid values are excluded completely.
- Each page attempt samples Analytics every 400 ms for up to 10 seconds, within a 45-second refresh timeout. The reader observes at least 13 reads after the first metric and requires five stable merged reads before accepting the snapshot. Metrics found in different reads are accumulated instead of replacing one another.
- The main status shows a friendly age such as **Last refresh: 5 min ago**. Diagnostics retain the exact collection and attempt timestamps.
- Open **Diagnostics** only when troubleshooting. It shows extractor version, page detection, visible fields, and local refresh timing.
- Use **Copy diagnostics** when opening an issue. The copied payload is redacted and omits raw page text, full URLs, conversation content, and account identifiers.

### Capacity alert behavior

- Above 25%: normal state.
- Crossing downward to 25%: preventive badge color, without a system notification.
- Crossing the configured low threshold (10% by default): one low-capacity notification.
- Crossing the configured critical threshold (5% by default): one higher-priority notification.
- Reaching 0%: persistent critical badge and an exhausted notification; visible reset text is included without inferring a duration.
- Moving from below 100% to exactly 100%: clear the previous range naturally, restore the normal state, and optionally notify the reset once.
- Repeated reads in the same range do not notify again. A direct jump across multiple thresholds emits only the most severe newly reached state, avoiding a burst of notifications.
- The first valid observation establishes the baseline and visual state without creating a potentially stale notification.
- Only stable or completed best-effort refreshes evaluate threshold crossings. DOM mutation snapshots may update the popup cache but cannot emit alerts.
- Capacity baselines are seeded during upgrades only while signed in and when the cached read is at most 35 minutes old, cleared on explicit sign-out, and re-established without alerts after two missed 15-minute observations.
- A persistent exhausted notification is cleared as soon as that counter reports capacity above 0% or its observation expires; disabling notifications clears any capacity alerts still visible.

## Troubleshooting

- **Sign in required**: the automatically created Analytics tab remains open so you can sign in through ChatGPT. The extension never asks for credentials.
- **Usage unavailable**: open the Codex usage page manually only as a diagnostic check and confirm usage values are visible there.
- **Usage page detected**: Analytics responded, but no new values were recognized during that attempt. This is not treated as a load failure; the popup updates automatically if the content script reports values afterward.
- **Refresh failed**: Analytics loaded but did not respond to the extractor after all retries, or the temporary tab could not be created. Reload the unpacked extension and retry.
- **Visible in browser but not in popup**: copy diagnostics and include the extension version, browser, language, and whether the Codex usage page opens manually.
- **Stale values**: click **Refresh**. The popup distinguishes the successful data collection time from the latest refresh attempt.

## Project files

```text
background.js
capacity-monitor.js
content-script.js
offscreen.html
offscreen.js
package.json
manifest.json
popup.html
popup.js
providers.js
test/
usage-model.js
README.md
```

## Development

No dependency install is required for the current checks. The test suite uses Node's built-in test runner and sanitized fixtures in `test/fixtures/`.

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

## Testing

- `npm run check` runs `node --check` against every extension JavaScript file.
- `npm test` runs English/Spanish parser tests, refresh-orchestration tests, popup/permission checks, and capacity transition/deduplication tests.
- Manual release testing should load the unpacked extension in Chrome or Edge and verify signed-in, signed-out, unavailable-usage, and visible-usage states when possible.

## Contributing

Keep the extension small and local-only:

- Do not add private OpenAI APIs.
- Do not add telemetry, analytics, or third-party services.
- Do not request additional permissions unless the README explains the user benefit and risk.
- Prefer visible-UI extraction that fails clearly over guessed values.
- Update `CHANGELOG.md` for user-visible changes.

## Release checklist

- Load the unpacked extension in Chrome or Edge.
- Verify the popup at normal and narrow widths.
- Test signed-in, signed-out, unavailable-usage, and visible-usage states when possible.
- Run `npm run check` and `npm test`.
- Confirm `chrome://extensions` shows only the expected permissions.
- Check that diagnostics do not expose conversation text or credentials.
- Prepare the Web Store ZIP with `scripts/package-web-store.ps1` and review `store-prep/STORE-LISTING.md` and `store-prep/PRIVACY-POLICY.md`.

## Chrome Web Store preparation

The `store-prep/` folder contains a listing draft and privacy-policy draft. The policy needs a working support contact and a public URL before submission. The listing also needs a sanitized current screenshot and a 440x280 promotional tile. The Store publisher display name comes from the developer account; `Teambotics Inc.` is recorded as the package author in `package.json`.

Create an upload ZIP from the repository root with:

```powershell
./scripts/package-web-store.ps1 -OutputPath "C:/path/to/ai-usage-viewer-0.6.0.zip"
```

The ZIP contains only the runtime extension files, icons, and upstream MIT license. It excludes source tests and store-preparation documents. Creating a package does not upload or submit it.

## License

MIT. See `LICENSE`.

## Disclaimer

This project is not affiliated with OpenAI.

ChatGPT and Codex are trademarks or products of their respective owners. This extension only reads information visible in the web interface through the user's existing browser session.

---

Built with ❤️ by [Teambotics](https://www.teambotics.app)

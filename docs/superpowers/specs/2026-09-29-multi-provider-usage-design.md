# Multi-provider usage viewer: ChatGPT + Claude + Muse

Date: 2026-09-29 · Status: draft for review · Target version: 0.6.0

## Goal

Extend the extension from a ChatGPT/Codex-only viewer into a provider-agnostic usage viewer that also tracks **claude.ai** (Settings → Usage) and **muse.ai** (Settings → General → Usage). Claude and Muse get full parity with ChatGPT: popup display, scheduled background refresh, threshold/reset alerts, toolbar-icon percentage, on-page badge, and pace estimates.

## Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Structure | Integrate into this extension; provider abstraction (approach B). Refactor ChatGPT behind it first, tests as the safety net. |
| Scope | Full parity for the new providers. |
| Toolbar icon | Lowest `remainingPercent` across all valid, fresh limits from all providers; tooltip names provider + limit. |
| Name | **AI Usage Viewer** (replaces "ChatGPT Usage Viewer"). |
| Muse | In scope as a third provider. |
| Privacy | Rendered-DOM only. No private/internal APIs are called or relied upon. Network inspection during recon is for understanding cadence/staleness only. Local storage only. |

## Architecture

### Provider contract

Each provider is a module exposing:

- `id` — `"chatgpt" | "claude" | "muse"`
- `hosts` / content-script matches
- `usageSurface` — how to reach the usage UI (see Refresh)
- `extract()` — content-script DOM reader returning raw text + accessible values (`aria-valuenow`, `aria-valuetext`, `<time datetime>`)
- `parse(raw) → NormalizedSnapshot`
- `isReady(raw)` — true only when the surface is fully rendered (headings + at least one percentage)
- login-state detection

The existing Codex parsing in `usage-model.js` moves behind the `chatgpt` provider with no behavior change.

### Normalized snapshot

```
{ provider, loginStatus, plan, collectedAt, extractorVersion,
  limits: [ { key, label, remainingPercent, resetText, resetAt, state } ],
  extras: { credits?, bankedResets? } }   // ChatGPT-only, optional
```

- Providers that report "% used" (Claude, Muse) convert once in `parse`: `remainingPercent = 100 − used`. Downstream code only sees remaining.
- `limits` is per-provider and not forced into a 5-hour/weekly mold: ChatGPT → `five-hour`, `weekly`; Claude → `session`, `weekly:all-models` (+ any extra labelled weekly rows shown); Muse → `weekly`.
- `state`: `ok | not-started | exhausted | unavailable`. `not-started` covers Claude's "Starts when a message is sent" (0% used, no reset timer) so idle sessions never generate a false "reset" notification.

### Storage and migration

- Capacity baselines, pace history and notification ids key on `provider:limitKey`.
- On upgrade, existing unscoped ChatGPT state migrates to `chatgpt:*` keys, preserving baselines and pace history. The legacy-key handling already in `background.js` (`LEGACY_MESSAGE_COUNTERS_KEY`) is kept.
- Migration is covered by a dedicated test and must be idempotent.

### Refresh

ChatGPT keeps its current mechanism (inactive extension-owned tab on the Codex Analytics URL, 400 ms sampling, stable-read rule, sign-in recovery tab). The reader loop, ownership rules and timeouts are generalized, not duplicated, and parameterized by provider.

Claude's surface is a **settings modal on a hash route** (`https://claude.ai/new#settings/usage`), not a dedicated page.

- Primary: open the hash URL in an inactive extension-owned tab and read once `isReady`.
- Fallback (built only if the hash route does not auto-open the modal): the content script opens Settings → Usage via visible controls.
- Muse's route (deep-linkable hash or click path) is determined in recon.
- Because these are long-lived SPA surfaces, every refresh uses a freshly loaded tab (same stale-value rule as ChatGPT). Recon must also record whether values update while a modal stays open.

### Capacity, alerts, pace

The existing capacity monitor is already largely provider-agnostic; it is generalized to iterate `provider:limit` counters. Threshold rules (25% preventive, configurable low/critical, exhausted, reset) are unchanged. Notification titles name the provider, e.g. "Claude session low: 10% left". Pace estimates use per-`provider:limit` history and the window length appropriate to each limit.

### UI

- **Popup:** one section per provider using the shared compact gauges. A never-signed-in provider collapses to a slim "Sign in to <provider>" row. Settings (thresholds, notifications, sounds, interval) are global. One Refresh refreshes all providers.
- **On-page badge:** `chat-badge.js` gains per-site variants (claude.ai, muse.ai): shared visuals, provider-specific data; click expands to the provider's other limits and refresh time.
- **Toolbar icon:** min across providers as decided above.

### Manifest and permissions

Adds `https://claude.ai/*` and the confirmed Muse host to `host_permissions` and the content-script matches. This triggers a permission re-prompt for existing users on update; the changelog says so. `name`, `action.default_title`, `description` and `package.json` become "AI Usage Viewer".

## Provider notes

| | ChatGPT | Claude | Muse |
|---|---|---|---|
| Surface | Codex Analytics page | Settings → Usage modal (`#settings/usage`) | Settings → General → Usage |
| Semantics | remaining | **used** | **used** |
| Limits | 5-hour, weekly, credits, banked resets | Current session, weekly All models | weekly |
| Reset text | absolute/relative | relative ("Resets in 3 hr 0 min") | absolute ("Weekly limit resets on Oct 5") |
| Source | existing code | user screenshot, 2026-09-29 | **second-hand description only; unverified** |

Muse specifics come from a description supplied in conversation, not from an observed page. They are treated as hypotheses until recon confirms them.

## Phase 0: recon (gates the parsers)

Deliverables per new provider, from a real signed-in session, with account details sanitized:

1. Whether the usage surface is deep-linkable, and the exact URL or click path.
2. Stable selectors and ARIA attributes (does the progress bar expose `aria-valuenow`?).
3. Exact text patterns for plan, percent used, reset text, and the "not started" / signed-out / loading states.
4. Whether values refresh while the surface stays open.
5. Sanitized text fixtures saved under `test/fixtures/<provider>-*.txt`.

Parsers and extractors are written against these fixtures, not against screenshots.

## Sequencing

Each step keeps `npm run check` and `npm test` green.

1. Extract the provider seam and namespaced storage with ChatGPT as the only provider; add the migration test. No behavior change.
2. Generalize refresh, capacity, pace, badge and popup to iterate providers.
3. Phase 0 recon for Claude and Muse.
4. Add the Claude provider, then the Muse provider (parser, extractor, manifest entries, fixtures).
5. Combined toolbar rule and rename.
6. Version 0.6.0, `CHANGELOG.md`, README, store-prep updates.

## Testing

- Existing suites remain the regression net for steps 1–2.
- Fixture-driven parser tests per provider: not-started, in-use, exhausted, reset text, signed-out, half-rendered surface (rejected), used→remaining conversion.
- Cross-provider tests: min-across-providers toolbar value, per-provider alert isolation (a Claude threshold never suppresses or triggers a ChatGPT alert), and stale/missing readings excluded from the toolbar.
- Migration test: old ChatGPT baselines and pace history survive the upgrade.

## Versioning

Per `AGENTS.md`: new feature → minor bump `0.5.1 → 0.6.0` in `manifest.json` and `package.json` together, dated `CHANGELOG.md` entry. Before finishing: `npm run check`, `npm test`, `git diff --check`. No commits, pushes or tags without explicit request.

## Out of scope

- Private or internal provider APIs.
- Providers beyond these three.
- Cloud sync or any transmission of readings.
- Muse-specific work that recon shows is not observable from the DOM (it would be reported as unavailable, as ChatGPT values are today).

## Amendment 1 (2026-09-29, from reading the code while planning)

Reading `capacity-monitor.js`, `background.js` and the tests showed two parts of this spec are unnecessary. Both reduce risk and neither changes user-visible behavior.

1. **Snapshot shape.** The `limits[]` field in "Normalized snapshot" is dropped. The existing `snapshot.usage` map (`usage[counterKey] = { value, structured: { remainingPercent, resetText, … } }`) is already a generic limit map consumed by the capacity monitor, pace tracker, badge and popup. New providers emit the same shape with namespaced counter keys (`claude:session`, `claude:weekly`, …). Per-provider limit definitions (key, label, window length) live in a provider registry (`providers.js`) instead of in the snapshot.
2. **No storage migration.** ChatGPT's existing counter keys (`codexWeekly`, `codex5h`) and storage keys (`chatgptUsageMonitor.*`) are grandfathered and unchanged. Only new providers use `<providerId>:<limit>` counter keys and `aiUsageViewer.*` storage keys. The "migration test" becomes a regression test that pre-change stored state still loads. This replaces "migrate to `chatgpt:*` keys" in *Storage and migration*.
3. **Refresh concurrency.** The single global refresh generation and single-flight promise stay. Providers refresh one at a time; a refresh only joins an in-flight refresh for the same provider. The existing test suite depends on these globals.
4. **Plan split.** Work is delivered as three plans: (1) the provider seam on ChatGPT with no behavior change, (2) Claude, after Phase 0 recon, (3) Muse, the rename, and version 0.6.0.

## Amendment 2 (2026-09-29, user request): live reset countdown

Each limit shows how long until it resets, e.g. **Resets in 3 hr 0 min** (the wording Claude's own usage page uses), for every provider including ChatGPT.

- **Where:** the popup limit cards (alongside or replacing today's raw `Reset: <text>` line) and the expanded on-page badge. Not the toolbar tooltip unless requested.
- **How:** compute `resetAt = parseResetAt(resetText, collectedAt)` once per reading and render `resetAt − now` live. Text like "Resets in 3 hr 0 min" is relative to when the page was read, so showing it verbatim goes stale; the countdown must be recomputed. The popup already has a tick that refreshes "Last refresh: … ago"; the countdown rides that tick. The badge recomputes when opened.
- **Format:** `X hr Y min` (e.g. `3 hr 0 min`), `Y min` under an hour, `X d Y hr` from a day up, `<1 min` under a minute. A reset already in the past shows `Reset due · refresh usage` (matching the existing pace copy). If `resetText` is missing or unparseable, fall back to today's raw text; never invent a deadline.
- **Shared code:** one `formatResetCountdown(resetAt, now)` in `usage-model.js`, next to `parseResetAt`, reusing the duration wording already used by the pace estimates so the two never disagree. Parsing already supports English and Spanish relative and absolute times.
- **Tests:** fixture-driven formatter tests (hours+minutes, minutes only, days, sub-minute, past due, unparseable); a popup test that the text advances as the tick advances; a badge test.
- **Scheduling:** part of Plan 2 (popup/badge work). Plan 1 changes no UI.

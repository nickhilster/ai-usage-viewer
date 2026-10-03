# Privacy Policy — AI Usage Viewer

**Draft for review before publication**
**Effective date:** 2026-09-28
**Publisher:** Teambotics Inc.
**Contact:** hello@teambotics.app (confirm this inbox is monitored for extension privacy requests before publication)

AI Usage Viewer is an independent browser extension. It is not affiliated with OpenAI or Anthropic.

## Information the extension processes

On ChatGPT's visible Codex Analytics interface and Claude's visible usage settings, the extension reads rendered usage-related information and derives fields such as visible sign-in status, plan label, current-session and weekly usage percentages, credits, reset details, and refresh timestamps. It does not read conversation text, passwords, or authentication cookies. A separate display-only badge on supported provider pages reads the extension's locally stored usage summary and does not inspect conversation content.

The extension stores derived usage state (including the visible plan label, sign-in status, usage values, and limited page-category/diagnostic flags), timestamps, notification settings, refresh preferences, capacity-estimation history, and the badge's screen position using browser extension storage on the device. A temporary tab identifier used for sign-in recovery is stored in session-scoped extension storage. The extension does not store raw conversation text or full-page text. Chrome documents that local extension storage is cleared when the extension is removed.

## How information is used and shared

Information is used only to display usage, estimate capacity timing from observed readings, and provide user-configured local alerts. The extension does not transmit derived usage readings to Teambotics Inc., nikdesign.ca, analytics providers, or other project-operated external services. It does not include advertising, telemetry, or third-party analytics. To refresh readings, the extension loads the visible usage page from ChatGPT or Claude through the user's existing browser session; each site request is handled by that provider under its own terms and privacy policy.

The extension uses the user's existing ChatGPT and Claude browser sessions to load visible usage pages. It does not collect credentials or make private API calls.

## User controls and deletion

Users can change refresh and notification settings in the extension popup. Users can remove the extension through browser extension-management controls; Chrome clears local extension storage when the extension is removed.

## Changes and contact

Material changes to this policy will be reflected at the public URL where it is hosted. For privacy questions or support, contact hello@teambotics.app.

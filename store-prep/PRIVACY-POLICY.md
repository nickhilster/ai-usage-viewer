# Privacy Policy — ChatGPT Usage Viewer

**Draft for review before publication**
**Effective date:** 2026-09-28
**Publisher:** TeamBotics Inc.
**Contact:** hello@teambotics.app (confirm this inbox is monitored for extension privacy requests before publication)

ChatGPT Usage Viewer is an independent browser extension. It is not affiliated with OpenAI.

## Information the extension processes

On ChatGPT's visible Codex Analytics interface, the extension reads rendered usage-related information and derives fields such as visible sign-in status, plan label, 5-hour and weekly usage percentages, credits, reset details, and refresh timestamps. It does not read ChatGPT conversation text, passwords, or authentication cookies. A separate display-only badge on ChatGPT pages reads the extension's locally stored usage summary and does not inspect page content.

The extension stores derived usage state (including the visible plan label, sign-in status, usage values, and limited page-category/diagnostic flags), timestamps, notification settings, refresh preferences, capacity-estimation history, and the badge's screen position using browser extension storage on the device. A temporary tab identifier used for sign-in recovery is stored in session-scoped extension storage. The extension does not store raw conversation text or full-page text. Chrome documents that local extension storage is cleared when the extension is removed.

## How information is used and shared

Information is used only to display usage, estimate capacity timing from observed readings, and provide user-configured local alerts. The extension does not transmit derived usage readings to TeamBotics Inc., nikdesign.ca, analytics providers, or other project-operated external services. It does not include advertising, telemetry, or third-party analytics. To refresh readings, the extension loads the visible Analytics page from ChatGPT through the user's existing browser session; that site request is handled by ChatGPT under its own terms and privacy policy.

The extension uses the user's existing ChatGPT browser session to load the visible Analytics page. It does not collect credentials or make private API calls.

## User controls and deletion

Users can change refresh and notification settings in the extension popup. Users can remove the extension through browser extension-management controls; Chrome clears local extension storage when the extension is removed.

## Changes and contact

Material changes to this policy will be reflected at the public URL where it is hosted. For privacy questions or support, contact hello@teambotics.app.

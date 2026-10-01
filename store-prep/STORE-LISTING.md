# Chrome Web Store listing draft

## Product details

- **Name:** ChatGPT Usage Viewer
- **Publisher account display name:** Teambotics Inc. (must be configured in the Chrome Web Store developer account; it is not set by extension metadata)
- **Version:** 0.5.1
- **Language:** English
- **Suggested category:** Productivity
- **Short description:** View visible Codex usage limits and reset details from your ChatGPT session, with a compact draggable badge.
- **Single purpose:** Show usage information that ChatGPT visibly renders and provide local capacity alerts and estimates.
- **Homepage:** https://www.teambotics.app/ (verified live on 2026-09-28; confirm publisher ownership in the dashboard)
- **Support contact:** hello@teambotics.app (public contact shown on the Teambotics site; confirm it is monitored for extension support).
- **Privacy policy URL:** https://www.teambotics.app/privacy exists, but currently describes the public website and its services. Add and publish the extension-specific disclosures from `PRIVACY-POLICY.md` there, or publish that draft at a dedicated stable URL, before submission.

## Detailed description draft

ChatGPT Usage Viewer puts visible Codex capacity information where you need it. It reads the usage values ChatGPT renders in its Analytics interface and shows the latest 5-hour and weekly limits, credits, reset details, and local estimates in the extension popup. A small draggable badge can stay on ChatGPT pages; click it for weekly usage and refresh details.

The extension refreshes on a local schedule that you control. It loads ChatGPT's visible Analytics page through your existing browser session, keeps derived usage data and preferences in local browser extension storage, and does not transmit derived usage readings to Teambotic, nikdesign.ca, or other analytics services. It does not read conversation text, ask for passwords, or call private OpenAI APIs. Values are shown only when the visible page provides data the parser can recognize.

Features:

- View visible 5-hour and weekly usage, credits, and reset information.
- Keep a compact badge on ChatGPT pages and drag it to a preferred position.
- Refresh manually or choose an automatic refresh interval.
- Configure local capacity notifications and optional alert sounds.
- Inspect redacted diagnostics when troubleshooting.

Availability depends on the values ChatGPT exposes for your account, region, language, and current interface. This is an independent third-party extension and is not affiliated with OpenAI. ChatGPT and Codex are trademarks or products of their respective owners.

## Permission explanations for the dashboard

- **alarms:** run the user-configurable periodic refresh (15 minutes by default).
- **notifications:** show capacity alerts when the user enables them.
- **offscreen:** play the optional local alert sound when enabled.
- **storage:** keep derived usage readings, refresh history, local preferences, and badge position on the device.
- **chatgpt.com host access:** inspect visible Analytics UI and show the display-only badge on ChatGPT pages. The badge does not inspect page conversations.

## Privacy-practices form preparation

Review the public privacy policy and match the dashboard declarations to the submitted source. The extension processes website content (visible Analytics UI) to derive usage information, and stores derived account/usage status locally. The current code does not transmit those readings to an external service. The dashboard should accurately disclose local collection/processing even when data stays on-device. Do not claim that no data is handled.

## Remaining store tasks

- Register/configure the Chrome Web Store publisher account and enable required account security.
- Confirm Teambotics Inc. is the publisher display name and verify any official website URL in Search Console if the dashboard requires it.
- Add and publish the extension-specific privacy disclosure; confirm hello@teambotics.app is an appropriate monitored contact.
- Capture at least one sanitized, current 1280x800 or 640x400 screenshot of the real extension. Do not submit an account-identifying screenshot.
- Create the required 440x280 small promotional tile using approved branding.
- Complete the dashboard's privacy/data declarations and distribution settings.
- Upload the ZIP, inspect the dashboard's automated review results, then submit manually when ready.

No Store upload or submission has been performed.

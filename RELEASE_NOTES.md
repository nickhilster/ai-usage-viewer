# Release Notes

## v0.6.0

### Highlights

- Rename the product to AI Usage Viewer.
- Add visible Claude current-session and weekly usage alongside ChatGPT Codex usage.
- Keep background refresh tabs inside an existing normal browser window.
- Preserve local-only storage and visible-UI extraction for both providers.

## v0.1.0

### Highlights

- First public release of the extension, originally named ChatGPT Usage Viewer.
- Local-only Chrome/Edge extension for visible ChatGPT/Codex usage information.
- Designed for unpacked installation from this repository.

### Features

- Detects whether ChatGPT appears to be signed in.
- Detects the visible plan when ChatGPT exposes it in the UI.
- Reads visible Codex Analytics usage cards from `chatgpt.com`.
- Shows visible 5-hour, weekly, and credit values.
- Uses green, amber, and red usage indicators based on remaining percentage.
- Refreshes through an automatically managed inactive Codex Analytics tab; users do not need to open Analytics manually.
- Provides redacted diagnostics for bug reports.

### Privacy Guarantees

- No external backend.
- No third-party telemetry.
- No private OpenAI APIs.
- No password collection.
- No conversation-content storage.
- Uses the existing browser session.
- Stores derived metadata and timestamps only in `chrome.storage.local`.
- Redacted diagnostics omit raw page text, full URLs, conversation content, account identifiers, and credentials.

### Known Limitations

- Usage appears only when ChatGPT/Codex exposes it in visible page text.
- Values may be unavailable because of plan, region, language settings, A/B tests, or ChatGPT frontend changes.
- The extension does not infer hidden limits, account entitlements, or exact reset behavior.
- The Codex usage page location and wording may change and require parser updates.
- Chrome Web Store packaging has not been added for v0.1.0.

### Future Roadmap

- Add sanitized screenshots before broader public promotion.
- Add more parser fixtures as ChatGPT/Codex UI wording changes.
- Consider Firefox support if Manifest V3 compatibility and APIs are sufficient.
- Improve troubleshooting documentation based on real issue reports.

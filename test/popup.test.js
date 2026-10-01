const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const popupHtml = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
const popupSource = readFileSync(join(__dirname, "..", "popup.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));
const packageMetadata = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const offscreenSource = readFileSync(join(__dirname, "..", "offscreen.js"), "utf8");

test("the popup uses the compact layout without a mode toggle", () => {
  assert.doesNotMatch(popupHtml, /compactModeToggle|compact-toggle|toggle-track|body\.compact/);
  assert.doesNotMatch(popupSource, /storageKeys\.compactMode|applyCompactMode|saveCompactMode/);
  assert.match(popupHtml, /#chatgptSection\s*{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(popupSource, /CodexCapacityMonitor\.classifyUsageLevel\(remainingPercent\)/);
  assert.match(popupSource, /classList\.add\("percentage-metric", `usage-\$\{usageLevel\}`\)/);
  assert.match(popupHtml, /\.percentage-metric \.metric-value\s*{[^}]*conic-gradient/s);
});

test("the popup footer credits Teambotics in tiny text and identifies the local-only status", () => {
  assert.match(popupHtml, /Built with ❤️ by/);
  assert.match(popupHtml, /href="https:\/\/www\.teambotics\.app\/"/);
  assert.match(popupHtml, /\.foot-credit\s*{[^}]*font-size:\s*9px/s);
  assert.match(popupHtml, /Local only\. Not affiliated with OpenAI\./);
});

test("release author and versions match extension metadata", () => {
  assert.equal(packageMetadata.author, "Teambotics Inc.");
  assert.equal(packageMetadata.homepage, "https://www.teambotics.app/");
  assert.equal(packageMetadata.name, "chatgpt-usage-viewer");
  assert.equal(packageMetadata.version, manifest.version);
  assert.equal(manifest.version, "0.5.1");
  assert.equal(manifest.homepage_url, "https://www.teambotics.app/");
  assert.equal(manifest.name, "ChatGPT Usage Viewer");
  assert.equal(manifest.action.default_title, "ChatGPT Usage Viewer");
  assert.match(popupHtml, /<title>ChatGPT Usage Viewer<\/title>/);
  assert.match(popupHtml, /<h1>ChatGPT Usage Viewer<\/h1>/);
  assert.match(popupSource, /extension: "ChatGPT Usage Viewer"/);
});

test("account metadata has no redundant ChatGPT section heading", () => {
  assert.doesNotMatch(popupHtml, /<h2>ChatGPT<\/h2>/);
  assert.match(popupHtml, /<section class="account-section">\s*<dl id="chatgptSection"><\/dl>/s);
});

test("metrics are grouped into primary limits and totals", () => {
  const orderedKeys = [
    "codex5h",
    "codexWeekly",
    "codexCredits",
    "bankedResets"
  ];
  let previousIndex = -1;

  for (const key of orderedKeys) {
    const index = popupSource.indexOf(`, "${key}",`, previousIndex + 1);
    assert.ok(index > previousIndex, `${key} should follow the previous metric`);
    previousIndex = index;
  }

  assert.match(popupHtml, /id="primaryLimits" class="primary-limits"/);
  assert.doesNotMatch(popupHtml, /otherLimits|Other limits/);
  assert.match(popupHtml, /id="totalsSection" class="totals-list"/);
});

test("an empty 5-hour limit is shown in a direct row below Weekly", () => {
  const renderer = popupSource.slice(
    popupSource.indexOf("function renderCodexCards"),
    popupSource.indexOf("function hasMetricData")
  );

  assert.doesNotMatch(renderer, /codexSpark|otherLimits/);
  assert.match(renderer, /if \(has5hData\)\s*{\s*appendMetric\(primaryLimits, snapshot, "codex5h"/);
  assert.match(renderer, /if \(!has5hData\)\s*{\s*appendMetric\(secondaryLimits, snapshot, "codex5h"/);
  assert.match(popupHtml, /id="primaryLimits"[^>]*><\/div>\s*<div id="secondaryLimits"/);
  assert.match(renderer, /appendMetric\(primaryLimits, snapshot, "codexWeekly"/);
});

test("refresh age sits immediately before Refresh in the action cluster", () => {
  assert.match(
    popupHtml,
    /class="refresh-cluster">\s*<span id="statusAge">[^<]+<\/span>\s*<button id="refreshButton"[^>]*>Refresh<\/button>/s
  );
});

test("visible usage is presented as one concise status message", () => {
  assert.match(popupHtml, /class="status-copy">\s*<strong id="statusTitle">/s);
  assert.doesNotMatch(popupHtml, /status-divider/);
  assert.match(popupSource, /statusTitle\.textContent = "Usage visible in ChatGPT"/);
  assert.match(popupSource, /statusDetail\.textContent = ""/);
});

test("percentage metrics explicitly describe remaining capacity", () => {
  assert.match(popupSource, /setAttribute\("aria-label", `\$\{structured\.remainingPercent\}% remaining`\)/);
  assert.match(popupSource, /remaining\.textContent = "Remaining"/);
});

test("unavailable metrics render one dash without redundant copy", () => {
  const unavailableRenderer = popupSource.slice(
    popupSource.indexOf("function renderUnavailableCard"),
    popupSource.indexOf("function renderVisibleFields")
  );
  assert.match(unavailableRenderer, /value\.textContent = "-"/);
  assert.doesNotMatch(unavailableRenderer, /Usage unavailable/);
});

test("capacity settings expose accessible persisted controls", () => {
  for (const id of [
    "enableNotifications",
    "notifyOnReset",
    "showRemainingPercentage",
    "lowThreshold",
    "criticalThreshold",
    "enableSounds"
  ]) {
    assert.match(popupHtml, new RegExp(`for="${id}"`));
    assert.match(popupHtml, new RegExp(`id="${id}"`));
  }
  assert.match(popupHtml, /Show remaining percentage on icon/);
  assert.match(popupHtml, /<script src="capacity-monitor\.js"><\/script>\s*<script src="popup\.js"><\/script>/s);
  assert.match(popupSource, /storageKeys\.capacitySettings/);
  assert.match(popupSource, /CodexCapacityMonitor\.normalizeSettings/);
});

test("settings expose a progressive automatic refresh slider with a 15-minute default", () => {
  assert.match(popupHtml, /<label for="refreshPeriodMinutes">Automatic refresh<\/label>/);
  assert.match(popupHtml, /<output id="refreshPeriodValue" for="refreshPeriodMinutes">15 minutes<\/output>/);
  assert.match(popupHtml, /<input id="refreshPeriodMinutes" type="range" min="1" max="60" step="1" value="15"/);
  assert.doesNotMatch(popupHtml, /<select id="refreshPeriodMinutes">/);
  assert.match(popupSource, /storageKeys\.refreshPeriodMinutes/);
  assert.match(popupSource, /normalizeRefreshPeriodMinutes/);
  assert.match(popupSource, /addEventListener\("input", previewRefreshPeriod\)/);
  assert.match(popupSource, /setAttribute\(\s*"aria-valuetext"/s);
});

test("manifest requests only the APIs required by capacity alerts", () => {
  assert.deepEqual(manifest.permissions, ["alarms", "notifications", "offscreen", "storage"]);
  assert.match(offscreenSource, /message\.type !== "capacity:playSound"/);
  assert.match(offscreenSource, /createOscillator\(\)/);
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const { UsageProviders } = require("../providers.js");
const { ClaudeUsageProvider: claude } = require("../claude-provider.js");

const collectedAt = "2026-09-29T12:00:00.000Z";
const fixture = readFileSync(join(__dirname, "fixtures", "claude-team-not-started-exhausted.txt"), "utf8");

test("the live Team fixture preserves not-started session state and exhausted weekly usage", () => {
  const result = claude.parseUsageText(fixture, collectedAt);
  assert.equal(result.ready, true);
  assert.equal(result.plan.value, "Team");
  assert.equal(result.usage["claude:session"].structured.state, "not-started");
  assert.equal(result.usage["claude:session"].structured.remainingPercent, null);
  assert.equal(result.usage["claude:weekly"].structured.remainingPercent, 0);
  assert.equal(result.usage["claude:weekly"].structured.resetText, "in 14 min");
});
test("numeric used percentages become remaining percentages", () => {
  const result = claude.parseUsageText(`Your usage limits\nPro\nCurrent session\nResets in 3 hr 20 min\n25% used\nWeekly limits\nAll models\nResets Oct 5\n40% used`, collectedAt);
  assert.equal(result.ready, true);
  assert.equal(result.usage["claude:session"].structured.remainingPercent, 75);
  assert.equal(result.usage["claude:session"].structured.state, "active");
  assert.equal(result.usage["claude:weekly"].structured.remainingPercent, 60);
  assert.equal(result.usage["claude:weekly"].structured.resetText, "Oct 5");
});

test("100 percent used is an explicit zero remaining", () => {
  const result = claude.parseUsageText(`Current session\n100% used\nWeekly limits\nAll models\n100% used`, collectedAt);
  assert.equal(result.usage["claude:session"].structured.remainingPercent, 0);
  assert.equal(result.usage["claude:weekly"].structured.remainingPercent, 0);
});

test("signed-out and half-rendered views are not ready", () => {
  for (const text of [
    "Sign in to Claude",
    "Current session\n25% used",
    "Weekly limits\nAll models\n40% used",
    "Current session\nWeekly limits\nAll models"
  ]) {
    const result = claude.parseUsageText(text, collectedAt);
    assert.equal(result.ready, false, text);
    assert.equal(claude.hasParsedUsageLimit({ usage: result.usage }), false, text);
  }
});

test("Claude registers once with namespaced storage and counter definitions", () => {
  const provider = UsageProviders.getProvider("claude");
  assert.equal(provider, claude.provider);
  assert.equal(provider.stateKey, "aiUsageViewer.state.claude");
  assert.equal(provider.retainedSignInTabKey, "aiUsageViewer.retainedSignInTab.claude");
  assert.deepEqual(provider.counters.map(({ key, windowMs }) => [key, windowMs]), [
    ["claude:session", 5 * 60 * 60 * 1000],
    ["claude:weekly", 7 * 24 * 60 * 60 * 1000]
  ]);
  assert.equal(provider.isUsageUrl("https://claude.ai/new#settings/usage"), true);
  assert.equal(provider.isUsageUrl("https://claude.ai/new"), false);
});

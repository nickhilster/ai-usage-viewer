const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));
function matches(pattern, url) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}
function scriptsAt(url) {
  return manifest.content_scripts.filter((entry) => entry.matches.some((pattern) => matches(pattern, url)))
    .flatMap((entry) => entry.js);
}

test("reader covers Analytics and sign-in recovery routes", () => {
  for (const url of [
    "https://chatgpt.com/codex/cloud/settings/analytics",
    "https://chatgpt.com/auth/login",
    "https://chatgpt.com/login",
    "https://chatgpt.com/signin"
  ]) assert.ok(scriptsAt(url).includes("content-script.js"), url);
  assert.ok(!scriptsAt("https://chatgpt.com/c/abc").includes("content-script.js"));
});

test("ChatGPT chat pages load only the display badge and its model", () => {
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/c/abc"]) {
    assert.deepEqual(scriptsAt(url), ["usage-model.js", "chat-badge.js"]);
  }
  assert.deepEqual(scriptsAt("https://chat.openai.com/c/abc"), []);
});

test("Claude usage loads its provider before the rendered-DOM reader", () => {
  assert.ok(manifest.host_permissions.includes("https://claude.ai/*"));
  assert.deepEqual(scriptsAt("https://claude.ai/new#settings/usage"), [
    "usage-model.js", "providers.js", "claude-provider.js", "claude-content-script.js", "chat-badge.js"
  ]);
  assert.match(readFileSync(join(__dirname, "..", "background.js"), "utf8"),
    /importScripts\("usage-model\.js", "providers\.js", "claude-provider\.js", "capacity-monitor\.js"\)/);
  const popup = readFileSync(join(__dirname, "..", "popup.html"), "utf8");
  assert.ok(popup.indexOf('src="providers.js"') < popup.indexOf('src="claude-provider.js"'));
  assert.ok(popup.indexOf('src="claude-provider.js"') < popup.indexOf('src="capacity-monitor.js"'));
});

test("Claude pages load the generic badge after the reader without loading the reader twice", () => {
  assert.deepEqual(scriptsAt("https://claude.ai/new#settings/usage"), [
    "usage-model.js", "providers.js", "claude-provider.js", "claude-content-script.js",
    "chat-badge.js"
  ]);
});

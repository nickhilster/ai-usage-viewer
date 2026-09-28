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

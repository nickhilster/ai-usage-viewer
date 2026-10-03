const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const { ClaudeUsageProvider } = require("../claude-provider.js");
const source = readFileSync(join(__dirname, "..", "claude-content-script.js"), "utf8");

function meter(value, sectionText) {
  const section = { innerText: sectionText, textContent: sectionText, parentElement: null };
  return {
    parentElement: section,
    getAttribute(name) {
      return { role: "meter", "aria-valuenow": String(value), "aria-valuetext": `${value}% used` }[name] || null;
    }
  };
}

function harness({ dialogText = "", meters = [], bodyText = "", hash = "#settings/usage" } = {}) {
  const listeners = [];
  const sent = [];
  const dialog = dialogText ? {
    innerText: dialogText,
    textContent: dialogText,
    querySelectorAll(selector) { return selector === '[role="meter"]' ? meters : []; }
  } : null;
  for (const item of meters) {
    let node = item.parentElement;
    while (node) {
      if (!node.parentElement) node.parentElement = dialog;
      node = node.parentElement === dialog ? null : node.parentElement;
    }
  }
  const document = {
    body: { innerText: bodyText || dialogText, textContent: bodyText || dialogText },
    documentElement: {},
    querySelector(selector) { return selector === '[role="dialog"]' ? dialog : null; }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }
  const context = vm.createContext({
    ClaudeUsageProvider,
    MutationObserver,
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        sendMessage(message) { sent.push(message); return Promise.resolve(); }
      }
    },
    document,
    location: { hostname: "claude.ai", pathname: "/new", hash },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    console
  });
  vm.runInContext(source, context);
  return {
    collect() {
      let response;
      listeners[0]({ type: "usage:collectSnapshot" }, {}, (value) => { response = value; });
      return response;
    },
    listeners,
    rerun() { vm.runInContext(source, context); },
    sent
  };
}

test("rendered Claude dialog associates unlabelled meters with their headings", () => {
  const view = harness({
    dialogText: "Your usage limits\nTeam\nCurrent session\nStarts when a message is sent\nWeekly limits\nAll models\nResets in 14 min\nResets upgrade promotion",
    meters: [
      meter(0, "Current session\nStarts when a message is sent"),
      meter(100, "Weekly limits\nAll models\nResets in 14 min")
    ]
  });
  const snapshot = view.collect();
  assert.equal(snapshot.loginStatus, "logged-in");
  assert.equal(snapshot.claudeUsage.ready, true);
  assert.equal(snapshot.usage["claude:session"].structured.state, "not-started");
  assert.equal(snapshot.usage["claude:weekly"].structured.remainingPercent, 0);
  assert.equal(snapshot.usage["claude:weekly"].structured.resetText, "in 14 min");
});
test("skeleton and signed-out pages cannot produce accepted usage", () => {
  const skeleton = harness({ dialogText: "Your usage limits\nCurrent session\nWeekly limits" }).collect();
  assert.equal(skeleton.claudeUsage.ready, false);
  assert.equal(Object.keys(skeleton.usage).length, 0);
  const signedOut = harness({ bodyText: "Sign in to Claude", hash: "#settings/usage" }).collect();
  assert.equal(signedOut.loginStatus, "logged-out");
  assert.deepEqual(Object.keys(signedOut.usage), []);
});

test("reinjection installs one listener and one reader", () => {
  const view = harness({ dialogText: "Current session\nWeekly limits" });
  view.rerun();
  assert.equal(view.listeners.length, 1);
});

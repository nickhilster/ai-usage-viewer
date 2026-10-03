const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { ChatGPTUsageConfig } = require("../usage-model.js");
const { CodexCapacityMonitor } = require("../capacity-monitor.js");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.className = "";
    this.style = { setProperty() {} };
    this.classList = { add: (...names) => { this.className += ` ${names.join(" ")}`; } };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute() {}
}

async function openPopup({ legacyBackground = false, paceTrackerVersion = CodexCapacityMonitor.PACE_TRACKER_VERSION } = {}) {
  let now = Date.parse("2026-09-05T16:00:00Z");
  const snapshot = {
    loginStatus: "logged-in", hostname: "chatgpt.com", domUsageVisible: true,
    collectedAt: new Date(now - 8 * 60000).toISOString(),
    usage: { codexWeekly: { value: "7% remaining", structured: {
      remainingPercent: 7, resetText: "Sep 11, 2026 7:32 AM"
    } } }
  };
  const state = { snapshot, dataCollectedAt: snapshot.collectedAt };
  const claudeSnapshot = {
    loginStatus: "logged-in", hostname: "claude.ai", domUsageVisible: true,
    collectedAt: new Date(now).toISOString(), plan: { value: "Team" },
    usage: {
      "claude:session": { value: "Not started", structured: { state: "not-started", remainingPercent: null, resetText: null } },
      "claude:weekly": { value: "100% used", structured: { state: "active", remainingPercent: 0, resetText: "in 14 min" } }
    }
  };
  const claudeState = { snapshot: claudeSnapshot, dataCollectedAt: claudeSnapshot.collectedAt };
  const elements = new Map();
  let onChange;
  let tick;
  let reloads = 0;
  const messages = [];
  const document = {
    createElement: () => new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    document,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval(callback) { tick = callback; },
    chrome: {
      runtime: {
        getManifest() { return JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8")); },
        async sendMessage(message) {
          messages.push(message);
          if (message.type !== "usage:getState") return { ok: true };
          return legacyBackground ? { state } : {
            state, providers: { chatgpt: state, claude: claudeState }, paceSessionId: "session", paceTrackerVersion
          };
        },
        reload() { reloads += 1; }
      },
      storage: { local: { async get() { return {}; } }, onChanged: { addListener(fn) { onChange = fn; } } }
    }
  });
  for (const file of ["usage-model.js", "providers.js", "claude-provider.js", "capacity-monitor.js", "popup.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", file), "utf8"), context);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const findEstimate = (element) => element.className === "metric-estimate"
    ? element.textContent : element.children.map(findEstimate).find(Boolean);
  return {
    snapshot, state, claudeSnapshot, claudeState,
    elements,
    reloads: () => reloads,
    text: () => findEstimate(document.getElementById("primaryLimits")),
    emit(key, value) { onChange({ [key]: { newValue: value } }, "local"); },
    advance(minutes) { now += minutes * 60000; tick(); },
    now: () => now
    , messages
  };
}

test("the reported weekly-only popup starts proportionally and switches to confirmed pace", async () => {
  const popup = await openPopup();
  const keys = ChatGPTUsageConfig.storageKeys;
  assert.equal(popup.text(), "≈ 11 hr 45 min left · initial estimate");
  let capacity = CodexCapacityMonitor.evaluateSnapshot(popup.snapshot, null, {},
    new Date(popup.now()).toISOString(), "session").state;
  popup.emit(keys.capacityState, capacity);
  popup.advance(15);
  popup.snapshot.usage.codexWeekly.structured.remainingPercent = 6;
  popup.snapshot.usage.codexWeekly.value = "6% remaining";
  popup.snapshot.collectedAt = new Date(popup.now()).toISOString();
  popup.emit(keys.state, popup.state);
  assert.equal(popup.text(), "≈ 10 hr 4 min left · initial estimate");
  capacity = CodexCapacityMonitor.evaluateSnapshot(popup.snapshot, capacity, {},
    new Date(popup.now()).toISOString(), "session").state;
  popup.emit(keys.capacityState, capacity);
  assert.equal(popup.text(), "≈ 1 hr 30 min left at this pace");
});

test("an older installed background offers an explicit reload instead of the weekly fallback", async () => {
  const popup = await openPopup({ legacyBackground: true });
  assert.equal(popup.text(), "Reload extension for estimate");
  assert.equal(popup.elements.get("paceReloadNotice").hidden, false);
  assert.equal(popup.reloads(), 0);
  popup.elements.get("reloadExtensionButton").listeners.click();
  assert.equal(popup.reloads(), 1);
});

test("the current background hides the reload prompt", async () => {
  const popup = await openPopup();
  assert.equal(popup.elements.get("paceReloadNotice").hidden, true);
  assert.equal(popup.reloads(), 0);
});

test("an outdated pace tracker is detected even when the background already has a session ID", async () => {
  const popup = await openPopup({ paceTrackerVersion: 1 });
  assert.equal(popup.text(), "Reload extension for estimate");
  assert.equal(popup.elements.get("paceReloadNotice").hidden, false);
});

test("a fallback still obeys the visible reset deadline and expires with stale data", async () => {
  const popup = await openPopup();
  popup.snapshot.usage.codexWeekly.structured.resetText = "in 1 hr";
  popup.emit(ChatGPTUsageConfig.storageKeys.state, popup.state);
  assert.equal(popup.text(), "≈ 52 min left · resets then");
  popup.advance(28);
  assert.equal(popup.text(), "Estimate unavailable");
});

test("signed-out and unknown-login snapshots cannot use the proportional fallback", async () => {
  const popup = await openPopup();
  for (const loginStatus of ["logged-out", "unknown"]) {
    popup.snapshot.loginStatus = loginStatus;
    popup.emit(ChatGPTUsageConfig.storageKeys.state, popup.state);
    assert.equal(popup.text(), "Estimate unavailable");
  }
});

test("the popup renders Claude inline with not-started copy and a live countdown", async () => {
  const popup = await openPopup();
  const providerText = () => popup.elements.get("providerSections").textContent;
  assert.match(providerText(), /Claude/);
  assert.match(providerText(), /Not started · starts when a message is sent/);
  assert.match(providerText(), /0%/);
  assert.match(providerText(), /Resets in 14 min/);
  popup.advance(1);
  assert.match(providerText(), /Resets in 13 min/);
  popup.claudeSnapshot.usage["claude:weekly"].structured.resetText = "whenever";
  popup.emit("aiUsageViewer.state.claude", popup.claudeState);
  assert.match(providerText(), /Reset: whenever/);
});

test("Claude's inline action opens its own usage page and Refresh stays global", async () => {
  const popup = await openPopup();
  const root = popup.elements.get("providerSections");
  const buttons = [];
  const walk = (element) => {
    if (element.listeners.click) buttons.push(element);
    element.children.forEach(walk);
  };
  walk(root);
  assert.equal(buttons.length, 1);
  await buttons[0].listeners.click();
  assert.equal(JSON.stringify(popup.messages.at(-1)), JSON.stringify({ type: "usage:openUsage", providerId: "claude" }));
  const refreshMessagesBefore = popup.messages.filter((message) => message.type === "usage:refresh").length;
  await popup.elements.get("refreshButton").listeners.click();
  assert.equal(popup.messages.filter((message) => message.type === "usage:refresh").length, refreshMessagesBefore + 1);
});

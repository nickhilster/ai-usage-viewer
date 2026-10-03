const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { ChatGPTUsageConfig } = require("../usage-model.js");

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.offsetWidth = 200;
    this.offsetHeight = 40;
  }
  append(...children) { this.children.push(...children); }
  attachShadow() { this.shadowRoot = new Element("shadow"); return this.shadowRoot; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left) || 0;
    const bottom = Number.parseFloat(this.style.bottom) || 0;
    return { left, top: 900 - bottom - this.offsetHeight, bottom: 900 - bottom };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(" "); }
}

const NOW = Date.parse("2026-09-27T16:00:00Z");
function state(five = 41, weekly = 82, minutesOld = 5) {
  const usage = {};
  if (five !== null) usage.codex5h = { value: `${five}% remaining`, structured: { remainingPercent: five } };
  if (weekly !== null) usage.codexWeekly = { value: `${weekly}% remaining`, structured: { remainingPercent: weekly } };
  return {
    snapshot: { usage }, status: "usage-current",
    dataCollectedAt: new Date(NOW - minutesOld * 60000).toISOString(),
    lastRefreshAttemptAt: new Date(NOW - minutesOld * 60000).toISOString()
  };
}

async function harness(initial, savedPosition = null, hostname = "chatgpt.com") {
  let currentNow = NOW;
  let tick;
  const windowListeners = {};
  const body = new Element("body");
  const document = {
    body, createElement: (tag) => new Element(tag),
    querySelector: () => body.children.find((child) => "data-chatgpt-usage-badge" in child.attributes) || null
  };
  const listeners = [];
  const sent = [];
  const sentMessages = [];
  const stateKey = hostname === "claude.ai" ? "aiUsageViewer.state.claude" : ChatGPTUsageConfig.storageKeys.state;
  const positionKey = hostname === "claude.ai" ? "aiUsageViewer.badgePosition.claude" : "chatgptUsageMonitor.badgePosition";
  const chrome = {
    storage: {
      local: {
        saved: savedPosition ? { "chatgptUsageMonitor.badgePosition": savedPosition } : {},
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, key === stateKey ? initial : this.saved[key]]));
        },
        async set(value) { Object.assign(this.saved, value); }
      },
      onChanged: { addListener(fn) { listeners.push(fn); } }
    },
    runtime: { async sendMessage(message) { sent.push(message.type); sentMessages.push(message); } }
  };
  const context = vm.createContext({
    console, innerWidth: 1400, innerHeight: 900,
    addEventListener(name, callback) { windowListeners[name] = callback; },
    removeEventListener(name) { delete windowListeners[name]; },
    setInterval(callback) { tick = callback; },
    location: { hostname }
  });
  for (const name of ["usage-model.js", "providers.js", "claude-provider.js", "chat-badge.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", name), "utf8"), context);
  }
  await context.ChatGPTUsageBadge.mount(document, chrome, () => currentNow);
  const root = () => body.children[0].shadowRoot;
  const find = (name, node = root()) => {
    if (node.attributes["data-role"] === name) return node;
    for (const child of node.children) { const found = find(name, child); if (found) return found; }
    return null;
  };
  return {
    body, root, find, sent, sentMessages,
    listenerCount: () => listeners.length,
    update(value) { listeners.forEach((fn) => fn({ [stateKey]: { newValue: value } }, "local")); },
    mount: () => context.ChatGPTUsageBadge.mount(document, chrome, () => currentNow),
    reloadScript: () => vm.runInContext(readFileSync(join(__dirname, "..", "chat-badge.js"), "utf8"), context),
    advance(minutes) { currentNow += minutes * 60000; tick(); },
    pointer(name, event) { windowListeners[name](event); },
    savedPosition() { return chrome.storage.local.saved[positionKey]; },
    chrome
  };
}

test("compact pill initially shows the 5-hour remaining value", async () => {
  const ui = await harness(state());
  assert.match(ui.find("pill").textContent, /5-hour.*41% left/);
  assert.equal(ui.find("details").hidden, true);
  assert.equal(ui.body.children.length, 1);
  assert.equal(ui.body.children[0].style.position, "fixed");
  assert.equal(ui.body.children[0].style.left, "160px");
  assert.equal(ui.body.children[0].style.bottom, "16px");
  assert.equal(ui.body.children[0].style.right, undefined);
});

test("dragging moves the badge, saves its position, and does not toggle details", async () => {
  const ui = await harness(state());
  const host = ui.body.children[0];
  const pill = ui.find("pill");
  const pointer = (clientX, clientY) => ({
    button: 0, pointerId: 1, clientX, clientY,
    preventDefault() {}, stopPropagation() {}
  });
  pill.listeners.pointerdown(pointer(180, 860));
  ui.pointer("pointermove", pointer(300, 800));
  ui.pointer("pointerup", pointer(300, 800));
  pill.listeners.click();
  assert.equal(host.style.left, "280px");
  assert.equal(host.style.bottom, "84px");
  assert.equal(ui.savedPosition().left, 280);
  assert.equal(ui.savedPosition().bottom, 84);
  assert.equal(ui.find("details").hidden, true);
});

test("saved badge position is restored and clamped to the viewport", async () => {
  const ui = await harness(state(), { left: 5000, bottom: 5000 });
  assert.equal(ui.body.children[0].style.left, "1200px");
  assert.equal(ui.body.children[0].style.bottom, "860px");
});

test("click opens weekly value and last successful reading time", async () => {
  const ui = await harness(state());
  ui.find("pill").listeners.click();
  assert.equal(ui.find("details").hidden, false);
  assert.match(ui.find("details").textContent, /Weekly.*82% left/);
  assert.match(ui.find("details").textContent, /5 min ago/);
});

test("missing weekly data is shown as unavailable", async () => {
  const ui = await harness(state(41, null));
  ui.find("pill").listeners.click();
  assert.match(ui.find("details").textContent, /Weekly.*Unavailable/);
});

test("unavailable state offers retry and open usage actions", async () => {
  const ui = await harness(null);
  assert.match(ui.find("pill").textContent, /Unavailable/);
  ui.find("pill").listeners.click();
  ui.find("retry").listeners.click();
  ui.find("open-usage").listeners.click();
  assert.deepEqual(ui.sent, ["usage:refresh", "usage:openCodexAnalytics"]);
});

test("local storage updates refresh displayed values", async () => {
  const ui = await harness(state());
  ui.update(state(12, 32));
  assert.match(ui.find("pill").textContent, /12% left/);
  ui.find("pill").listeners.click();
  assert.match(ui.find("details").textContent, /32% left/);
});

test("a cached reading becomes stale after 30 minutes", async () => {
  const ui = await harness(state(41, 82, 31));
  assert.match(ui.find("pill").textContent, /41% left.*Stale/);
  ui.find("pill").listeners.click();
  assert.match(ui.find("details").textContent, /31 min ago/);
});

test("an open badge updates its stale age as time passes", async () => {
  const ui = await harness(state(41, 82, 5));
  assert.doesNotMatch(ui.find("pill").textContent, /Stale/);
  ui.advance(26);
  assert.match(ui.find("pill").textContent, /41% left.*Stale/);
});

test("failed refresh keeps the last values and marks them stale", async () => {
  const ui = await harness(state());
  ui.update({ ...state(), status: "sign-in-required", lastRefreshAttemptAt: new Date(NOW).toISOString() });
  assert.match(ui.find("pill").textContent, /41% left.*Stale/);
  ui.find("pill").listeners.click();
  assert.match(ui.find("details").textContent, /82% left/);
});

test("an in-progress refresh does not mark a recent reading stale", async () => {
  const ui = await harness({ ...state(), status: "refreshing-codex-analytics", lastRefreshAttemptAt: new Date(NOW).toISOString() });
  assert.doesNotMatch(ui.find("pill").textContent, /Stale/);
});

test("mounting twice keeps one badge", async () => {
  const ui = await harness(state());
  await ui.mount();
  assert.equal(ui.body.children.length, 1);
});

test("evaluating the content script twice keeps one badge and one storage listener", async () => {
  const ui = await harness(state());
  ui.reloadScript();
  await ui.mount();
  assert.equal(ui.body.children.length, 1);
  assert.equal(ui.listenerCount(), 1);
  ui.update(state(12, 32));
  assert.match(ui.find("pill").textContent, /12% left/);
});

test("a storage update during initial read wins over the older read response", async () => {
  const body = new Element("body");
  const document = {
    body, createElement: (tag) => new Element(tag),
    querySelector: () => body.children.find((child) => "data-chatgpt-usage-badge" in child.attributes) || null
  };
  let resolveRead;
  let onChange;
  const chrome = {
    storage: {
      local: { get() { return new Promise((resolve) => { resolveRead = resolve; }); } },
      onChanged: { addListener(fn) { onChange = fn; } }
    },
    runtime: { sendMessage() {} }
  };
  const context = vm.createContext({ setInterval() {} });
  for (const name of ["usage-model.js", "chat-badge.js"]) {
    vm.runInContext(readFileSync(join(__dirname, "..", name), "utf8"), context);
  }
  const mounting = context.ChatGPTUsageBadge.mount(document, chrome, () => NOW);
  onChange({ [ChatGPTUsageConfig.storageKeys.state]: { newValue: state(12, 32) } }, "local");
  resolveRead({ [ChatGPTUsageConfig.storageKeys.state]: state(41, 82) });
  await mounting;
  assert.match(body.children[0].shadowRoot.textContent, /12% left/);
  assert.doesNotMatch(body.children[0].shadowRoot.textContent, /41% left/);
});

function claudeState(session = "not-started", weekly = 0, resetText = "in 14 min", minutesOld = 0) {
  return {
    snapshot: {
      loginStatus: "logged-in",
      collectedAt: new Date(NOW - minutesOld * 60000).toISOString(),
      usage: {
        "claude:session": session === "not-started"
          ? { value: "Not started", structured: { state: "not-started", remainingPercent: null } }
          : { value: `${100 - session}% used`, structured: { state: "active", remainingPercent: session } },
        "claude:weekly": { value: `${100 - weekly}% used`, structured: { state: "active", remainingPercent: weekly, resetText } }
      }
    },
    status: "usage-current",
    dataCollectedAt: new Date(NOW - minutesOld * 60000).toISOString()
  };
}

test("Claude pages select the Claude provider and render not-started plus weekly countdown", async () => {
  const ui = await harness(claudeState(), null, "claude.ai");
  assert.match(ui.find("pill").textContent, /Claude session: Not started/);
  ui.find("pill").listeners.click();
  assert.match(ui.find("details").textContent, /Claude weekly usage: 0% left/);
  assert.match(ui.find("details").textContent, /Resets in 14 min/);
  ui.advance(1);
  assert.match(ui.find("details").textContent, /Resets in 13 min/);
});

test("Claude updates and actions stay provider-specific", async () => {
  const ui = await harness(claudeState(75, 60), null, "claude.ai");
  assert.match(ui.find("pill").textContent, /Claude session: 75% left/);
  ui.update(claudeState(50, 40));
  assert.match(ui.find("pill").textContent, /50% left/);
  ui.find("open-usage").listeners.click();
  assert.equal(JSON.stringify(ui.sentMessages.at(-1)), JSON.stringify({ type: "usage:openUsage", providerId: "claude" }));
});

test("Claude badge reinjection keeps one mount and one listener", async () => {
  const ui = await harness(claudeState(), null, "claude.ai");
  ui.reloadScript();
  await ui.mount();
  assert.equal(ui.body.children.length, 1);
  assert.equal(ui.listenerCount(), 1);
});

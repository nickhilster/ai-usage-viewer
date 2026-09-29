# Provider Seam Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a provider registry and make the refresh, capacity, pace and toolbar-badge pipeline provider-aware, with ChatGPT as the only real provider and **no user-visible change**.

**Architecture:** A new `providers.js` registry holds per-provider definitions (URLs, storage keys, counter definitions with window lengths, parse hooks, message strings). `capacity-monitor.js` reads its counters from the registry instead of hard-coded `codex5h`/`codexWeekly`, and `evaluateSnapshot` gains a provider scope so one provider's snapshot never disturbs another provider's counters or pace history. `background.js` threads an optional trailing `provider` argument (default: ChatGPT) through the refresh path and refreshes every registered provider one at a time. A test-only fake provider proves the seam works for a second provider before any real one exists.

**Tech Stack:** Vanilla JS, Chrome/Edge Manifest V3, `node --test` (Node 26 here), `vm`-based harnesses.

**Spec:** `docs/superpowers/specs/2026-09-29-multi-provider-usage-design.md` (read **Amendment 1** — it overrides the spec's snapshot shape and storage-migration sections).

## Global Constraints

- **No user-visible change and no version bump.** `manifest.json` and `package.json` stay at `0.5.1`. `AGENTS.md`: refactors and tests-only changes do not require a version increase.
- **No commits, pushes or tags** unless the user asks (`AGENTS.md`). Each task ends with a *Checkpoint* step (run checks), not a commit step.
- **The existing 211 tests must keep passing.** Baseline verified 2026-09-29: `npm test` → 211 pass, 0 fail. The only allowed edits to existing tests are: adding `providers.js` to script lists / injecting the `UsageProviders` global into vm contexts (Tasks 2 and 4), and appending new tests.
- **ChatGPT keys are grandfathered:** counter keys `codexWeekly` / `codex5h`, storage keys `chatgptUsageMonitor.*`, notification ids `codex-capacity-<key>-<type>`, refresh status strings (`refreshing-codex-analytics`, …) and every ChatGPT user-facing string stay byte-identical.
- **Existing internals keep their old call signatures.** Tests call `saveSnapshot(snap, {id:7}, source)`, `requestSnapshotWithRetry(7)`, `refreshOnce('popup', true)`, `saveIncompleteRefresh(x, 99)`, `retainOnlySignInTab(99)`, `forgetRetainedSignInTab(42)`, `processCapacitySnapshot(snap)`, `clearCapacityMonitorState()`, `openCodexAnalyticsPage()`, and set/read the top-level `analyticsRefreshGeneration` and `analyticsRefreshContext`. New parameters are **trailing and optional, defaulting to ChatGPT**. Do not introduce per-provider generation counters.
- Extension privacy stance unchanged: rendered DOM only, `chrome.storage.local` only, no new network calls, no new permissions in this plan.
- Node's test runner treats every `.js` file under `test/` as a test file; `test/helpers/*.js` will be loaded harmlessly (it defines no tests).
- Run commands from `C:\dev\Usage-Tracker`. Full verification: `npm run check && npm test && git diff --check`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `providers.js` | create | Provider registry: definitions, counter definitions, lookups. Loaded in the service worker, popup and node tests. Not a content script in this plan. |
| `capacity-monitor.js` | modify | Counters/pace keys/window lengths come from the registry; provider-scoped `evaluateSnapshot`; `removeProviderCounters`. |
| `background.js` | modify | Provider parameter through refresh + capacity paths; refresh-all scheduling. |
| `popup.html` | modify | Load `providers.js` before `capacity-monitor.js`. |
| `package.json` | modify | Add `node --check providers.js` to `check`. |
| `scripts/package-web-store.ps1` | modify | Include `providers.js` in the package file list. |
| `test/helpers/fake-provider.js` | create | Shared fake provider + snapshot builder for tests. |
| `test/providers.test.js` | create | Registry tests. |
| `test/capacity-providers.test.js` | create | Registry-driven counters and provider-scoped evaluation tests. |
| `test/background.test.js` | modify | Inject `UsageProviders`; append fake-provider integration tests. |
| `test/popup-runtime.test.js` | modify | Add `providers.js` to the loaded script list. |

---

### Task 1: Provider registry

**Files:**
- Create: `providers.js`, `test/helpers/fake-provider.js`, `test/providers.test.js`
- Modify: `package.json` (check script), `scripts/package-web-store.ps1` (file list)

**Interfaces:**
- Consumes: `ChatGPTUsageConfig.storageKeys.{state,retainedSignInTab}` and `ChatGPTUsageModel.{hasVisibleUsage,hasParsedUsageLimit,mergeUsageFields}` from `usage-model.js`.
- Produces (global `UsageProviders`, also `require("./providers.js").UsageProviders`):
  - `registerProvider(definition) → provider` (frozen; throws `Error` on invalid/duplicate)
  - `unregisterProvider(id) → boolean`
  - `getProvider(id) → provider | undefined`
  - `listProviders() → provider[]` (registration order)
  - `allCounters() → { key, label, limitName, windowMs, providerId, providerName }[]` (registration order)
  - `counterDefinition(key) → counter | undefined`
  - `providerForCounterKey(key) → provider | undefined`
  - `providerForUrl(url) → provider | undefined` (first provider whose `isUsageUrl(url)` is true)
  - `providerForHostname(hostname) → provider | undefined`
  - `defaultStorageKeys(id) → { stateKey, retainedSignInTabKey }` (`aiUsageViewer.state.<id>`, `aiUsageViewer.retainedSignInTab.<id>`)
  - Provider shape: `{ id, name, usageUrl, hostnames[], hostPatterns[], stateKey, retainedSignInTabKey, counters[{key,label,limitName,windowMs}], messages{loadFailed,readerUnresponsive,noNewData,routeNotDetected,contentScriptMissing,loadTimeout}, isUsageUrl(url), isUsagePageSnapshot(snapshot), hasVisibleUsage(snapshot), hasParsedUsageLimit(snapshot), mergeUsageFields(a,b), grandfatheredCounterKeys? }`
  - Built-in provider `"chatgpt"` is registered at load with counters in this order: `codexWeekly` (`"Weekly usage"`, limit `"weekly"`, 7 days), `codex5h` (`"5-hour usage"`, limit `"5-hour"`, 5 hours).

- [ ] **Step 1: Write the shared test helper**

Create `test/helpers/fake-provider.js`:

```js
const { UsageProviders } = require("../../providers.js");

const FAKE_KEY = "fake:session";

function fakeProvider(overrides = {}) {
  return {
    id: "fake",
    name: "Fake",
    usageUrl: "https://fake.example/usage",
    hostnames: ["fake.example"],
    hostPatterns: ["https://fake.example/*"],
    stateKey: "aiUsageViewer.state.fake",
    retainedSignInTabKey: "aiUsageViewer.retainedSignInTab.fake",
    counters: [{
      key: FAKE_KEY,
      label: "Fake session usage",
      limitName: "session",
      windowMs: 5 * 60 * 60 * 1000
    }],
    messages: {
      loadFailed: "The extension could not create the temporary Fake usage tab.",
      readerUnresponsive: "The temporary Fake usage page did not respond after loading.",
      noNewData: "Fake usage rendered, but no new visible usage values were detected yet.",
      routeNotDetected: "The temporary tab responded, but the Fake usage view was not detected yet.",
      contentScriptMissing: "Fake usage content script did not respond.",
      loadTimeout: "Timed out loading Fake usage."
    },
    isUsageUrl: (url) => String(url).startsWith("https://fake.example/usage"),
    isUsagePageSnapshot: (snapshot) => Boolean(snapshot && snapshot.fakeUsagePage),
    hasVisibleUsage: (snapshot) => Boolean(snapshot && snapshot.usage
      && snapshot.usage[FAKE_KEY] && snapshot.usage[FAKE_KEY].value),
    hasParsedUsageLimit: (snapshot) => Number.isFinite(snapshot && snapshot.usage
      && snapshot.usage[FAKE_KEY] && snapshot.usage[FAKE_KEY].structured
      && snapshot.usage[FAKE_KEY].structured.remainingPercent),
    mergeUsageFields: (a, b) => ({ ...(a || {}), ...(b || {}) }),
    ...overrides
  };
}

function fakeSnapshot(remainingPercent, collectedAt, resetText = "in 2 hours") {
  return {
    status: "ok",
    loginStatus: "logged-in",
    fakeUsagePage: true,
    hostname: "fake.example",
    usage: {
      [FAKE_KEY]: {
        value: `${remainingPercent}%`,
        structured: { remainingPercent, resetText }
      }
    },
    domUsageVisible: true,
    collectedAt
  };
}

function withFakeProvider(run, overrides) {
  const provider = UsageProviders.registerProvider(fakeProvider(overrides));
  try {
    return run(provider);
  } finally {
    UsageProviders.unregisterProvider(provider.id);
  }
}

async function withFakeProviderAsync(run, overrides) {
  const provider = UsageProviders.registerProvider(fakeProvider(overrides));
  try {
    return await run(provider);
  } finally {
    UsageProviders.unregisterProvider(provider.id);
  }
}

module.exports = {
  FAKE_KEY,
  fakeProvider,
  fakeSnapshot,
  withFakeProvider,
  withFakeProviderAsync
};
```

- [ ] **Step 2: Write the failing registry tests**

Create `test/providers.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ChatGPTUsageConfig } = require("../usage-model.js");
const { UsageProviders } = require("../providers.js");
const { FAKE_KEY, fakeProvider, withFakeProvider } = require("./helpers/fake-provider.js");

test("the built-in ChatGPT provider keeps its grandfathered keys and windows", () => {
  const chatgpt = UsageProviders.getProvider("chatgpt");
  assert.equal(chatgpt.name, "ChatGPT");
  assert.equal(chatgpt.stateKey, ChatGPTUsageConfig.storageKeys.state);
  assert.equal(chatgpt.retainedSignInTabKey, ChatGPTUsageConfig.storageKeys.retainedSignInTab);
  assert.deepEqual(
    chatgpt.counters.map(({ key, label, limitName, windowMs }) => ({ key, label, limitName, windowMs })),
    [
      { key: "codexWeekly", label: "Weekly usage", limitName: "weekly", windowMs: 7 * 24 * 3600000 },
      { key: "codex5h", label: "5-hour usage", limitName: "5-hour", windowMs: 5 * 3600000 }
    ]
  );
  assert.deepEqual([...chatgpt.hostnames], ["chatgpt.com"]);
  assert.deepEqual([...chatgpt.hostPatterns], ["https://chatgpt.com/*"]);
});

test("ChatGPT recognises only the Codex Analytics settings page", () => {
  const { isUsageUrl } = UsageProviders.getProvider("chatgpt");
  assert.equal(isUsageUrl("https://chatgpt.com/codex/cloud/settings/analytics"), true);
  assert.equal(isUsageUrl("https://chatgpt.com/codex/abc/settings/analytics?x=1"), true);
  assert.equal(isUsageUrl("https://chatgpt.com/"), false);
  assert.equal(isUsageUrl("https://example.com/codex/cloud/settings/analytics"), false);
  assert.equal(isUsageUrl("not a url"), false);
});

test("registerProvider rejects duplicate ids and malformed definitions", () => {
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ id: "chatgpt" })), /already registered/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ id: "Bad Id" })), /Provider id/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ usageUrl: "" })), /usageUrl/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ counters: [] })), /counters/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ isUsageUrl: null })), /isUsageUrl/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ messages: { loadFailed: "x" } })), /messages/);
  assert.equal(UsageProviders.getProvider("fake"), undefined);
});

test("non-grandfathered counter keys must be namespaced and globally unique", () => {
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [{ key: "session", label: "Fake", limitName: "session", windowMs: 1000 }]
  })), /must start with "fake:"/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    grandfatheredCounterKeys: true,
    counters: [{ key: "codexWeekly", label: "Fake", limitName: "weekly", windowMs: 1000 }]
  })), /duplicate counter key/i);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [
      { key: "fake:a", label: "A", limitName: "a", windowMs: 1000 },
      { key: "fake:a", label: "B", limitName: "b", windowMs: 1000 }
    ]
  })), /duplicate counter key/i);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [{ key: "fake:a", label: "A", limitName: "a", windowMs: 0 }]
  })), /windowMs/);
});

test("lookups cover counters, urls and hostnames, and unregister removes them", () => {
  withFakeProvider((provider) => {
    assert.deepEqual(UsageProviders.listProviders().map((p) => p.id), ["chatgpt", "fake"]);
    assert.equal(UsageProviders.counterDefinition(FAKE_KEY).windowMs, 5 * 3600000);
    assert.equal(UsageProviders.providerForCounterKey(FAKE_KEY), provider);
    assert.equal(UsageProviders.providerForCounterKey("codex5h").id, "chatgpt");
    assert.equal(UsageProviders.providerForUrl("https://fake.example/usage#x"), provider);
    assert.equal(UsageProviders.providerForHostname("fake.example"), provider);
    assert.equal(UsageProviders.providerForHostname("chatgpt.com").id, "chatgpt");
    assert.equal(UsageProviders.providerForHostname("nowhere.example"), undefined);
    const fake = UsageProviders.allCounters().find((counter) => counter.key === FAKE_KEY);
    assert.deepEqual(
      { providerId: fake.providerId, providerName: fake.providerName, limitName: fake.limitName },
      { providerId: "fake", providerName: "Fake", limitName: "session" }
    );
  });
  assert.equal(UsageProviders.getProvider("fake"), undefined);
  assert.equal(UsageProviders.counterDefinition(FAKE_KEY), undefined);
  assert.equal(UsageProviders.unregisterProvider("fake"), false);
});

test("new providers get namespaced default storage keys", () => {
  assert.deepEqual(UsageProviders.defaultStorageKeys("claude"), {
    stateKey: "aiUsageViewer.state.claude",
    retainedSignInTabKey: "aiUsageViewer.retainedSignInTab.claude"
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/providers.test.js`
Expected: FAIL — `Cannot find module '../providers.js'`.

- [ ] **Step 4: Implement `providers.js`**

Create `providers.js`:

```js
(function initProviders(globalScope) {
  "use strict";

  const usageConfig = globalScope.ChatGPTUsageConfig
    || (typeof require === "function" ? require("./usage-model.js").ChatGPTUsageConfig : null);
  const usageModel = globalScope.ChatGPTUsageModel
    || (typeof require === "function" ? require("./usage-model.js").ChatGPTUsageModel : null);

  const HOUR_MS = 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * HOUR_MS;
  const MESSAGE_KEYS = Object.freeze([
    "loadFailed",
    "readerUnresponsive",
    "noNewData",
    "routeNotDetected",
    "contentScriptMissing",
    "loadTimeout"
  ]);
  const REQUIRED_STRINGS = Object.freeze(["name", "usageUrl", "stateKey", "retainedSignInTabKey"]);
  const REQUIRED_FUNCTIONS = Object.freeze([
    "isUsageUrl",
    "isUsagePageSnapshot",
    "hasVisibleUsage",
    "hasParsedUsageLimit",
    "mergeUsageFields"
  ]);
  const registry = new Map();

  function registerProvider(definition) {
    const input = definition && typeof definition === "object" ? definition : {};
    const id = String(input.id);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error("Provider id must use lowercase letters, digits or hyphens.");
    }
    if (registry.has(id)) throw new Error(`Provider already registered: ${id}`);
    for (const field of REQUIRED_STRINGS) {
      if (typeof input[field] !== "string" || !input[field]) {
        throw new Error(`Provider ${id} needs a ${field}.`);
      }
    }
    for (const field of REQUIRED_FUNCTIONS) {
      if (typeof input[field] !== "function") throw new Error(`Provider ${id} needs an ${field} function.`);
    }
    for (const field of ["hostnames", "hostPatterns"]) {
      if (!Array.isArray(input[field]) || !input[field].length
        || !input[field].every((value) => typeof value === "string" && value)) {
        throw new Error(`Provider ${id} needs ${field}.`);
      }
    }
    const messages = input.messages;
    if (!messages || !MESSAGE_KEYS.every((key) => typeof messages[key] === "string" && messages[key])) {
      throw new Error(`Provider ${id} needs messages: ${MESSAGE_KEYS.join(", ")}.`);
    }
    if (!Array.isArray(input.counters) || !input.counters.length) {
      throw new Error(`Provider ${id} needs counters.`);
    }

    const takenKeys = new Set(allCounters().map((counter) => counter.key));
    const counters = input.counters.map((counter) => {
      const key = String(counter && counter.key);
      if (!input.grandfatheredCounterKeys && !key.startsWith(`${id}:`)) {
        throw new Error(`Counter key "${key}" must start with "${id}:".`);
      }
      if (takenKeys.has(key)) throw new Error(`Duplicate counter key: ${key}`);
      takenKeys.add(key);
      if (!counter.label || !counter.limitName) {
        throw new Error(`Counter ${key} needs a label and limitName.`);
      }
      if (!Number.isFinite(counter.windowMs) || counter.windowMs <= 0) {
        throw new Error(`Counter ${key} needs a positive windowMs.`);
      }
      return Object.freeze({
        key,
        label: String(counter.label),
        limitName: String(counter.limitName),
        windowMs: counter.windowMs
      });
    });

    const provider = Object.freeze({
      ...input,
      id,
      hostnames: Object.freeze([...input.hostnames]),
      hostPatterns: Object.freeze([...input.hostPatterns]),
      messages: Object.freeze({ ...messages }),
      counters: Object.freeze(counters)
    });
    registry.set(id, provider);
    return provider;
  }

  function unregisterProvider(id) {
    return registry.delete(id);
  }

  function getProvider(id) {
    return registry.get(id);
  }

  function listProviders() {
    return [...registry.values()];
  }

  function allCounters() {
    return listProviders().flatMap((provider) => provider.counters.map((counter) => ({
      ...counter,
      providerId: provider.id,
      providerName: provider.name
    })));
  }

  function counterDefinition(key) {
    return allCounters().find((counter) => counter.key === key);
  }

  function providerForCounterKey(key) {
    const definition = counterDefinition(key);
    return definition ? registry.get(definition.providerId) : undefined;
  }

  function providerForUrl(url) {
    return listProviders().find((provider) => provider.isUsageUrl(url));
  }

  function providerForHostname(hostname) {
    return listProviders().find((provider) => provider.hostnames.includes(hostname));
  }

  function defaultStorageKeys(id) {
    return {
      stateKey: `aiUsageViewer.state.${id}`,
      retainedSignInTabKey: `aiUsageViewer.retainedSignInTab.${id}`
    };
  }

  registerProvider({
    id: "chatgpt",
    name: "ChatGPT",
    usageUrl: "https://chatgpt.com/codex/cloud/settings/analytics",
    hostnames: ["chatgpt.com"],
    hostPatterns: ["https://chatgpt.com/*"],
    stateKey: usageConfig.storageKeys.state,
    retainedSignInTabKey: usageConfig.storageKeys.retainedSignInTab,
    grandfatheredCounterKeys: true,
    counters: [
      { key: "codexWeekly", label: "Weekly usage", limitName: "weekly", windowMs: WEEK_MS },
      { key: "codex5h", label: "5-hour usage", limitName: "5-hour", windowMs: 5 * HOUR_MS }
    ],
    messages: {
      loadFailed: "The extension could not create the temporary Codex Analytics tab.",
      readerUnresponsive: "The temporary Codex Analytics page did not respond after loading.",
      noNewData: "Codex Analytics rendered, but no new visible usage values were detected yet.",
      routeNotDetected: "The temporary tab responded, but the Codex Analytics route was not detected yet.",
      contentScriptMissing: "Codex Analytics content script did not respond.",
      loadTimeout: "Timed out loading Codex Analytics."
    },
    isUsageUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "chatgpt.com"
          && parsed.pathname.toLowerCase().includes("/codex/")
          && parsed.pathname.toLowerCase().includes("/settings/analytics");
      } catch {
        return false;
      }
    },
    isUsagePageSnapshot: (snapshot) => Boolean(snapshot && snapshot.codexAnalytics),
    hasVisibleUsage: (snapshot) => usageModel.hasVisibleUsage(snapshot),
    hasParsedUsageLimit: (snapshot) => usageModel.hasParsedUsageLimit(snapshot),
    mergeUsageFields: (accumulated, incoming) => usageModel.mergeUsageFields(accumulated, incoming)
  });

  const api = {
    allCounters,
    counterDefinition,
    defaultStorageKeys,
    getProvider,
    listProviders,
    providerForCounterKey,
    providerForHostname,
    providerForUrl,
    registerProvider,
    unregisterProvider
  };

  globalScope.UsageProviders = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { UsageProviders: api };
  }
})(typeof self !== "undefined" ? self : globalThis);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/providers.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Wire the new file into checks and packaging**

In `package.json`, change the `check` script so it also checks the new file:

```json
"check": "node --check background.js && node --check capacity-monitor.js && node --check content-script.js && node --check chat-badge.js && node --check offscreen.js && node --check popup.js && node --check usage-model.js && node --check providers.js",
```

In `scripts/package-web-store.ps1`, add `"providers.js",` to the file list, keeping alphabetical order: it goes between `"popup.js",` and `"usage-model.js",`. Verify with `grep -n '"' scripts/package-web-store.ps1 | sed -n 1,50p` that the list around lines 20-35 now contains it.

- [ ] **Step 7: Checkpoint**

Run: `npm run check && npm test && git diff --check`
Expected: check passes; tests `217 pass, 0 fail` (211 + 6); no whitespace errors. Do not commit unless the user asks.

---

### Task 2: Capacity monitor reads counters from the registry (no behavior change)

**Files:**
- Modify: `capacity-monitor.js` (lines ~4, 19-24, 49, 61, 76, 97, 152, 167, 227-231, 234, 269-272, 286, 467-491), `background.js:1` (importScripts), `popup.html:703-705`, `test/background.test.js` (harness), `test/popup-runtime.test.js:64`
- Create: `test/capacity-providers.test.js`

**Interfaces:**
- Consumes: `UsageProviders.allCounters()`, `UsageProviders.counterDefinition(key)` from Task 1.
- Produces: `CodexCapacityMonitor.COUNTERS` becomes a **getter** returning `[{ key, label }]` for every registered counter (same element shape as before). Internal helpers `counters()` and `paceKeys()`. Behavior with only ChatGPT registered is identical.

- [ ] **Step 1: Write the failing tests**

Create `test/capacity-providers.test.js`:

```js
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { CodexCapacityMonitor: monitor } = require("../capacity-monitor.js");
const { FAKE_KEY, fakeSnapshot, withFakeProvider } = require("./helpers/fake-provider.js");

const NOW = "2026-09-29T12:00:00.000Z";

test("COUNTERS reflects the registry and keeps the {key,label} shape", () => {
  assert.deepEqual(monitor.COUNTERS, [
    { key: "codexWeekly", label: "Weekly usage" },
    { key: "codex5h", label: "5-hour usage" }
  ]);
  withFakeProvider(() => {
    assert.deepEqual(monitor.COUNTERS.map((counter) => counter.key), ["codexWeekly", "codex5h", FAKE_KEY]);
  });
  assert.equal(monitor.COUNTERS.length, 2);
});

test("a registered provider's counters are extracted from a snapshot", () => {
  withFakeProvider(() => {
    const available = monitor.extractAvailableCounters(fakeSnapshot(60, NOW, "in 2 hours"));
    assert.deepEqual(available, [{
      key: FAKE_KEY,
      label: "Fake session usage",
      remainingPercent: 60,
      resetText: "in 2 hours"
    }]);
  });
});

test("initial pace estimates use the provider's own window length", () => {
  withFakeProvider(() => {
    const now = Date.parse(NOW);
    const estimate = monitor.estimateDisplayedTimeRemaining({}, FAKE_KEY, 50, now, now);
    assert.equal(estimate.status, "nominal");
    assert.equal(estimate.durationMs, 0.5 * 5 * 3600000);
    assert.equal(
      monitor.formatPaceTooltip(estimate, FAKE_KEY),
      "Initial estimate from your remaining session capacity."
    );
  });
});

test("pace state has a slot for every registered counter", () => {
  withFakeProvider(() => {
    const state = monitor.normalizeMonitorState({ pace: { [FAKE_KEY]: [{ at: 1, remainingPercent: 50 }] } });
    assert.deepEqual(Object.keys(state.pace), ["codexWeekly", "codex5h", FAKE_KEY]);
    assert.deepEqual(state.pace[FAKE_KEY], [{ at: 1, remainingPercent: 50 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/capacity-providers.test.js`
Expected: FAIL — `COUNTERS` does not include `fake:session` (or `Cannot find module` if Task 1 isn't done).

- [ ] **Step 3: Make `capacity-monitor.js` registry-driven**

Apply these edits to `capacity-monitor.js`.

3a. Replace lines 4-5 (`const usageModel = …`) with:

```js
  const usageModel = globalScope.ChatGPTUsageModel
    || (typeof require === "function" ? require("./usage-model.js").ChatGPTUsageModel : null);
  const providers = globalScope.UsageProviders
    || (typeof require === "function" ? require("./providers.js").UsageProviders : null);
```

3b. Delete the `PACE_KEYS` constant (line 19) and the frozen `COUNTERS` constant (lines 21-24). Add, in their place:

```js
  function counters() {
    return providers.allCounters().map(({ key, label }) => ({ key, label }));
  }

  function paceKeys() {
    return providers.allCounters().map((counter) => counter.key);
  }
```

3c. Replace every remaining use:

| Where | Old | New |
|---|---|---|
| `normalizeMonitorState` | `for (const definition of COUNTERS)` | `for (const definition of counters())` |
| `normalizeMonitorState` | `COUNTERS.map((definition) => definition.key)` | `counters().map((definition) => definition.key)` |
| `extractAvailableCounters` | `return COUNTERS.flatMap(` | `return counters().flatMap(` |
| `extractFreshStateCounters` | `return COUNTERS.flatMap(` | `return counters().flatMap(` |
| `evaluateSnapshot` (upgrade block) | `for (const key of PACE_KEYS)` | `for (const key of paceKeys())` |
| `normalizePace` | `PACE_KEYS.map((key) =>` | `paceKeys().map((key) =>` |
| `updatePace` | `for (const key of PACE_KEYS)` | `for (const key of paceKeys())` |
| `estimateDisplayedTimeRemaining` | `!PACE_KEYS.includes(key)` | `!paceKeys().includes(key)` |

3d. Replace `proportionalEstimate`:

```js
  function proportionalEstimate(key, remainingPercent) {
    if (remainingPercent === 0) return { status: "exhausted" };
    const definition = providers.counterDefinition(key);
    const windowMs = definition ? definition.windowMs : 7 * 24 * 3600000;
    return { status: "nominal", durationMs: remainingPercent / 100 * windowMs };
  }
```

3e. In `formatPaceTooltip`, replace `const limit = key === "codexWeekly" ? "weekly" : "5-hour";` with:

```js
    const definition = providers.counterDefinition(key);
    const limit = definition ? definition.limitName : "usage";
```

3f. In the `api` object, replace the `COUNTERS,` line with a getter:

```js
    get COUNTERS() { return counters(); },
```

- [ ] **Step 4: Load `providers.js` wherever `capacity-monitor.js` is loaded**

- `background.js` line 1 → `importScripts("usage-model.js", "providers.js", "capacity-monitor.js");`
- `popup.html` lines 703-705 → add `<script src="providers.js"></script>` between the `usage-model.js` and `capacity-monitor.js` script tags.
- `test/popup-runtime.test.js` line 64: `for (const file of ["usage-model.js", "providers.js", "capacity-monitor.js", "popup.js"])`.
- `test/background.test.js`: after line 8 add `const { UsageProviders } = require("../providers.js");` and add `UsageProviders,` to the `contextGlobals` object (next to `CodexCapacityMonitor,`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass — `221 pass, 0 fail` (217 + 4). If an existing capacity/pace test fails, the change is not behavior-preserving: fix the code, never the assertion.

- [ ] **Step 6: Checkpoint**

Run: `npm run check && npm test && git diff --check`. Do not commit unless asked.

---

### Task 3: Provider-scoped evaluation and removal in the capacity monitor

**Files:**
- Modify: `capacity-monitor.js` (`evaluateSnapshot`, `updatePace`, new `scopeKeysFor`, new `removeProviderCounters`, `api`)
- Test: `test/capacity-providers.test.js` (append)

**Interfaces:**
- Consumes: Task 2's `counters()`, `paceKeys()`, `providers`.
- Produces:
  - `evaluateSnapshot(snapshot, previousState, rawSettings, now, paceSessionId, options = {}) → { available, events, settings, state, visual }` where `options.providerId` scopes the evaluation. Without `providerId`, behavior is exactly as before.
  - `removeProviderCounters(rawState, providerId, now = new Date().toISOString()) → monitorState` — drops that provider's counters, availableKeys and pace samples, keeps everything else.
  - Scoped rule: only the scoped provider's counters may be replaced, reset or have pace cleared. `state.availableKeys` = other providers' still-fresh keys + this snapshot's keys. `visual` considers **every** fresh counter across providers when more than one provider is registered (so the toolbar shows the lowest remaining across providers); with a single registered provider `visual` is unchanged (built from `available`).

- [ ] **Step 1: Append the failing tests**

Append to `test/capacity-providers.test.js`:

```js
const { FAKE_KEY: KEY, fakeSnapshot: snap, withFakeProvider: withFake } = require("./helpers/fake-provider.js");

function chatgptPreviousState() {
  const before = Date.parse(NOW) - 5 * 60000;
  return {
    before,
    state: {
      version: 2,
      counters: {
        codexWeekly: {
          remainingPercent: 80, resetText: null, sessionId: "s",
          lastSeenAt: new Date(before).toISOString()
        }
      },
      pace: { codexWeekly: [{ at: before, remainingPercent: 80 }], codex5h: [] },
      paceSessionId: "s",
      availableKeys: ["codexWeekly"],
      updatedAt: new Date(before).toISOString()
    }
  };
}

test("a scoped evaluation leaves other providers' counters and pace untouched", () => {
  const { before, state } = chatgptPreviousState();
  withFake(() => {
    const scoped = monitor.evaluateSnapshot(snap(60, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(scoped.state.counters.codexWeekly.remainingPercent, 80);
    assert.equal(scoped.state.counters[KEY].remainingPercent, 60);
    assert.deepEqual(scoped.state.pace.codexWeekly, [{ at: before, remainingPercent: 80 }]);
    assert.deepEqual([...scoped.state.availableKeys].sort(), ["codexWeekly", KEY]);

    // Documents why scoping exists: an unscoped evaluation wipes the other provider's pace.
    const unscoped = monitor.evaluateSnapshot(snap(60, NOW), state, null, NOW, "s");
    assert.deepEqual(unscoped.state.pace.codexWeekly, []);
    assert.deepEqual(unscoped.state.availableKeys, [KEY]);
  });
});

test("the toolbar visual is the lowest remaining across providers", () => {
  const { state } = chatgptPreviousState();
  withFake(() => {
    const low = monitor.evaluateSnapshot(snap(30, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(low.visual.badgeText, "30");
    assert.equal(low.visual.counter.key, KEY);
    const high = monitor.evaluateSnapshot(snap(95, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(high.visual.badgeText, "80");
    assert.equal(high.visual.counter.key, "codexWeekly");
  });
});

test("threshold events are raised only for the scoped provider's counters", () => {
  const { before, state } = chatgptPreviousState();
  state.counters[KEY] = {
    remainingPercent: 30, resetText: null, sessionId: "s",
    lastSeenAt: new Date(before).toISOString()
  };
  state.availableKeys = ["codexWeekly", KEY];
  withFake(() => {
    const result = monitor.evaluateSnapshot(snap(8, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.deepEqual(result.events.map((event) => [event.key, event.type]), [[KEY, "low"]]);
  });
});

test("an unknown provider scope changes nothing", () => {
  const { state } = chatgptPreviousState();
  const result = monitor.evaluateSnapshot(null, state, null, NOW, "s", { providerId: "nope" });
  assert.deepEqual(result.events, []);
  assert.equal(result.state.counters.codexWeekly.remainingPercent, 80);
  assert.deepEqual(result.state.availableKeys, ["codexWeekly"]);
});

test("removeProviderCounters clears one provider and keeps the rest", () => {
  const { before, state } = chatgptPreviousState();
  state.counters[KEY] = {
    remainingPercent: 30, resetText: null, sessionId: "s",
    lastSeenAt: new Date(before).toISOString()
  };
  state.pace[KEY] = [{ at: before, remainingPercent: 30 }];
  state.availableKeys = ["codexWeekly", KEY];
  withFake(() => {
    const next = monitor.removeProviderCounters(state, "fake", NOW);
    assert.deepEqual(Object.keys(next.counters), ["codexWeekly"]);
    assert.deepEqual(next.availableKeys, ["codexWeekly"]);
    assert.deepEqual(next.pace[KEY], []);
    assert.deepEqual(next.pace.codexWeekly, [{ at: before, remainingPercent: 80 }]);
    assert.equal(next.updatedAt, NOW);
    assert.equal(next.paceSessionId, "s");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/capacity-providers.test.js`
Expected: the five new tests FAIL (`removeProviderCounters is not a function`; scoped assertions fail).

- [ ] **Step 3: Implement scoping in `capacity-monitor.js`**

3a. Add near `paceKeys()`:

```js
  function scopeKeysFor(providerId) {
    const definitions = providers.allCounters();
    return (providerId
      ? definitions.filter((counter) => counter.providerId === providerId)
      : definitions).map((counter) => counter.key);
  }
```

3b. Replace the whole `evaluateSnapshot` with (only the marked lines differ from the current code):

```js
  function evaluateSnapshot(snapshot, previousState, rawSettings, now = new Date().toISOString(), paceSessionId = null, options = {}) {
    const settings = normalizeSettings(rawSettings);
    const previous = normalizeMonitorState(previousState);
    const scopeKeys = scopeKeysFor(options && options.providerId);                    // changed
    const available = extractAvailableCounters(snapshot)
      .filter((counter) => scopeKeys.includes(counter.key));                          // changed
    const upgradingPace = previousState && previousState.pace === undefined
      && previousState.paceSessionId === undefined;
    if (upgradingPace) {
      // Older versions kept one confirmed observation per counter. Preserve it
      // as the first rate sample instead of discarding it during the upgrade.
      for (const key of scopeKeys) {                                                  // changed
        const stored = previous.counters[key];
        if (stored && isFreshObservation(stored, now)) {
          previous.pace[key] = [{ at: Date.parse(stored.lastSeenAt), remainingPercent: stored.remainingPercent }];
        }
      }
    }
    const counters = Object.fromEntries(
      Object.entries(previous.counters).filter(([, stored]) => isFreshObservation(stored, now))
    );
    const events = [];
    for (const counter of available) {
      const stored = counters[counter.key];
      if (stored) {
        const eventType = detectTransition(stored.remainingPercent, counter.remainingPercent, settings);
        const sameSession = paceSessionId !== null && stored.sessionId === paceSessionId;
        const increased = sameSession && counter.remainingPercent > stored.remainingPercent;
        const resetChanged = sameSession && hasResetChanged(stored, counter, now);
        // A full reset already explains both changes; emit it only once.
        if (eventType) events.push({ ...counter, type: eventType });
        if (eventType !== "reset" && (increased || resetChanged)) {
          events.push({ ...counter, type: increased ? "capacity-increased" : "reset-changed",
            previousRemainingPercent: stored.remainingPercent, resetChanged });
        }
      }
      counters[counter.key] = {
        remainingPercent: counter.remainingPercent,
        resetText: counter.resetText,
        sessionId: paceSessionId,
        lastSeenAt: now
      };
    }
    const state = {
      version: 2,
      counters,
      pace: updatePace(available, previous.pace, Date.parse(now),
        upgradingPace || previous.paceSessionId === paceSessionId, scopeKeys),        // changed
      paceSessionId,
      availableKeys: [                                                                // changed
        ...previous.availableKeys.filter((key) => !scopeKeys.includes(key) && counters[key]),
        ...available.map((counter) => counter.key)
      ],
      updatedAt: now
    };
    // With several providers the toolbar shows the lowest remaining across all of
    // them, so the visual must include the other providers' still-fresh counters.
    const visualCounters = scopeKeys.length === counters_length()
      ? available
      : [
        ...extractFreshStateCounters(state, now).filter((counter) => !scopeKeys.includes(counter.key)),
        ...available
      ];
    return { available, events, settings, state, visual: deriveVisualState(visualCounters, settings) };
  }
```

Replace the placeholder `counters_length()` with `paceKeys().length` (every registered counter has a pace key, so this is "the scope covers every registered counter").

3c. Change `updatePace`'s signature and loop:

```js
  function updatePace(available, previous, now, sameSession, keys = paceKeys()) {
    const pace = normalizePace(previous);
    for (const key of keys) {
```

(The body of the loop is unchanged.)

3d. Add before `normalizePace`:

```js
  function removeProviderCounters(rawState, providerId, now = new Date().toISOString()) {
    const previous = normalizeMonitorState(rawState);
    const removed = scopeKeysFor(providerId);
    const keep = (key) => !removed.includes(key);
    return {
      version: 2,
      counters: Object.fromEntries(Object.entries(previous.counters).filter(([key]) => keep(key))),
      pace: Object.fromEntries(Object.entries(previous.pace)
        .map(([key, samples]) => [key, keep(key) ? samples : []])),
      paceSessionId: previous.paceSessionId,
      availableKeys: previous.availableKeys.filter(keep),
      updatedAt: now
    };
  }
```

3e. Add `removeProviderCounters,` to the `api` object (alphabetical, after `normalizeSettings,`).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `226 pass, 0 fail` (221 + 5). Existing evaluate/pace tests must still pass with no edits: with no `providerId`, `scopeKeys` is every counter, `visualCounters` is `available`, and `availableKeys` is `available`'s keys.

- [ ] **Step 5: Checkpoint**

Run: `npm run check && npm test && git diff --check`. Do not commit unless asked.

---

### Task 4: Thread a provider through the refresh path (ChatGPT stays the default)

**Files:**
- Modify: `background.js` (see substitution table), `test/background.test.js` (append test)

**Interfaces:**
- Consumes: `UsageProviders` global (Task 2 injected it into the harness), provider fields `usageUrl`, `stateKey`, `retainedSignInTabKey`, `hostPatterns`, `hostnames`, `messages`, `isUsageUrl`, `isUsagePageSnapshot`, `hasVisibleUsage`, `hasParsedUsageLimit`, `mergeUsageFields`.
- Produces (all with trailing optional `provider`, default `chatgptProvider`):
  - `refreshOnce(reason, boundRetry = false, provider = chatgptProvider)`
  - `refreshWithTimeout(reason, provider = chatgptProvider)`
  - `refreshFromAnalyticsPage(reason, refreshContext, provider = chatgptProvider)`
  - `saveSnapshot(snapshot, tab, source, expectedCapacityGeneration, capacitySnapshot, expectedAnalyticsRefreshGeneration, provider = chatgptProvider)`
  - `saveIncompleteRefresh(pageSnapshot, tabId, source, expectedAnalyticsRefreshGeneration, provider = chatgptProvider)`
  - `requestSnapshotWithRetry(tabId, refreshContext, provider = chatgptProvider)`
  - `readAnalyticsTab(tabId, refreshContext, provider = chatgptProvider)`, `markRefreshStarted(reason, refreshContext, provider = chatgptProvider)`, `createBackgroundAnalyticsTab(provider = chatgptProvider)`, `waitForTabReadyOrDelay(tabId, provider = chatgptProvider)`, `waitForTabComplete(tabId, provider = chatgptProvider)`, `withTimeout(promise, ms, message, expectedRefreshGeneration = null, provider = chatgptProvider)`
  - `getRetainedSignInTab(provider)`, `retainOnlySignInTab(tabId, provider)`, `forgetRetainedSignInTab(tabId, provider)`, `removeRetainedSignInTabIfOwned(exceptTabId, provider)` (all default ChatGPT)
  - `openUsagePage(provider = chatgptProvider)`; `openCodexAnalyticsPage()` becomes `return openUsagePage(chatgptProvider)`
  - `providerForSender(sender) → provider` (hostname lookup, falls back to ChatGPT)
  - `analyticsRefreshContext.providerId` (a missing `providerId` means ChatGPT)

- [ ] **Step 1: Write the failing integration test**

Append to `test/background.test.js` (add `const { fakeSnapshot, withFakeProviderAsync } = require("./helpers/fake-provider.js");` near the other requires at the top):

```js
test("a second provider refreshes from its own URL and never touches ChatGPT state", async () => {
  await withFakeProviderAsync(async (fake) => {
    const collectedAt = new Date().toISOString();
    const chatgptState = { status: "usage-current", marker: "chatgpt-untouched" };
    const harness = createBackgroundHarness({
      initialState: chatgptState,
      snapshot: fakeSnapshot(60, collectedAt)
    });
    const result = await harness.run(`refreshOnce("popup", false, UsageProviders.getProvider("fake"))`);
    assert.equal(result.ok, true);
    assert.equal(harness.calls.createArgs[0].url, "https://fake.example/usage");
    const saved = harness.storage[fake.stateKey];
    assert.equal(saved.status, "usage-current");
    assert.equal(saved.snapshot.usage["fake:session"].structured.remainingPercent, 60);
    assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.state].marker, "chatgpt-untouched");
    assert.equal(
      harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters["fake:session"].remainingPercent,
      60
    );
    assert.equal(harness.calls.removedTabIds.at(-1), 99);
  });
});

test("a refresh for one provider waits for an in-flight refresh of another instead of joining it", async () => {
  await withFakeProviderAsync(async () => {
    const harness = createBackgroundHarness({ snapshot: fakeSnapshot(60, new Date().toISOString()) });
    harness.run(`analyticsRefreshContext = { providerId: "chatgpt", popupRequested: false, acceptingPopupJoin: true, generation: analyticsRefreshGeneration };
      analyticsRefreshPromise = new Promise((resolve) => { globalThis.finishChatgpt = () => resolve({ ok: true, from: "chatgpt" }); });`);
    const pending = harness.run(`refreshOnce("popup", false, UsageProviders.getProvider("fake"))`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.calls.create, 0, "the fake refresh must not start while ChatGPT is in flight");
    harness.run(`analyticsRefreshPromise = null; analyticsRefreshContext = null; finishChatgpt()`);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(harness.calls.createArgs[0].url, "https://fake.example/usage");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/background.test.js`
Expected: the two new tests FAIL (the refresh still opens the ChatGPT URL / joins the in-flight promise); the previous 91 pass.

- [ ] **Step 3: Apply the substitutions to `background.js`**

3a. Top of file — after the destructured `storageKeys` block, add `const chatgptProvider = UsageProviders.getProvider("chatgpt");`. Run `grep -n "CODEX_ANALYTICS_URL" background.js test/*.js` — after the substitutions below it must have no remaining uses in `background.js`; delete the constant only then.

3b. Provider-aware helpers. Add near the bottom (replacing the body of `isCodexAnalyticsUrl`, which stays as a wrapper because tests or older call sites may use it):

```js
function isCodexAnalyticsUrl(url) {
  return chatgptProvider.isUsageUrl(url);
}

function providerForSender(sender) {
  const url = (sender && (sender.url || (sender.tab && sender.tab.url))) || "";
  try {
    return UsageProviders.providerForHostname(new URL(url).hostname) || chatgptProvider;
  } catch {
    return chatgptProvider;
  }
}
```

3c. Tab lifecycle listeners (`onActivated`, `onRemoved`) must forget the tab for every provider:

```js
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo && Number.isInteger(activeInfo.tabId)) {
    adoptedAnalyticsTabIds.add(activeInfo.tabId);
    for (const provider of UsageProviders.listProviders()) {
      forgetRetainedSignInTab(activeInfo.tabId, provider).catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  adoptedAnalyticsTabIds.delete(tabId);
  for (const provider of UsageProviders.listProviders()) {
    forgetRetainedSignInTab(tabId, provider).catch(() => {});
  }
});
```

3d. `onMessage`: `usage:contentSnapshot` → `saveContentSnapshot(message.payload, sender.tab, providerForSender(sender)).then(sendResponse);`.

3e. Retained-tab helpers — add `provider = chatgptProvider` as the last parameter of each of the four functions and replace `storageKeys.retainedSignInTab` with `provider.retainedSignInTabKey` inside them. Example:

```js
function forgetRetainedSignInTab(tabId, provider = chatgptProvider) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = provider.retainedSignInTabKey;
    const stored = await chrome.storage.session.get([retainedKey]);
    if (stored[retainedKey] !== tabId) return;
    await chrome.storage.session.set({ [retainedKey]: null });
  });
}
```

3f. `openCodexAnalyticsPage` → generalize (behavior for ChatGPT is identical):

```js
async function openCodexAnalyticsPage() {
  return openUsagePage(chatgptProvider);
}

async function openUsagePage(provider = chatgptProvider) {
  const tabs = await chrome.tabs.query({ url: [...provider.hostPatterns] });
  const existing = tabs.find((tab) => provider.isUsageUrl(tab.url));
  if (existing) {
    await forgetRetainedSignInTab(existing.id, provider);
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId) && chrome.windows && chrome.windows.update) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { ok: true, tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: provider.usageUrl, active: true });
  return { ok: true, tabId: tab.id, reused: false };
}
```

3g. `refreshOnce` — replace with (the only new logic is the first `if` and the `providerId`/`provider` plumbing):

```js
async function refreshOnce(reason, boundRetry = false, provider = chatgptProvider) {
  if (analyticsRefreshPromise && analyticsRefreshContext
    && (analyticsRefreshContext.providerId || chatgptProvider.id) !== provider.id) {
    // Refreshes are single-flight. Never join another provider's read; run after it.
    const inFlight = analyticsRefreshPromise;
    return inFlight.then(
      () => refreshOnce(reason, boundRetry, provider),
      () => refreshOnce(reason, boundRetry, provider)
    );
  }
  if (!analyticsRefreshPromise) {
    analyticsRefreshGeneration += 1;
    analyticsRefreshContext = {
      providerId: provider.id,
      popupRequested: reason === "popup",
      acceptingPopupJoin: true,
      generation: analyticsRefreshGeneration
    };
    const trackedRefreshPromise = refreshFromAnalyticsPage(reason, analyticsRefreshContext, provider)
      .finally(() => {
        if (analyticsRefreshPromise === trackedRefreshPromise) {
          analyticsRefreshPromise = null;
          analyticsRefreshContext = null;
        }
      });
    analyticsRefreshPromise = trackedRefreshPromise;
  } else if (reason === "popup" && analyticsRefreshContext) {
    if (!analyticsRefreshContext.acceptingPopupJoin) {
      const joinedGeneration = analyticsRefreshContext.generation;
      return analyticsRefreshPromise.then(() => (
        joinedGeneration === analyticsRefreshGeneration
          ? boundRetry
            ? refreshWithTimeout("popup", provider)
            : refreshOnce("popup", false, provider)
          : { ok: false, ignored: true, reason: "Analytics refresh expired before retry." }
      ));
    }
    analyticsRefreshContext.popupRequested = true;
  }
  return analyticsRefreshPromise;
}
```

`refreshWithTimeout`:

```js
function refreshWithTimeout(reason, provider = chatgptProvider) {
  const refreshPromise = refreshOnce(reason, true, provider);
  const expectedRefreshGeneration = analyticsRefreshContext
    && analyticsRefreshContext.generation;
  return withTimeout(
    refreshPromise,
    REFRESH_TIMEOUT_MS,
    "Refresh timed out.",
    expectedRefreshGeneration,
    provider
  );
}
```

3h. `refreshFromAnalyticsPage(reason, refreshContext = {…}, provider = chatgptProvider)` — inside it replace: `isCodexAnalyticsUrl(x)` → `provider.isUsageUrl(x)` (3 places), `CODEX_ANALYTICS_URL` → `provider.usageUrl`, `getRetainedSignInTab()` → `getRetainedSignInTab(provider)`, every `forgetRetainedSignInTab(id)` / `retainOnlySignInTab(id)` / `removeRetainedSignInTabIfOwned(id)` gets `, provider`, `markRefreshStarted(reason, refreshContext)` → `(…, provider)`, `createBackgroundAnalyticsTab()` → `createBackgroundAnalyticsTab(provider)`, `readAnalyticsTab(analyticsTab.id, refreshContext)` → `(…, provider)`, `storageKeys.state` → `provider.stateKey` (in the `catch`), and the two diagnostic strings in the `catch` become `provider.messages.loadFailed` and `provider.messages.readerUnresponsive`.

3i. `createBackgroundAnalyticsTab(provider = chatgptProvider)`: `url: provider.usageUrl`. `readAnalyticsTab(tabId, refreshContext, provider = chatgptProvider)`: `waitForTabReadyOrDelay(tabId, provider)` then `requestSnapshotWithRetry(tabId, refreshContext, provider)`. `waitForTabReadyOrDelay(tabId, provider = chatgptProvider)` → `waitForTabComplete(tabId, provider)`; `waitForTabComplete(tabId, provider = chatgptProvider)` → `reject(new Error(provider.messages.loadTimeout))`. `markRefreshStarted(reason, refreshContext, provider = chatgptProvider)` → `provider.stateKey` (2 places).

3j. `requestSnapshotWithRetry(tabId, refreshContext, provider = chatgptProvider)`:
- `snapshot.codexAnalytics && ChatGPTUsageModel.hasVisibleUsage(snapshot)` → `provider.isUsagePageSnapshot(snapshot) && provider.hasVisibleUsage(snapshot)`
- `ChatGPTUsageModel.hasParsedUsageLimit(accumulatedSnapshot)` → `provider.hasParsedUsageLimit(accumulatedSnapshot)`
- `mergeUsageSnapshot(accumulatedSnapshot, snapshot)` → `mergeUsageSnapshot(accumulatedSnapshot, snapshot, provider)`
- the two `saveSnapshot(…)` calls and the `saveIncompleteRefresh(…)` call get `, provider` appended (after the existing last argument)
- `clearCapacityMonitorState()` stays as-is in this task (Task 5 scopes it)
- `throw lastError || new Error("Codex Analytics content script did not respond.")` → `throw lastError || new Error(provider.messages.contentScriptMissing)`

`mergeUsageSnapshot(accumulated, incoming, provider = chatgptProvider)`: `provider.mergeUsageFields(accumulated && accumulated.usage, incoming && incoming.usage)`.

3k. `saveSnapshot(…, expectedAnalyticsRefreshGeneration = null, provider = chatgptProvider)`: `ChatGPTUsageModel.hasParsedUsageLimit(snapshot)` (2 places) → `provider.hasParsedUsageLimit(snapshot)`; `storageKeys.state` → `provider.stateKey` (2 places); the `saveIncompleteRefresh(snapshot, tab && tab.id, source, expectedAnalyticsRefreshGeneration)` call gets `, provider`.

3l. `saveIncompleteRefresh(pageSnapshot, tabId, source = …, expectedAnalyticsRefreshGeneration = null, provider = chatgptProvider)`: `storageKeys.state` → `provider.stateKey` (2 places), `ChatGPTUsageModel.hasParsedUsageLimit(existingSnapshot)` → `provider.hasParsedUsageLimit(existingSnapshot)`, and the diagnostic text becomes `pageSnapshot` … `provider.isUsagePageSnapshot(pageSnapshot) ? provider.messages.noNewData : provider.messages.routeNotDetected`.

3m. `withTimeout(promise, ms, message, expectedRefreshGeneration = null, provider = chatgptProvider)`: replace the three `storageKeys.state` uses with `provider.stateKey`.

3n. `saveContentSnapshot(snapshot, tab, provider = chatgptProvider)`: `snapshot.codexAnalytics` → `provider.isUsagePageSnapshot(snapshot)` (2 places), `ChatGPTUsageModel.hasParsedUsageLimit/hasVisibleUsage` → `provider.…`, `storageKeys.state` → `provider.stateKey`, the `saveSnapshot(snapshot, tab, "content-script")` call gets four trailing arguments so provider lands in position 7: `saveSnapshot(snapshot, tab, "content-script", capacityGeneration, snapshot, null, provider)`.

Leave `getPopupState`, `refreshIfStale`, `refreshForPopup`, the popup `usage:refresh` handler and all capacity functions unchanged in this task.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `228 pass, 0 fail` (226 + 2 new). If an existing test fails, the refactor changed ChatGPT behavior: diff the failing test's expectation against the substitution it touches (most likely a missed `, provider` argument or a string that changed).

- [ ] **Step 5: Checkpoint**

Run: `npm run check && npm test && git diff --check`, and `grep -n "storageKeys.state\|CODEX_ANALYTICS_URL\|ChatGPTUsageModel.has" background.js` — remaining hits must only be in `getPopupState`, `refreshIfStale`, capacity code, and `saveContentSnapshot`'s `hasVisibleUsage(currentSnapshot)` line (note: convert that one too if it references ChatGPT-only parsing: `provider.hasVisibleUsage(currentSnapshot)`). Do not commit unless asked.

---

### Task 5: Provider-scoped capacity handling and refresh-all scheduling

**Files:**
- Modify: `background.js` (capacity functions, schedulers), `test/background.test.js` (append tests)

**Interfaces:**
- Consumes: `CodexCapacityMonitor.evaluateSnapshot(…, { providerId })`, `CodexCapacityMonitor.removeProviderCounters`, Task 4's provider-aware refresh path.
- Produces:
  - `processCapacitySnapshot(snapshot, expectedCapacityGeneration = capacityGeneration, expectedAnalyticsRefreshGeneration = null, provider = chatgptProvider)`
  - `clearCapacityMonitorState(provider)` — if `provider` is omitted or is the only registered provider, behaves exactly as today (global suppression); otherwise clears only that provider's counters, pace and notifications and recomputes the toolbar visual from the remaining counters.
  - `clearAllCapacityNotifications(provider)` — with a provider, clears only that provider's counter notifications.
  - `refreshAllProviders(reason) → { [providerId]: result }` — sequential, errors captured per provider.
  - `refreshIfStale(reason, state = null, now = Date.now())` checks staleness per provider and refreshes only stale ones; returns the first refreshed provider's result (ChatGPT's whenever ChatGPT is stale) or the existing "still recent" skip object.
  - Alarm, install, startup and window-created refreshes go through `refreshAllProviders` / `refreshIfStale`.

- [ ] **Step 1: Write the failing tests**

Append to `test/background.test.js`:

```js
test("signing out of one provider preserves the other provider's capacity counters", async () => {
  await withFakeProviderAsync(async () => {
    const seen = new Date().toISOString();
    const harness = createBackgroundHarness({
      capacityState: {
        version: 2,
        counters: {
          codexWeekly: { remainingPercent: 80, resetText: null, sessionId: "test-session", lastSeenAt: seen },
          "fake:session": { remainingPercent: 30, resetText: null, sessionId: "test-session", lastSeenAt: seen }
        },
        pace: { codexWeekly: [], codex5h: [], "fake:session": [] },
        paceSessionId: "test-session",
        availableKeys: ["codexWeekly", "fake:session"],
        updatedAt: seen
      }
    });
    await harness.run(`clearCapacityMonitorState(UsageProviders.getProvider("fake"))`);
    const state = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
    assert.equal(state.suppressed, undefined);
    assert.deepEqual(Object.keys(state.counters), ["codexWeekly"]);
    assert.deepEqual(Array.from(state.availableKeys), ["codexWeekly"]);
    assert.equal(harness.run("capacitySuppressed"), false);
  });
});

test("clearing the only provider keeps the existing global suppression behavior", async () => {
  const harness = createBackgroundHarness({});
  await harness.run("clearCapacityMonitorState()");
  const state = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(state.suppressed, true);
  assert.equal(harness.run("capacitySuppressed"), true);
});

test("a provider refresh does not reset another provider's pace history", async () => {
  await withFakeProviderAsync(async () => {
    const seen = new Date(Date.now() - 5 * 60000).toISOString();
    const harness = createBackgroundHarness({
      snapshot: fakeSnapshot(60, new Date().toISOString()),
      capacityState: {
        version: 2,
        counters: { codexWeekly: { remainingPercent: 80, resetText: null, sessionId: "test-session", lastSeenAt: seen } },
        pace: { codexWeekly: [{ at: Date.parse(seen), remainingPercent: 80 }], codex5h: [], "fake:session": [] },
        paceSessionId: "test-session",
        availableKeys: ["codexWeekly"],
        updatedAt: seen
      }
    });
    await harness.run(`refreshOnce("popup", false, UsageProviders.getProvider("fake"))`);
    const state = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
    assert.equal(state.pace.codexWeekly.length, 1);
    assert.deepEqual(Array.from(state.availableKeys).sort(), ["codexWeekly", "fake:session"]);
  });
});

test("scheduled refreshes visit every provider one at a time", async () => {
  await withFakeProviderAsync(async () => {
    const harness = createBackgroundHarness({});
    harness.run(`var order = [];
      refreshWithTimeout = async (reason, provider) => { order.push(reason + ":" + provider.id); return { ok: true }; };`);
    harness.listeners.alarm({ name: ChatGPTUsageConfig.refreshAlarmName });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Array.from(harness.run("order")), ["alarm:chatgpt", "alarm:fake"]);
  });
});

test("staleness is checked per provider", async () => {
  await withFakeProviderAsync(async (fake) => {
    const fresh = new Date().toISOString();
    const harness = createBackgroundHarness({ initialState: { dataCollectedAt: fresh, status: "usage-current" } });
    harness.run(`var order = [];
      refreshWithTimeout = async (reason, provider) => { order.push(provider.id); return { ok: true }; };`);
    await harness.run(`refreshIfStale("startup")`);
    assert.deepEqual(Array.from(harness.run("order")), [fake.id]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/background.test.js`
Expected: the five new tests FAIL; the existing tests pass.

- [ ] **Step 3: Provider-scope the capacity functions in `background.js`**

3a. `processCapacitySnapshot` and its serialized twin: add `provider = chatgptProvider` as the 4th parameter of `processCapacitySnapshot`, pass it as the 4th argument to `processCapacitySnapshotSerialized(snapshot, expectedCapacityGeneration, expectedAnalyticsRefreshGeneration, provider)` in both `.then` branches, and inside the serialized function change the evaluation call to:

```js
  const evaluation = CodexCapacityMonitor.evaluateSnapshot(
    snapshot,
    data[storageKeys.capacityState],
    data[storageKeys.capacitySettings],
    new Date().toISOString(),
    paceSessionId,
    { providerId: provider.id }
  );
```

In `saveSnapshot` (Task 4 already added the `provider` parameter) pass it on: `processCapacitySnapshot(capacitySnapshot, expectedCapacityGeneration, expectedAnalyticsRefreshGeneration, provider)`.

3b. Replace `clearCapacityMonitorState` (keep the sole-provider branch byte-for-byte as today):

```js
function isOnlyRegisteredProvider(provider) {
  const registered = UsageProviders.listProviders();
  return !provider || (registered.length === 1 && registered[0].id === provider.id);
}

function clearCapacityMonitorState(provider) {
  if (isOnlyRegisteredProvider(provider)) {
    if (!markCapacitySuppressed()) return capacityUpdate;
    const result = capacityUpdate.then(
      () => clearCapacityMonitorStateSerialized(),
      () => clearCapacityMonitorStateSerialized()
    );
    capacityUpdate = result.catch(() => {});
    return result;
  }
  // Other providers still have live readings: drop only this provider's state.
  capacityGeneration += 1;
  const result = capacityUpdate.then(
    () => clearProviderCapacityStateSerialized(provider),
    () => clearProviderCapacityStateSerialized(provider)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function clearProviderCapacityStateSerialized(provider) {
  const data = await chrome.storage.local.get([
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  const rawState = data[storageKeys.capacityState];
  const next = rawState && rawState.suppressed
    ? rawState
    : CodexCapacityMonitor.removeProviderCounters(rawState, provider.id);
  await chrome.storage.local.set({ [storageKeys.capacityState]: next });
  const remaining = next.suppressed ? [] : CodexCapacityMonitor.extractFreshStateCounters(next);
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState(remaining, settings));
  await clearAllCapacityNotifications(provider);
}
```

3c. `clearAllCapacityNotifications`:

```js
async function clearAllCapacityNotifications(provider) {
  const keys = UsageProviders.allCounters()
    .filter((counter) => !provider || counter.providerId === provider.id)
    .map((counter) => counter.key);
  await Promise.all(keys.flatMap((key) => (
    CAPACITY_NOTIFICATION_TYPES.map((type) => clearCapacityNotification(key, type))
  )));
}
```

(Notification ids are unchanged: `codex-capacity-<key>-<type>`.)

3d. Pass the provider where sign-out is detected: in `requestSnapshotWithRetry`, `saveIncompleteRefresh` and `saveContentSnapshot` change `clearCapacityMonitorState()` to `clearCapacityMonitorState(provider)`. Leave `expireCapacityMonitorState`, `initializeCapacityUi` and `applyObservedCapacityVisual` untouched (they are time-based or ChatGPT-gated; `applyObservedCapacityVisual` is generalized in Plan 2 when a second real provider exists — record this in the plan-2 task list).

- [ ] **Step 4: Refresh every provider on schedule**

Add near `refreshIfStale`:

```js
async function refreshAllProviders(reason) {
  const results = {};
  for (const provider of UsageProviders.listProviders()) {
    results[provider.id] = await refreshWithTimeout(reason, provider).catch((error) => ({
      ok: false,
      error: String(error && error.message ? error.message : error)
    }));
  }
  return results;
}
```

Replace `refreshIfStale`:

```js
async function refreshIfStale(reason, state = null, now = Date.now()) {
  const registered = UsageProviders.listProviders();
  const keys = [storageKeys.refreshPeriodMinutes];
  for (const provider of registered) {
    if (!(state && provider.id === chatgptProvider.id)) keys.push(provider.stateKey);
  }
  const data = await chrome.storage.local.get(keys);
  const refreshPeriodMinutes = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(
    data[storageKeys.refreshPeriodMinutes]
  );
  const stale = registered.filter((provider) => {
    const current = state && provider.id === chatgptProvider.id ? state : data[provider.stateKey];
    return shouldRefreshUsage(current, now, refreshPeriodMinutes);
  });
  if (!stale.length) {
    return { ok: true, skipped: true, reason: "Usage data is still recent." };
  }
  let first = null;
  for (const provider of stale) {
    const result = await refreshWithTimeout(reason, provider);
    if (first === null) first = result;
  }
  return first;
}
```

In `chrome.alarms.onAlarm`: `refreshAllProviders("alarm").catch(() => {});`. In `onInstalled`: `return refreshAllProviders("install");`. `refreshOnStartup` and the `windows.onCreated` listener already go through `refreshIfStale`. The popup's `usage:refresh` handler and `getPopupState` stay ChatGPT-only until Plan 2.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `233 pass, 0 fail` (228 + 5). If an existing "startup/alarm/window-created/popup-open refresh" test fails, check that it still observes exactly one `refreshWithTimeout` call with only ChatGPT registered.

- [ ] **Step 6: Final verification of the whole plan**

Run:

```bash
npm run check && npm test && git diff --check
grep -n '"version"' manifest.json package.json
```

Expected: check passes; `233 pass, 0 fail`; no whitespace errors; both versions still `0.5.1`.

Manual smoke test in a real browser (the vm harness cannot prove this): load the unpacked extension in Edge/Chrome, open the popup, press **Refresh**, and confirm ChatGPT usage, the toolbar percentage and notifications behave exactly as before this plan. There is no visible difference to look for; the check is that nothing regressed and the service worker console (`chrome://extensions` → *service worker*) shows no errors.

---

## Self-review (against the spec)

- **Provider contract / registry** → Task 1. **Counters, pace windows, labels from the registry** → Task 2. **Provider-scoped evaluation, min-across-providers toolbar visual, per-provider clearing** → Tasks 3 and 5. **Provider threading and per-provider refresh/state/retained-tab keys** → Task 4. **Refresh scheduling for all providers, independent staleness** → Task 5.
- **Amendment 1** items: snapshot shape (`usage` map, namespaced keys) → Tasks 1-3; grandfathered ChatGPT keys → Task 1 test and Global Constraints; single global generation + join-only-same-provider → Task 4; plan split → header.
- **Deliberately deferred to Plan 2** (needs a real second provider to validate): popup per-provider sections and `usage:refresh` refreshing all providers, `applyObservedCapacityVisual` combining providers, `getPopupState` returning per-provider state, the on-page badge for other sites, Claude's extractor/parser/content script, manifest host permissions, `openUsage` message for non-ChatGPT providers, and per-provider refresh status strings (`refreshing-codex-analytics` is ChatGPT-specific today).
- **Deferred to Plan 3:** Muse, rename to "AI Usage Viewer" (includes `deriveVisualState`'s hard-coded "ChatGPT Usage Viewer — …" title), README/store-prep, version 0.6.0.
- **Placeholder scan:** the only code-shaped hole is Task 3 step 3b's `counters_length()`, which is explicitly replaced by `paceKeys().length` in the same step.
- **Type consistency:** `provider` is always the trailing optional parameter; `providerId` (string) is what crosses into `evaluateSnapshot`/`removeProviderCounters`; counter keys are strings (`codexWeekly`, `codex5h`, `fake:session`); test count checkpoints: 211 → 217 → 221 → 226 → 228 → 233.

**Also deferred to Plan 2:** the live "Resets in X hr Y min" countdown on popup cards and the on-page badge (spec Amendment 2), because it changes visible UI and Plan 1 must not.

**Also required in Plan 2 before a second real provider registers** (found in Plan 1 Task 5 review): `clearCapacityMonitorState(provider)`'s partial branch bumps the global `capacityGeneration` on every call with no idempotence guard (`background.js`, `clearCapacityMonitorState`). A logged-out content-script snapshot for provider X arriving while provider Y's refresh is in its read loop makes Y's capacity result `ignored` (swallowed), losing Y's toolbar/pace reading until the next refresh; a repeatedly-posting logged-out tab repeats it. Fix with per-provider capacity generations, or skip the bump when the stored state has no counters for that provider. Also: when the last of several providers signs out one at a time, global suppression is never entered. Related smaller Plan 2 items: `refreshIfStale` stops refreshing later providers when an earlier one rejects (capture per-provider errors like `refreshAllProviders`); `getPopupState` now refreshes stale non-ChatGPT providers on popup open; `saveContentSnapshot` reason strings are Codex-specific for any provider. Further items from the final whole-branch review: startup sign-out in `initializeCapacityUiSerialized` only checks ChatGPT's state and wipes ALL providers' counters when ChatGPT is signed out; the whole "shared generation means any provider" family (`capacityGeneration`, `capacitySuppressed`, `initializeCapacityUiSerialized`, `applyObservedCapacityVisual`) should become provider-aware together; registry hardening (uniqueness of `stateKey` / `retainedSignInTabKey` / hostnames across providers, reject a non-string `id` instead of coercing `String(undefined)`, try/catch around third-party `isUsageUrl` in `providerForUrl`); `refreshIfStale` should capture per-provider errors like `refreshAllProviders`.

---

## As built (read before writing Plan 2/3)

1. **Task 4 queueing.** `refreshWithTimeout` shipped as a plain (non-async) function that starts with `isOtherProviderRefreshInFlight(provider)`; when another provider's refresh is in flight it returns `waitForOtherProviderRefresh(provider).then(() => refreshWithTimeout(reason, provider))`. The wait therefore happens OUTSIDE the timed region, so the generation capture and the 45 s timer start when the queued provider actually begins. Supporting pieces: `refreshLockWaiters`, `notifyRefreshLockReleased()` (called in `refreshOnce`'s `.finally` and in `withTimeout`'s timeout branch right after it clears the lock) and the race in `waitForOtherProviderRefresh` between the in-flight promise and a lock-release waiter (a hung in-flight promise never blocks a waiter forever). The final fix wave added `generationOwners` / `recordGenerationOwner` / `isRefreshSuperseded`: the single shared `analyticsRefreshGeneration` and strict-equality `isCurrentAnalyticsRefreshGeneration` are unchanged, but `withTimeout` (both supersession checks) and the popup join-retry check ignore newer generations that were started by a DIFFERENT provider. Unowned bumps (tests, legacy code) still count as superseding, so ChatGPT-only behaviour is identical.
2. **Task 5 `onInstalled`.** It awaits `refreshAllProviders("install")` and returns `results[chatgpt]` (the ChatGPT result) because an existing test asserts on the return value, rather than returning the plan's bare `refreshAllProviders("install")`.
3. **Capacity clearing is provider-scoped.** `saveIncompleteRefresh`, `saveContentSnapshot` and `requestSnapshotWithRetry` pass `provider` to `clearCapacityMonitorState`.
4. **Test totals.** `node --test` counts `test/helpers/fake-provider.js` as one extra test, so every plan checkpoint is +1. Final `npm test` after the final fix wave: 239 pass, 0 fail (233 planned + 1 helper + fix-round and fix-wave regression tests).
5. **Process.** Work was done in the git worktree at `C:/dev/Usage-Tracker-seam` on branch `feat/provider-seam` with local commits (controller Ruling 1), not the plan's "do not commit" rule; commands ran from that directory.
6. **`paceKeys()` order** is registry order (`codexWeekly`, `codex5h`), not the old `PACE_KEYS` order.

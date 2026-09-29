const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const { ChatGPTUsageConfig, ChatGPTUsageModel } = require("../usage-model.js");
const { CodexCapacityMonitor } = require("../capacity-monitor.js");
const { UsageProviders } = require("../providers.js");
const { fakeSnapshot, withFakeProviderAsync } = require("./helpers/fake-provider.js");
const backgroundSource = readFileSync(join(__dirname, "..", "background.js"), "utf8");
const LEGACY_MESSAGE_COUNTERS_KEY = "chatgptUsageMonitor.counters";

function createBackgroundHarness({ tabs = [], snapshot = null, sendError = null, createError = null, initialState = {}, existingAlarm = true, retainedSignInTabId = null, localRetainedSignInTabId = null, refreshPeriodMinutes = null, capacitySettings = null, capacityState = null, enableCustomActionIcon = false, blockCapacityInitialization = false, callbackOnlyNotificationClear = false, deferRefreshTimeout = false } = {}) {
  const storage = {
    [ChatGPTUsageConfig.storageKeys.state]: initialState,
    [LEGACY_MESSAGE_COUNTERS_KEY]: { events: [{ ts: 1, kind: "message" }] },
    [ChatGPTUsageConfig.storageKeys.retainedSignInTab]: localRetainedSignInTabId,
    [ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes]: refreshPeriodMinutes,
    [ChatGPTUsageConfig.storageKeys.capacitySettings]: capacitySettings,
    [ChatGPTUsageConfig.storageKeys.capacityState]: capacityState
  };
  const sessionStorage = {
    [ChatGPTUsageConfig.storageKeys.retainedSignInTab]: retainedSignInTabId,
    [ChatGPTUsageConfig.storageKeys.paceSessionId]: "test-session"
  };
  const calls = { create: 0, createArgs: [], remove: 0, removedTabIds: [], update: 0, updateArgs: [], windowUpdate: 0, windowUpdateArgs: [], sendMessage: 0, messages: [], soundMessages: [], alarmCreate: 0, alarmCreateArgs: [], badgeText: [], badgeColor: [], badgeTextColor: [], badgeDraws: [], badgeTypography: [], actionIcon: [], actionTitle: [], notifications: [], clearedNotifications: [], notificationEvents: [] };
  const listeners = {};
  const tabUpdatedListeners = new Set();
  const tabActivatedListeners = new Set();
  const tabRemovedListeners = new Set();
  let alarmExists = existingAlarm;
  let openTabs = tabs.map((tab) => ({ ...tab }));
  let releaseInitialCapacityRead;
  const initialCapacityReadReleased = new Promise((resolve) => { releaseInitialCapacityRead = resolve; });
  let shouldBlockInitialCapacityRead = blockCapacityInitialization;
  const chrome = {
    action: {
      async setBadgeText(options) { calls.badgeText.push(options); },
      async setBadgeBackgroundColor(options) { calls.badgeColor.push(options); },
      async setBadgeTextColor(options) { calls.badgeTextColor.push(options); },
      async setIcon(options) { calls.actionIcon.push(options); },
      async setTitle(options) { calls.actionTitle.push(options); }
    },
    notifications: {
      async create(id, options) {
        calls.notifications.push({ id, ...options });
        calls.notificationEvents.push({ type: "create", id });
        return id;
      },
      clear(id, callback) {
        calls.clearedNotifications.push(id);
        calls.notificationEvents.push({ type: "clear", id });
        if (callbackOnlyNotificationClear) {
          queueMicrotask(() => callback(true));
          return undefined;
        }
        return Promise.resolve(true);
      }
    },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      async sendMessage(message) { calls.soundMessages.push(message); },
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    alarms: {
      async create(name, options) {
        alarmExists = true;
        calls.alarmCreate += 1;
        calls.alarmCreateArgs.push({ name, ...options });
      },
      async get() { return alarmExists ? { name: ChatGPTUsageConfig.refreshAlarmName } : null; },
      onAlarm: { addListener(listener) { listeners.alarm = listener; } }
    },
    storage: {
      local: {
        async get(keys) {
          if (shouldBlockInitialCapacityRead
            && keys.includes(ChatGPTUsageConfig.storageKeys.capacityState)) {
            shouldBlockInitialCapacityRead = false;
            await initialCapacityReadReleased;
          }
          return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        }
      },
      session: {
        async get(keys) {
          return Object.fromEntries(keys.map((key) => [key, sessionStorage[key]]));
        },
        async set(values) {
          Object.assign(sessionStorage, values);
        }
      },
      onChanged: { addListener(listener) { listeners.storageChanged = listener; } }
    },
    windows: {
      async update(windowId, args) {
        calls.windowUpdate += 1;
        calls.windowUpdateArgs.push({ windowId, ...args });
        return { id: windowId, ...args };
      },
      onCreated: {
        addListener(listener, filters) {
          listeners.windowCreated = listener;
          listeners.windowCreatedFilters = filters;
        }
      }
    },
    tabs: {
      async query(queryInfo = {}) {
        return queryInfo.active ? openTabs.filter((tab) => tab.active) : openTabs;
      },
      async create(args) {
        calls.create += 1;
        calls.createArgs.push(args);
        if (createError) throw createError;
        const createdTabIsActive = Boolean(args.active);
        if (createdTabIsActive) openTabs = openTabs.map((tab) => ({ ...tab, active: false }));
        const createdTab = { id: 99, url: args.url, active: createdTabIsActive, status: "complete" };
        openTabs.push(createdTab);
        return createdTab;
      },
      async remove(tabId) {
        calls.remove += 1;
        calls.removedTabIds.push(tabId);
        openTabs = openTabs.filter((tab) => tab.id !== tabId);
        for (const listener of tabRemovedListeners) listener(tabId, { isWindowClosing: false });
      },
      async update(tabId, args) {
        calls.update += 1;
        calls.updateArgs.push({ tabId, ...args });
        if (args.active) openTabs = openTabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
        const updatedTab = openTabs.find((tab) => tab.id === tabId) || { id: tabId };
        Object.assign(updatedTab, args);
        if (args.url) {
          for (const listener of tabUpdatedListeners) {
            listener(tabId, { url: args.url }, { ...updatedTab });
          }
        }
        if (args.active) {
          await Promise.all([...tabActivatedListeners].map((listener) => (
            listener({ tabId, windowId: updatedTab.windowId })
          )));
        }
        return updatedTab;
      },
      async sendMessage(tabId, message) {
        calls.sendMessage += 1;
        calls.messages.push(message);
        if (sendError) throw sendError;
        return typeof snapshot === "function" ? snapshot(calls.sendMessage, tabId, message) : snapshot;
      },
      async get(tabId) {
        const tab = openTabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      onUpdated: {
        addListener(listener) { tabUpdatedListeners.add(listener); },
        removeListener(listener) { tabUpdatedListeners.delete(listener); }
      },
      onActivated: {
        addListener(listener) { tabActivatedListeners.add(listener); },
        removeListener(listener) { tabActivatedListeners.delete(listener); }
      },
      onRemoved: {
        addListener(listener) { tabRemovedListeners.add(listener); },
        removeListener(listener) { tabRemovedListeners.delete(listener); }
      }
    }
  };
  class FakeCanvasContext {
    constructor(size) { this.size = size; }
    drawImage() {}
    save() {}
    beginPath() {}
    moveTo() {}
    lineTo() {}
    quadraticCurveTo() {}
    closePath() {}
    fill() { this.badgeBackgroundColor = this.fillStyle; }
    stroke() {}
    fillText(text, _x, _y, maxWidth) {
      calls.badgeDraws.push({
        text,
        backgroundColor: this.badgeBackgroundColor,
        textColor: this.fillStyle
      });
      calls.badgeTypography.push({ size: this.size, font: this.font, maxWidth });
    }
    restore() {}
    getImageData(x, y, width, height) { return { x, y, width, height }; }
  }
  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() { return new FakeCanvasContext(this.width); }
  }
  const contextGlobals = {
    ChatGPTUsageConfig,
    ChatGPTUsageModel,
    CodexCapacityMonitor,
    UsageProviders,
    URL,
    chrome,
    clearTimeout,
    console,
    importScripts() {},
    setTimeout(callback, ms) {
      if (deferRefreshTimeout && ms === 45000) return setTimeout(callback, ms);
      queueMicrotask(callback);
      return 1;
    }
  };
  if (enableCustomActionIcon) {
    contextGlobals.OffscreenCanvas = FakeOffscreenCanvas;
    contextGlobals.createImageBitmap = async () => ({});
    contextGlobals.fetch = async () => ({ ok: true, async blob() { return {}; } });
  }
  const context = vm.createContext(contextGlobals);
  vm.runInContext(backgroundSource, context);
  return {
    calls,
    context,
    listeners,
    sessionStorage,
    storage,
    getOpenTabs() {
      return openTabs.map((tab) => ({ ...tab }));
    },
    async setActiveTab(tabId) {
      openTabs = openTabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
      await Promise.all([...tabActivatedListeners].map((listener) => listener({ tabId })));
    },
    setTabUrl(tabId, url) {
      const tab = openTabs.find((candidate) => candidate.id === tabId);
      if (tab) {
        tab.url = url;
        for (const listener of tabUpdatedListeners) listener(tabId, { url }, { ...tab });
      }
    },
    releaseCapacityInitialization() {
      releaseInitialCapacityRead();
    },
    run(expression) {
      return vm.runInContext(expression, context);
    }
  };
}

test("background worker startup repairs a missing periodic alarm", async () => {
  const harness = createBackgroundHarness({ existingAlarm: false });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.alarmCreate, 1);
  assert.deepEqual(harness.calls.alarmCreateArgs, [{
    name: ChatGPTUsageConfig.refreshAlarmName,
    delayInMinutes: 1,
    periodInMinutes: 15
  }]);
});

test("installation removes legacy message counts and starts one usage refresh with a 15-minute alarm", async () => {
  const observedCapacity = CodexCapacityMonitor.evaluateSnapshot({
    usage: { codexWeekly: { value: "42% remaining", structured: { remainingPercent: 42 } } }
  }, null, {}).state;
  const harness = createBackgroundHarness({
    existingAlarm: false,
    snapshot: visibleSnapshot(),
    initialState: { counters: { messages_5h: 7 } },
    capacityState: observedCapacity,
    deferRefreshTimeout: true
  });

  const installRefresh = await harness.listeners.installed();

  assert.equal(installRefresh.ok, true, installRefresh.error);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.sendMessage, 13);
  assert.ok(harness.calls.alarmCreate >= 1);
  assert.ok(harness.calls.alarmCreateArgs.every((alarm) => alarm.periodInMinutes === 15));
  assert.equal(LEGACY_MESSAGE_COUNTERS_KEY in harness.storage, false);
  assert.equal("counters" in harness.storage[ChatGPTUsageConfig.storageKeys.state], false);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent, 42);
});

test("an unparseable Analytics refresh preserves the last valid values and timestamps", async () => {
  const cached = visibleSnapshot();
  const collectedAt = "2026-08-24T10:05:00.000Z";
  const refreshedAt = "2026-08-24T10:06:00.000Z";
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok", loginStatus: "logged-in", codexAnalytics: { pageDetected: true },
      domUsageVisible: false, usage: {}
    },
    initialState: { snapshot: cached, dataCollectedAt: collectedAt, lastRefreshAt: refreshedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "analytics-no-new-data");
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(result.state.dataCollectedAt, collectedAt);
  assert.equal(result.state.lastRefreshAt, refreshedAt);
  assert.equal("counters" in result.state, false);
});

test("a load failure preserves the last valid values and timestamps", async () => {
  const cached = visibleSnapshot();
  const collectedAt = "2026-08-24T10:05:00.000Z";
  const refreshedAt = "2026-08-24T10:06:00.000Z";
  const harness = createBackgroundHarness({
    createError: new Error("Tabs cannot be created"),
    initialState: { snapshot: cached, dataCollectedAt: collectedAt, lastRefreshAt: refreshedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "codex-analytics-load-failed");
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(result.state.dataCollectedAt, collectedAt);
  assert.equal(result.state.lastRefreshAt, refreshedAt);
  assert.equal("counters" in result.state, false);
});

test("changing the refresh interval reprograms the periodic alarm", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));

  harness.listeners.storageChanged({
    [ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes]: { newValue: 23 }
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.alarmCreate, 1);
  assert.deepEqual(harness.calls.alarmCreateArgs[0], {
    name: ChatGPTUsageConfig.refreshAlarmName,
    delayInMinutes: 23,
    periodInMinutes: 23
  });
});

test("browser startup refreshes usage when the stored data is stale", async () => {
  const staleAt = new Date(
    Date.now() - ChatGPTUsageConfig.refreshPeriodMinutes * 60 * 1000
  ).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: staleAt, lastRefreshAt: staleAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.startupRefreshReasons = [];
  harness.context.fakeStartupRefresh = async (reason) => {
    harness.context.startupRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakeStartupRefresh");

  await harness.listeners.startup();

  assert.deepEqual(Array.from(harness.context.startupRefreshReasons), ["startup"]);
});

test("browser startup skips the refresh when collected usage is still recent", async () => {
  const recentAt = new Date(Date.now() - 60 * 1000).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: recentAt, lastRefreshAt: recentAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.startupRefreshReasons = [];
  harness.context.fakeStartupRefresh = async (reason) => {
    harness.context.startupRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakeStartupRefresh");

  const result = await harness.listeners.startup();

  assert.equal(result.skipped, true);
  assert.deepEqual(Array.from(harness.context.startupRefreshReasons), []);
});

test("opening a normal browser window refreshes stale usage", async () => {
  const staleAt = new Date(
    Date.now() - ChatGPTUsageConfig.refreshPeriodMinutes * 60 * 1000
  ).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: staleAt, lastRefreshAt: staleAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.windowRefreshReasons = [];
  harness.context.fakeWindowRefresh = async (reason) => {
    harness.context.windowRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakeWindowRefresh");

  await harness.listeners.windowCreated({ id: 7, type: "normal" });

  assert.deepEqual(
    Array.from(harness.listeners.windowCreatedFilters.windowTypes),
    ["normal"]
  );
  assert.deepEqual(Array.from(harness.context.windowRefreshReasons), ["window-created"]);
});

test("opening a normal browser window skips recent usage", async () => {
  const recentAt = new Date(Date.now() - 60 * 1000).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: recentAt, lastRefreshAt: recentAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.windowRefreshReasons = [];
  harness.context.fakeWindowRefresh = async (reason) => {
    harness.context.windowRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakeWindowRefresh");

  const result = await harness.listeners.windowCreated({ id: 7, type: "normal" });

  assert.equal(result.skipped, true);
  assert.deepEqual(Array.from(harness.context.windowRefreshReasons), []);
});

test("stale checks honor the persisted refresh interval", async () => {
  const collectedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: collectedAt, lastRefreshAt: collectedAt },
    refreshPeriodMinutes: 60
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.customIntervalRefreshReasons = [];
  harness.context.fakeCustomIntervalRefresh = async (reason) => {
    harness.context.customIntervalRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakeCustomIntervalRefresh");

  const result = await harness.listeners.windowCreated({ id: 7, type: "normal" });

  assert.equal(result.skipped, true);
  assert.deepEqual(Array.from(harness.context.customIntervalRefreshReasons), []);
  assert.equal(harness.run(`shouldRefreshUsage(
    { dataCollectedAt: ${JSON.stringify(collectedAt)} },
    Date.now(),
    5
  )`), true);
});

test("opening the popup returns cached state and refreshes stale usage", async () => {
  const staleAt = new Date(
    Date.now() - ChatGPTUsageConfig.refreshPeriodMinutes * 60 * 1000
  ).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: staleAt, lastRefreshAt: staleAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.popupOpenRefreshReasons = [];
  harness.context.fakePopupOpenRefresh = async (reason) => {
    harness.context.popupOpenRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakePopupOpenRefresh");

  const result = await harness.run("getPopupState()");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, true);
  assert.equal(result.state.dataCollectedAt, staleAt);
  assert.deepEqual(Array.from(harness.context.popupOpenRefreshReasons), ["popup-open"]);
});

test("opening the popup skips the refresh when usage is recent", async () => {
  const recentAt = new Date(Date.now() - 60 * 1000).toISOString();
  const harness = createBackgroundHarness({
    initialState: { dataCollectedAt: recentAt, lastRefreshAt: recentAt }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.popupOpenRefreshReasons = [];
  harness.context.fakePopupOpenRefresh = async (reason) => {
    harness.context.popupOpenRefreshReasons.push(reason);
    return { ok: true };
  };
  harness.run("refreshWithTimeout = fakePopupOpenRefresh");

  const result = await harness.run("getPopupState()");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(harness.context.popupOpenRefreshReasons), []);
});

test("opening the popup synchronizes the badge with its recent Analytics snapshot", async () => {
  const recentAt = new Date(Date.now() - 60 * 1000).toISOString();
  const previous = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {}, recentAt);
  const current = {
    status: "ok",
    loginStatus: "logged-in",
    collectedAt: recentAt,
    codexAnalytics: { pageDetected: true },
    domUsageVisible: true,
    usage: {
      codexWeekly: { value: "100% remaining", structured: { remainingPercent: 100 } }
    }
  };
  const harness = createBackgroundHarness({
    initialState: {
      snapshot: current,
      dataCollectedAt: recentAt,
      lastRefreshAt: recentAt
    },
    capacityState: previous.state
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const result = await harness.run("getPopupState()");

  assert.equal(result.ok, true);
  assert.equal(harness.calls.badgeText.at(-1).text, "100");
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    0
  );
  assert.equal(harness.calls.notifications.length, 0);
});

test("scheduled checks use the same bounded refresh wrapper as the popup", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.boundedRefreshReasons = [];
  harness.context.fakeRefreshWithTimeout = async (reason) => {
    harness.context.boundedRefreshReasons.push(reason);
  };
  harness.run("refreshWithTimeout = fakeRefreshWithTimeout");

  harness.listeners.alarm({ name: ChatGPTUsageConfig.refreshAlarmName });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(Array.from(harness.context.boundedRefreshReasons), ["alarm"]);
});

test("a queued popup retry starts its own bounded refresh", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  let releaseCurrentRefresh;
  harness.context.currentRefresh = new Promise((resolve) => {
    releaseCurrentRefresh = resolve;
  });
  harness.context.boundedRetryReasons = [];
  harness.context.fakeRefreshWithTimeout = async (reason) => {
    harness.context.boundedRetryReasons.push(reason);
    return { ok: true };
  };
  harness.run(`analyticsRefreshGeneration = 41;
    analyticsRefreshPromise = currentRefresh;
    analyticsRefreshContext = {
      popupRequested: false,
      acceptingPopupJoin: false,
      generation: analyticsRefreshGeneration
    };
    refreshWithTimeout = fakeRefreshWithTimeout;`);

  const queued = harness.run("refreshOnce('popup', true)");
  releaseCurrentRefresh();
  const result = await queued;

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(harness.context.boundedRetryReasons), ["popup"]);
});

test("capacity alerts persist crossings and never repeat the same alert", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;
  harness.calls.badgeText.length = 0;

  const processWeekly = (remainingPercent) => harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: {
        value: `${remainingPercent}% remaining`,
        structured: { remainingPercent, resetText: "Aug 31, 2026 14:00" }
      }
    }
  })})`);

  await processWeekly(11);
  assert.equal(harness.calls.notifications.length, 0);
  assert.equal(harness.calls.badgeText.at(-1).text, "11");

  await processWeekly(10);
  assert.equal(harness.calls.notifications.length, 1);
  assert.match(harness.calls.notifications[0].id, /codexWeekly-low/);

  await processWeekly(10);
  await processWeekly(9);
  assert.equal(harness.calls.notifications.length, 1);

  await processWeekly(5);
  await processWeekly(0);
  await processWeekly(100);
  await processWeekly(100);
  assert.deepEqual(harness.calls.notifications.map((notification) => notification.id), [
    "codex-capacity-codexWeekly-low",
    "codex-capacity-codexWeekly-critical",
    "codex-capacity-codexWeekly-exhausted",
    "codex-capacity-codexWeekly-reset"
  ]);
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codexWeekly-exhausted"));

  await processWeekly(10);
  assert.equal(harness.calls.notifications.length, 5);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent, 10);
});

test("concurrent snapshots serialize one threshold notification", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;
  const snapshotAt = (remainingPercent) => JSON.stringify({
    usage: {
      codexWeekly: {
        value: `${remainingPercent}% remaining`,
        structured: { remainingPercent }
      }
    }
  });

  await harness.run(`processCapacitySnapshot(${snapshotAt(11)})`);
  await Promise.all([
    harness.run(`processCapacitySnapshot(${snapshotAt(10)})`),
    harness.run(`processCapacitySnapshot(${snapshotAt(10)})`)
  ]);

  assert.equal(harness.calls.notifications.length, 1);
  assert.equal(harness.calls.notifications[0].id, "codex-capacity-codexWeekly-low");
});

test("sign-out wins over an accepted capacity update already in flight", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const originalGet = harness.context.chrome.storage.local.get;
  let releaseCapacityRead;
  let capacityReadStarted;
  const capacityReadBlocked = new Promise((resolve) => { capacityReadStarted = resolve; });
  const capacityReadReleased = new Promise((resolve) => { releaseCapacityRead = resolve; });
  let blockNextCapacityRead = true;
  harness.context.chrome.storage.local.get = async (keys) => {
    if (blockNextCapacityRead && keys.includes(ChatGPTUsageConfig.storageKeys.capacityState)) {
      blockNextCapacityRead = false;
      capacityReadStarted();
      await capacityReadReleased;
    }
    return originalGet(keys);
  };

  const processing = harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: { value: "10% remaining", structured: { remainingPercent: 10 } }
    }
  })})`);
  await capacityReadBlocked;
  const clearing = harness.run("clearCapacityMonitorState()");
  releaseCapacityRead();
  await Promise.all([processing, clearing]);

  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
  assert.equal(harness.calls.notifications.length, 0);
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("sign-out before alert emission suppresses the in-flight notification", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const originalSetTitle = harness.context.chrome.action.setTitle;
  let releaseVisualUpdate;
  let visualUpdateStarted;
  const visualUpdateBlocked = new Promise((resolve) => { visualUpdateStarted = resolve; });
  const visualUpdateReleased = new Promise((resolve) => { releaseVisualUpdate = resolve; });
  let blockNextVisualUpdate = true;
  harness.context.chrome.action.setTitle = async (options) => {
    if (blockNextVisualUpdate) {
      blockNextVisualUpdate = false;
      visualUpdateStarted();
      await visualUpdateReleased;
    }
    return originalSetTitle(options);
  };

  const processing = harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: { value: "10% remaining", structured: { remainingPercent: 10 } }
    }
  })})`);
  await visualUpdateBlocked;
  const clearing = harness.run("clearCapacityMonitorState()");
  releaseVisualUpdate();
  await Promise.all([processing, clearing]);

  assert.equal(harness.calls.notifications.length, 0);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
});

test("sign-out wins over startup capacity initialization already in flight", async () => {
  const cached = visibleSnapshot();
  cached.usage.codexWeekly = {
    value: "4% remaining",
    structured: { remainingPercent: 4 }
  };
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.storage[ChatGPTUsageConfig.storageKeys.state] = {
    status: "usage-current",
    snapshot: cached
  };
  harness.storage[ChatGPTUsageConfig.storageKeys.capacityState] = null;

  const originalGet = harness.context.chrome.storage.local.get;
  let releaseInitializationRead;
  let initializationReadStarted;
  const initializationReadBlocked = new Promise((resolve) => { initializationReadStarted = resolve; });
  const initializationReadReleased = new Promise((resolve) => { releaseInitializationRead = resolve; });
  let blockNextInitializationRead = true;
  harness.context.chrome.storage.local.get = async (keys) => {
    if (blockNextInitializationRead && keys.includes(ChatGPTUsageConfig.storageKeys.capacityState)) {
      blockNextInitializationRead = false;
      initializationReadStarted();
      await initializationReadReleased;
    }
    return originalGet(keys);
  };

  const initializing = harness.run("initializeCapacityUi()");
  await initializationReadBlocked;
  const clearing = harness.run("clearCapacityMonitorState()");
  releaseInitializationRead();
  await Promise.all([initializing, clearing]);

  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
  assert.equal(Object.keys(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters).length, 0);
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("supported browsers render the percentage as a larger custom action icon badge", async () => {
  const harness = createBackgroundHarness({ enableCustomActionIcon: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.badgeText.length = 0;
  harness.calls.actionIcon.length = 0;

  await harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: {
        value: "42% remaining",
        structured: { remainingPercent: 42 }
      }
    }
  })})`);

  assert.equal(harness.calls.badgeText.at(-1).text, "");
  assert.deepEqual(Object.keys(harness.calls.actionIcon.at(-1).imageData), ["16", "32", "48"]);
  assert.deepEqual(harness.calls.badgeDraws.at(-1), {
    text: "42",
    backgroundColor: CodexCapacityMonitor.BADGE_COLORS.amber,
    textColor: "#000000"
  });
  assert.match(harness.calls.actionTitle.at(-1).title, /42% remaining$/);
});

test("custom action badges use lighter, larger numerals for single digits", async () => {
  const harness = createBackgroundHarness({ enableCustomActionIcon: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.badgeTypography.length = 0;

  await harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: {
        value: "6% remaining",
        structured: { remainingPercent: 6 }
      }
    }
  })})`);

  assert.deepEqual(harness.calls.badgeTypography, [
    { size: 16, font: '500 10px "Segoe UI", Arial, sans-serif', maxWidth: 14.08 },
    { size: 32, font: '500 19px "Segoe UI", Arial, sans-serif', maxWidth: 28.16 },
    { size: 48, font: '500 29px "Segoe UI", Arial, sans-serif', maxWidth: 42.24 }
  ]);
});

test("native action badges receive the same accessible colors as custom badges", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));

  await harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: {
        value: "14% remaining",
        structured: { remainingPercent: 14 }
      }
    }
  })})`);

  assert.equal(harness.calls.badgeColor.at(-1).color, CodexCapacityMonitor.BADGE_COLORS.red);
  assert.equal(harness.calls.badgeTextColor.at(-1).color, "#ffffff");
});

test("startup seeds capacity state from a confirmed cached snapshot without alerting", async () => {
  const cached = visibleSnapshot();
  cached.collectedAt = new Date().toISOString();
  cached.usage.codexWeekly = {
    value: "20% remaining",
    structured: { remainingPercent: 20 }
  };
  const harness = createBackgroundHarness({
    initialState: { snapshot: cached, confirmedCapacitySnapshot: cached }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    20
  );
  assert.equal(harness.calls.notifications.length, 0);

  await harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: {
        value: "5% remaining",
        structured: { remainingPercent: 5 }
      }
    }
  })})`);
  assert.equal(harness.calls.notifications.at(-1).id, "codex-capacity-codexWeekly-critical");
});

test("startup never seeds unconfirmed fields from a legacy cached snapshot", async () => {
  const cached = visibleSnapshot();
  cached.collectedAt = new Date().toISOString();
  cached.usage.codexWeekly = {
    value: "20% remaining",
    structured: { remainingPercent: 20 }
  };
  cached.usage.codex5h = {
    value: "5% remaining",
    structured: { remainingPercent: 5 }
  };
  const harness = createBackgroundHarness({ initialState: { snapshot: cached } });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    Object.keys(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters).length,
    0
  );
  assert.equal(harness.calls.notifications.length, 0);
});

test("startup rejects a cached capacity snapshot older than retention", async () => {
  const cached = visibleSnapshot();
  cached.collectedAt = new Date(Date.now() - CodexCapacityMonitor.COUNTER_STALE_AFTER_MS - 1).toISOString();
  cached.usage.codexWeekly = {
    value: "4% remaining",
    structured: { remainingPercent: 4 }
  };
  const harness = createBackgroundHarness({
    initialState: { snapshot: cached, confirmedCapacitySnapshot: cached }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    Object.keys(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters).length,
    0
  );
  assert.equal(harness.calls.badgeText.at(-1).text, "");
  assert.equal(harness.calls.notifications.length, 0);
});

test("startup never seeds capacity from a signed-out cached snapshot", async () => {
  const cached = visibleSnapshot();
  cached.usage.codexWeekly = {
    value: "4% remaining",
    structured: { remainingPercent: 4 }
  };
  const harness = createBackgroundHarness({
    initialState: {
      status: "sign-in-required",
      snapshot: cached,
      confirmedCapacitySnapshot: cached
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].availableKeys.length, 0);
  assert.equal(harness.calls.badgeText.at(-1).text, "");
  assert.equal(harness.calls.notifications.length, 0);
});

test("an authenticated refresh waits for signed-out startup suppression", async () => {
  const harness = createBackgroundHarness({
    blockCapacityInitialization: true,
    initialState: {
      status: "sign-in-required",
      snapshot: {
        status: "ok",
        loginStatus: "logged-out",
        codexAnalytics: { pageDetected: true },
        domUsageVisible: false,
        usage: {}
      }
    },
    snapshot: visibleSnapshot()
  });

  const refreshing = harness.run("refreshForPopup()");
  await new Promise((resolve) => setImmediate(resolve));
  harness.releaseCapacityInitialization();
  const result = await refreshing;

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, undefined);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codex5h.remainingPercent,
    60
  );
});

test("content snapshots never emit alerts before the accepted stable read", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const snapshotAt = (remainingPercent) => ({
    status: "ok",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: true,
    usage: {
      codexWeekly: {
        value: `${remainingPercent}% remaining`,
        structured: { remainingPercent }
      }
    }
  });
  await harness.run(`saveContentSnapshot(${JSON.stringify(snapshotAt(10))}, { id: 7, active: true })`);
  await harness.run(`saveContentSnapshot(${JSON.stringify(snapshotAt(5))}, { id: 7, active: true })`);

  assert.equal(harness.calls.notifications.length, 0);
  assert.equal(harness.calls.badgeText.at(-1).text, "5");
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    11
  );
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].pace, baseline.state.pace);

  await harness.run(`saveSnapshot(${JSON.stringify(snapshotAt(5))}, { id: 7 }, "requested-stable")`);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].pace.codexWeekly.at(-1).remainingPercent, 5);
  assert.deepEqual(
    harness.calls.notifications.map((notification) => notification.id),
    ["codex-capacity-codexWeekly-critical"]
  );
});

test("alert expiration preserves pace for hourly refreshes, while sign-out clears it", async () => {
  const now = Date.now();
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: { codex5h: { structured: { remainingPercent: 80 } } }
  }, null, {}, new Date(now - 60 * 60000).toISOString(), "test-session");
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.run("expireCapacityMonitorState()");
  let stored = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(stored.counters.codex5h, undefined);
  assert.equal(stored.pace.codex5h[0].remainingPercent, 80);
  await harness.run('processCapacitySnapshot({ usage: { codex5h: { structured: { remainingPercent: 60 } } } })');
  stored = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  const estimate = CodexCapacityMonitor.estimateTimeRemaining(stored.pace, "codex5h", 60);
  assert.equal(estimate.status, "estimated");
  assert.ok(Math.abs(estimate.durationMs - 180 * 60000) < 1000);
  await harness.run('saveContentSnapshot({ loginStatus: "logged-out" }, { id: 7 })');
  stored = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(CodexCapacityMonitor.estimateTimeRemaining(stored.pace, "codex5h", 60).status, "unavailable");
});

test("browser session storage selects inherited pace or a provisional window after reset", async () => {
  const now = Date.now();
  const snapshot = (remainingPercent) => ({ usage: { codex5h: { structured: { remainingPercent } } } });
  let baseline = CodexCapacityMonitor.evaluateSnapshot(snapshot(80), null, {},
    new Date(now - 30 * 60000).toISOString(), "test-session").state;
  baseline = CodexCapacityMonitor.evaluateSnapshot(snapshot(70), baseline, {},
    new Date(now - 15 * 60000).toISOString(), "test-session").state;
  const sameSession = createBackgroundHarness({ capacityState: baseline });
  await new Promise((resolve) => setImmediate(resolve));
  await sameSession.run('processCapacitySnapshot({ usage: { codex5h: { structured: { remainingPercent: 100 } } } })');
  const stored = sameSession.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(stored.paceSessionId, "test-session");
  assert.equal(CodexCapacityMonitor.estimateTimeRemaining(stored.pace, "codex5h", 100).durationMs, 150 * 60000);

  const restartedWorker = createBackgroundHarness({ capacityState: stored });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restartedWorker.sessionStorage[ChatGPTUsageConfig.storageKeys.paceSessionId], stored.paceSessionId);
  assert.equal(CodexCapacityMonitor.estimateTimeRemaining(
    restartedWorker.storage[ChatGPTUsageConfig.storageKeys.capacityState].pace, "codex5h", 100
  ).durationMs, 150 * 60000);

  const newSession = createBackgroundHarness({ capacityState: baseline });
  delete newSession.sessionStorage[ChatGPTUsageConfig.storageKeys.paceSessionId];
  await new Promise((resolve) => setImmediate(resolve));
  await newSession.run('processCapacitySnapshot({ usage: { codex5h: { structured: { remainingPercent: 100 } } } })');
  const newStored = newSession.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.notEqual(newStored.paceSessionId, "test-session");
  assert.equal(newStored.paceSessionId, newSession.sessionStorage[ChatGPTUsageConfig.storageKeys.paceSessionId]);
  assert.equal(CodexCapacityMonitor.estimateTimeRemaining(newStored.pace, "codex5h", 100).status, "nominal");
});

test("the first refresh migrates a legacy baseline and a reload preserves the measured rate", async () => {
  const previousTime = new Date(Date.now() - 6 * 60000).toISOString();
  const legacy = {
    version: 2, availableKeys: ["codexWeekly"], updatedAt: previousTime,
    counters: { codexWeekly: { remainingPercent: 5, resetText: "Sep 11, 2026 7:32 AM", lastSeenAt: previousTime } }
  };
  const harness = createBackgroundHarness({ capacityState: legacy });
  await new Promise((resolve) => setImmediate(resolve));
  const process = 'processCapacitySnapshot({ usage: { codexWeekly: { structured: { remainingPercent: 4 } } } })';
  await harness.run(process);
  const stored = harness.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(stored.pace.codexWeekly.length, 2);
  const result = CodexCapacityMonitor.estimateTimeRemaining(stored.pace, "codexWeekly", 4);
  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.durationMs - 24 * 60000) < 1000);

  const reloaded = createBackgroundHarness({ capacityState: stored });
  reloaded.sessionStorage[ChatGPTUsageConfig.storageKeys.paceSessionId] = "reloaded-session";
  await new Promise((resolve) => setImmediate(resolve));
  await reloaded.run(process);
  const after = reloaded.storage[ChatGPTUsageConfig.storageKeys.capacityState];
  assert.equal(after.paceSessionId, "reloaded-session");
  assert.equal(CodexCapacityMonitor.estimateTimeRemaining(after.pace, "codexWeekly", 4).status, "estimated");
});

test("a transient optional counter stays in popup data but cannot alert", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "50% remaining", structured: { remainingPercent: 50 } },
      codex5h: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({
    capacityState: baseline.state,
    snapshot(callNumber) {
      return {
        status: "ok",
        loginStatus: "logged-in",
        codexAnalytics: { pageDetected: true },
        domUsageVisible: true,
        usage: {
          codexWeekly: {
            value: "50% remaining",
            structured: { remainingPercent: 50 }
          },
          ...(callNumber === 1 ? {
            codex5h: {
              value: "5% remaining",
              structured: { remainingPercent: 5 }
            }
          } : {})
        }
      };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const result = await harness.run("requestSnapshotWithRetry(7)");

  assert.equal(result.state.snapshot.usage.codex5h.structured.remainingPercent, 5);
  assert.deepEqual(
    Object.keys(result.state.confirmedCapacitySnapshot.usage),
    ["codexWeekly"]
  );
  assert.deepEqual(
    Array.from(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].availableKeys),
    ["codexWeekly"]
  );
  assert.equal(harness.calls.notifications.length, 0);
});

test("explicit sign-out suppresses cached capacity and clears exhausted notifications", async () => {
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: exhausted.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.clearedNotifications.length = 0;

  await harness.run(`saveContentSnapshot(${JSON.stringify({
    status: "ok",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  })}, { id: 7 })`);

  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
  assert.equal(
    Object.keys(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters).length,
    0
  );
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codexWeekly-exhausted"));
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("an expired missing counter clears its persistent exhausted notification", async () => {
  const staleSeenAt = new Date(
    Date.now() - CodexCapacityMonitor.COUNTER_STALE_AFTER_MS - 1
  ).toISOString();
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codex5h: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {}, staleSeenAt);
  const harness = createBackgroundHarness({ capacityState: exhausted.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.clearedNotifications.length = 0;

  await harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: { value: "50% remaining", structured: { remainingPercent: 50 } }
    }
  })})`);

  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codex5h,
    undefined
  );
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codex5h-exhausted"));
});

test("an incomplete refresh expires stale capacity without a worker restart", async () => {
  const staleSeenAt = new Date(
    Date.now() - CodexCapacityMonitor.COUNTER_STALE_AFTER_MS - 1
  ).toISOString();
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codex5h: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {}, staleSeenAt);
  const harness = createBackgroundHarness({ capacityState: exhausted.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.clearedNotifications.length = 0;

  await harness.run(`saveIncompleteRefresh(${JSON.stringify({
    status: "ok",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  })}, 7)`);

  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codex5h,
    undefined
  );
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codex5h-exhausted"));
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("startup clears a persistent exhausted notification after its counter expires", async () => {
  const staleSeenAt = new Date(
    Date.now() - CodexCapacityMonitor.COUNTER_STALE_AFTER_MS - 1
  ).toISOString();
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codex5h: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {}, staleSeenAt);
  const harness = createBackgroundHarness({ capacityState: exhausted.state });

  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codex5h-exhausted"));
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("startup keeps an exhausted notification for a fresh missing counter", async () => {
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "50% remaining", structured: { remainingPercent: 50 } },
      codex5h: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {});
  const missing = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "49% remaining", structured: { remainingPercent: 49 } }
    }
  }, exhausted.state, {});
  const harness = createBackgroundHarness({ capacityState: missing.state });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.calls.clearedNotifications.includes("codex-capacity-codex5h-exhausted"),
    false
  );
  assert.deepEqual(
    Array.from(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].availableKeys),
    ["codexWeekly"]
  );
});

test("a logged-out retry discards usage accumulated earlier in the same refresh", async () => {
  const harness = createBackgroundHarness({
    snapshot(callNumber) {
      if (callNumber === 1) {
        const visible = visibleSnapshot();
        visible.usage.codexWeekly = {
          value: "5% remaining",
          structured: { remainingPercent: 5 }
        };
        return visible;
      }
      return {
        status: "ok",
        loginStatus: "logged-out",
        codexAnalytics: { pageDetected: true },
        domUsageVisible: false,
        usage: {}
      };
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const result = await harness.run("requestSnapshotWithRetry(7)");

  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.sendMessage, 25);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, true);
  assert.equal(harness.calls.notifications.length, 0);
});

test("in-place authentication after logout establishes a new capacity baseline", async () => {
  const previousAccount = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "80% remaining", structured: { remainingPercent: 80 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({
    capacityState: previousAccount.state,
    snapshot(callNumber) {
      if (callNumber === 1) {
        return {
          status: "ok",
          loginStatus: "logged-out",
          codexAnalytics: { pageDetected: true },
          domUsageVisible: false,
          usage: {}
        };
      }
      const visible = visibleSnapshot();
      visible.usage.codexWeekly = {
        value: "5% remaining",
        structured: { remainingPercent: 5 }
      };
      return visible;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const result = await harness.run("requestSnapshotWithRetry(7)");

  assert.equal(result.state.status, "usage-current");
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    5
  );
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, undefined);
  assert.equal(harness.calls.notifications.length, 0);
});

test("a repeated content logout does not invalidate in-place reauthentication", async () => {
  const previousAccount = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "80% remaining", structured: { remainingPercent: 80 } }
    }
  }, null, {});
  let harness;
  harness = createBackgroundHarness({
    capacityState: previousAccount.state,
    async snapshot(callNumber) {
      if (callNumber === 1) {
        return {
          status: "ok",
          loginStatus: "logged-out",
          codexAnalytics: { pageDetected: true },
          domUsageVisible: false,
          usage: {}
        };
      }
      if (callNumber === 2) {
        await harness.run(`saveContentSnapshot(${JSON.stringify({
          status: "ok",
          loginStatus: "logged-out",
          codexAnalytics: { pageDetected: true },
          domUsageVisible: false,
          usage: {}
        })}, { id: 7 })`);
      }
      const visible = visibleSnapshot();
      visible.usage.codexWeekly = {
        value: "5% remaining",
        structured: { remainingPercent: 5 }
      };
      return visible;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  await harness.run("requestSnapshotWithRetry(7)");

  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].suppressed, undefined);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    5
  );
  assert.equal(harness.calls.notifications.length, 0);
});

test("disabling notifications clears every capacity alert type", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.clearedNotifications.length = 0;

  await harness.run(`handleCapacitySettingsChanged(${JSON.stringify({
    enableNotifications: false
  })})`);

  assert.equal(harness.calls.clearedNotifications.length, CodexCapacityMonitor.COUNTERS.length * 6);
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codexWeekly-exhausted"));
  assert.ok(harness.calls.clearedNotifications.includes("codex-capacity-codexWeekly-reset"));
});

test("callback-only notification clearing completes every capacity ID", async () => {
  const harness = createBackgroundHarness({ callbackOnlyNotificationClear: true });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.clearedNotifications.length = 0;

  await harness.run("clearCapacityMonitorState()");

  assert.equal(harness.calls.clearedNotifications.length, CodexCapacityMonitor.COUNTERS.length * 6);
});

test("sign-out during offscreen setup suppresses the pending alert sound", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  let releaseOffscreenSetup;
  let offscreenSetupStarted;
  const offscreenSetupBlocked = new Promise((resolve) => { offscreenSetupStarted = resolve; });
  const offscreenSetupReleased = new Promise((resolve) => { releaseOffscreenSetup = resolve; });
  harness.context.blockingEnsureOffscreenDocument = async () => {
    offscreenSetupStarted();
    await offscreenSetupReleased;
    return true;
  };
  harness.run("ensureOffscreenDocument = blockingEnsureOffscreenDocument");

  const playing = harness.run("playCapacitySound(capacityGeneration)");
  await offscreenSetupBlocked;
  const clearing = harness.run("clearCapacityMonitorState()");
  releaseOffscreenSetup();
  await Promise.all([playing, clearing]);

  assert.equal(harness.calls.soundMessages.length, 0);
});

test("a popup timeout expires stale capacity and abandons the hung refresh", async () => {
  const exhausted = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "0% remaining", structured: { remainingPercent: 0 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: exhausted.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.storage[ChatGPTUsageConfig.storageKeys.capacityState]
    .counters.codexWeekly.lastSeenAt = new Date(
      Date.now() - CodexCapacityMonitor.COUNTER_STALE_AFTER_MS - 1
    ).toISOString();
  harness.calls.clearedNotifications.length = 0;
  harness.context.hungRefresh = new Promise(() => {});
  harness.run(`analyticsRefreshGeneration = 4;
    analyticsRefreshPromise = hungRefresh;
    analyticsRefreshContext = {
      popupRequested: true,
      acceptingPopupJoin: true,
      generation: analyticsRefreshGeneration
    };`);

  const result = await harness.run(
    "withTimeout(hungRefresh, 1, 'Refresh timed out.')"
  );

  assert.equal(result.ok, false);
  assert.equal(harness.run("analyticsRefreshPromise === null"), true);
  assert.equal(harness.run("analyticsRefreshContext === null"), true);
  assert.equal(harness.run("analyticsRefreshGeneration"), 5);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly,
    undefined
  );
  assert.ok(harness.calls.clearedNotifications.includes(
    "codex-capacity-codexWeekly-exhausted"
  ));
  assert.equal(harness.calls.badgeText.at(-1).text, "");
});

test("timeout cleanup never overwrites a newer refresh state", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  let releaseExpiration;
  let expirationStarted;
  const expirationBlocked = new Promise((resolve) => { expirationStarted = resolve; });
  const expirationReleased = new Promise((resolve) => { releaseExpiration = resolve; });
  harness.context.blockingExpireCapacityState = async () => {
    expirationStarted();
    await expirationReleased;
  };
  harness.context.hungRefresh = new Promise(() => {});
  harness.run(`expireCapacityMonitorState = blockingExpireCapacityState;
    analyticsRefreshGeneration = 20;
    analyticsRefreshPromise = hungRefresh;
    analyticsRefreshContext = {
      popupRequested: true,
      acceptingPopupJoin: true,
      generation: analyticsRefreshGeneration
    };`);

  const timingOut = harness.run(
    "withTimeout(hungRefresh, 1, 'Refresh timed out.')"
  );
  await expirationBlocked;
  harness.run("analyticsRefreshGeneration += 1");
  harness.storage[ChatGPTUsageConfig.storageKeys.state] = {
    status: "usage-current",
    snapshot: {
      ...visibleSnapshot(),
      usage: {
        codexWeekly: { value: "40% remaining", structured: { remainingPercent: 40 } }
      }
    }
  };
  releaseExpiration();
  const result = await timingOut;

  assert.equal(result.ignored, true);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.state].status,
    "usage-current"
  );
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.state]
      .snapshot.usage.codexWeekly.structured.remainingPercent,
    40
  );
});

test("a late timeout cannot invalidate a different refresh generation", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.oldHungRefresh = new Promise(() => {});
  harness.context.newHungRefresh = new Promise(() => {});
  harness.run(`analyticsRefreshGeneration = 31;
    analyticsRefreshPromise = newHungRefresh;
    analyticsRefreshContext = {
      popupRequested: false,
      acceptingPopupJoin: true,
      generation: analyticsRefreshGeneration
    };`);

  const result = await harness.run(
    "withTimeout(oldHungRefresh, 1, 'Refresh timed out.', 30)"
  );

  assert.equal(result.ignored, true);
  assert.equal(harness.run("analyticsRefreshGeneration"), 31);
  assert.equal(harness.run("analyticsRefreshPromise === newHungRefresh"), true);
  assert.equal(harness.run("analyticsRefreshContext.generation"), 31);
});

test("a late timed-out refresh cannot overwrite a newer snapshot", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  const newerSnapshot = {
    ...visibleSnapshot(),
    collectedAt: "2026-08-26T11:30:00.000Z",
    usage: {
      codexWeekly: { value: "40% remaining", structured: { remainingPercent: 40 } }
    }
  };
  const staleSnapshot = {
    ...visibleSnapshot(),
    collectedAt: "2026-08-26T11:20:00.000Z",
    usage: {
      codexWeekly: { value: "5% remaining", structured: { remainingPercent: 5 } }
    }
  };
  harness.run("analyticsRefreshGeneration = 8");

  await harness.run(`saveSnapshot(
    ${JSON.stringify(newerSnapshot)},
    { id: 8 },
    "requested-stable",
    capacityGeneration,
    ${JSON.stringify(newerSnapshot)},
    8
  )`);
  await assert.rejects(
    harness.run(`saveSnapshot(
      ${JSON.stringify(staleSnapshot)},
      { id: 7 },
      "requested-stable",
      capacityGeneration,
      ${JSON.stringify(staleSnapshot)},
      7
    )`),
    /expired before it could persist results/
  );

  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.state]
      .snapshot.usage.codexWeekly.structured.remainingPercent,
    40
  );
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState]
      .counters.codexWeekly.remainingPercent,
    40
  );
});

test("a timed-out refresh cannot emit a queued capacity alert", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;
  const originalGet = harness.context.chrome.storage.local.get;
  let releaseCapacityRead;
  let capacityReadStarted;
  let blockNextCapacityRead = true;
  const capacityReadBlocked = new Promise((resolve) => { capacityReadStarted = resolve; });
  const capacityReadReleased = new Promise((resolve) => { releaseCapacityRead = resolve; });
  harness.context.chrome.storage.local.get = async (keys) => {
    if (blockNextCapacityRead
      && keys.includes(ChatGPTUsageConfig.storageKeys.capacityState)) {
      blockNextCapacityRead = false;
      capacityReadStarted();
      await capacityReadReleased;
    }
    return originalGet(keys);
  };
  harness.run("analyticsRefreshGeneration = 12");

  const processing = harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: { value: "5% remaining", structured: { remainingPercent: 5 } }
    }
  })}, capacityGeneration, 12)`);
  await capacityReadBlocked;
  harness.run("analyticsRefreshGeneration = 13");
  releaseCapacityRead();
  const result = await processing;

  assert.equal(result.ignored, true);
  assert.equal(harness.calls.notifications.length, 0);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState]
      .counters.codexWeekly.remainingPercent,
    11
  );
});

test("startup normalization preserves settings changed after its first read", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.storage[ChatGPTUsageConfig.storageKeys.capacitySettings] = null;

  const originalGet = harness.context.chrome.storage.local.get;
  let injectConcurrentSettings = true;
  harness.context.chrome.storage.local.get = async (keys) => {
    const result = await originalGet(keys);
    if (injectConcurrentSettings && keys.includes(ChatGPTUsageConfig.storageKeys.capacityState)) {
      injectConcurrentSettings = false;
      queueMicrotask(() => {
        harness.storage[ChatGPTUsageConfig.storageKeys.capacitySettings] = {
          ...CodexCapacityMonitor.DEFAULT_SETTINGS,
          enableNotifications: false
        };
      });
    }
    return result;
  };

  await harness.run("initializeCapacityUi()");

  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacitySettings].enableNotifications,
    false
  );
});

test("notification opt-out wins over a capacity alert already in flight", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: { value: "11% remaining", structured: { remainingPercent: 11 } }
    }
  }, null, {});
  const harness = createBackgroundHarness({ capacityState: baseline.state });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notificationEvents.length = 0;

  const originalSet = harness.context.chrome.storage.local.set;
  let releaseCapacityWrite;
  let capacityWriteStarted;
  const capacityWriteBlocked = new Promise((resolve) => { capacityWriteStarted = resolve; });
  const capacityWriteReleased = new Promise((resolve) => { releaseCapacityWrite = resolve; });
  let blockNextCapacityWrite = true;
  harness.context.chrome.storage.local.set = async (values) => {
    if (blockNextCapacityWrite && values[ChatGPTUsageConfig.storageKeys.capacityState]) {
      blockNextCapacityWrite = false;
      capacityWriteStarted();
      await capacityWriteReleased;
    }
    return originalSet(values);
  };

  const processing = harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: {
      codexWeekly: { value: "10% remaining", structured: { remainingPercent: 10 } }
    }
  })})`);
  await capacityWriteBlocked;
  harness.storage[ChatGPTUsageConfig.storageKeys.capacitySettings] = {
    ...CodexCapacityMonitor.DEFAULT_SETTINGS,
    enableNotifications: false
  };
  const disabling = harness.run(`handleCapacitySettingsChanged(${JSON.stringify({
    enableNotifications: false
  })})`);
  releaseCapacityWrite();
  await Promise.all([processing, disabling]);

  const lowEvents = harness.calls.notificationEvents.filter((event) => (
    event.id === "codex-capacity-codexWeekly-low"
  ));
  assert.deepEqual(lowEvents.map((event) => event.type), ["create", "clear"]);
});

function visibleSnapshot() {
  return {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    collectedAt: "2026-08-24T10:00:00.000Z",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: true,
    usage: {
      codex5h: { value: "5h limit: 60% remaining", structured: { remainingPercent: 60 } },
      bankedResets: {
        value: "Banked resets: 2; expires Aug 31, 2026",
        structured: { bankedResetCount: 2, expiresText: "Aug 31, 2026" }
      }
    }
  };
}

test("popup refresh opens a background Analytics tab and closes it after reading", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.match(harness.calls.createArgs[0].url, /settings\/analytics/);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.remove, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [17]);
});

test("background refresh does not override a tab selected by the user during collection", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/starting-page", active: true, status: "complete" },
      { id: 18, url: "https://chatgpt.com/c/user-selected-page", active: false, status: "complete" }
    ],
    snapshot(callNumber) {
      if (callNumber === 1) harness.setActiveTab(18);
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
});

test("refresh preserves a temporary Analytics tab activated during collection", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      if (callNumber === 1) harness.setActiveTab(99);
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 99).active, true);
});

test("refresh remembers temporary-tab adoption after the user switches away", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 18, url: "https://chatgpt.com/c/next-conversation", active: false, status: "complete" }
    ],
    snapshot(callNumber) {
      if (callNumber === 1) harness.setActiveTab(99);
      if (callNumber === 2) harness.setActiveTab(18);
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 99).active, false);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [18]);
});

test("refresh tracks adoption until asynchronous cleanup finishes", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 18, url: "https://chatgpt.com/c/next-conversation", active: false, status: "complete" }
    ],
    snapshot: visibleSnapshot()
  });
  const originalGet = harness.context.chrome.storage.session.get;
  let retainedReads = 0;
  let activationInjected = false;
  harness.context.chrome.storage.session.get = async (keys) => {
    if (keys.includes(ChatGPTUsageConfig.storageKeys.retainedSignInTab)) {
      retainedReads += 1;
      if (retainedReads === 2 && !activationInjected) {
        activationInjected = true;
        harness.setActiveTab(99);
        harness.setActiveTab(18);
      }
    }
    return originalGet(keys);
  };

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(activationInjected, true);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 99), true);
});

test("an inactive automatic redirect remains extension-owned during cleanup", async () => {
  let harness;
  harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      if (callNumber === 1) {
        harness.setTabUrl(99, "https://chatgpt.com/c/user-owned-conversation");
      }
      return visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 99), false);
});

test("periodic refresh creates a real temporary Analytics tab when none is open", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.remove, 1);
  assert.equal(harness.calls.update, 0);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [17]);
});

test("periodic refresh uses a fresh background page while Analytics stays open", async () => {
  const baseline = CodexCapacityMonitor.evaluateSnapshot({
    usage: {
      codexWeekly: {
        value: "11% remaining",
        structured: { remainingPercent: 11 }
      }
    }
  }, null, {});
  const snapshotAt = (remainingPercent) => ({
    ...visibleSnapshot(),
    usage: {
      codexWeekly: {
        value: `${remainingPercent}% remaining`,
        structured: { remainingPercent }
      }
    }
  });
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    capacityState: baseline.state,
    snapshot(_callNumber, tabId) {
      return snapshotAt(tabId === 42 ? 11 : 10);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [42]);
  assert.equal(
    harness.storage[ChatGPTUsageConfig.storageKeys.capacityState].counters.codexWeekly.remainingPercent,
    10
  );
  assert.deepEqual(harness.calls.notifications.map((notification) => notification.id), [
    "codex-capacity-codexWeekly-low"
  ]);
});

test("refresh opens a fresh background tab when Analytics exists only in the background", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    snapshot: visibleSnapshot()
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.calls.update, 0);
});

test("periodic refresh ignores an unusable open page and reads a fresh background page", async () => {
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      return tabId === 42 ? emptySnapshot : visibleSnapshot();
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

test("a temporary Analytics tab remains open only when ChatGPT requires sign-in", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 99).active, false);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("repeated logged-out refreshes reuse one retained background sign-in tab", async () => {
  const loggedOutSnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot: loggedOutSnapshot
  });

  const firstResult = await harness.run("refreshForPopup()");
  const secondResult = await harness.run("refreshForPopup()");

  assert.equal(firstResult.state.status, "sign-in-required");
  assert.equal(secondResult.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
  assert.equal(
    harness.getOpenTabs().filter((tab) => /settings\/analytics/.test(tab.url)).length,
    1
  );
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("a scheduled sign-in tab is retained and adopted by the next refresh", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok", loginStatus: "logged-out", codexAnalytics: { pageDetected: true },
      domUsageVisible: false, usage: {}
    }
  });

  const first = await harness.run('refreshOnce("alarm")');
  const second = await harness.run('refreshOnce("alarm")');

  assert.equal(first.state.status, "sign-in-required");
  assert.equal(second.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("automatic sign-in redirects remain owned and are returned to Analytics", async () => {
  const loggedOutSnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "other",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: false },
    domUsageVisible: false,
    usage: {}
  };
  let harness;
  let redirected = false;
  harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot() {
      if (!redirected) {
        redirected = true;
        harness.setTabUrl(99, "https://chatgpt.com/auth/login");
      }
      return loggedOutSnapshot;
    }
  });

  await harness.run("refreshForPopup()");
  const secondResult = await harness.run("refreshForPopup()");

  assert.equal(secondResult.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.updateArgs, [{
    tabId: 99,
    url: "https://chatgpt.com/codex/cloud/settings/analytics",
    active: false
  }]);
  assert.equal(harness.calls.remove, 0);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
  assert.match(harness.getOpenTabs().find((tab) => tab.id === 99).url, /settings\/analytics/);
});

test("a local tab ID from an earlier browser session is never trusted", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    snapshot: visibleSnapshot(),
    localRetainedSignInTabId: 42
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 42), true);
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 42);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("a retained sign-in tab is removed after authentication succeeds", async () => {
  const loggedOutSnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-out",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }],
    snapshot(callNumber) {
      return callNumber <= 25 ? loggedOutSnapshot : visibleSnapshot();
    }
  });

  await harness.run("refreshForPopup()");
  const authenticatedResult = await harness.run("refreshForPopup()");

  assert.equal(authenticatedResult.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("activating a retained sign-in tab transfers ownership between refreshes", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    retainedSignInTabId: 42
  });

  await harness.setActiveTab(42);
  await harness.setActiveTab(17);

  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 42), true);
});

test("concurrent release cannot erase a newly retained sign-in tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" },
      { id: 99, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    retainedSignInTabId: 42
  });
  const originalGet = harness.context.chrome.storage.session.get;
  let releaseFirstRead;
  let signalFirstRead;
  const firstReadStarted = new Promise((resolve) => { signalFirstRead = resolve; });
  const firstReadReleased = new Promise((resolve) => { releaseFirstRead = resolve; });
  let retainedReads = 0;
  harness.context.chrome.storage.session.get = async (keys) => {
    const result = await originalGet(keys);
    if (keys.includes(ChatGPTUsageConfig.storageKeys.retainedSignInTab)) {
      retainedReads += 1;
      if (retainedReads === 1) {
        signalFirstRead();
        await firstReadReleased;
      }
    }
    return result;
  };

  const releaseOwnership = harness.run("forgetRetainedSignInTab(42)");
  await firstReadStarted;
  const retainReplacement = harness.run("retainOnlySignInTab(99)");
  releaseFirstRead();
  await Promise.all([releaseOwnership, retainReplacement]);

  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
});

test("an active retained Analytics tab becomes user-owned while refresh uses a temporary tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: visibleSnapshot(),
    retainedSignInTabId: 42
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 42).active, true);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("a periodic logged-out refresh retains its temporary tab without stealing focus", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a successful periodic refresh removes an extension-owned sign-in tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/auth/login", active: false, status: "complete" }
    ],
    snapshot: visibleSnapshot(),
    retainedSignInTabId: 42
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.state.status, "usage-current");
  assert.equal(harness.calls.create, 0);
  assert.deepEqual(harness.calls.removedTabIds, [42]);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("scheduled sign-in status preserves a newer stored usage snapshot", async () => {
  const newerSnapshot = visibleSnapshot();
  const harness = createBackgroundHarness({
    initialState: {
      snapshot: newerSnapshot,
      status: "usage-current",
      dataCollectedAt: "2026-08-24T10:05:00.000Z",
      lastRefreshAt: "2026-08-24T10:05:00.000Z"
    }
  });
  harness.context.staleSignInSnapshot = {
    loginStatus: "logged-out", usage: {}, codexAnalytics: { pageDetected: true }
  };

  const result = await harness.run("saveIncompleteRefresh(staleSignInSnapshot, 99)");

  assert.equal(result.state.status, "sign-in-required");
  assert.deepEqual(result.state.snapshot, newerSnapshot);
  assert.equal(result.state.dataCollectedAt, "2026-08-24T10:05:00.000Z");
  assert.equal(result.state.lastRefreshAt, "2026-08-24T10:05:00.000Z");
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state], result.state);
});

test("a periodic logged-out refresh verifies sign-in without touching the open page", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const result = await harness.run('refreshOnce("alarm")');

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.deepEqual(harness.calls.removedTabIds, []);
  assert.equal(harness.getOpenTabs().find((tab) => tab.id === 42).active, true);
});

test("a popup joining a periodic logged-out refresh keeps the temporary tab for sign-in", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });

  const results = await harness.run('Promise.all([refreshOnce("alarm"), refreshForPopup()])');

  assert.equal(results[0].state.status, "sign-in-required");
  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a popup joining an alarm keeps the older retained sign-in tab", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    retainedSignInTabId: 42
  });

  const results = await harness.run('Promise.all([refreshOnce("alarm"), refreshForPopup()])');

  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.calls.create, 0);
  assert.deepEqual(harness.calls.removedTabIds, []);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 42);
  assert.equal(
    harness.getOpenTabs().filter((tab) => /settings\/analytics/.test(tab.url)).length,
    1
  );
});

test("adopting an older retained tab during replacement preserves it as user-owned", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" },
      { id: 99, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    retainedSignInTabId: 42
  });
  const originalGet = harness.context.chrome.tabs.get;
  let releasePreviousRead;
  let signalPreviousRead;
  const previousReadStarted = new Promise((resolve) => { signalPreviousRead = resolve; });
  const previousReadReleased = new Promise((resolve) => { releasePreviousRead = resolve; });
  harness.context.chrome.tabs.get = async (tabId) => {
    const tab = await originalGet(tabId);
    if (tabId === 42) {
      signalPreviousRead();
      await previousReadReleased;
    }
    return tab;
  };

  const replacement = harness.run("retainOnlySignInTab(99)");
  await previousReadStarted;
  await harness.setActiveTab(42);
  await harness.setActiveTab(17);
  releasePreviousRead();
  const retainedTabId = await replacement;

  assert.equal(retainedTabId, 99);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], 99);
  assert.deepEqual(harness.calls.removedTabIds, []);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 42), true);
  assert.equal(harness.getOpenTabs().some((tab) => tab.id === 99), true);
});

test("a popup joining a scheduled sign-in refresh keeps the temporary tab", async () => {
  const harness = createBackgroundHarness({
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-out",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    }
  });
  const results = await harness.run('Promise.all([refreshOnce("alarm"), refreshForPopup()])');

  assert.equal(results[0].state.status, "sign-in-required");
  assert.equal(results[1].state.status, "sign-in-required");
  assert.equal(harness.storage[ChatGPTUsageConfig.storageKeys.state].status, "sign-in-required");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.remove, 0);
});

test("a non-Analytics page cannot overwrite a valid usage snapshot", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({ initialState: { snapshot: cached } });
  const ordinaryPageSnapshot = {
    status: "ok",
    codexAnalytics: null,
    domUsageVisible: false,
    usage: {}
  };
  harness.context.ordinaryPageSnapshot = ordinaryPageSnapshot;

  const result = await harness.run("saveContentSnapshot(ordinaryPageSnapshot, { id: 7 })");

  assert.equal(result.ignored, true);
  assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state].snapshot, cached);
});

test("Visit Analytics focuses an existing page instead of duplicating it", async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 17, windowId: 5, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" },
      { id: 42, windowId: 5, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: false, status: "complete" }
    ],
    retainedSignInTabId: 42
  });

  const result = await harness.run("openCodexAnalyticsPage()");

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(harness.calls.create, 0);
  assert.deepEqual(harness.calls.updateArgs, [{ tabId: 42, active: true }]);
  assert.deepEqual(harness.calls.windowUpdateArgs, [{ windowId: 5, focused: true }]);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [42]);
  assert.equal(harness.sessionStorage[ChatGPTUsageConfig.storageKeys.retainedSignInTab], null);
});

test("Visit Analytics creates a focused active page when none exists", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 17, windowId: 5, url: "https://chatgpt.com/c/ordinary-conversation", active: true, status: "complete" }]
  });

  const result = await harness.run("openCodexAnalyticsPage()");

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, true);
  assert.match(harness.calls.createArgs[0].url, /settings\/analytics/);
  assert.deepEqual(harness.getOpenTabs().filter((tab) => tab.active).map((tab) => tab.id), [99]);
});

test("concurrent popup refreshes share one Analytics collection", async () => {
  const snapshot = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot
  });

  const results = await harness.run("Promise.all([refreshForPopup(), refreshForPopup()])");

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.calls.removedTabIds, [99]);
});

test("a responsive Analytics page without new metrics is not reported as a failure", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-in",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.fresh, false);
  assert.equal(result.state.status, "analytics-no-new-data");
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.sendMessage, 25);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

for (const [label, usage] of [
  ["credits-only", { codexCredits: { value: "Credits: 12", structured: { remainingCredits: 12 } } }],
  ["unstructured limit text", { codex5h: { value: "5h limit: 45% remaining" } }]
]) {
  test(`${label} refresh preserves the last parsed limit and its timestamp`, async () => {
    const cached = visibleSnapshot();
    const lastRefreshAt = "2026-08-24T10:01:00.000Z";
    const harness = createBackgroundHarness({
      snapshot: {
        ...cached,
        collectedAt: "2026-08-24T10:10:00.000Z",
        usage
      },
      initialState: {
        snapshot: cached,
        dataCollectedAt: cached.collectedAt,
        lastRefreshAt
      }
    });

    const result = await harness.run("refreshForPopup()");

    assert.equal(result.state.status, "analytics-no-new-data");
    assert.deepEqual(result.state.snapshot, cached);
    assert.equal(result.state.dataCollectedAt, cached.collectedAt);
    assert.equal(result.state.lastRefreshAt, lastRefreshAt);
  });
}

test("manual refresh bypasses an open page without metrics for a fresh background page", async () => {
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      return tabId === 42 ? emptySnapshot : visibleSnapshot();
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 60% remaining");
  assert.equal(harness.calls.sendMessage, 13);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.createArgs[0].active, false);
  assert.equal(harness.calls.remove, 1);
});

test("refresh failure is based on the fresh temporary Analytics reader", async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    sendError: new Error("Receiving end does not exist")
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "content-script-unavailable");
  assert.match(result.error, /Receiving end does not exist/);
  assert.equal(harness.calls.sendMessage, 25);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 1);
});

test("failure to create a fresh reader never trusts the open Analytics page", async () => {
  const cached = visibleSnapshot();
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot: {
      status: "ok",
      hostname: "chatgpt.com",
      pathCategory: "codex",
      loginStatus: "logged-in",
      codexAnalytics: { pageDetected: true },
      domUsageVisible: false,
      usage: {}
    },
    createError: new Error("Tabs cannot be created"),
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "codex-analytics-load-failed");
  assert.match(result.state.diagnostic, /could not create the temporary/i);
  assert.match(result.error, /Tabs cannot be created/);
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 0);
});

test("failure to read the fresh page preserves cached usage without trusting the open page", async () => {
  const cached = visibleSnapshot();
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      if (tabId === 42) return emptySnapshot;
      throw new Error("Temporary reader unavailable");
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "content-script-unavailable");
  assert.match(result.state.diagnostic, /temporary Codex Analytics page did not respond/i);
  assert.match(result.error, /Temporary reader unavailable/);
  assert.deepEqual(result.state.snapshot, cached);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.remove, 1);
});

test("fresh-reader failure keeps a newer content snapshot stored during the attempt", async () => {
  const cached = visibleSnapshot();
  const newerSnapshot = {
    ...visibleSnapshot(),
    collectedAt: "2026-08-24T10:05:00.000Z",
    usage: {
      codex5h: { value: "5h limit: 58% remaining" }
    }
  };
  const emptySnapshot = {
    status: "ok",
    hostname: "chatgpt.com",
    pathCategory: "codex",
    loginStatus: "logged-in",
    codexAnalytics: { pageDetected: true },
    domUsageVisible: false,
    usage: {}
  };
  let harness;
  let newerSnapshotStored = false;
  harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(_callNumber, tabId) {
      if (tabId === 42) return emptySnapshot;
      if (!newerSnapshotStored) {
        newerSnapshotStored = true;
        harness.storage[ChatGPTUsageConfig.storageKeys.state] = {
          status: "usage-current",
          snapshot: newerSnapshot,
          dataCollectedAt: newerSnapshot.collectedAt,
          lastRefreshAt: newerSnapshot.collectedAt
        };
      }
      throw new Error("Temporary reader unavailable");
    },
    initialState: { snapshot: cached, dataCollectedAt: cached.collectedAt }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, false);
  assert.equal(result.state.status, "content-script-unavailable");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 58% remaining");
  assert.equal(result.state.dataCollectedAt, newerSnapshot.collectedAt);
  assert.match(result.state.diagnostic, /temporary Codex Analytics page did not respond/i);
  assert.match(result.error, /Temporary reader unavailable/);
  assert.equal(harness.calls.remove, 1);
});

test("a recoverable tab-readiness timeout does not overwrite refresh state", async () => {
  const initialState = {
    status: "analytics-no-new-data",
    diagnostic: "Analytics responded without new metrics."
  };
  const harness = createBackgroundHarness({ initialState });
  harness.context.chrome.tabs.get = async () => new Promise(() => {});

  await harness.run("waitForTabReadyOrDelay(42)");

  assert.deepEqual(
    harness.storage[ChatGPTUsageConfig.storageKeys.state],
    initialState
  );
});

test("refresh waits for late usage cards before saving the page snapshot", async () => {
  const completeSnapshot = visibleSnapshot();
  const partialSnapshot = {
    ...completeSnapshot,
    usage: {
      codex5h: completeSnapshot.usage.codex5h
    }
  };
  const lateSnapshot = {
    ...completeSnapshot,
    usage: {
      bankedResets: completeSnapshot.usage.bankedResets
    }
  };
  const harness = createBackgroundHarness({
    tabs: [{ id: 42, url: "https://chatgpt.com/codex/cloud/settings/analytics", active: true, status: "complete" }],
    snapshot(callNumber) {
      return callNumber <= 5 ? partialSnapshot : lateSnapshot;
    }
  });

  const result = await harness.run("refreshForPopup()");

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "usage-current");
  assert.equal(result.state.snapshot.usage.codex5h.value, "5h limit: 60% remaining");
  assert.equal(result.state.snapshot.usage.bankedResets.structured.bankedResetCount, 2);
  assert.equal(result.state.snapshot.source, "requested-stable");
  assert.equal(harness.calls.sendMessage, 13);
});


test("partial replenishment and reset date changes create native notifications once", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  harness.calls.notifications.length = 0;
  const process = (remainingPercent, resetText) => harness.run(`processCapacitySnapshot(${JSON.stringify({
    usage: { codexWeekly: { structured: { remainingPercent, resetText } } }
  })})`);
  await process(20, "Sep 10, 2026 14:00");
  await process(45, "Sep 10, 2026 14:00");
  await process(45, "Sep 10, 2026 14:00");
  await process(45, "Sep 11, 2026 14:00");
  await process(45, "Sep 11, 2026 14:00");
  assert.deepEqual(harness.calls.notifications.map(n => n.id), [
    "codex-capacity-codexWeekly-capacity-increased",
    "codex-capacity-codexWeekly-reset-changed"
  ]);
  await harness.run("clearAllCapacityNotifications()");
  for (const notification of harness.calls.notifications) {
    assert.ok(harness.calls.clearedNotifications.includes(notification.id));
  }
});

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
    assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state], chatgptState);
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

test("a refresh queued behind a hung refresh of another provider runs after that refresh's owner times out, with its own generation", async () => {
  await withFakeProviderAsync(async (fake) => {
    const harness = createBackgroundHarness({
      deferRefreshTimeout: true,
      snapshot: fakeSnapshot(60, new Date().toISOString())
    });
    const initialChatgptState = harness.storage[ChatGPTUsageConfig.storageKeys.state];
    harness.run(`analyticsRefreshContext = { providerId: "chatgpt", popupRequested: false, acceptingPopupJoin: true, generation: analyticsRefreshGeneration };
      analyticsRefreshPromise = new Promise(() => {});`);
    const pending = harness.run(`refreshWithTimeout("popup", UsageProviders.getProvider("fake"))`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.calls.create, 0, "the queued refresh must not start while the other provider is in flight");
    harness.run(`analyticsRefreshGeneration += 1; analyticsRefreshPromise = null; analyticsRefreshContext = null; notifyRefreshLockReleased();`);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(harness.calls.createArgs[0].url, "https://fake.example/usage");
    assert.equal(harness.storage[fake.stateKey].status, "usage-current");
    assert.equal(harness.storage[fake.stateKey].snapshot.usage["fake:session"].structured.remainingPercent, 60);
    assert.deepEqual(harness.storage[ChatGPTUsageConfig.storageKeys.state], initialChatgptState);
  });
});

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

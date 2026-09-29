importScripts("usage-model.js", "providers.js", "capacity-monitor.js");

const {
  storageKeys,
  refreshAlarmName,
  refreshPeriodMinutes: defaultRefreshPeriodMinutes
} = ChatGPTUsageConfig;
const chatgptProvider = UsageProviders.getProvider("chatgpt");
const ANALYTICS_LOAD_TIMEOUT_MS = 8000;
const ANALYTICS_READ_ATTEMPTS = 25;
const ANALYTICS_READ_INTERVAL_MS = 400;
const ANALYTICS_STABLE_READS_REQUIRED = 5;
const ANALYTICS_MIN_READS_AFTER_FIRST_DATA = 13;
const REFRESH_TIMEOUT_MS = 45000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const LEGACY_MESSAGE_COUNTERS_KEY = "chatgptUsageMonitor.counters";
const CAPACITY_NOTIFICATION_TYPES = Object.freeze(["low", "critical", "exhausted", "reset", "capacity-increased", "reset-changed"]);
const ACTION_ICON_PATHS = Object.freeze({
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png"
});
let analyticsRefreshPromise = null;
let analyticsRefreshContext = null;
let analyticsRefreshGeneration = 0;
let refreshLockWaiters = [];
let retainedSignInTabUpdate = Promise.resolve();
let paceSessionPromise = null;
let capacityUpdate = Promise.resolve();
let capacityInitializationPromise = Promise.resolve();
let capacityGeneration = 0;
let capacitySuppressed = false;
const actionIconBitmapPromises = new Map();
const adoptedAnalyticsTabIds = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRefreshAlarm();
  const existing = await chrome.storage.local.get([storageKeys.state]);
  if (existing[storageKeys.state] && "counters" in existing[storageKeys.state]) {
    const { counters: _legacyCounters, ...state } = existing[storageKeys.state];
    await chrome.storage.local.set({ [storageKeys.state]: state });
  }
  await chrome.storage.local.remove(LEGACY_MESSAGE_COUNTERS_KEY);
  await initializeCapacityUi();
  const results = await refreshAllProviders("install");
  return results[chatgptProvider.id];
});

chrome.runtime.onStartup.addListener(() => refreshOnStartup().catch(() => {}));

chrome.windows.onCreated.addListener(
  () => refreshIfStale("window-created").catch(() => {}),
  { windowTypes: ["normal"] }
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === refreshAlarmName) {
    refreshAllProviders("alarm").catch(() => {});
  }
});

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

ensureRefreshAlarm().catch(() => {});
initializeCapacityUi().catch(() => {});

if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[storageKeys.capacitySettings]) {
      handleCapacitySettingsChanged(changes[storageKeys.capacitySettings].newValue).catch(() => {});
    }
    if (changes[storageKeys.refreshPeriodMinutes]) {
      handleRefreshPeriodChanged(changes[storageKeys.refreshPeriodMinutes].newValue).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "usage:contentSnapshot") {
    saveContentSnapshot(message.payload, sender.tab, providerForSender(sender)).then(sendResponse);
    return true;
  }

  if (message.type === "usage:getState") {
    getPopupState().then(sendResponse);
    return true;
  }

  if (message.type === "usage:refresh") {
    refreshWithTimeout("popup").then(sendResponse);
    return true;
  }

  if (message.type === "usage:openCodexAnalytics") {
    openCodexAnalyticsPage().then(sendResponse);
    return true;
  }

  return false;
});

async function saveSnapshot(
  snapshot,
  tab,
  source,
  expectedCapacityGeneration = capacityGeneration,
  capacitySnapshot = snapshot,
  expectedAnalyticsRefreshGeneration = null,
  provider = chatgptProvider
) {
  if (!provider.hasParsedUsageLimit(snapshot)) {
    return saveIncompleteRefresh(snapshot, tab && tab.id, source, expectedAnalyticsRefreshGeneration, provider);
  }
  const existing = await chrome.storage.local.get([provider.stateKey]);
  assertCurrentAnalyticsRefresh(
    Number.isInteger(expectedAnalyticsRefreshGeneration)
      ? { generation: expectedAnalyticsRefreshGeneration }
      : null
  );
  const currentState = existing[provider.stateKey] || {};
  const hasVisibleUsage = provider.hasParsedUsageLimit(snapshot);
  const collectedAt = snapshot && snapshot.collectedAt ? snapshot.collectedAt : new Date().toISOString();
  const acceptedCapacitySnapshot = hasVisibleUsage
    && (source === "requested-stable" || source === "requested-best-effort")
    ? {
        ...capacitySnapshot,
        collectedAt: capacitySnapshot && capacitySnapshot.collectedAt
          ? capacitySnapshot.collectedAt
          : collectedAt
      }
    : null;
  const nextState = {
    ...withoutLegacyMessageCounters(currentState),
    snapshot: {
      ...snapshot,
      tabId: tab && tab.id,
      source
    },
    status: hasVisibleUsage ? "usage-current" : "page-snapshot",
    dataCollectedAt: hasVisibleUsage ? collectedAt : currentState.dataCollectedAt,
    lastRefreshAt: hasVisibleUsage ? collectedAt : currentState.lastRefreshAt,
    ...(acceptedCapacitySnapshot
      ? { confirmedCapacitySnapshot: acceptedCapacitySnapshot }
      : {})
  };
  await chrome.storage.local.set({ [provider.stateKey]: nextState });
  assertCurrentAnalyticsRefresh(
    Number.isInteger(expectedAnalyticsRefreshGeneration)
      ? { generation: expectedAnalyticsRefreshGeneration }
      : null
  );
  if (hasVisibleUsage && (source === "requested-stable" || source === "requested-best-effort")) {
    await processCapacitySnapshot(
      capacitySnapshot,
      expectedCapacityGeneration,
      expectedAnalyticsRefreshGeneration,
      provider
    ).catch(() => {});
  }
  return { ok: true, state: nextState, pageLoginStatus: snapshot && snapshot.loginStatus };
}

async function saveContentSnapshot(snapshot, tab, provider = chatgptProvider) {
  if (snapshot && snapshot.loginStatus === "logged-out") {
    await clearCapacityMonitorState(provider);
  }
  if (snapshot && provider.isUsagePageSnapshot(snapshot) && !provider.hasParsedUsageLimit(snapshot)) {
    return { ok: true, ignored: true, reason: "Codex Analytics usage not visible yet." };
  }
  if (snapshot && !provider.isUsagePageSnapshot(snapshot)) {
    const existing = await chrome.storage.local.get([provider.stateKey]);
    const currentSnapshot = existing[provider.stateKey] && existing[provider.stateKey].snapshot;
    if (provider.hasVisibleUsage(currentSnapshot)) {
      return { ok: true, ignored: true, reason: "Preserved the last valid Codex Analytics snapshot." };
    }
  }
  const result = await saveSnapshot(snapshot, tab, "content-script", capacityGeneration, snapshot, null, provider);
  if (tab && tab.active && snapshot && snapshot.loginStatus !== "logged-out") {
    await applyObservedCapacityVisual(snapshot);
  }
  return result;
}

async function getPopupState() {
  const data = await chrome.storage.local.get([storageKeys.state]);
  const nextState = withoutLegacyMessageCounters(data[storageKeys.state] || {});
  if (!isSignedOutUsageState(nextState)) {
    await applyObservedCapacityVisual(nextState.snapshot);
  }
  refreshIfStale("popup-open", nextState).catch(() => {});
  return {
    ok: true,
    state: nextState,
    paceSessionId: await getPaceSessionId(),
    paceTrackerVersion: CodexCapacityMonitor.PACE_TRACKER_VERSION
  };
}

function withoutLegacyMessageCounters(state) {
  const { counters: _legacyCounters, ...usageState } = state;
  return usageState;
}

async function refreshForPopup() {
  return refreshOnce("popup");
}

async function refreshOnStartup(now = Date.now()) {
  await ensureRefreshAlarm();
  await initializeCapacityUi();
  return refreshIfStale("startup", null, now);
}

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

function shouldRefreshUsage(
  state,
  now = Date.now(),
  refreshPeriodMinutes = defaultRefreshPeriodMinutes
) {
  const collectedAt = Date.parse(state && (state.dataCollectedAt || state.lastRefreshAt));
  const maxAgeMs = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(refreshPeriodMinutes) * 60 * 1000;
  return !Number.isFinite(collectedAt)
    || !Number.isFinite(now)
    || now < collectedAt
    || now - collectedAt >= maxAgeMs;
}

function isOtherProviderRefreshInFlight(provider) {
  return Boolean(analyticsRefreshPromise && analyticsRefreshContext
    && (analyticsRefreshContext.providerId || chatgptProvider.id) !== provider.id);
}

function notifyRefreshLockReleased() {
  const waiters = refreshLockWaiters;
  refreshLockWaiters = [];
  for (const wake of waiters) wake();
}

async function waitForOtherProviderRefresh(provider) {
  while (isOtherProviderRefreshInFlight(provider)) {
    await Promise.race([
      analyticsRefreshPromise.catch(() => {}),
      new Promise((resolve) => refreshLockWaiters.push(resolve))
    ]);
  }
}

function refreshWithTimeout(reason, provider = chatgptProvider) {
  if (isOtherProviderRefreshInFlight(provider)) {
    return waitForOtherProviderRefresh(provider).then(() => refreshWithTimeout(reason, provider));
  }
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

async function refreshOnce(reason, boundRetry = false, provider = chatgptProvider) {
  if (isOtherProviderRefreshInFlight(provider)) {
    // Refreshes are single-flight. Never join another provider's read; run after it.
    return waitForOtherProviderRefresh(provider).then(() => (
      boundRetry ? refreshWithTimeout(reason, provider) : refreshOnce(reason, false, provider)
    ));
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
          notifyRefreshLockReleased();
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

async function refreshFromAnalyticsPage(reason, refreshContext = {
  popupRequested: reason === "popup",
  generation: analyticsRefreshGeneration
}, provider = chatgptProvider) {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0] || null;
  const activeAnalyticsTab = activeTab && provider.isUsageUrl(activeTab.url)
    ? activeTab
    : null;
  let analyticsTab = null;
  let temporaryTab = false;
  let keepTemporaryTab = false;
  let failureStage = "create-temporary";
  let trackedTemporaryTabId = null;
  let temporaryTabWasActivated = false;
  const trackTemporaryTabActivation = (activeInfo) => {
    if (activeInfo && activeInfo.tabId === trackedTemporaryTabId) {
      temporaryTabWasActivated = true;
    }
  };
  if (chrome.tabs.onActivated && chrome.tabs.onActivated.addListener) {
    chrome.tabs.onActivated.addListener(trackTemporaryTabActivation);
  }

  try {
    if (activeAnalyticsTab) {
      // A long-lived Analytics page can keep rendering the values fetched when
      // it opened. Treat an active page as user-owned, leave it untouched, and
      // collect from an extension-owned background page below.
      await forgetRetainedSignInTab(activeAnalyticsTab.id, provider);
    }
    if (!analyticsTab) {
      analyticsTab = await getRetainedSignInTab(provider);
      if (analyticsTab) {
        temporaryTab = true;
        trackedTemporaryTabId = analyticsTab.id;
        failureStage = "read-temporary";
        if (!provider.isUsageUrl(analyticsTab.url)) {
          analyticsTab = await chrome.tabs.update(analyticsTab.id, {
            url: provider.usageUrl,
            active: false
          });
        }
      }
    }

    await markRefreshStarted(reason, refreshContext, provider);
    if (!analyticsTab) {
      analyticsTab = await createBackgroundAnalyticsTab(provider);
      temporaryTab = true;
      trackedTemporaryTabId = analyticsTab.id;
      failureStage = "read-temporary";
    }

    let result = await readAnalyticsTab(analyticsTab.id, refreshContext, provider);

    assertCurrentAnalyticsRefresh(refreshContext);

    if (result.pageLoginStatus === "logged-in") {
      await removeRetainedSignInTabIfOwned(analyticsTab.id, provider);
    }

    const temporaryTabRequiresSignIn = temporaryTab && result.pageLoginStatus === "logged-out";
    keepTemporaryTab = temporaryTabRequiresSignIn;
    refreshContext.acceptingPopupJoin = false;
    if (keepTemporaryTab) {
      if (temporaryTabWasActivated) {
        await forgetRetainedSignInTab(analyticsTab.id, provider);
      } else {
        const retainedTabId = await retainOnlySignInTab(analyticsTab.id, provider);
        keepTemporaryTab = retainedTabId === analyticsTab.id && !temporaryTabWasActivated;
      }
    }
    assertCurrentAnalyticsRefresh(refreshContext);
    return { ...result, state: { ...result.state, reason } };
  } catch (error) {
    if (isStaleAnalyticsRefreshError(error)) {
      return { ok: false, ignored: true, reason: error.message };
    }
    const data = await chrome.storage.local.get([provider.stateKey]);
    assertCurrentAnalyticsRefresh(refreshContext);
    const tabCreationFailed = failureStage === "create-temporary";
    const state = {
      ...withoutLegacyMessageCounters(data[provider.stateKey] || {}),
      status: tabCreationFailed ? "codex-analytics-load-failed" : "content-script-unavailable",
      lastRefreshAttemptAt: new Date().toISOString(),
      diagnostic: tabCreationFailed
        ? provider.messages.loadFailed
        : provider.messages.readerUnresponsive
    };
    await chrome.storage.local.set({ [provider.stateKey]: state });
    await expireCapacityMonitorState().catch(() => {});
    return { ok: false, state, error: String(error && error.message ? error.message : error) };
  } finally {
    try {
      if (temporaryTab && analyticsTab && !keepTemporaryTab) {
        await forgetRetainedSignInTab(analyticsTab.id, provider);
        const currentTab = await chrome.tabs.get(analyticsTab.id).catch(() => null);
        const extensionStillOwnsTab = currentTab
          && !temporaryTabWasActivated
          && !currentTab.active;
        if (extensionStillOwnsTab) {
          await chrome.tabs.remove(analyticsTab.id).catch(() => {});
        }
      }
    } finally {
      if (chrome.tabs.onActivated && chrome.tabs.onActivated.removeListener) {
        chrome.tabs.onActivated.removeListener(trackTemporaryTabActivation);
      }
    }
  }
}

function isCurrentAnalyticsRefresh(refreshContext) {
  return !refreshContext
    || isCurrentAnalyticsRefreshGeneration(refreshContext.generation);
}

function isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration) {
  return !Number.isInteger(expectedAnalyticsRefreshGeneration)
    || expectedAnalyticsRefreshGeneration === analyticsRefreshGeneration;
}

function assertCurrentAnalyticsRefresh(refreshContext) {
  if (isCurrentAnalyticsRefresh(refreshContext)) return;
  const error = new Error("Analytics refresh expired before it could persist results.");
  error.code = "STALE_ANALYTICS_REFRESH";
  throw error;
}

function isStaleAnalyticsRefreshError(error) {
  return Boolean(error && error.code === "STALE_ANALYTICS_REFRESH");
}

function serializeRetainedSignInTabUpdate(operation) {
  const result = retainedSignInTabUpdate.then(operation, operation);
  retainedSignInTabUpdate = result.catch(() => {});
  return result;
}

function getRetainedSignInTab(provider = chatgptProvider) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = provider.retainedSignInTabKey;
    const stored = await chrome.storage.session.get([retainedKey]);
    const retainedTabId = stored[retainedKey];
    if (!Number.isInteger(retainedTabId)) return null;

    if (adoptedAnalyticsTabIds.has(retainedTabId)) {
      await chrome.storage.session.set({ [retainedKey]: null });
      return null;
    }

    try {
      const tab = await chrome.tabs.get(retainedTabId);
      if (
        tab
        && !tab.active
        && !adoptedAnalyticsTabIds.has(retainedTabId)
      ) {
        return tab;
      }
    } catch {
      // The retained tab was closed by the user.
    }
    await chrome.storage.session.set({ [retainedKey]: null });
    return null;
  });
}

function retainOnlySignInTab(tabId, provider = chatgptProvider) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = provider.retainedSignInTabKey;
    if (adoptedAnalyticsTabIds.has(tabId)) return null;

    const stored = await chrome.storage.session.get([retainedKey]);
    const previousTabId = stored[retainedKey];
    if (Number.isInteger(previousTabId) && previousTabId !== tabId) {
      try {
        const previousTab = await chrome.tabs.get(previousTabId);
        if (
          previousTab
          && !previousTab.active
          && !adoptedAnalyticsTabIds.has(previousTabId)
        ) {
          return previousTabId;
        }
      } catch {
        // The previous retained tab was already closed.
      }
    }

    if (adoptedAnalyticsTabIds.has(tabId)) return null;
    await chrome.storage.session.set({ [retainedKey]: tabId });
    return tabId;
  });
}

function forgetRetainedSignInTab(tabId, provider = chatgptProvider) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = provider.retainedSignInTabKey;
    const stored = await chrome.storage.session.get([retainedKey]);
    if (stored[retainedKey] !== tabId) return;
    await chrome.storage.session.set({ [retainedKey]: null });
  });
}

function removeRetainedSignInTabIfOwned(exceptTabId, provider = chatgptProvider) {
  return serializeRetainedSignInTabUpdate(async () => {
    const retainedKey = provider.retainedSignInTabKey;
    const stored = await chrome.storage.session.get([retainedKey]);
    const retainedTabId = stored[retainedKey];
    if (!Number.isInteger(retainedTabId) || retainedTabId === exceptTabId) return;

    await chrome.storage.session.set({ [retainedKey]: null });
    if (adoptedAnalyticsTabIds.has(retainedTabId)) return;

    const retainedTab = await chrome.tabs.get(retainedTabId).catch(() => null);
    const extensionStillOwnsTab = retainedTab
      && !retainedTab.active
      && !adoptedAnalyticsTabIds.has(retainedTabId);
    if (extensionStillOwnsTab) {
      await chrome.tabs.remove(retainedTabId).catch(() => {});
    }
  });
}

async function createBackgroundAnalyticsTab(provider = chatgptProvider) {
  const activeTabsBeforeCreate = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  }).catch(() => []);
  const previouslyActiveTab = activeTabsBeforeCreate[0] || null;
  const createOptions = {
    url: provider.usageUrl,
    active: false
  };
  if (previouslyActiveTab && Number.isInteger(previouslyActiveTab.windowId)) {
    createOptions.windowId = previouslyActiveTab.windowId;
  }

  const temporaryTab = await chrome.tabs.create(createOptions);
  return temporaryTab;
}

async function readAnalyticsTab(tabId, refreshContext, provider = chatgptProvider) {
  await waitForTabReadyOrDelay(tabId, provider);
  assertCurrentAnalyticsRefresh(refreshContext);
  return requestSnapshotWithRetry(tabId, refreshContext, provider);
}

async function markRefreshStarted(reason, refreshContext, provider = chatgptProvider) {
  const data = await chrome.storage.local.get([provider.stateKey]);
  assertCurrentAnalyticsRefresh(refreshContext);
  const state = {
    ...withoutLegacyMessageCounters(data[provider.stateKey] || {}),
    status: "refreshing-codex-analytics",
    lastRefreshAttemptAt: new Date().toISOString(),
    reason
  };
  await chrome.storage.local.set({ [provider.stateKey]: state });
}

async function requestSnapshotWithRetry(tabId, refreshContext, provider = chatgptProvider) {
  await capacityInitializationPromise;
  assertCurrentAnalyticsRefresh(refreshContext);
  let expectedCapacityGeneration = capacityGeneration;
  let observedLogout = false;
  let lastError = null;
  let lastSnapshot = null;
  let accumulatedSnapshot = null;
  let lastUsageSignature = null;
  let stableUsageReads = 0;
  let firstVisibleAttempt = null;
  const stableCapacityCounters = new Map();

  for (let attempt = 0; attempt < ANALYTICS_READ_ATTEMPTS; attempt += 1) {
    try {
      await delay(ANALYTICS_READ_INTERVAL_MS);
      assertCurrentAnalyticsRefresh(refreshContext);
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: "usage:collectSnapshot" });
      assertCurrentAnalyticsRefresh(refreshContext);
      if (snapshot && snapshot.status === "ok") {
        lastSnapshot = snapshot;
        if (snapshot.loginStatus === "logged-out") {
          if (!observedLogout) {
            observedLogout = true;
            await clearCapacityMonitorState(provider);
            expectedCapacityGeneration = capacityGeneration;
          }
          accumulatedSnapshot = null;
          lastUsageSignature = null;
          stableUsageReads = 0;
          firstVisibleAttempt = null;
          stableCapacityCounters.clear();
          continue;
        }
        updateStableCapacityCounters(snapshot, stableCapacityCounters);
        if (provider.isUsagePageSnapshot(snapshot) && provider.hasVisibleUsage(snapshot)) {
          accumulatedSnapshot = mergeUsageSnapshot(accumulatedSnapshot, snapshot, provider);
          const signature = JSON.stringify(accumulatedSnapshot.usage || {});
          stableUsageReads = signature === lastUsageSignature ? stableUsageReads + 1 : 1;
          lastUsageSignature = signature;
          if (firstVisibleAttempt === null) firstVisibleAttempt = attempt;

          const readsSinceFirstData = attempt - firstVisibleAttempt + 1;
          if (provider.hasParsedUsageLimit(accumulatedSnapshot)
            && stableUsageReads >= ANALYTICS_STABLE_READS_REQUIRED
            && readsSinceFirstData >= ANALYTICS_MIN_READS_AFTER_FIRST_DATA) {
            return saveSnapshot(
              accumulatedSnapshot,
              { id: tabId },
              "requested-stable",
              expectedCapacityGeneration,
              buildStableCapacitySnapshot(accumulatedSnapshot, stableCapacityCounters),
              refreshContext && refreshContext.generation,
              provider
            );
          }
        }
      }
    } catch (error) {
      if (isStaleAnalyticsRefreshError(error)) throw error;
      lastError = error;
    }
  }
  if (accumulatedSnapshot) {
    return saveSnapshot(
      accumulatedSnapshot,
      { id: tabId },
      "requested-best-effort",
      expectedCapacityGeneration,
      buildStableCapacitySnapshot(accumulatedSnapshot, stableCapacityCounters),
      refreshContext && refreshContext.generation,
      provider
    );
  }
  if (lastSnapshot) {
    return saveIncompleteRefresh(
      lastSnapshot,
      tabId,
      "requested-no-new-usage",
      refreshContext && refreshContext.generation,
      provider
    );
  }
  throw lastError || new Error(provider.messages.contentScriptMissing);
}

function mergeUsageSnapshot(accumulated, incoming, provider = chatgptProvider) {
  const usage = provider.mergeUsageFields(
    accumulated && accumulated.usage,
    incoming && incoming.usage
  );
  return {
    ...(accumulated || {}),
    ...incoming,
    usage,
    domUsageVisible: Object.values(usage).some((field) => field && field.value)
  };
}

function updateStableCapacityCounters(snapshot, observations) {
  const available = new Map(CodexCapacityMonitor.extractAvailableCounters(snapshot)
    .map((counter) => [counter.key, counter]));
  for (const definition of CodexCapacityMonitor.COUNTERS) {
    const counter = available.get(definition.key);
    if (!counter) {
      observations.delete(definition.key);
      continue;
    }
    const signature = JSON.stringify([counter.remainingPercent, counter.resetText]);
    const previous = observations.get(definition.key);
    observations.set(definition.key, {
      count: previous && previous.signature === signature ? previous.count + 1 : 1,
      field: snapshot.usage[definition.key],
      signature
    });
  }
}

function buildStableCapacitySnapshot(snapshot, observations) {
  const usage = Object.fromEntries([...observations.entries()]
    .filter(([, observation]) => observation.count >= ANALYTICS_STABLE_READS_REQUIRED)
    .map(([key, observation]) => [key, observation.field]));
  return {
    ...snapshot,
    usage,
    domUsageVisible: Object.values(usage).some((field) => field && field.value)
  };
}

async function saveIncompleteRefresh(
  pageSnapshot,
  tabId,
  source = "requested-no-new-usage",
  expectedAnalyticsRefreshGeneration = null,
  provider = chatgptProvider
) {
  const data = await chrome.storage.local.get([provider.stateKey]);
  assertCurrentAnalyticsRefresh(
    Number.isInteger(expectedAnalyticsRefreshGeneration)
      ? { generation: expectedAnalyticsRefreshGeneration }
      : null
  );
  const existingState = data[provider.stateKey] || {};
  const existingSnapshot = existingState.snapshot;
  const state = {
    ...withoutLegacyMessageCounters(existingState),
    snapshot: provider.hasParsedUsageLimit(existingSnapshot)
      ? existingSnapshot
      : { ...pageSnapshot, tabId, source },
    status: pageSnapshot.loginStatus === "logged-out" ? "sign-in-required" : "analytics-no-new-data",
    lastRefreshAttemptAt: new Date().toISOString(),
    diagnostic: provider.isUsagePageSnapshot(pageSnapshot)
      ? provider.messages.noNewData
      : provider.messages.routeNotDetected
  };
  await chrome.storage.local.set({ [provider.stateKey]: state });
  if (pageSnapshot.loginStatus === "logged-out") {
    await clearCapacityMonitorState(provider);
  } else {
    await expireCapacityMonitorState();
  }
  return { ok: true, fresh: false, state, pageLoginStatus: pageSnapshot.loginStatus };
}

function initializeCapacityUi() {
  const expectedCapacityGeneration = capacityGeneration;
  const result = capacityUpdate.then(
    () => initializeCapacityUiSerialized(expectedCapacityGeneration),
    () => initializeCapacityUiSerialized(expectedCapacityGeneration)
  );
  capacityInitializationPromise = result.catch(() => {});
  capacityUpdate = capacityInitializationPromise;
  return result;
}

async function initializeCapacityUiSerialized(expectedCapacityGeneration) {
  const data = await chrome.storage.local.get([
    storageKeys.state,
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed during initialization." };
  }
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed while initializing settings." };
  }
  const usageState = data[storageKeys.state];
  const confirmedCapacitySnapshot = usageState && usageState.confirmedCapacitySnapshot;
  const rawMonitorState = data[storageKeys.capacityState];
  let available;
  if (isSignedOutUsageState(usageState)) {
    markCapacitySuppressed();
    await clearCapacityMonitorStateSerialized();
    return { suppressed: true };
  } else if (rawMonitorState === undefined || rawMonitorState === null) {
    const baseline = isFreshCapacitySnapshot(confirmedCapacitySnapshot)
      ? CodexCapacityMonitor.evaluateSnapshot(
          confirmedCapacitySnapshot,
          null,
          settings,
          confirmedCapacitySnapshot.collectedAt
        )
      : CodexCapacityMonitor.evaluateSnapshot(null, null, settings);
    await chrome.storage.local.set({ [storageKeys.capacityState]: baseline.state });
    available = CodexCapacityMonitor.extractFreshStateCounters(baseline.state);
  } else if (rawMonitorState.suppressed) {
    capacitySuppressed = true;
    available = [];
  } else {
    capacitySuppressed = false;
    available = CodexCapacityMonitor.extractFreshStateCounters(rawMonitorState);
  }
  if (rawMonitorState && !rawMonitorState.suppressed) {
    await clearExpiredExhaustedNotifications(rawMonitorState);
  }
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState(available, settings));
}

function isFreshCapacitySnapshot(snapshot, now = Date.now()) {
  const collectedAt = Date.parse(snapshot && snapshot.collectedAt);
  return Number.isFinite(collectedAt)
    && Number.isFinite(now)
    && now >= collectedAt
    && now - collectedAt <= CodexCapacityMonitor.COUNTER_STALE_AFTER_MS;
}

function processCapacitySnapshot(
  snapshot,
  expectedCapacityGeneration = capacityGeneration,
  expectedAnalyticsRefreshGeneration = null,
  provider = chatgptProvider
) {
  const result = capacityUpdate.then(
    () => processCapacitySnapshotSerialized(
      snapshot,
      expectedCapacityGeneration,
      expectedAnalyticsRefreshGeneration,
      provider
    ),
    () => processCapacitySnapshotSerialized(
      snapshot,
      expectedCapacityGeneration,
      expectedAnalyticsRefreshGeneration,
      provider
    )
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

function applyObservedCapacityVisual(snapshot) {
  const result = capacityUpdate.then(
    () => applyObservedCapacityVisualSerialized(snapshot),
    () => applyObservedCapacityVisualSerialized(snapshot)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function applyObservedCapacityVisualSerialized(snapshot) {
  if (!snapshot || !snapshot.codexAnalytics || snapshot.loginStatus === "logged-out") {
    return { ignored: true, reason: "No signed-in Analytics snapshot is available." };
  }
  const available = CodexCapacityMonitor.extractAvailableCounters(snapshot);
  if (!available.length) {
    return { ignored: true, reason: "No visible capacity counters are available." };
  }
  const data = await chrome.storage.local.get([storageKeys.capacitySettings]);
  const visual = CodexCapacityMonitor.deriveVisualState(
    available,
    data[storageKeys.capacitySettings]
  );
  await applyCapacityVisual(visual);
  return { visual };
}

function getPaceSessionId() {
  if (!paceSessionPromise) {
    paceSessionPromise = (async () => {
      const key = storageKeys.paceSessionId;
      const session = await chrome.storage.session.get([key]);
      if (session[key]) return session[key];
      const id = `${Date.now()}-${Math.random()}`;
      await chrome.storage.session.set({ [key]: id });
      return id;
    })().catch((error) => {
      paceSessionPromise = null;
      throw error;
    });
  }
  return paceSessionPromise;
}

async function processCapacitySnapshotSerialized(
  snapshot,
  expectedCapacityGeneration,
  expectedAnalyticsRefreshGeneration,
  provider = chatgptProvider
) {
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed before processing." };
  }
  if (!isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration)) {
    return { ignored: true, reason: "Analytics refresh expired before capacity processing." };
  }
  const paceSessionId = await getPaceSessionId();
  const data = await chrome.storage.local.get([
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  if (expectedCapacityGeneration !== capacityGeneration) {
    return { ignored: true, reason: "Capacity session changed during processing." };
  }
  if (!isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration)) {
    return { ignored: true, reason: "Analytics refresh expired during capacity processing." };
  }
  const evaluation = CodexCapacityMonitor.evaluateSnapshot(
    snapshot,
    data[storageKeys.capacityState],
    data[storageKeys.capacitySettings],
    new Date().toISOString(),
    paceSessionId,
    { providerId: provider.id }
  );
  const storageUpdate = { [storageKeys.capacityState]: evaluation.state };
  await chrome.storage.local.set(storageUpdate);
  if (expectedCapacityGeneration === capacityGeneration) {
    capacitySuppressed = false;
  }
  await applyCapacityVisual(evaluation.visual);
  await clearRecoveredOrExpiredExhaustedNotifications(
    data[storageKeys.capacityState],
    evaluation
  );

  for (const event of evaluation.events) {
    if (expectedCapacityGeneration !== capacityGeneration) break;
    if (!isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration)) break;
    if (CodexCapacityMonitor.shouldNotify(event, evaluation.settings)) {
      await showCapacityNotification(event).catch(() => {});
    }
  }
  if (expectedCapacityGeneration === capacityGeneration
    && isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration)
    && evaluation.events.some((event) => CodexCapacityMonitor.shouldPlaySound(event, evaluation.settings))) {
    await playCapacitySound(
      expectedCapacityGeneration,
      expectedAnalyticsRefreshGeneration
    ).catch(() => {});
  }
  return evaluation;
}

async function applyCapacityVisualFromStoredSnapshot(rawSettings) {
  const data = await chrome.storage.local.get([storageKeys.capacityState]);
  const monitorState = data[storageKeys.capacityState];
  const available = monitorState && !monitorState.suppressed
    ? CodexCapacityMonitor.extractFreshStateCounters(monitorState)
    : [];
  const visual = CodexCapacityMonitor.deriveVisualState(available, rawSettings);
  await applyCapacityVisual(visual);
}

function handleCapacitySettingsChanged(rawSettings) {
  const result = capacityUpdate.then(
    () => handleCapacitySettingsChangedSerialized(rawSettings),
    () => handleCapacitySettingsChangedSerialized(rawSettings)
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function handleCapacitySettingsChangedSerialized(rawSettings) {
  const settings = CodexCapacityMonitor.normalizeSettings(rawSettings);
  if (!settings.enableNotifications) {
    await clearAllCapacityNotifications();
  }
  await applyCapacityVisualFromStoredSnapshot(settings);
}

function isSignedOutUsageState(state) {
  return Boolean(state && (
    state.status === "sign-in-required"
    || state.status === "sign-in-required-manual-refresh"
    || (state.snapshot && state.snapshot.loginStatus === "logged-out")
  ));
}

function createSuppressedCapacityState() {
  return {
    version: 2,
    counters: {},
    availableKeys: [],
    updatedAt: new Date().toISOString(),
    suppressed: true
  };
}

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

function expireCapacityMonitorState() {
  const result = capacityUpdate.then(
    () => expireCapacityMonitorStateSerialized(),
    () => expireCapacityMonitorStateSerialized()
  );
  capacityUpdate = result.catch(() => {});
  return result;
}

async function expireCapacityMonitorStateSerialized() {
  if (capacitySuppressed) return { suppressed: true };
  const data = await chrome.storage.local.get([
    storageKeys.capacitySettings,
    storageKeys.capacityState
  ]);
  const previous = CodexCapacityMonitor.normalizeMonitorState(data[storageKeys.capacityState]);
  const counters = Object.fromEntries(Object.entries(previous.counters)
    .filter(([, observation]) => isFreshCapacityObservation(observation)));
  const state = {
    version: 2,
    counters,
    availableKeys: previous.availableKeys.filter((key) => counters[key]),
    pace: previous.pace,
    paceSessionId: previous.paceSessionId,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [storageKeys.capacityState]: state });
  await clearExpiredExhaustedNotifications(previous);
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  const available = CodexCapacityMonitor.extractFreshStateCounters(state);
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState(available, settings));
  return state;
}

function markCapacitySuppressed() {
  if (capacitySuppressed) return false;
  capacitySuppressed = true;
  capacityGeneration += 1;
  return true;
}

async function clearCapacityMonitorStateSerialized() {
  const data = await chrome.storage.local.get([storageKeys.capacitySettings]);
  const settings = CodexCapacityMonitor.normalizeSettings(data[storageKeys.capacitySettings]);
  await chrome.storage.local.set({
    [storageKeys.capacityState]: createSuppressedCapacityState()
  });
  await applyCapacityVisual(CodexCapacityMonitor.deriveVisualState([], settings));
  await clearAllCapacityNotifications();
}

async function clearRecoveredOrExpiredExhaustedNotifications(previousState, evaluation) {
  const previous = CodexCapacityMonitor.normalizeMonitorState(previousState);
  const next = CodexCapacityMonitor.normalizeMonitorState(evaluation && evaluation.state);
  const recoveredKeys = (evaluation && evaluation.available ? evaluation.available : [])
    .filter((counter) => counter.remainingPercent > 0)
    .map((counter) => counter.key);
  const expiredKeys = CodexCapacityMonitor.COUNTERS
    .map((counter) => counter.key)
    .filter((key) => (
      previous.counters[key]
      && previous.counters[key].remainingPercent === 0
      && !next.counters[key]
    ));
  await Promise.all([...new Set([...recoveredKeys, ...expiredKeys])]
    .map((key) => clearCapacityNotification(key, "exhausted")));
}

async function clearExpiredExhaustedNotifications(previousState) {
  const previous = CodexCapacityMonitor.normalizeMonitorState(previousState);
  await Promise.all(CodexCapacityMonitor.COUNTERS
    .map((counter) => counter.key)
    .filter((key) => (
      previous.counters[key]
      && previous.counters[key].remainingPercent === 0
      && !isFreshCapacityObservation(previous.counters[key])
    ))
    .map((key) => clearCapacityNotification(key, "exhausted")));
}

function isFreshCapacityObservation(observation, now = Date.now()) {
  const lastSeenAt = Date.parse(observation && observation.lastSeenAt);
  return Number.isFinite(lastSeenAt)
    && Number.isFinite(now)
    && now >= lastSeenAt
    && now - lastSeenAt <= CodexCapacityMonitor.COUNTER_STALE_AFTER_MS;
}

function clearCapacityNotification(counterKey, type) {
  if (!chrome.notifications || !chrome.notifications.clear) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    try {
      const result = chrome.notifications.clear(
        `codex-capacity-${counterKey}-${type}`,
        finish
      );
      if (result && typeof result.then === "function") {
        result.then(finish, () => finish(false));
      } else if (result !== undefined) {
        finish(result);
      }
    } catch (_) {
      finish(false);
    }
  });
}

async function clearAllCapacityNotifications(provider) {
  const keys = UsageProviders.allCounters()
    .filter((counter) => !provider || counter.providerId === provider.id)
    .map((counter) => counter.key);
  await Promise.all(keys.flatMap((key) => (
    CAPACITY_NOTIFICATION_TYPES.map((type) => clearCapacityNotification(key, type))
  )));
}

async function applyCapacityVisual(visual) {
  if (!chrome.action) return;
  let usesCustomIcon = false;
  if (visual.badgeText && chrome.action.setIcon) {
    const imageData = await buildCapacityActionIcon(
      visual.badgeText,
      visual.badgeColor,
      visual.badgeTextColor
    ).catch(() => null);
    if (imageData) {
      try {
        await chrome.action.setIcon({ imageData });
        usesCustomIcon = true;
      } catch (_) {
        usesCustomIcon = false;
      }
    }
  }
  if (!usesCustomIcon && chrome.action.setIcon) {
    await chrome.action.setIcon({ path: ACTION_ICON_PATHS }).catch(() => {});
  }

  const updates = [];
  if (chrome.action.setBadgeText) {
    updates.push(chrome.action.setBadgeText({ text: usesCustomIcon ? "" : visual.badgeText }));
  }
  if (chrome.action.setBadgeBackgroundColor) {
    updates.push(chrome.action.setBadgeBackgroundColor({ color: visual.badgeColor }));
  }
  if (!usesCustomIcon && chrome.action.setBadgeTextColor) {
    updates.push(chrome.action.setBadgeTextColor({ color: visual.badgeTextColor }));
  }
  if (chrome.action.setTitle) {
    updates.push(chrome.action.setTitle({ title: visual.title }));
  }
  await Promise.all(updates);
}

async function buildCapacityActionIcon(text, color, textColor) {
  if (
    typeof OffscreenCanvas !== "function"
    || typeof createImageBitmap !== "function"
    || typeof fetch !== "function"
  ) {
    return null;
  }

  const entries = await Promise.all(Object.entries(ACTION_ICON_PATHS).map(async ([sizeKey, path]) => {
    const size = Number(sizeKey);
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable.");
    context.drawImage(await loadActionIconBitmap(size, path), 0, 0, size, size);
    drawCapacityBadge(context, size, text, color, textColor);
    return [sizeKey, context.getImageData(0, 0, size, size)];
  }));
  return Object.fromEntries(entries);
}

function loadActionIconBitmap(size, path) {
  if (!actionIconBitmapPromises.has(size)) {
    actionIconBitmapPromises.set(size, (async () => {
      const response = await fetch(chrome.runtime.getURL(path));
      if (!response.ok) throw new Error(`Could not load action icon ${size}.`);
      return createImageBitmap(await response.blob());
    })());
  }
  return actionIconBitmapPromises.get(size);
}

function drawCapacityBadge(context, size, rawText, color, textColor) {
  const text = String(rawText).slice(0, 3);
  const badgeHeight = Math.round(size * 0.68);
  const badgeTop = size - badgeHeight;
  const radius = Math.max(2, Math.round(size * 0.16));
  const fontScale = text.length >= 3 ? 0.43 : text.length === 2 ? 0.54 : 0.6;

  context.save();
  context.beginPath();
  roundedRectangle(context, 0, badgeTop, size, badgeHeight, radius);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = "rgba(0, 0, 0, 0.42)";
  context.lineWidth = Math.max(1, Math.round(size / 32));
  context.stroke();
  context.fillStyle = textColor;
  context.font = `500 ${Math.max(7, Math.round(size * fontScale))}px "Segoe UI", Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size / 2, badgeTop + badgeHeight / 2, size * 0.88);
  context.restore();
}

function roundedRectangle(context, x, y, width, height, radius) {
  const right = x + width;
  const bottom = y + height;
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

async function showCapacityNotification(event) {
  if (!chrome.notifications || !chrome.notifications.create) return;
  const copy = CodexCapacityMonitor.buildNotification(event);
  await chrome.notifications.create(`codex-capacity-${event.key}-${event.type}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: copy.title,
    message: copy.message,
    priority: event.type === "exhausted" ? 2 : 1,
    requireInteraction: event.type === "exhausted",
    silent: true
  });
}

async function playCapacitySound(
  expectedCapacityGeneration,
  expectedAnalyticsRefreshGeneration = null
) {
  const ready = await ensureOffscreenDocument();
  if (!ready
    || expectedCapacityGeneration !== capacityGeneration
    || !isCurrentAnalyticsRefreshGeneration(expectedAnalyticsRefreshGeneration)) return;
  await chrome.runtime.sendMessage({ type: "capacity:playSound" });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    if (contexts.length) return true;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a user-enabled sound once for a newly crossed capacity alert."
    });
  } catch (error) {
    if (!/single offscreen document|already exists/i.test(String(error && error.message ? error.message : error))) {
      throw error;
    }
  }
  return true;
}

async function waitForTabReadyOrDelay(tabId, provider = chatgptProvider) {
  try {
    await waitForTabComplete(tabId, provider);
  } catch {
    await delay(1000);
  }
}

async function ensureRefreshAlarm() {
  const data = await chrome.storage.local.get([storageKeys.refreshPeriodMinutes]);
  const refreshPeriodMinutes = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(
    data[storageKeys.refreshPeriodMinutes]
  );
  const existing = await chrome.alarms.get(refreshAlarmName);
  if (existing && (
    !Number.isFinite(existing.periodInMinutes)
    || existing.periodInMinutes === refreshPeriodMinutes
  )) return;
  await chrome.alarms.create(refreshAlarmName, {
    delayInMinutes: 1,
    periodInMinutes: refreshPeriodMinutes
  });
}

async function handleRefreshPeriodChanged(value) {
  const refreshPeriodMinutes = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(value);
  await chrome.alarms.create(refreshAlarmName, {
    delayInMinutes: refreshPeriodMinutes,
    periodInMinutes: refreshPeriodMinutes
  });
}

function waitForTabComplete(tabId, provider = chatgptProvider) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(provider.messages.loadTimeout));
    }, ANALYTICS_LOAD_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch((error) => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(
  promise,
  ms,
  message,
  expectedRefreshGeneration = null,
  provider = chatgptProvider
) {
  let timeoutId = null;
  let timedOut = false;
  let invalidatedRefreshGeneration = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(message));
        }, ms);
      })
    ]);
  } catch (error) {
    if (timedOut) {
      if (Number.isInteger(expectedRefreshGeneration)
        && expectedRefreshGeneration !== analyticsRefreshGeneration) {
        const latest = await chrome.storage.local.get([provider.stateKey]);
        return {
          ok: false,
          ignored: true,
          state: latest[provider.stateKey] || {},
          error: String(error && error.message ? error.message : error)
        };
      }
      analyticsRefreshGeneration += 1;
      invalidatedRefreshGeneration = analyticsRefreshGeneration;
      analyticsRefreshPromise = null;
      analyticsRefreshContext = null;
      notifyRefreshLockReleased();
      await expireCapacityMonitorState().catch(() => {});
    }
    const data = await chrome.storage.local.get([provider.stateKey]);
    if (invalidatedRefreshGeneration !== null
      && invalidatedRefreshGeneration !== analyticsRefreshGeneration) {
      return {
        ok: false,
        ignored: true,
        state: data[provider.stateKey] || {},
        error: String(error && error.message ? error.message : error)
      };
    }
    const state = {
      ...withoutLegacyMessageCounters(data[provider.stateKey] || {}),
      status: "refresh-timeout",
      lastRefreshAttemptAt: new Date().toISOString(),
      diagnostic: String(error && error.message ? error.message : error)
    };
    await chrome.storage.local.set({ [provider.stateKey]: state });
    return { ok: false, state, error: state.diagnostic };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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

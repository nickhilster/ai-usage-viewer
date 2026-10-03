(function initPopup() {
  "use strict";

  document.getElementById("extensionVersion").textContent = `v${chrome.runtime.getManifest().version}`;

  const refreshButton = document.getElementById("refreshButton");
  const reloadExtensionButton = document.getElementById("reloadExtensionButton");
  const paceReloadNotice = document.getElementById("paceReloadNotice");
  const openUsageButton = document.getElementById("openUsageButton");
  const copyDiagnosticsButton = document.getElementById("copyDiagnosticsButton");
  const statusTitle = document.getElementById("statusTitle");
  const statusDetail = document.getElementById("statusDetail");
  const statusAge = document.getElementById("statusAge");
  const warningBox = document.getElementById("warningBox");
  const settingsStatus = document.getElementById("settingsStatus");
  const refreshPeriodInput = document.getElementById("refreshPeriodMinutes");
  const refreshPeriodValue = document.getElementById("refreshPeriodValue");
  const providerSectionsRoot = document.getElementById("providerSections");
  const registeredProviders = UsageProviders.listProviders();
  const providerViews = new Map();
  const capacitySettingInputs = {
    enableNotifications: document.getElementById("enableNotifications"),
    notifyOnReset: document.getElementById("notifyOnReset"),
    showRemainingPercentage: document.getElementById("showRemainingPercentage"),
    lowThreshold: document.getElementById("lowThreshold"),
    criticalThreshold: document.getElementById("criticalThreshold"),
    enableSounds: document.getElementById("enableSounds")
  };
  let latestDiagnostics = null;
  let latestRefreshTimestamp = null;
  let latestSnapshot = null;
  let latestPace = null;
  let latestCapacitySessionId = null;
  let currentPaceSessionId = null;
  let requiresExtensionReload = false;
  const latestProviderStates = {};
  const latestProviderSnapshots = {};

  createProviderSections();

  refreshButton.addEventListener("click", () => refresh(true));
  reloadExtensionButton.addEventListener("click", () => chrome.runtime.reload());
  openUsageButton.addEventListener("click", openUsagePage);
  copyDiagnosticsButton.addEventListener("click", copyDiagnostics);
  for (const input of Object.values(capacitySettingInputs)) {
    input.addEventListener("change", () => {
      saveCapacitySettings().catch(() => {
        settingsStatus.textContent = "Could not save settings. Reload the extension and try again.";
      });
    });
  }
  refreshPeriodInput.addEventListener("input", previewRefreshPeriod);
  refreshPeriodInput.addEventListener("change", () => {
    saveRefreshPeriod().catch(() => {
      settingsStatus.textContent = "Could not save settings. Reload the extension and try again.";
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const stateChange = changes[ChatGPTUsageConfig.storageKeys.state];
    if (stateChange && stateChange.newValue) renderState(stateChange.newValue);
    for (const provider of registeredProviders) {
      if (provider.id === "chatgpt") continue;
      const change = changes[provider.stateKey];
      if (change) renderProviderState(provider, change.newValue || {});
    }
    const capacityChange = changes[ChatGPTUsageConfig.storageKeys.capacityState];
    if (capacityChange) {
      latestPace = capacityChange.newValue && capacityChange.newValue.pace;
      latestCapacitySessionId = capacityChange.newValue && capacityChange.newValue.paceSessionId;
      renderCodexCards(latestSnapshot);
    }
    const settingsChange = changes[ChatGPTUsageConfig.storageKeys.capacitySettings];
    if (settingsChange) applyCapacitySettings(settingsChange.newValue);
    const refreshPeriodChange = changes[ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes];
    if (refreshPeriodChange) applyRefreshPeriod(refreshPeriodChange.newValue);
  });
  initializePopup();
  setInterval(() => {
    updateRefreshAge();
    renderCodexCards(latestSnapshot);
    renderProviderSections();
  }, 30000);

  async function initializePopup() {
    renderLoading();
    await Promise.all([loadCapacitySettings(), loadRefreshPeriod(), loadCachedState()]);
  }

  async function loadCachedState() {
    const key = ChatGPTUsageConfig.storageKeys.capacityState;
    const stored = await chrome.storage.local.get([key]);
    latestPace = stored[key] && stored[key].pace;
    latestCapacitySessionId = stored[key] && stored[key].paceSessionId;
    const response = await chrome.runtime.sendMessage({ type: "usage:getState" });
    currentPaceSessionId = response && response.paceSessionId;
    requiresExtensionReload = Boolean(response && response.state && (!currentPaceSessionId
      || response.paceTrackerVersion !== CodexCapacityMonitor.PACE_TRACKER_VERSION));
    paceReloadNotice.hidden = !requiresExtensionReload;
    renderState(response && response.state);
    for (const provider of registeredProviders) {
      if (provider.id === "chatgpt") continue;
      renderProviderState(provider, response && response.providers && response.providers[provider.id]);
    }
  }

  async function loadCapacitySettings() {
    const key = ChatGPTUsageConfig.storageKeys.capacitySettings;
    const stored = await chrome.storage.local.get([key]);
    applyCapacitySettings(stored[key]);
  }

  async function loadRefreshPeriod() {
    const key = ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes;
    const stored = await chrome.storage.local.get([key]);
    applyRefreshPeriod(stored[key]);
  }

  function applyRefreshPeriod(value) {
    const refreshPeriodMinutes = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(value);
    refreshPeriodInput.value = String(refreshPeriodMinutes);
    refreshPeriodInput.setAttribute(
      "aria-valuetext",
      formatRefreshPeriod(refreshPeriodMinutes)
    );
    refreshPeriodValue.textContent = formatRefreshPeriod(refreshPeriodMinutes);
  }

  function previewRefreshPeriod() {
    applyRefreshPeriod(refreshPeriodInput.value);
  }

  function formatRefreshPeriod(minutes) {
    if (minutes === 1) return "1 minute";
    if (minutes === 60) return "1 hour";
    return `${minutes} minutes`;
  }

  async function saveRefreshPeriod() {
    const refreshPeriodMinutes = ChatGPTUsageModel.normalizeRefreshPeriodMinutes(
      refreshPeriodInput.value
    );
    applyRefreshPeriod(refreshPeriodMinutes);
    settingsStatus.textContent = "Saving locally...";
    await chrome.storage.local.set({
      [ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes]: refreshPeriodMinutes
    });
    settingsStatus.textContent = "";
  }

  function applyCapacitySettings(rawSettings) {
    const settings = CodexCapacityMonitor.normalizeSettings(rawSettings);
    capacitySettingInputs.enableNotifications.checked = settings.enableNotifications;
    capacitySettingInputs.notifyOnReset.checked = settings.notifyOnReset;
    capacitySettingInputs.showRemainingPercentage.checked = settings.showRemainingPercentage;
    capacitySettingInputs.lowThreshold.value = String(settings.lowThreshold);
    capacitySettingInputs.criticalThreshold.max = String(settings.lowThreshold);
    capacitySettingInputs.criticalThreshold.value = String(settings.criticalThreshold);
    capacitySettingInputs.enableSounds.checked = settings.enableSounds;
  }

  async function saveCapacitySettings() {
    const settings = CodexCapacityMonitor.normalizeSettings({
      enableNotifications: capacitySettingInputs.enableNotifications.checked,
      notifyOnReset: capacitySettingInputs.notifyOnReset.checked,
      showRemainingPercentage: capacitySettingInputs.showRemainingPercentage.checked,
      lowThreshold: capacitySettingInputs.lowThreshold.value,
      criticalThreshold: capacitySettingInputs.criticalThreshold.value,
      enableSounds: capacitySettingInputs.enableSounds.checked
    });
    applyCapacitySettings(settings);
    settingsStatus.textContent = "Saving locally...";
    await chrome.storage.local.set({
      [ChatGPTUsageConfig.storageKeys.capacitySettings]: settings
    });
    settingsStatus.textContent = "";
  }

  async function refresh(userRequested) {
    setBusy(true);
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({ type: "usage:refresh" }),
        47000,
        "Refresh timed out. Reload any open ChatGPT page and try again."
      );
      renderState(response && response.state);
      for (const provider of registeredProviders) {
        if (provider.id === "chatgpt") continue;
        renderProviderState(provider, response && response.providers && response.providers[provider.id]);
      }
      if ((!response || !response.ok) && !userRequested) statusDetail.textContent = "Using cached local data.";
    } catch (error) {
      statusTitle.textContent = "Usage unavailable";
      statusDetail.textContent = friendlyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function openUsagePage() {
    openUsageButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "usage:openCodexAnalytics" });
      statusTitle.textContent = "Analytics opened";
      statusDetail.textContent = "This visit is optional; Refresh can manage its own temporary tab.";
    } catch (error) {
      statusTitle.textContent = "Could not open Analytics";
      statusDetail.textContent = friendlyError(error);
    } finally {
      openUsageButton.disabled = false;
    }
  }

  function createProviderSections() {
    providerSectionsRoot.textContent = "";
    for (const provider of registeredProviders) {
      if (provider.id === "chatgpt") continue;
      const section = document.createElement("section");
      section.className = "provider-section";
      const heading = document.createElement("div");
      heading.className = "provider-heading";
      const title = document.createElement("h2");
      title.textContent = provider.name;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Open ${provider.name} usage`;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await chrome.runtime.sendMessage({ type: "usage:openUsage", providerId: provider.id });
        } finally {
          button.disabled = false;
        }
      });
      const content = document.createElement("div");
      content.className = "provider-metrics";
      heading.append(title, button);
      section.append(heading, content);
      providerSectionsRoot.append(section);
      providerViews.set(provider.id, { content });
    }
  }

  function renderProviderSections() {
    for (const provider of registeredProviders) {
      if (provider.id !== "chatgpt") renderProviderState(provider, latestProviderStates[provider.id]);
    }
  }

  function renderProviderState(provider, state) {
    const view = providerViews.get(provider.id);
    if (!view) return;
    latestProviderStates[provider.id] = state || {};
    const snapshot = state && state.snapshot;
    latestProviderSnapshots[provider.id] = snapshot || null;
    view.content.textContent = "";
    if (!snapshot || snapshot.loginStatus === "logged-out" || isProviderSignedOut(state)) {
      const signIn = document.createElement("div");
      signIn.className = "provider-sign-in";
      signIn.textContent = `Sign in to ${provider.name} to view usage.`;
      view.content.append(signIn);
      return;
    }
    for (const counter of provider.counters) {
      const field = snapshot.usage && snapshot.usage[counter.key];
      if (field && field.structured && field.structured.state === "not-started") {
        const card = document.createElement("div");
        card.className = "metric-card";
        const title = document.createElement("div");
        title.className = "metric-title";
        title.textContent = counter.label;
        const value = document.createElement("div");
        value.className = "metric-reset";
        value.textContent = "Not started · starts when a message is sent";
        card.append(title, value);
        view.content.append(card);
      } else if (field) {
        view.content.append(renderMetricCard(field, counter.label, snapshot));
      } else {
        view.content.append(renderUnavailableCard(counter.label));
      }
    }
  }

  function isProviderSignedOut(state) {
    return Boolean(state && (state.status === "sign-in-required"
      || state.status === "sign-in-required-manual-refresh"));
  }

  function setBusy(isBusy) {
    refreshButton.disabled = isBusy;
    refreshButton.textContent = isBusy ? "Refreshing" : "Refresh";
  }

  function renderLoading() {
    renderRows("chatgptSection", [
      ["Login", "Checking..."],
      ["Plan", "Checking..."]
    ]);
    renderCodexCards(null);
    renderRows("diagnosticsSection", [["Usage signals found", "Checking..."]]);
    warningBox.textContent = "This extension reads the rendered Codex Analytics UI with your existing browser session.";
  }

  function renderState(state) {
    const snapshot = state && state.snapshot;
    latestSnapshot = snapshot;
    const status = ChatGPTUsageModel.summarizeAvailability(snapshot || state);
    const hasVisibleUsage = ChatGPTUsageModel.hasVisibleUsage(snapshot);
    const domUsageVisible = Boolean(snapshot && (snapshot.domUsageVisible || hasVisibleUsage));
    statusTitle.textContent = status;
    latestRefreshTimestamp = state && (state.dataCollectedAt || state.lastRefreshAt);
    updateRefreshAge();

    if (state && state.status === "sign-in-required-manual-refresh") {
      statusTitle.textContent = "Sign in required";
      statusDetail.textContent = "Click Refresh, then open the background Analytics tab to sign in through ChatGPT.";
    } else if (state && state.status === "sign-in-required") {
      statusTitle.textContent = "Sign in required";
      statusDetail.textContent = "The background Analytics tab was left open so you can sign in through ChatGPT, then refresh again.";
    } else if (snapshot && snapshot.loginStatus === "logged-out") {
      statusTitle.textContent = "Sign in required";
      statusDetail.textContent = "Sign in using ChatGPT. This extension never asks for passwords.";
    } else if (state && state.status === "refreshing-codex-analytics") {
      statusTitle.textContent = "Refreshing usage";
      statusDetail.textContent = hasVisibleUsage
        ? "Checking for newer values; the last collected usage remains visible."
        : "Reading Analytics in a temporary background tab if needed.";
    } else if (state && state.status === "analytics-no-new-data") {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Analytics loaded";
      statusDetail.textContent = hasVisibleUsage
        ? "Analytics loaded, but no newer usage values were detected yet."
        : "Analytics loaded, but its usage values were not detected yet.";
    } else if (state && state.status === "cached-visible-usage") {
      statusTitle.textContent = "Usage visible";
      statusDetail.textContent = "Showing the last visible Codex usage found.";
    } else if (state && (state.status === "content-script-unavailable" || state.status === "codex-analytics-load-failed")) {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Refresh failed";
      statusDetail.textContent = hasVisibleUsage
        ? "The Analytics reader failed. Showing the last collected usage values."
        : "Reload the extension and try again; the failure was confirmed after Analytics loaded.";
    } else if (state && state.status === "refresh-timeout") {
      statusTitle.textContent = hasVisibleUsage ? "Showing cached usage" : "Refresh timed out";
      statusDetail.textContent = hasVisibleUsage
        ? "The latest refresh timed out. Showing the last collected usage values."
        : "Refresh took too long. Try again; Analytics may still be loading.";
    } else if (!domUsageVisible) {
      statusTitle.textContent = "Usage unavailable";
      statusDetail.textContent = "ChatGPT did not show usage values on the loaded page.";
    } else {
      statusTitle.textContent = "Usage visible in ChatGPT";
      statusDetail.textContent = "";
    }

    renderRows("chatgptSection", [
      ["Login", renderLogin(snapshot)],
      ["Plan", renderPlan(snapshot)]
    ]);

    renderCodexCards(snapshot);

    renderRows("diagnosticsSection", [
      ["Extractor version", snapshot && snapshot.extractorVersion ? escapeHtml(snapshot.extractorVersion) : "Unavailable"],
      ["Page detected", snapshot ? `${escapeHtml(snapshot.hostname)} (${escapeHtml(snapshot.pathCategory || snapshot.pageKind || "chat")})` : "No Analytics snapshot"],
      ["Usage signals found", renderUsageSignals(snapshot)],
      ["Visible fields found", renderVisibleFields(snapshot)],
      ["Data collected", state && (state.dataCollectedAt || state.lastRefreshAt) ? ChatGPTUsageModel.formatTime(state.dataCollectedAt || state.lastRefreshAt) : "Unavailable"],
      ["Last refresh attempt", state && state.lastRefreshAttemptAt ? ChatGPTUsageModel.formatTime(state.lastRefreshAttemptAt) : "Unavailable"],
      ["Storage", "chrome.storage.local only"],
      ["Network", "No third-party requests"]
    ]);

    warningBox.textContent = collectWarnings(snapshot, state).slice(0, 5).join(" ");
    latestDiagnostics = buildDiagnosticsPayload(state);
  }

  function updateRefreshAge() {
    statusAge.textContent = `Last refresh: ${ChatGPTUsageModel.formatRelativeTime(latestRefreshTimestamp)}`;
  }

  function renderLogin(snapshot) {
    if (!snapshot) return badge("Unavailable", "warn");
    if (snapshot.loginStatus === "logged-in") return badge("Detected signed in", "ok");
    if (snapshot.loginStatus === "logged-out") return badge("Not logged in", "bad");
    return badge("Unavailable", "warn");
  }

  function renderPlan(snapshot) {
    if (snapshot && snapshot.plan && snapshot.plan.value) {
      return `${escapeHtml(snapshot.plan.value)} ${badge("Visible", "ok")}`;
    }
    return `Unavailable ${badge("Unavailable", "warn")}`;
  }

  function renderCodexCards(snapshot) {
    const primaryLimits = document.getElementById("primaryLimits");
    const secondaryLimits = document.getElementById("secondaryLimits");
    const totals = document.getElementById("totalsSection");
    const has5hData = hasMetricData(snapshot, "codex5h");
    primaryLimits.textContent = "";
    secondaryLimits.textContent = "";
    totals.textContent = "";

    if (has5hData) {
      appendMetric(primaryLimits, snapshot, "codex5h", "5h limit", "primary-metric");
    }
    appendMetric(primaryLimits, snapshot, "codexWeekly", "Weekly limit", "primary-metric");
    if (!has5hData) {
      appendMetric(secondaryLimits, snapshot, "codex5h", "5h limit", "secondary-metric");
    }
    appendMetric(totals, snapshot, "codexCredits", "Credits", "total-metric");
    appendMetric(totals, snapshot, "bankedResets", "Full resets banked", "total-metric");
  }

  function hasMetricData(snapshot, key) {
    const field = snapshot && snapshot.usage && snapshot.usage[key];
    if (!field) return false;
    if (field.value !== undefined && field.value !== null && String(field.value).trim()) return true;
    return Boolean(field.structured && Number.isFinite(field.structured.remainingPercent));
  }

  function appendMetric(section, snapshot, key, fallbackTitle, className) {
    const field = snapshot && snapshot.usage && snapshot.usage[key];
    const card = hasMetricData(snapshot, key)
      ? renderMetricCard(field, fallbackTitle, snapshot)
      : renderUnavailableCard(fallbackTitle);
    card.classList.add(className);
    if ((key === "codex5h" || key === "codexWeekly") && hasMetricData(snapshot, key)) {
      const estimate = document.createElement("div");
      estimate.className = "metric-estimate";
      const structured = ChatGPTUsageModel.normalizeMetricField(field, fallbackTitle);
      const remaining = structured.remainingPercent;
      const observedAt = Date.parse(snapshot.collectedAt || latestRefreshTimestamp);
      let result = requiresExtensionReload ? { status: "reload-required" } : CodexCapacityMonitor.estimateDisplayedTimeRemaining(
        latestPace, key, remaining, snapshot.loginStatus === "logged-in" ? observedAt : NaN, Date.now(),
        Boolean(currentPaceSessionId && latestCapacitySessionId === currentPaceSessionId)
      );
      if (structured.resetText && !requiresExtensionReload) {
        const resetAt = ChatGPTUsageModel.parseResetAt(
          structured.resetText, observedAt
        );
        result = resetAt === null ? { status: "unavailable" }
          : CodexCapacityMonitor.limitEstimateToReset(result, resetAt);
      }
      estimate.textContent = CodexCapacityMonitor.formatPaceEstimate(result);
      estimate.title = CodexCapacityMonitor.formatPaceTooltip(result, key);
      card.append(estimate);
    }
    section.append(card);
  }

  function renderMetricCard(field, fallbackTitle, snapshot = null) {
    const structured = ChatGPTUsageModel.normalizeMetricField(field, fallbackTitle);
    const card = document.createElement("div");
    card.className = "metric-card";
    const hasRemainingPercent = typeof structured.remainingPercent === "number";
    const remainingPercent = hasRemainingPercent
      ? Math.max(0, Math.min(100, structured.remainingPercent))
      : null;
    const usageLevel = hasRemainingPercent
      ? CodexCapacityMonitor.classifyUsageLevel(remainingPercent)
      : null;
    if (hasRemainingPercent) {
      card.classList.add("percentage-metric", `usage-${usageLevel}`);
      card.style.setProperty("--metric-percent", `${remainingPercent}%`);
    }

    const title = document.createElement("div");
    title.className = "metric-title";
    title.textContent = structured.label || fallbackTitle;

    const body = document.createElement("div");
    body.className = "metric-body";

    const value = document.createElement("div");
    value.className = "metric-value";
    const valueText = document.createElement("span");
    valueText.className = "metric-value-text";
    if (hasRemainingPercent) {
      valueText.textContent = `${structured.remainingPercent}%`;
    } else if (typeof structured.remainingCredits === "number") {
      valueText.textContent = String(structured.remainingCredits);
    } else if (typeof structured.bankedResetCount === "number") {
      valueText.textContent = String(structured.bankedResetCount);
    } else {
      valueText.textContent = "Visible";
    }
    value.append(valueText);
    body.append(value);

    const meta = document.createElement("div");
    meta.className = "metric-meta";

    if (hasRemainingPercent) {
      value.setAttribute("aria-label", `${structured.remainingPercent}% remaining`);
      const remaining = document.createElement("div");
      remaining.className = "metric-reset";
      remaining.textContent = "Remaining";
      meta.append(remaining);
    }

    if (structured.resetText) {
      const reset = document.createElement("div");
      reset.className = "metric-reset";
      const observedAt = Date.parse(snapshot && snapshot.collectedAt);
      const resetAt = ChatGPTUsageModel.parseResetAt(structured.resetText, observedAt);
      const countdown = ChatGPTUsageModel.formatResetCountdown(resetAt, Date.now());
      reset.textContent = countdown
        ? countdown === "Reset due · refresh usage" ? countdown : `Resets in ${countdown}`
        : `Reset: ${structured.resetText}`;
      meta.append(reset);
    }

    if (structured.expiresText) {
      const expiry = document.createElement("div");
      expiry.className = "metric-reset";
      expiry.textContent = `Expires: ${structured.expiresText}`;
      meta.append(expiry);
    }

    if (meta.childElementCount) body.append(meta);
    card.append(title, body);

    return card;
  }

  function renderUnavailableCard(title) {
    const card = document.createElement("div");
    card.className = "metric-card";
    const label = document.createElement("div");
    label.className = "metric-title";
    label.textContent = title;
    const body = document.createElement("div");
    body.className = "metric-body";
    const value = document.createElement("div");
    value.className = "metric-value";
    value.textContent = "-";
    body.append(value);
    card.append(label, body);
    return card;
  }

  function renderVisibleFields(snapshot) {
    if (!snapshot || !snapshot.usage) return "unavailable";
    const labels = {
      codex5h: "5h",
      codexWeekly: "weekly",
      codexCredits: "credits",
      bankedResets: "full resets banked"
    };
    const found = Object.entries(labels)
      .filter(([key]) => snapshot.usage[key] && snapshot.usage[key].value)
      .map(([, label]) => label);
    return found.length ? escapeHtml(found.join(", ")) : "None";
  }

  function renderUsageSignals(snapshot) {
    if (!snapshot || !snapshot.sessionSignals) return "Unavailable";
    const active = Object.entries(snapshot.sessionSignals)
      .filter(([, value]) => value)
      .map(([key]) => key);
    return active.length ? escapeHtml(active.join(", ")) : "None detected";
  }

  async function copyDiagnostics() {
    const diagnostics = redactDiagnostics(latestDiagnostics || buildDiagnosticsPayload(null));
    copyDiagnosticsButton.disabled = true;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      copyDiagnosticsButton.textContent = "Copied";
    } catch {
      copyDiagnosticsButton.textContent = "Copy failed";
    } finally {
      setTimeout(() => {
        copyDiagnosticsButton.disabled = false;
        copyDiagnosticsButton.textContent = "Copy diagnostics";
      }, 1600);
    }
  }

  function buildDiagnosticsPayload(state) {
    const snapshot = state && state.snapshot;
    return {
      extension: "AI Usage Viewer",
      diagnosticSchema: 1,
      status: state && state.status ? state.status : null,
      popupStatus: statusTitle ? statusTitle.textContent : null,
      extractorVersion: snapshot && snapshot.extractorVersion ? snapshot.extractorVersion : null,
      pageDetected: snapshot ? {
        hostname: snapshot.hostname || null,
        pathCategory: snapshot.pathCategory || snapshot.pageKind || null
      } : null,
      loginStatus: snapshot && snapshot.loginStatus ? snapshot.loginStatus : null,
      usageSignalsFound: snapshot && snapshot.sessionSignals ? truthyKeys(snapshot.sessionSignals) : [],
      visibleFieldsFound: visibleFieldKeys(snapshot),
      codexAnalytics: snapshot && snapshot.codexAnalytics ? {
        pageDetected: Boolean(snapshot.codexAnalytics.pageDetected),
        foundKeys: snapshot.codexAnalytics.foundKeys || [],
        hasResetText: Boolean(snapshot.codexAnalytics.hasResetText),
        hasRemainingText: Boolean(snapshot.codexAnalytics.hasRemainingText),
        hasCreditsText: Boolean(snapshot.codexAnalytics.hasCreditsText),
        hasBankedResetsText: Boolean(snapshot.codexAnalytics.hasBankedResetsText),
        hasExpiryText: Boolean(snapshot.codexAnalytics.hasExpiryText),
        domSignals: snapshot.codexAnalytics.domSignals ? {
          relevantContainerCount: snapshot.codexAnalytics.domSignals.relevantContainerCount || 0,
          progressbarCount: snapshot.codexAnalytics.domSignals.progressbarCount || 0,
          ariaValueCount: snapshot.codexAnalytics.domSignals.ariaValueCount || 0,
          timeElementCount: snapshot.codexAnalytics.domSignals.timeElementCount || 0,
          mainTextLength: snapshot.codexAnalytics.domSignals.mainTextLength || 0,
          readyState: snapshot.codexAnalytics.domSignals.readyState || null
        } : null
      } : null,
      dataCollectedAt: state && (state.dataCollectedAt || state.lastRefreshAt) ? state.dataCollectedAt || state.lastRefreshAt : null,
      lastRefreshAttemptAt: state && state.lastRefreshAttemptAt ? state.lastRefreshAttemptAt : null,
      collectedAt: snapshot && snapshot.collectedAt ? snapshot.collectedAt : null,
      storage: "chrome.storage.local only",
      network: "no usage uploads or telemetry"
    };
  }

  function redactDiagnostics(value) {
    return JSON.parse(JSON.stringify(value), (_key, item) => {
      if (typeof item !== "string") return item;
      return item
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/\b(?:acct|account|user|org|workspace|team)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
    });
  }

  function truthyKeys(record) {
    return Object.entries(record || {})
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
  }

  function visibleFieldKeys(snapshot) {
    if (!snapshot || !snapshot.usage) return [];
    return Object.entries(snapshot.usage)
      .filter(([, field]) => field && field.value)
      .map(([key]) => key);
  }

  function collectWarnings(snapshot, state) {
    const warnings = [];
    if (state && state.status === "content-script-unavailable") {
      warnings.push("Analytics loaded but its content script did not respond after all retries.");
    }
    if (state && state.status === "analytics-no-new-data") {
      warnings.push("Analytics responded successfully, but no new usage values were detected during this attempt.");
    }
    if (state && state.status === "sign-in-required") {
      warnings.push("The temporary Analytics tab remains open in the background only so you can sign in safely through ChatGPT.");
    }
    if (state && state.status === "sign-in-required-manual-refresh") {
      warnings.push("The scheduled sign-in tab was closed; use Refresh to reopen it for sign-in.");
    }
    if (snapshot && !snapshot.domUsageVisible) {
      warnings.push("Usage not exposed by ChatGPT UI.");
    }
    warnings.push("Usage is read from an extension-owned Codex Analytics page in the background without changing focus or reloading your open page.");
    return warnings;
  }

  function renderRows(sectionId, rows) {
    const section = document.getElementById(sectionId);
    section.textContent = "";
    for (const [label, value] of rows) {
      const wrapper = document.createElement("div");
      wrapper.className = "row";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.innerHTML = value;
      wrapper.append(dt, dd);
      section.append(wrapper);
    }
  }

  function badge(text, className) {
    return `<span class="badge ${className}">${escapeHtml(text)}</span>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function withTimeout(promise, ms, message) {
    let timeoutId = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      })
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function friendlyError(error) {
    const message = String(error && error.message ? error.message : error);
    if (/timed out/i.test(message)) return "Refresh took too long. Try again; Analytics may still be loading.";
    return "Analytics could not be read. Reload the extension and try again.";
  }
})();

(function initCapacityMonitor(globalScope) {
  "use strict";

  const usageModel = globalScope.ChatGPTUsageModel
    || (typeof require === "function" ? require("./usage-model.js").ChatGPTUsageModel : null);
  const providers = globalScope.UsageProviders
    || (typeof require === "function" ? require("./providers.js").UsageProviders : null);
  if (!providers) throw new Error("providers.js must be loaded before capacity-monitor.js");

  const DEFAULT_SETTINGS = Object.freeze({
    enableNotifications: true,
    notifyOnReset: true,
    showRemainingPercentage: true,
    lowThreshold: 10,
    criticalThreshold: 5,
    enableSounds: false
  });
  const PREVENTIVE_THRESHOLD = 25;
  const COUNTER_STALE_AFTER_MS = 35 * 60 * 1000;
  const PACE_WINDOW_MS = 2 * 60 * 60 * 1000;
  const PACE_MAX_GAP_MS = 90 * 60 * 1000;
  const PACE_TRACKER_VERSION = 2;
  function counters() {
    return providers.allCounters().map(({ key, label }) => ({ key, label }));
  }

  function paceKeys() {
    return providers.allCounters().map((counter) => counter.key);
  }

  function scopeKeysFor(providerId) {
    const definitions = providers.allCounters();
    return (providerId
      ? definitions.filter((counter) => counter.providerId === providerId)
      : definitions).map((counter) => counter.key);
  }

  const SEVERITY = Object.freeze({ normal: 0, preventive: 1, warning: 2, critical: 3, exhausted: 4 });
  const BADGE_COLORS = Object.freeze({
    green: "#15803d",
    amber: "#f59e0b",
    red: "#dc2626"
  });

  function normalizeSettings(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const lowThreshold = clampInteger(value.lowThreshold, 1, PREVENTIVE_THRESHOLD, DEFAULT_SETTINGS.lowThreshold);
    const criticalThreshold = clampInteger(value.criticalThreshold, 1, lowThreshold, Math.min(DEFAULT_SETTINGS.criticalThreshold, lowThreshold));
    return {
      enableNotifications: booleanSetting(value.enableNotifications, DEFAULT_SETTINGS.enableNotifications),
      notifyOnReset: booleanSetting(value.notifyOnReset, DEFAULT_SETTINGS.notifyOnReset),
      showRemainingPercentage: booleanSetting(value.showRemainingPercentage, DEFAULT_SETTINGS.showRemainingPercentage),
      lowThreshold,
      criticalThreshold,
      enableSounds: booleanSetting(value.enableSounds, DEFAULT_SETTINGS.enableSounds)
    };
  }

  function normalizeMonitorState(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const normalizedCounters = {};
    for (const definition of counters()) {
      const stored = value.counters && value.counters[definition.key];
      const remainingPercent = normalizePercent(stored && stored.remainingPercent);
      if (remainingPercent === null) continue;
      normalizedCounters[definition.key] = {
        remainingPercent,
        resetText: cleanResetText(stored.resetText),
        sessionId: typeof stored.sessionId === "string" ? stored.sessionId : value.paceSessionId || null,
        lastSeenAt: typeof stored.lastSeenAt === "string" ? stored.lastSeenAt : null
      };
    }
    const availableKeys = Array.isArray(value.availableKeys)
      ? counters().map((definition) => definition.key)
        .filter((key) => value.availableKeys.includes(key) && normalizedCounters[key])
      : [];
    return {
      version: 2,
      counters: normalizedCounters,
      pace: normalizePace(value.pace),
      paceSessionId: typeof value.paceSessionId === "string" ? value.paceSessionId : null,
      availableKeys,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
    };
  }

  function extractAvailableCounters(snapshot) {
    const usage = snapshot && snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : {};
    return counters().flatMap((definition) => {
      const field = usage[definition.key];
      const remainingPercent = readRemainingPercent(field);
      if (remainingPercent === null) return [];
      return [{
        ...definition,
        remainingPercent,
        resetText: cleanResetText(field && field.structured && field.structured.resetText)
      }];
    });
  }

  function evaluateSnapshot(snapshot, previousState, rawSettings, now = new Date().toISOString(), paceSessionId = null, options = {}) {
    const settings = normalizeSettings(rawSettings);
    const previous = normalizeMonitorState(previousState);
    const scopeKeys = scopeKeysFor(options && options.providerId);
    const available = extractAvailableCounters(snapshot)
      .filter((counter) => scopeKeys.includes(counter.key));
    const upgradingPace = previousState && previousState.pace === undefined
      && previousState.paceSessionId === undefined;
    if (upgradingPace) {
      // Older versions kept one confirmed observation per counter. Preserve it
      // as the first rate sample instead of discarding it during the upgrade.
      for (const key of scopeKeys) {
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
        upgradingPace || previous.paceSessionId === paceSessionId, scopeKeys),
      paceSessionId,
      availableKeys: [
        ...previous.availableKeys.filter((key) => !scopeKeys.includes(key) && counters[key]),
        ...available.map((counter) => counter.key)
      ],
      updatedAt: now
    };
    // With several providers the toolbar shows the lowest remaining across all of
    // them, so the visual must include the other providers' still-fresh counters.
    const visualCounters = scopeKeys.length === paceKeys().length
      ? available
      : [
        ...extractFreshStateCounters(state, now).filter((counter) => !scopeKeys.includes(counter.key)),
        ...available
      ];
    return { available, events, settings, state, visual: deriveVisualState(visualCounters, settings) };
  }

  function hasResetChanged(previous, current, now) {
    if (!previous.resetText || !current.resetText || !usageModel) return false;
    const before = usageModel.parseResetAt(previous.resetText, Date.parse(previous.lastSeenAt));
    const after = usageModel.parseResetAt(current.resetText, Date.parse(now));
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    // Relative UI durations are rounded to minutes; absolute dates compare exactly.
    const absolute = (text) => /\d{1,2}:\d{2}/.test(text);
    const tolerance = absolute(previous.resetText) && absolute(current.resetText) ? 0 : 60000;
    return Math.abs(after - before) > tolerance;
  }

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

  function normalizePace(raw) {
    return Object.fromEntries(paceKeys().map((key) => {
      const samples = raw && Array.isArray(raw[key]) ? raw[key] : [];
      return [key, samples.slice(-121).filter((sample) => sample
        && Number.isFinite(sample.at)
        && normalizePercent(sample.remainingPercent) !== null)
        .map(({ at, remainingPercent, msPerPercent }) => ({
          at,
          remainingPercent,
          ...(Number.isFinite(msPerPercent) && msPerPercent > 0 ? { msPerPercent } : {})
        }))];
    }));
  }

  function updatePace(available, previous, now, sameSession, keys = paceKeys()) {
    const pace = normalizePace(previous);
    for (const key of keys) {
      const counter = available.find((item) => item.key === key);
      if (!counter || !Number.isFinite(now)) {
        pace[key] = [];
        continue;
      }
      const last = pace[key].at(-1);
      const continuous = last && now >= last.at && now - last.at <= PACE_MAX_GAP_MS
        && (sameSession || counter.remainingPercent <= last.remainingPercent);
      let samples = continuous ? pace[key].filter((sample) => sample.at >= now - PACE_WINDOW_MS) : [];
      let seed = {};
      if (last && counter.remainingPercent > last.remainingPercent) {
        // The replenishment interval contains a reset, not measurable consumption.
        // Project the new balance with the rate measured before that interval.
        const prior = continuous ? estimateTimeRemaining(pace, key, last.remainingPercent, last.at) : null;
        const measuredRate = prior && prior.status === "estimated" && last.remainingPercent > 0
          ? prior.durationMs / last.remainingPercent
          : continuous ? measuredMsPerPercent(pace[key]) : null;
        seed = measuredRate ? { msPerPercent: measuredRate } : {};
        samples = [];
      }
      // Repeated reads at one instant cannot establish a consumption rate.
      if (samples.at(-1)?.at === now) {
        const replaced = samples.pop();
        seed = { ...replaced, ...seed };
      }
      samples.push({ ...seed, at: now, remainingPercent: counter.remainingPercent });
      pace[key] = samples.slice(-121);
    }
    return pace;
  }

  function measuredMsPerPercent(samples) {
    const last = samples.at(-1);
    const recent = last ? samples.filter((sample) => sample.at >= last.at - PACE_WINDOW_MS) : [];
    const first = recent[0];
    if (recent.length < 2 || last.at - first.at < 60000) return null;
    const consumed = first.remainingPercent - last.remainingPercent;
    return consumed > 0 ? (last.at - first.at) / consumed : null;
  }

  function estimateTimeRemaining(rawPace, key, remainingPercent, now = Date.now(), sameSession = true) {
    let samples = normalizePace(rawPace)[key] || [];
    const last = samples.at(-1);
    if (!last || last.remainingPercent !== remainingPercent || now < last.at
      || now - last.at > COUNTER_STALE_AFTER_MS) return { status: "unavailable" };
    if (remainingPercent === 0) return { status: "exhausted" };
    if (!sameSession) samples = [{ at: last.at, remainingPercent: last.remainingPercent }];
    const recent = samples.filter((sample) => sample.at >= last.at - PACE_WINDOW_MS);
    const first = recent[0];
    if (recent.length < 2 || last.at - first.at < 60000) {
      if (first.msPerPercent) return { status: "estimated", durationMs: remainingPercent * first.msPerPercent };
      return proportionalEstimate(key, remainingPercent);
    }
    const consumed = first.remainingPercent - last.remainingPercent;
    if (consumed <= 0) return { status: "idle" };
    const durationMs = remainingPercent * (last.at - first.at) / consumed;
    return { status: "estimated", durationMs };
  }

  function proportionalEstimate(key, remainingPercent) {
    if (remainingPercent === 0) return { status: "exhausted" };
    const definition = providers.counterDefinition(key);
    const windowMs = definition ? definition.windowMs : 7 * 24 * 3600000;
    return { status: "nominal", durationMs: remainingPercent / 100 * windowMs };
  }

  function estimateDisplayedTimeRemaining(rawPace, key, remainingPercent, observedAt, now = Date.now(), sameSession = true) {
    if (!paceKeys().includes(key) || normalizePercent(remainingPercent) === null
      || !Number.isFinite(observedAt) || observedAt > now
      || now - observedAt > COUNTER_STALE_AFTER_MS) return { status: "unavailable" };
    const measured = estimateTimeRemaining(rawPace, key, remainingPercent, now, sameSession);
    // A fresh visible balance can provide a proportional starting point even
    // before confirmed history exists, or while it catches up with that balance.
    return measured.status === "unavailable" ? proportionalEstimate(key, remainingPercent) : measured;
  }

  function limitEstimateToReset(estimate, resetAt, now = Date.now()) {
    if (!Number.isFinite(resetAt) || !Number.isFinite(estimate.durationMs)) return estimate;
    const untilReset = Math.max(0, resetAt - now);
    return untilReset <= estimate.durationMs
      ? { status: "reset-bound", durationMs: untilReset } : estimate;
  }

  function formatPaceEstimate(estimate) {
    if (estimate.status === "reload-required") return "Reload extension for estimate";
    if (estimate.status === "exhausted") return "Limit reached";
    if (estimate.status === "idle") return "No recent consumption";
    if (!["estimated", "nominal", "reset-bound"].includes(estimate.status)) return "Estimate unavailable";
    if (estimate.status === "reset-bound" && estimate.durationMs === 0) return "Reset due · refresh usage";
    const minutes = Math.floor(estimate.durationMs / 60000);
    let duration;
    if (estimate.status === "nominal" && minutes === 7 * 24 * 60) duration = "1 week";
    else if (minutes < 1) duration = "<1 min";
    else if (minutes < 60) duration = `${minutes} min`;
    else if (minutes < 1440) duration = `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    else duration = `${Math.floor(minutes / 1440)} d${Math.floor(minutes % 1440 / 60) ? ` ${Math.floor(minutes % 1440 / 60)} h` : ""}`;
    if (estimate.status === "reset-bound") return `≈ ${duration} left · resets then`;
    return estimate.status === "nominal"
      ? `≈ ${duration} left · initial estimate`
      : `≈ ${duration} left at this pace`;
  }

  function formatPaceTooltip(estimate, key) {
    const definition = providers.counterDefinition(key);
    const limit = definition ? definition.limitName : "usage";
    if (estimate.status === "reload-required") {
      return `Reload to track ${limit} usage.`;
    }
    if (estimate.status === "nominal") {
      return `Initial estimate from your remaining ${limit} capacity.`;
    }
    if (estimate.status === "reset-bound") return `Time until the ${limit} reset.`;
    if (estimate.status === "idle") return `No recent ${limit} consumption.`;
    if (estimate.status === "exhausted") return `The ${limit} limit has been reached.`;
    if (estimate.status !== "estimated") return `Not enough recent ${limit} data.`;
    return `Time left at your current ${limit} usage rate.`;
  }

  function extractFreshStateCounters(rawState, now = new Date().toISOString()) {
    const state = normalizeMonitorState(rawState);
    return counters().flatMap((definition) => {
      const stored = state.counters[definition.key];
      if (!state.availableKeys.includes(definition.key) || !stored || !isFreshObservation(stored, now)) return [];
      return [{ ...definition, ...stored }];
    });
  }

  function isFreshObservation(stored, now) {
    const lastSeenAt = Date.parse(stored && stored.lastSeenAt);
    const currentTime = Date.parse(now);
    return Number.isFinite(lastSeenAt)
      && Number.isFinite(currentTime)
      && currentTime >= lastSeenAt
      && currentTime - lastSeenAt <= COUNTER_STALE_AFTER_MS;
  }

  function detectTransition(previous, current, settings) {
    if (current === 100 && previous < 100) return "reset";
    if (current >= previous) return null;
    if (current === 0 && previous > 0) return "exhausted";
    if (current <= settings.criticalThreshold && previous > settings.criticalThreshold) return "critical";
    if (current <= settings.lowThreshold && previous > settings.lowThreshold) return "low";
    if (current <= PREVENTIVE_THRESHOLD && previous > PREVENTIVE_THRESHOLD) return "preventive";
    return null;
  }

  function deriveVisualState(availableCounters, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const available = Array.isArray(availableCounters)
      ? availableCounters.filter((counter) => normalizePercent(counter && counter.remainingPercent) !== null)
      : [];
    if (!available.length) {
      const badgeColor = BADGE_COLORS.green;
      return {
        badgeText: "",
        badgeColor,
        badgeTextColor: getContrastingTextColor(badgeColor),
        counter: null,
        state: "normal",
        title: "ChatGPT Usage Viewer — usage unavailable"
      };
    }
    const worst = available.reduce((selected, candidate) => (
      candidate.remainingPercent < selected.remainingPercent ? candidate : selected
    ));
    const state = classifyRemaining(worst.remainingPercent, settings);
    const badgeLevel = classifyUsageLevel(worst.remainingPercent);
    const badgeColor = BADGE_COLORS[badgeLevel];
    const showTemporaryWarning = SEVERITY[state] >= SEVERITY.warning;
    return {
      badgeText: settings.showRemainingPercentage || showTemporaryWarning
        ? String(Math.round(worst.remainingPercent))
        : "",
      badgeColor,
      badgeTextColor: getContrastingTextColor(badgeColor),
      counter: worst,
      state,
      title: `ChatGPT Usage Viewer — ${worst.label}: ${worst.remainingPercent}% remaining`
    };
  }

  function classifyRemaining(remainingPercent, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const value = normalizePercent(remainingPercent);
    if (value === null) return "normal";
    if (value === 0) return "exhausted";
    if (value <= settings.criticalThreshold) return "critical";
    if (value <= settings.lowThreshold) return "warning";
    if (value <= PREVENTIVE_THRESHOLD) return "preventive";
    return "normal";
  }

  function classifyUsageLevel(remainingPercent) {
    const value = normalizePercent(remainingPercent);
    if (value === null) return "green";
    if (value < 15) return "red";
    if (value <= 50) return "amber";
    return "green";
  }

  function getContrastingTextColor(backgroundColor) {
    const backgroundLuminance = relativeLuminance(backgroundColor);
    const whiteContrast = contrastRatio(backgroundLuminance, 1);
    const blackContrast = contrastRatio(backgroundLuminance, 0);
    return whiteContrast >= blackContrast ? "#ffffff" : "#000000";
  }

  function relativeLuminance(color) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(color));
    if (!match) return 0;
    const channels = match[1].match(/.{2}/g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(firstLuminance, secondLuminance) {
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function buildNotification(event) {
    const resetSuffix = event.resetText ? ` Reset: ${event.resetText}.` : "";
    if (event.type === "capacity-increased") {
      return {
        title: `${event.label} capacity increased`,
        message: `${event.previousRemainingPercent}% → ${event.remainingPercent}% remaining.${event.resetChanged ? " Reset date changed." : ""}${resetSuffix}`
      };
    }
    if (event.type === "reset-changed") {
      return { title: `${event.label} reset date changed`,
        message: `${event.remainingPercent}% remaining.${resetSuffix}` };
    }
    if (event.type === "reset") {
      return {
        title: `${event.label} reset`,
        message: `${event.label} reset to 100% remaining.${resetSuffix}`
      };
    }
    if (event.type === "exhausted") {
      return { title: `${event.label} exhausted`, message: `0% remaining.${resetSuffix}` };
    }
    if (event.type === "critical") {
      return {
        title: `${event.label} is critically low`,
        message: `${event.remainingPercent}% remaining.${resetSuffix}`
      };
    }
    return { title: `${event.label} is low`, message: `${event.remainingPercent}% remaining.${resetSuffix}` };
  }

  function shouldNotify(event, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    if (!settings.enableNotifications || !event) return false;
    if (["reset", "capacity-increased", "reset-changed"].includes(event.type)) return settings.notifyOnReset;
    return event.type === "low" || event.type === "critical" || event.type === "exhausted";
  }

  function shouldPlaySound(event, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    return Boolean(settings.enableSounds && event && (
      event.type === "low" || event.type === "critical" || event.type === "exhausted"
    ));
  }

  function readRemainingPercent(field) {
    const structuredValue = field && field.structured && field.structured.remainingPercent;
    const structuredPercent = normalizePercent(structuredValue);
    if (structuredPercent !== null) return structuredPercent;
    const match = String(field && field.value ? field.value : "").match(/(\d{1,3})\s*%/);
    return match ? normalizePercent(Number(match[1])) : null;
  }

  function normalizePercent(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : null;
  }

  function cleanResetText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 100) : null;
  }

  function clampInteger(value, min, max, fallback) {
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      return fallback;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function booleanSetting(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  const api = {
    BADGE_COLORS,
    COUNTER_STALE_AFTER_MS,
    get COUNTERS() { return counters(); },
    DEFAULT_SETTINGS,
    PREVENTIVE_THRESHOLD,
    PACE_TRACKER_VERSION,
    buildNotification,
    classifyRemaining,
    classifyUsageLevel,
    deriveVisualState,
    detectTransition,
    evaluateSnapshot,
    estimateTimeRemaining,
    estimateDisplayedTimeRemaining,
    formatPaceEstimate,
    formatPaceTooltip,
    limitEstimateToReset,
    extractAvailableCounters,
    extractFreshStateCounters,
    normalizeMonitorState,
    normalizeSettings,
    removeProviderCounters,
    shouldNotify,
    shouldPlaySound
  };

  globalScope.CodexCapacityMonitor = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { CodexCapacityMonitor: api };
  }
})(typeof self !== "undefined" ? self : globalThis);

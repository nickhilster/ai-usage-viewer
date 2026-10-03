(function initClaudeUsageProvider(globalScope) {
  "use strict";

  const providers = globalScope.UsageProviders
    || (typeof require === "function" ? require("./providers.js").UsageProviders : null);
  if (!providers) throw new Error("providers.js must be loaded before claude-provider.js");

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const SESSION_KEY = "claude:session";
  const WEEKLY_KEY = "claude:weekly";
  const confidenceRank = Object.freeze({ low: 1, medium: 2, high: 3 });

  function linesOf(text) {
    return String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  function section(lines, heading, nextHeading) {
    const start = lines.findIndex((line) => line.toLowerCase() === heading.toLowerCase());
    if (start < 0) return [];
    const end = nextHeading
      ? lines.findIndex((line, index) => index > start && line.toLowerCase() === nextHeading.toLowerCase())
      : -1;
    return lines.slice(start + 1, end < 0 ? lines.length : end);
  }

  function resetTextFrom(lines) {
    const reset = lines.find((line) => /^resets?\b/i.test(line));
    return reset ? reset.replace(/^resets?\s*/i, "").trim() || null : null;
  }

  function usedPercentFrom(lines) {
    for (const line of lines) {
      const match = line.match(/\b(100|\d{1,2})(?:\.\d+)?%\s*used\b/i);
      if (match) return Math.max(0, Math.min(100, Number(match[1])));
    }
    return null;
  }

  function usageField(lines, key) {
    const usedPercent = usedPercentFrom(lines);
    if (key === SESSION_KEY && lines.some((line) => /starts when a message is sent/i.test(line)) && usedPercent === 0) {
      return {
        value: "Not started · starts when a message is sent",
        confidence: "high",
        structured: { state: "not-started", usedPercent: 0, remainingPercent: null, resetText: null },
        warning: null
      };
    }
    if (usedPercent === null) return null;
    return {
      value: `${usedPercent}% used`,
      confidence: "high",
      structured: {
        state: "active",
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetText: resetTextFrom(lines)
      },
      warning: null
    };
  }

  function parsePlan(lines) {
    const index = lines.findIndex((line) => /^your usage limits$/i.test(line));
    if (index < 0 || !lines[index + 1] || /^(current session|weekly limits)$/i.test(lines[index + 1])) return null;
    return { value: lines[index + 1], confidence: "medium", structured: null, warning: null };
  }

  function parseUsageText(text, collectedAt = new Date().toISOString()) {
    const lines = linesOf(text);
    const hasSession = lines.some((line) => /^current session$/i.test(line));
    const hasWeekly = lines.some((line) => /^weekly limits$/i.test(line));
    const hasPercent = lines.some((line) => /\b(?:100|\d{1,2})(?:\.\d+)?%\s*used\b/i.test(line));
    const ready = hasSession && hasWeekly && hasPercent;
    const usage = {};
    if (ready) {
      const session = usageField(section(lines, "Current session", "Weekly limits"), SESSION_KEY);
      const weekly = usageField(section(lines, "Weekly limits"), WEEKLY_KEY);
      if (session) usage[SESSION_KEY] = session;
      if (weekly) usage[WEEKLY_KEY] = weekly;
    }
    return { plan: parsePlan(lines), usage, ready, collectedAt };
  }

  function isUsagePageSnapshot(snapshot) {
    return Boolean(snapshot && snapshot.claudeUsage && snapshot.claudeUsage.pageDetected);
  }

  function hasVisibleUsage(snapshot) {
    return Boolean(snapshot && snapshot.usage && Object.values(snapshot.usage)
      .some((field) => field && field.value));
  }

  function hasParsedUsageLimit(snapshot) {
    return Boolean(snapshot && snapshot.usage && [SESSION_KEY, WEEKLY_KEY].some((key) => {
      const remaining = snapshot.usage[key] && snapshot.usage[key].structured
        && snapshot.usage[key].structured.remainingPercent;
      return Number.isFinite(remaining) && remaining >= 0 && remaining <= 100;
    }));
  }

  function mergeUsageFields(accumulated, incoming) {
    const result = { ...(accumulated || {}) };
    for (const [key, field] of Object.entries(incoming || {})) {
      const current = result[key];
      if (!current || (confidenceRank[field && field.confidence] || 0) >= (confidenceRank[current.confidence] || 0)) {
        result[key] = field;
      }
    }
    return result;
  }

  const storage = providers.defaultStorageKeys("claude");
  const definition = {
    id: "claude",
    name: "Claude",
    usageUrl: "https://claude.ai/new#settings/usage",
    hostnames: ["claude.ai"],
    hostPatterns: ["https://claude.ai/*"],
    ...storage,
    counters: [
      { key: SESSION_KEY, label: "Claude current session", limitName: "session", windowMs: 5 * HOUR_MS },
      { key: WEEKLY_KEY, label: "Claude weekly usage", limitName: "weekly", windowMs: 7 * DAY_MS }
    ],
    messages: {
      loadFailed: "The extension could not create the temporary Claude usage tab.",
      readerUnresponsive: "The temporary Claude usage page did not respond after loading.",
      noNewData: "Claude usage rendered, but no new visible usage values were detected yet.",
      routeNotDetected: "The temporary tab responded, but the Claude usage view was not detected yet.",
      contentScriptMissing: "Claude usage content script did not respond.",
      loadTimeout: "Timed out loading Claude usage."
    },
    isUsageUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.hostname.toLowerCase() === "claude.ai"
          && parsed.pathname.replace(/\/$/, "") === "/new"
          && parsed.hash === "#settings/usage";
      } catch {
        return false;
      }
    },
    isUsagePageSnapshot,
    hasVisibleUsage,
    hasParsedUsageLimit,
    mergeUsageFields
  };
  const provider = providers.getProvider("claude") || providers.registerProvider(definition);
  const api = Object.freeze({
    SESSION_KEY,
    WEEKLY_KEY,
    hasParsedUsageLimit,
    hasVisibleUsage,
    isUsagePageSnapshot,
    mergeUsageFields,
    parseUsageText,
    provider
  });

  globalScope.ClaudeUsageProvider = api;
  if (typeof module !== "undefined" && module.exports) module.exports = { ClaudeUsageProvider: api };
})(typeof self !== "undefined" ? self : globalThis);

(function initUsageModel(globalScope) {
  "use strict";

  const CONFIG = {
    storageKeys: {
      state: "chatgptUsageMonitor.state",
      retainedSignInTab: "chatgptUsageMonitor.retainedSignInTab",
      refreshPeriodMinutes: "chatgptUsageMonitor.refreshPeriodMinutes",
      capacitySettings: "chatgptUsageMonitor.capacitySettings",
      capacityState: "chatgptUsageMonitor.capacityState",
      paceSessionId: "chatgptUsageMonitor.paceSessionId"
    },
    refreshAlarmName: "chatgpt-usage-monitor-refresh",
    refreshPeriodMinutes: 15,
    refreshPeriodMinimumMinutes: 1,
    refreshPeriodMaximumMinutes: 60
  };

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;
  const CODEX_FIELD_KEYS = [
    "codex5h",
    "codexWeekly",
    "codexCredits",
    "remainingCredits",
    "bankedResets"
  ];
  const TERMS = {
    usage: ["usage", "use", "uso"],
    remaining: ["remaining", "left", "available", "restante", "restantes", "queda", "quedan", "disponible", "disponibles"],
    reset: ["reset", "resets", "renew", "renews", "refresh", "refreshes", "reinicia", "reinicio", "renueva", "recarga"],
    credits: ["credit", "credits", "credit balance", "credito", "creditos", "saldo"],
    weekly: ["weekly", "week", "semanal", "semana"],
    hours5: ["5h", "5 h", "5-hour", "5 hour", "5 hours", "five hour", "five-hour", "5 horas", "5 hora"],
    bankedResets: ["banked reset", "banked resets", "saved reset", "saved resets", "full reset", "full resets", "restablecimiento completo", "restablecimientos completos", "reinicio acumulado", "reinicios acumulados", "reinicio guardado", "reinicios guardados"],
    expiry: ["expires", "expire", "expiration", "expiry", "valid until", "vence", "vencen", "vencimiento", "caduca", "caducan"]
  };
  const CONCEPT_PATTERNS = buildConceptPatterns(TERMS);

  function formatTime(value) {
    if (!value) return "Unavailable";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatRelativeTime(value, now = Date.now()) {
    const timestamp = parseTimestamp(value);
    if (!timestamp) return "unavailable";
    const elapsedMs = Math.max(0, now - timestamp);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
    if (elapsedMinutes < 1) return "just now";
    if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours} h ago`;
    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) return `${elapsedDays} d ago`;
    return formatTime(timestamp);
  }

  function normalizeRefreshPeriodMinutes(value) {
    if (value === null || value === undefined || value === "") {
      return CONFIG.refreshPeriodMinutes;
    }
    const period = Number(value);
    if (!Number.isFinite(period)) return CONFIG.refreshPeriodMinutes;
    return Math.min(
      CONFIG.refreshPeriodMaximumMinutes,
      Math.max(CONFIG.refreshPeriodMinimumMinutes, Math.round(period))
    );
  }

  function parseTimestamp(value) {
    if (!value) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function hasVisibleUsage(snapshot) {
    if (!snapshot || !snapshot.usage) return false;
    return Object.entries(snapshot.usage).some(([key, field]) => !isRetiredMetric(key) && field && field.value);
  }

  function hasParsedUsageLimit(snapshot) {
    const usage = snapshot && snapshot.usage;
    return [usage && usage.codex5h, usage && usage.codexWeekly].some((field) => {
      const percent = field && field.structured && field.structured.remainingPercent;
      return Number.isFinite(percent) && percent >= 0 && percent <= 100;
    });
  }

  function isRetiredMetric(key) {
    return key === "codexSpark5h" || key === "codexSparkWeekly";
  }

  function mergeUsageFields(baseUsage, incomingUsage) {
    const merged = Object.fromEntries(Object.entries(baseUsage || {}).filter(([key]) => !isRetiredMetric(key)));
    for (const [key, incomingField] of Object.entries(incomingUsage || {})) {
      if (isRetiredMetric(key)) continue;
      const existingField = merged[key];
      if (!(key in merged)
        || usageFieldQuality(incomingField) >= usageFieldQuality(existingField)) {
        merged[key] = incomingField;
      }
    }
    return merged;
  }

  function usageFieldQuality(field) {
    if (!field || !field.value) return 0;
    const structured = field.structured && typeof field.structured === "object"
      ? field.structured
      : null;
    const hasStructuredValue = Boolean(structured && (
      Number.isFinite(structured.remainingPercent)
      || Number.isFinite(structured.remainingCredits)
      || Number.isFinite(structured.bankedResetCount)
      || structured.resetText
      || structured.expiresText
    ));
    const confidence = String(field.confidence || (structured && structured.confidence) || "");
    const confidenceScore = {
      high: 4,
      medium: 3,
      visible: 2,
      low: 1
    }[confidence] || 0;
    return (hasStructuredValue ? 10 : 0) + confidenceScore;
  }

  function parseCodexUsageText(text) {
    const normalized = normalizeVisibleText(text);
    const fields = {};

    for (const key of CODEX_FIELD_KEYS) {
      fields[key] = unavailableField();
    }

    if (!normalized) return fields;

    for (const match of collectPercentWindows(normalized)) {
      const key = classifyCodexPercentWindow(match);
      if (!key || fields[key].value) continue;
      fields[key] = visibleField(formatPercentValue(key, match.percent, match.resetText), {
        label: labelForMetricKey(key),
        remainingPercent: match.percent,
        resetText: match.resetText,
        confidence: match.confidence,
        resetConfidence: match.resetText ? match.resetConfidence : null
      }, match.confidence);
    }

    const credits = extractCredits(normalized);
    if (credits) {
      const field = visibleField(`Credits remaining: ${credits.value}`, {
        label: "Credits",
        remainingCredits: credits.value,
        confidence: credits.confidence
      }, credits.confidence);
      fields.codexCredits = field;
      fields.remainingCredits = field;
    }

    const bankedResets = extractBankedResets(normalized);
    if (bankedResets) {
      fields.bankedResets = visibleField(formatBankedResetsValue(bankedResets), {
        label: bankedResets.label,
        bankedResetCount: bankedResets.count,
        countSource: bankedResets.countSource,
        expiresText: bankedResets.expiresText,
        confidence: bankedResets.confidence,
        expiryConfidence: bankedResets.expiresText ? bankedResets.expiryConfidence : null
      }, bankedResets.confidence);
    }

    return fields;
  }

  function normalizeMetricField(field, fallbackTitle) {
    const structured = field && field.structured ? field.structured : {};
    const value = String(field && field.value ? field.value : "");
    const parsed = parseMetricText(value, fallbackTitle);
    const resetContext = normalizeForMatch(structured.resetText || "");
    const structuredLooksContaminated = structured.resetText
      && (hasAnyConcept(resetContext, ["usage", "credits", "reset"]) || containsTerm(resetContext, "settings") || containsTerm(resetContext, "configuracion"));
    const shouldPreferParsed = parsed && (
      structuredLooksContaminated
      || typeof structured.remainingPercent !== "number"
    );

    if (shouldPreferParsed) return parsed;

    if (typeof structured.remainingPercent === "number"
      || typeof structured.remainingCredits === "number"
      || typeof structured.bankedResetCount === "number") {
      return structured;
    }

    if (parsed) return parsed;
    return {
      label: fallbackTitle
    };
  }

  function summarizeAvailability(snapshot) {
    if (!snapshot || snapshot.status !== "ok") return "Open ChatGPT to refresh";
    if (snapshot.loginStatus === "logged-out") return "Sign in required";
    if (hasVisibleUsage(snapshot)) return "Usage visible";
    if (snapshot.loginStatus === "unknown") return "Usage unavailable";
    return "Ready";
  }

  function collectPercentWindows(text) {
    if (text.includes("\n")) {
      return collectLinePercentWindows(text);
    }

    const matches = [];
    const pattern = /(\d{1,3})\s*%|([a-záéíóúñ -]{1,28})\s+(\d{1,3})\s*%/gi;
    let match = pattern.exec(text);
    while (match) {
      const percent = Number(match[1] || match[3]);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
        const start = Math.max(0, match.index - 120);
        const end = Math.min(text.length, pattern.lastIndex);
        const resetEnd = Math.min(text.length, pattern.lastIndex + 140);
        const window = text.slice(start, end);
        matches.push({
          percent,
          window,
          confidence: scorePercentConfidence(match[0], window),
          resetText: extractResetText(text.slice(match.index, resetEnd)),
          resetConfidence: "medium"
        });
      }
      match = pattern.exec(text);
    }
    return matches;
  }

  function collectLinePercentWindows(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const percentMatch = extractPercent(lines[index]);
      const percent = percentMatch && percentMatch.percent;
      if (typeof percent !== "number") continue;
      const start = Math.max(0, index - 3);
      const end = Math.min(lines.length, index + 4);
      const window = lines.slice(start, index + 1).join("\n");
      const confidenceWindow = lines.slice(start, end).join("\n");
      const resetText = extractResetText(lines.slice(index, end).join(" "));
      matches.push({
        percent,
        line: lines[index],
        window,
        confidence: scorePercentConfidence(lines[index], confidenceWindow),
        resetText,
        resetConfidence: resetText ? "medium" : null
      });
    }
    return matches;
  }

  function extractPercent(value) {
    const match = String(value || "").match(/(\d{1,3})\s*%/);
    if (!match) return null;
    const percent = Number(match[1]);
    return Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? { percent, confidence: scorePercentConfidence(value, value) }
      : null;
  }

  function classifyCodexPercentWindow(match) {
    const normalized = normalizeForMatch(match.window);
    if (!hasAnyConcept(normalized, ["usage", "remaining"]) && !containsTerm(normalized, "codex")) return null;

    if (containsTerm(normalized, "spark")) return null;
    const fiveHourIndex = lastConceptIndex(normalized, "hours5");
    const weeklyIndex = lastConceptIndex(normalized, "weekly");
    const hasFiveHour = fiveHourIndex >= 0;
    const hasWeekly = weeklyIndex >= 0;
    const fiveHourIsClosest = hasFiveHour && (!hasWeekly || fiveHourIndex > weeklyIndex);
    const weeklyIsClosest = hasWeekly && (!hasFiveHour || weeklyIndex > fiveHourIndex);

    if (fiveHourIsClosest) return "codex5h";
    if (weeklyIsClosest) return "codexWeekly";
    return null;
  }

  function lastRegexIndex(value, pattern) {
    let lastIndex = -1;
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      lastIndex = match.index;
      match = pattern.exec(value);
    }
    return lastIndex;
  }

  function lastConceptIndex(value, concept) {
    return Math.max(...CONCEPT_PATTERNS[concept].map((pattern) => lastRegexIndex(value, pattern)));
  }

  function extractCredits(text) {
    const lines = text.includes("\n")
      ? text.split("\n").map((line) => line.trim()).filter(Boolean)
      : text.split(/(?=\b(?:credits?|credit balance|cr[eé]ditos?|saldo)\b)|(?<=\d)\s+/i).map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const currentLine = lines[index];
      const currentNormalized = normalizeForMatch(currentLine);
      if (!hasConcept(currentNormalized, "credits")) continue;
      const nextLine = lines[index + 1] || "";
      const value = extractInlineCreditValue(currentLine)
        ?? extractStandaloneCreditValue(nextLine);
      if (value === null) continue;
      const window = [currentLine, nextLine].filter(Boolean).join(" ");
      const normalized = normalizeForMatch(window);
      return {
        value,
        confidence: hasConcept(normalized, "remaining") ? "high" : "low"
      };
    }
    return null;
  }

  function extractInlineCreditValue(line) {
    const normalized = normalizeForMatch(line);
    const patterns = [
      /\b(?:credits?|creditos?)\s+(?:remaining|left|available|restantes?|disponibles?)\s*[:\-]?\s*(\d{1,9})\b/,
      /\b(?:remaining|left|available|restantes?|disponibles?)\s+(?:credits?|creditos?)\s*[:\-]?\s*(\d{1,9})\b/,
      /\bcredit\s+balance\s*[:\-]?\s*(\d{1,9})\b/,
      /\bsaldo(?:\s+de)?(?:\s+creditos?)?\s*[:\-]?\s*(\d{1,9})\b/,
      /^(?:credits?|creditos?)\s*[:\-]?\s*(\d{1,9})\b/,
      /\bcodex\s+credits?\s*[:\-]?\s*(\d{1,9})\b/
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function extractStandaloneCreditValue(line) {
    const match = normalizeForMatch(line).match(
      /^\s*(?:[$€£]\s*)?(\d{1,9})(?:[.,]0+)?\s*(?:credits?|creditos?)?\s*$/
    );
    return match ? Number(match[1]) : null;
  }

  function extractBankedResets(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const visibleCardCount = countBankedResetCards(text);

    for (let index = 0; index < lines.length; index += 1) {
      const currentNormalized = normalizeForMatch(lines[index]);
      if (!hasConcept(currentNormalized, "bankedResets")) continue;

      const labelTail = extractBankedResetLabelTail(lines[index]);
      const countWindow = [labelTail, ...lines.slice(index + 1, Math.min(lines.length, index + 3))];
      const explicitCount = extractBankedResetCount(countWindow);
      const expiryWindow = [labelTail, ...lines.slice(index + 1, Math.min(lines.length, index + 6))];
      const expiresText = extractExpiryText(expiryWindow);
      const count = explicitCount === null && expiresText && visibleCardCount > 0
        ? visibleCardCount
        : explicitCount;

      if (count === null && !expiresText) continue;
      return {
        label: /restablecimientos? completos?/i.test(lines[index])
          ? "Restablecimiento completo"
          : "Banked resets",
        count,
        countSource: explicitCount === null && count !== null ? "visible-card-count" : "explicit-number",
        expiresText,
        confidence: explicitCount !== null ? "high" : "medium",
        expiryConfidence: expiresText ? "high" : null
      };
    }

    return null;
  }

  function countBankedResetCards(text) {
    const matches = normalizeVisibleText(text).match(/\bbanked reset\b(?!s)|\bfull reset\b(?!s)|\brestablecimiento completo\b/gi);
    return matches ? matches.length : 0;
  }

  function extractBankedResetLabelTail(value) {
    const match = String(value || "").match(/(?:banked resets?|saved resets?|full resets?|restablecimientos? completos?|reinicios? (?:acumulados?|guardados?))[\s\S]*$/i);
    return match ? match[0] : String(value || "");
  }

  function extractBankedResetCount(lines) {
    for (let index = 0; index < lines.length; index += 1) {
      const beforeExpiry = String(lines[index] || "").split(/\b(?:expires?|expiration|expiry|valid until|vence(?:n)?|vencimiento|caduca(?:n)?)\b/i)[0];
      const match = index === 0
        ? beforeExpiry.match(/\b(\d{1,3})\b/)
        : beforeExpiry.match(/^\s*(?:count|cantidad|available|disponibles?)?\s*[:\-]?\s*(\d{1,3})\s*(?:available|disponibles?)?\s*$/i);
      if (!match) continue;
      const count = Number(match[1]);
      if (Number.isFinite(count) && count >= 0) return count;
    }
    return null;
  }

  function extractExpiryText(lines) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalized = normalizeForMatch(line);
      if (!hasConcept(normalized, "expiry")) continue;

      const match = line.match(/(?:expires?|expiration|expiry|valid until|vence(?:n)?|vencimiento|caduca(?:n)?)(?:\s+(?:at|on|el|a las|en))?\s*[:\-]?\s*(.*)$/i);
      const inlineValue = match && match[1] ? match[1].trim() : "";
      const value = inlineValue || String(lines[index + 1] || "").trim();
      return cleanExpiryText(value);
    }
    return null;
  }

  function cleanExpiryText(value) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[;|].*$/, "")
      .trim();
    if (!text || hasConcept(normalizeForMatch(text), "bankedResets")) return null;
    return text.slice(0, 100);
  }

  function extractResetText(text) {
    const match = normalizeVisibleText(text).match(/(?:resets?|renews?|refresh(?:es)?|reset|reinicia|reinicio|renueva|recarga)(?:\s+(?:at|on|a las|el|en))?\s+(.{1,80})/i);
    if (!match) return null;
    return cleanResetText(match[1]);
  }

  function parseMetricText(value, fallbackTitle) {
    const title = normalizeForMatch(fallbackTitle || "");
    const fields = parseCodexUsageText(`${fallbackTitle || ""} ${value || ""}`);
    if (containsTerm(title, "spark")) return null;
    const key = hasConcept(title, "weekly")
      ? "codexWeekly"
      : hasConcept(title, "credits")
        ? "codexCredits"
        : "codex5h";
    const parsed = fields[key];
    return parsed && parsed.structured ? parsed.structured : null;
  }

  function formatPercentValue(key, percent, resetText) {
    const reset = resetText ? `; resets ${resetText}` : "";
    return `${labelForMetricKey(key)}: ${percent}% remaining${reset}`;
  }

  function formatBankedResetsValue({ count, expiresText }) {
    const countText = count === null ? "count unavailable" : String(count);
    const expiryText = expiresText ? `; expires ${expiresText}` : "";
    return `Banked resets: ${countText}${expiryText}`;
  }

  function labelForMetricKey(key) {
    const labels = {
      codex5h: "5h limit",
      codexWeekly: "Weekly limit",
      codexCredits: "Credits",
      remainingCredits: "Credits",
      bankedResets: "Banked resets"
    };
    return labels[key] || key;
  }

  function cleanResetText(value) {
    if (!value) return null;
    const text = String(value)
      .replace(/\s+/g, " ")
      .replace(/[;|].*$/, "")
      .trim();
    const patterns = [
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)/i,
      /^((?:today|tomorrow|hoy|ma[nñ]ana)[, ]+(?:(?:at|a las)\s+)?\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /^((?:(?:in|en)\s+)?(?:\d+(?:[.,]\d+)?\s*(?:weeks?|semanas?|days?|dias?|días?|hours?|horas?|hrs?|h|minutes?|minutos?|mins?|m|seconds?|segundos?|secs?|s)\b[\s,]*(?:(?:and|y)\s+)?)+)/i,
      /^(\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /^(\d{1,2}\s+(?:de\s+)?\w+\.?(?:\s+(?:de\s+)?\d{4})?[, ]+(?:(?:at|a las)\s+)?\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i,
      /^([A-Z][a-z]{2,9}\.?\s+\d{1,2},?(?:\s+\d{4},?)?\s+(?:at\s+)?\d{1,2}:\d{2}(?:\s?(?:AM|PM))?)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  function parseResetAt(resetText, observedAt) {
    if (!Number.isFinite(observedAt)) return null;
    const text = normalizeForMatch(resetText).trim().replace(/^(?:in|en|at|on|a las|el)\s+/, "");
    if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})?$/.test(text)) {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const units = /(\d+(?:[.,]\d+)?)\s*(weeks?|semanas?|days?|dias?|hours?|horas?|hrs?|h|minutes?|minutos?|mins?|m|seconds?|segundos?|secs?|s)\b/g;
    const durations = [...text.matchAll(units)];
    if (durations.length && !text.replace(units, "").replace(/\b(?:and|y)\b/g, "").replace(/[\s,]/g, "")) {
      const durationMs = durations.reduce((total, [, amount, unit]) => {
        const factor = /^(?:w|sem)/.test(unit) ? 7 * ONE_DAY_MS
          : /^d/.test(unit) ? ONE_DAY_MS : /^h/.test(unit) ? ONE_HOUR_MS
            : /^m/.test(unit) ? 60000 : 1000;
        return total + Number(amount.replace(",", ".")) * factor;
      }, 0);
      return observedAt + durationMs;
    }
    const time = text.match(/^(.*?)\b(\d{1,2}):(\d{2})\s*(am|pm)?$/);
    if (!time) return null;
    let hours = Number(time[2]);
    const minutes = Number(time[3]);
    if (minutes > 59 || hours > 23 || (time[4] && (hours < 1 || hours > 12))) return null;
    if (time[4]) hours = hours % 12 + (time[4] === "pm" ? 12 : 0);
    const prefix = time[1].replace(/\b(?:at|a las|de)\b/g, " ").replace(/[,.]/g, " ").trim().replace(/\s+/g, " ");
    const observed = new Date(observedAt);
    const result = new Date(observedAt);
    result.setHours(hours, minutes, 0, 0);
    if (!prefix || /^(?:today|tomorrow|hoy|manana)$/.test(prefix)) {
      if (/^(?:tomorrow|manana)$/.test(prefix)
        || (!prefix && result.getTime() < observedAt - 60000)) result.setDate(result.getDate() + 1);
      return result.getTime();
    }
    const date = prefix.match(/^(?:(\d{1,2}) ([a-z]+)|([a-z]+) (\d{1,2}))(?: (\d{4}))?$/);
    if (!date) return null;
    const months = { jan: 0, ene: 0, feb: 1, mar: 2, apr: 3, abr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dec: 11, dic: 11 };
    const month = months[(date[2] || date[3]).slice(0, 3)];
    const day = Number(date[1] || date[4]);
    if (month === undefined || day < 1 || day > 31) return null;
    result.setFullYear(date[5] ? Number(date[5]) : observed.getFullYear(), month, day);
    if (result.getMonth() !== month || result.getDate() !== day) return null;
    if (!date[5] && result.getTime() < observedAt - 60000) {
      const nextYear = new Date(result);
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      if (nextYear.getTime() - observedAt <= 7 * ONE_DAY_MS) return nextYear.getTime();
    }
    return result.getTime();
  }

  function formatDuration(durationMs, { nominalWeek = false } = {}) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    const minutes = Math.floor(durationMs / 60000);
    if (nominalWeek && minutes === 7 * 24 * 60) return "1 week";
    if (minutes < 1) return "<1 min";
    if (minutes < 60) return `${minutes} min`;
    if (minutes < 1440) {
      const hours = Math.floor(minutes / 60);
      return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    }
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    return `${days} d${hours ? ` ${hours} hr` : ""}`;
  }

  function formatResetCountdown(resetAt, now = Date.now()) {
    if (!Number.isFinite(resetAt) || !Number.isFinite(now)) return null;
    if (resetAt <= now) return "Reset due · refresh usage";
    return formatDuration(resetAt - now);
  }

  function visibleField(snippet, structured, confidence = "medium") {
    const compact = String(snippet || "").replace(/\s+/g, " ").trim();
    return {
      value: compact.slice(0, 180),
      confidence,
      structured: structured || null,
      warning: "Read from public UI text; exact endpoint data was not used."
    };
  }

  function unavailableField() {
    return {
      value: null,
      confidence: "unavailable",
      warning: "Usage not exposed by ChatGPT UI"
    };
  }

  function normalizeVisibleText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function scorePercentConfidence(percentText, windowText) {
    const percentContext = normalizeForMatch(percentText);
    const window = normalizeForMatch(windowText);
    if (/\d{1,3}\s*%/.test(percentContext)) return "high";
    if (hasConcept(window, "remaining")) return "medium";
    return "low";
  }

  function hasAnyConcept(value, concepts) {
    return concepts.some((concept) => hasConcept(value, concept));
  }

  function hasConcept(value, concept) {
    return CONCEPT_PATTERNS[concept].some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }

  function containsTerm(value, term) {
    return new RegExp(`\\b${escapeRegExp(normalizeForMatch(term))}\\b`, "i").test(value);
  }

  function matchesUsageTerms(value, concepts) {
    const normalized = normalizeForMatch(value);
    return concepts.some((concept) => hasConcept(normalized, concept));
  }

  function buildConceptPatterns(terms) {
    const patterns = {};
    for (const [concept, values] of Object.entries(terms)) {
      patterns[concept] = values.map((term) => new RegExp(`\\b${escapeRegExp(normalizeForMatch(term)).replace(/\\ /g, "\\s+")}\\b`, "g"));
    }
    return patterns;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const api = {
    TERMS,
    formatDuration,
    formatRelativeTime,
    formatResetCountdown,
    formatTime,
    hasVisibleUsage,
    hasParsedUsageLimit,
    matchesUsageTerms,
    mergeUsageFields,
    normalizeRefreshPeriodMinutes,
    normalizeMetricField,
    parseCodexUsageText,
    parseResetAt,
    summarizeAvailability
  };

  globalScope.ChatGPTUsageConfig = CONFIG;
  globalScope.ChatGPTUsageModel = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ChatGPTUsageConfig: CONFIG,
      ChatGPTUsageModel: api
    };
  }
})(typeof self !== "undefined" ? self : globalThis);

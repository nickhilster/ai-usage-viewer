(function initContentScript() {
  "use strict";

  const EXTRACTOR_VERSION = "codex-analytics-v7";
  let snapshotTimer = null;
  let lastSnapshotSignature = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "usage:collectSnapshot") {
      sendResponse(collectSnapshot());
    }
    return false;
  });

  if (isCodexAnalyticsUsagePage()) scheduleSnapshotDelivery(1200);
  observeAnalyticsChanges();

  function observeAnalyticsChanges() {
    const root = document.body || document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (isCodexAnalyticsUsagePage()) scheduleSnapshotDelivery(500);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function scheduleSnapshotDelivery(delayMs) {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      const snapshot = collectSnapshot();
      const signature = JSON.stringify({
        pathCategory: snapshot.pathCategory,
        loginStatus: snapshot.loginStatus,
        plan: snapshot.plan,
        usage: snapshot.usage
      });
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      chrome.runtime.sendMessage({ type: "usage:contentSnapshot", payload: snapshot }).catch(() => {});
    }, delayMs);
  }

  function collectSnapshot() {
    const onAnalyticsPage = isCodexAnalyticsUsagePage();
    const analyticsDom = onAnalyticsPage ? collectCodexAnalyticsDom() : null;
    const safeText = collectSafeUiText();
    const sessionSignals = onAnalyticsPage ? collectSessionSignals(safeText) : {};
    const loginStatus = onAnalyticsPage
      ? detectLoginStatus(safeText, sessionSignals)
      : /\/(auth|login|signin)(\/|$)/i.test(location.pathname) ? "logged-out" : "unknown";
    const plan = detectPlan(safeText);
    const fallbackUsage = onAnalyticsPage ? extractUsage(safeText) : {};
    const structuredUsage = analyticsDom && analyticsDom.text
      ? extractUsage(analyticsDom.text)
      : null;
    const usage = ChatGPTUsageModel.mergeUsageFields(fallbackUsage, structuredUsage);
    const diagnosticText = analyticsDom && analyticsDom.text
      ? `${analyticsDom.text}\n${safeText}`
      : safeText;
    const codexAnalytics = onAnalyticsPage
      ? collectCodexAnalyticsDiagnostics(diagnosticText, usage, analyticsDom)
      : null;

    return {
      status: "ok",
      hostname: location.hostname,
      pathCategory: classifyPath(location.pathname),
      pageKind: detectPageKind(),
      loginStatus,
      sessionSignals,
      plan,
      modelLabel: null,
      usage,
      extractorVersion: EXTRACTOR_VERSION,
      domUsageVisible: Object.values(usage).some((field) => field && field.value),
      codexAnalytics,
      collectedAt: new Date().toISOString(),
      warnings: buildWarnings(loginStatus, plan, usage)
    };
  }

  function collectSafeUiText() {
    if (!isCodexAnalyticsUsagePage()) return "";
    const selectors = [
      "header",
      '[role="menu"]',
      '[role="menubar"]',
      '[role="dialog"]',
      '[data-testid*="account"]',
      '[data-testid*="profile"]',
      '[data-testid*="plan"]',
      '[data-testid*="billing"]',
      '[data-testid*="usage"]',
      '[aria-label*="account" i]',
      '[aria-label*="profile" i]',
      '[aria-label*="plan" i]',
      '[aria-label*="usage" i]',
      "button",
      "a"
    ];

    const parts = new Set();
    if (isCodexAnalyticsUsagePage()) {
      const mainText = getElementText(document.querySelector("main") || document.body);
      if (mainText) parts.add(mainText.slice(0, 16000));
    }

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isInsideConversation(element)) continue;
        const text = getElementText(element);
        if (!text) continue;
        if (isLikelyUsageText(text) || isLikelyUiChrome(element, text)) {
          parts.add(text.slice(0, 500));
        }
      }
    }

    return Array.from(parts).join("\n").slice(0, 24000);
  }

  function collectCodexAnalyticsDom(targetDocument = document) {
    const main = targetDocument.querySelector("main") || targetDocument.body;
    if (!main) return emptyAnalyticsDomSignals(targetDocument);

    const containers = new Set();
    const anchors = main.querySelectorAll([
      "h1", "h2", "h3", "h4", "h5", "h6",
      '[role="heading"]', "dt", "dd", "p", "span", "button",
      '[data-testid*="usage" i]', '[data-testid*="limit" i]',
      '[data-testid*="credit" i]', '[data-testid*="reset" i]'
    ].join(","));

    for (const element of anchors) {
      const anchorText = getOwnElementText(element);
      if (!anchorText || anchorText.length > 240 || !isLikelyUsageText(anchorText)) continue;
      containers.add(findBoundedUsageContainer(element, main));
      if (containers.size >= 80) break;
    }

    const parts = new Set();
    let progressbarCount = 0;
    let ariaValueCount = 0;
    let timeElementCount = 0;

    for (const container of containers) {
      const text = getElementText(container);
      if (text) parts.add(text.slice(0, 1600));

      const accessible = [container, ...container.querySelectorAll([
        '[role="progressbar"]', "[aria-valuenow]", "[aria-valuetext]",
        "[aria-label]", "time[datetime]"
      ].join(","))];
      for (const element of accessible) {
        const signals = getAccessibleValueSignals(element, targetDocument);
        for (const signal of signals.values) parts.add(signal);
        if (signals.progressbar) progressbarCount += 1;
        if (signals.ariaValue) ariaValueCount += 1;
        if (signals.timeElement) timeElementCount += 1;
      }
    }

    return {
      text: Array.from(parts).join("\n").slice(0, 16000),
      relevantContainerCount: containers.size,
      progressbarCount,
      ariaValueCount,
      timeElementCount,
      mainTextLength: getElementText(main).length,
      readyState: targetDocument.readyState
    };
  }

  function emptyAnalyticsDomSignals(targetDocument = document) {
    return {
      text: "",
      relevantContainerCount: 0,
      progressbarCount: 0,
      ariaValueCount: 0,
      timeElementCount: 0,
      mainTextLength: 0,
      readyState: targetDocument.readyState
    };
  }

  function findBoundedUsageContainer(element, main) {
    let current = element;
    let best = element;
    while (current.parentElement && current.parentElement !== main) {
      const parent = current.parentElement;
      const text = getElementText(parent);
      if (!text || text.length > 1600) break;
      best = parent;
      current = parent;
    }
    return best;
  }

  function getOwnElementText(element) {
    const directText = Array.from(element.childNodes || [])
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return directText || String(element.getAttribute("aria-label") || "").trim();
  }

  function getAccessibleValueSignals(element, targetDocument = document) {
    const values = new Set();
    const ariaLabel = String(element.getAttribute("aria-label") || "").trim();
    const labelledByText = String(element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => targetDocument.getElementById(id))
      .filter(Boolean)
      .map(getElementText)
      .filter(Boolean)
      .join(" ")
      .trim();
    const accessibleLabel = ariaLabel || labelledByText;
    const ariaValueText = String(element.getAttribute("aria-valuetext") || "").trim();
    const ariaValueNow = String(element.getAttribute("aria-valuenow") || "").trim();
    const dateTime = element.tagName && element.tagName.toLowerCase() === "time"
      ? String(element.getAttribute("datetime") || "").trim()
      : "";
    const visibleText = getElementText(element);

    if (accessibleLabel) values.add(accessibleLabel);
    if (ariaValueText) values.add(`${accessibleLabel} ${ariaValueText}`.trim());
    if (ariaValueNow) {
      const suffix = /^\d{1,3}(?:\.\d+)?$/.test(ariaValueNow) ? "%" : "";
      values.add(`${accessibleLabel} ${ariaValueNow}${suffix}`.trim());
    }
    if (dateTime) values.add(`${visibleText} ${dateTime}`.trim());

    return {
      values,
      progressbar: element.getAttribute("role") === "progressbar",
      ariaValue: Boolean(ariaValueText || ariaValueNow),
      timeElement: Boolean(dateTime)
    };
  }

  function isInsideConversation(element) {
    return Boolean(element.closest([
      '[data-message-author-role]',
      '[data-testid*="conversation"]',
      '[class*="conversation"]',
      "main article",
      "article"
    ].join(",")));
  }

  function isLikelyUiChrome(element, text) {
    const tag = element.tagName.toLowerCase();
    if (tag === "header") return text.length < 800;
    if (tag === "button" || tag === "a") return text.length < 160;
    return text.length < 500 && /(account|profile|plan|billing|usage|limit|credit|codex|plus|pro|team|enterprise|free|log in|sign up|upgrade)/i.test(text);
  }

  function isLikelyUsageText(text) {
    return ChatGPTUsageModel.matchesUsageTerms(text, ["usage", "remaining", "reset", "credits", "weekly", "hours5", "bankedResets", "expiry"])
      || /(codex|gpt|thinking|plan|billing|plus|pro|team|enterprise)/i.test(text);
  }

  function collectSessionSignals(text) {
    const lower = text.toLowerCase();
    const promptInput = document.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '#prompt-textarea',
      '[data-testid*="prompt"]',
      '[data-placeholder*="Message" i]',
      '[aria-label*="Message" i]',
      '[aria-label*="Ask" i]'
    ].join(","));
    const sendButton = document.querySelector([
      '[data-testid*="send"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Enviar" i]',
      'button[aria-label*="Submit" i]'
    ].join(","));
    const accountChrome = /(account|profile|settings|log out|logout|my plan|billing|workspace)/.test(lower);
    const loginChrome = /(log in|login|sign up|get started)/.test(lower);
    const modelChrome = /(chatgpt|gpt|codex|thinking|reasoning)/.test(lower);
    const appRoute = /^\/($|c\/|g\/|codex|usage|settings|admin|projects?)/i.test(location.pathname);

    return {
      promptInput: Boolean(promptInput && !isInsideConversation(promptInput)),
      sendButton: Boolean(sendButton && !isInsideConversation(sendButton)),
      accountChrome,
      loginChrome,
      modelChrome,
      appRoute
    };
  }

  function detectLoginStatus(text, signals) {
    const lower = text.toLowerCase();
    if (signals.promptInput || signals.sendButton || signals.accountChrome) {
      return "logged-in";
    }
    if (signals.appRoute && signals.modelChrome && !signals.loginChrome) return "logged-in";
    if (/(account|profile|settings|log out|logout|my plan|billing|workspace)/.test(lower)) return "logged-in";
    if (signals.loginChrome && !signals.promptInput && !signals.sendButton && !signals.accountChrome) return "logged-out";
    return "unknown";
  }

  function detectPlan(text) {
    const lower = text.toLowerCase();
    const planPatterns = [
      ["Enterprise", /\benterprise\b/],
      ["Team", /\bteam\b/],
      ["Pro", /\bpro\b/],
      ["Plus", /\bplus\b/],
      ["Free", /\bfree\b/]
    ];
    for (const [label, pattern] of planPatterns) {
      if (pattern.test(lower)) {
        return { value: label, confidence: "detected" };
      }
    }
    return { value: null, confidence: "unavailable" };
  }

  function detectPageKind() {
    const path = location.pathname.toLowerCase();
    if (path.includes("codex")) return "codex";
    if (path.includes("usage") || path.includes("billing")) return "usage";
    return "chatgpt";
  }

  function classifyPath(pathname) {
    const path = pathname.toLowerCase();
    if (path.includes("codex")) return "codex";
    if (path.includes("usage")) return "usage";
    if (path.includes("billing")) return "billing";
    return "chat";
  }

  function extractUsage(text) {
    const fields = {
      gpt55ShortWindow: unavailableField(),
      thinkingWeekly: unavailableField(),
      codexCredits: unavailableField(),
      remainingCredits: unavailableField(),
      codex5h: unavailableField(),
      codexWeekly: unavailableField()
    };

    if (isCodexAnalyticsUsagePage()) {
      Object.assign(fields, extractCodexAnalyticsUsage(text));
    }

    const normalized = text.replace(/\s+/g, " ");
    const snippets = normalized.split(/(?<=\.|\n)|(?=GPT|Codex|Thinking|Credits?|Usage|Limit|Remaining|Reset)/i);

    for (const snippet of snippets) {
      const s = snippet.trim();
      if (!s) continue;
      const lower = s.toLowerCase();
      if (/gpt-?5\.?5/.test(lower) && /(limit|usage|remaining|reset|message)/.test(lower)) {
        fields.gpt55ShortWindow = visibleField(s);
      }
      if (/(thinking|reasoning)/.test(lower) && /(weekly|week|usage|remaining|reset|message)/.test(lower)) {
        fields.thinkingWeekly = visibleField(s);
      }
      if (!fields.codexCredits.value && /codex/.test(lower) && /(credit|usage|remaining|limit|reset)/.test(lower)) {
        fields.codexCredits = visibleField(s);
      }
      if (!fields.remainingCredits.value && /(remaining|left)/.test(lower) && /credits?/.test(lower)) {
        fields.remainingCredits = visibleField(s);
      }
    }

    return fields;
  }

  function extractCodexAnalyticsUsage(text) {
    return ChatGPTUsageModel.parseCodexUsageText(text);
  }

  function collectCodexAnalyticsDiagnostics(text, usage, analyticsDom) {
    const keys = ["codex5h", "codexWeekly", "codexCredits", "bankedResets"];
    const foundKeys = keys.filter((key) => usage[key] && usage[key].value);
    return {
      pageDetected: true,
      foundKeys,
      textLength: text.length,
      hasResetText: ChatGPTUsageModel.matchesUsageTerms(text, ["reset"]),
      hasRemainingText: ChatGPTUsageModel.matchesUsageTerms(text, ["remaining"]),
      hasCreditsText: ChatGPTUsageModel.matchesUsageTerms(text, ["credits"]),
      hasBankedResetsText: ChatGPTUsageModel.matchesUsageTerms(text, ["bankedResets"]),
      hasExpiryText: ChatGPTUsageModel.matchesUsageTerms(text, ["expiry"]),
      domSignals: analyticsDom ? {
        relevantContainerCount: analyticsDom.relevantContainerCount,
        progressbarCount: analyticsDom.progressbarCount,
        ariaValueCount: analyticsDom.ariaValueCount,
        timeElementCount: analyticsDom.timeElementCount,
        mainTextLength: analyticsDom.mainTextLength,
        readyState: analyticsDom.readyState
      } : null
    };
  }

  function visibleField(snippet, structured) {
    const compact = snippet.replace(/\s+/g, " ").trim();
    return {
      value: compact.slice(0, 180),
      confidence: "visible",
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

  function buildWarnings(loginStatus, plan, usage) {
    const warnings = [];
    if (loginStatus !== "logged-in") warnings.push("Login status is not confirmed from visible UI.");
    if (!plan.value) warnings.push("Plan is not visible in the current ChatGPT UI.");
    for (const [key, field] of Object.entries(usage)) {
      if (!field.value) warnings.push(`${key}: Usage not exposed by ChatGPT UI.`);
    }
    return warnings;
  }

  function isCodexAnalyticsUsagePage() {
    return location.hostname === "chatgpt.com"
      && isCodexAnalyticsPath(location.pathname);
  }

  function isCodexAnalyticsPath(pathname) {
    const path = String(pathname || "").toLowerCase();
    return path.includes("/codex/") && path.includes("/settings/analytics");
  }

  function getElementText(element) {
    return String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
})();

(function initClaudeContentScript(globalScope) {
  "use strict";

  if (globalScope.__claudeUsageReaderInstalled) return;
  globalScope.__claudeUsageReaderInstalled = true;

  const EXTRACTOR_VERSION = "claude-usage-v1";
  let snapshotTimer = null;
  let lastSnapshotSignature = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "usage:collectSnapshot") sendResponse(collectSnapshot());
    return false;
  });

  observeChanges();
  if (isUsageRoute()) scheduleSnapshotDelivery(1200);

  function isUsageRoute() {
    return location.hostname.toLowerCase() === "claude.ai"
      && location.pathname.replace(/\/$/, "") === "/new"
      && location.hash === "#settings/usage";
  }

  function visibleText(element) {
    return String(element && (element.innerText || element.textContent) || "")
      .replace(/\r/g, "").trim();
  }

  function meterHeading(meter, dialog) {
    let node = meter.parentElement;
    while (node && node !== dialog) {
      const text = visibleText(node).toLowerCase();
      const session = text.includes("current session");
      const weekly = text.includes("weekly limits");
      if (session !== weekly) return session ? "Current session" : "Weekly limits";
      node = node.parentElement;
    }
    return null;
  }

  function parserText(dialog) {
    const lines = visibleText(dialog).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const meter of dialog.querySelectorAll('[role="meter"]')) {
      const heading = meterHeading(meter, dialog);
      const value = String(meter.getAttribute("aria-valuetext")
        || (meter.getAttribute("aria-valuenow") !== null ? `${meter.getAttribute("aria-valuenow")}% used` : "")).trim();
      if (!heading || !value) continue;
      const index = lines.findIndex((line) => line.toLowerCase() === heading.toLowerCase());
      if (index >= 0) lines.splice(index + 1, 0, value);
    }
    return lines.join("\n");
  }

  function collectSnapshot() {
    const onUsagePage = isUsageRoute();
    const dialog = onUsagePage ? document.querySelector('[role="dialog"]') : null;
    const bodyText = visibleText(document.body || document.documentElement);
    const parsed = ClaudeUsageProvider.parseUsageText(dialog ? parserText(dialog) : "", new Date().toISOString());
    const loginStatus = /\b(?:sign in|log in)\b/i.test(bodyText) && !dialog
      ? "logged-out" : dialog ? "logged-in" : "unknown";
    return {
      status: "ok",
      hostname: location.hostname,
      pathCategory: onUsagePage ? "claude-usage" : "other",
      loginStatus,
      plan: parsed.plan,
      usage: loginStatus === "logged-out" ? {} : parsed.usage,
      extractorVersion: EXTRACTOR_VERSION,
      domUsageVisible: loginStatus !== "logged-out" && ClaudeUsageProvider.hasVisibleUsage({ usage: parsed.usage }),
      claudeUsage: onUsagePage ? { pageDetected: true, ready: parsed.ready, meterCount: dialog ? dialog.querySelectorAll('[role="meter"]').length : 0 } : null,
      collectedAt: parsed.collectedAt,
      warnings: parsed.ready || loginStatus === "logged-out" ? [] : ["Claude usage is still rendering."]
    };
  }

  function scheduleSnapshotDelivery(delayMs) {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      const snapshot = collectSnapshot();
      const signature = JSON.stringify({
        loginStatus: snapshot.loginStatus,
        plan: snapshot.plan,
        usage: snapshot.usage,
        ready: snapshot.claudeUsage && snapshot.claudeUsage.ready
      });
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      chrome.runtime.sendMessage({ type: "usage:contentSnapshot", payload: snapshot }).catch(() => {});
    }, delayMs);
  }

  function observeChanges() {
    const root = document.body || document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (isUsageRoute()) scheduleSnapshotDelivery(500);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  }
})(typeof self !== "undefined" ? self : globalThis);

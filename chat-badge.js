(function initChatBadge(globalScope) {
  "use strict";

  const STALE_AFTER_MS = 30 * 60 * 1000;
  const POSITION_KEY = "chatgptUsageMonitor.badgePosition";
  const DEFAULT_POSITION = Object.freeze({ left: 160, bottom: 16 });
  const mounted = new WeakMap();

  function percent(state, key) {
    const value = state && state.snapshot && state.snapshot.usage
      && state.snapshot.usage[key] && state.snapshot.usage[key].structured
      && state.snapshot.usage[key].structured.remainingPercent;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? `${value}% left` : "Unavailable";
  }

  function successfulAt(state) {
    return state && (state.dataCollectedAt || state.lastRefreshAt);
  }

  function isStale(state, now) {
    const success = Date.parse(successfulAt(state));
    if (!Number.isFinite(success)) return true;
    if (now - success > STALE_AFTER_MS) return true;
    const attempt = Date.parse(state.lastRefreshAttemptAt);
    return Number.isFinite(attempt) && attempt > success
      && state.status !== "usage-current"
      && state.status !== "refreshing-codex-analytics";
  }

  function element(document, tag, role, text) {
    const node = document.createElement(tag);
    if (role) node.setAttribute("data-role", role);
    if (text) node.textContent = text;
    return node;
  }

  async function mount(document, chromeApi, now = () => Date.now()) {
    if (mounted.has(document)) return mounted.get(document);
    const existing = document.querySelector && document.querySelector("[data-chatgpt-usage-badge]");
    if (existing && existing.__chatGPTUsageBadge) return existing.__chatGPTUsageBadge;
    const host = element(document, "div");
    host.setAttribute("data-chatgpt-usage-badge", "");
    host.style.position = "fixed";
    host.style.left = `${DEFAULT_POSITION.left}px`;
    host.style.bottom = `${DEFAULT_POSITION.bottom}px`;
    host.style.zIndex = "2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const style = element(document, "style");
    style.textContent = `
      :host { all: initial; color-scheme: light dark; }
      * { box-sizing: border-box; }
      .wrap { font: 13px/1.4 system-ui, sans-serif; color: #f4f6fb; }
      button { font: inherit; cursor: pointer; }
      .pill { border: 1px solid #656f86; border-radius: 999px; padding: 8px 12px;
        background: #202c47; color: #f4f6fb; box-shadow: 0 3px 14px #0005; }
      .card { width: 230px; margin-bottom: 8px; border-radius: 12px; padding: 12px;
        background: #202c47; color: #f4f6fb; box-shadow: 0 4px 18px #0007; }
      .row { margin: 0 0 6px; }
      .actions { display: flex; gap: 8px; margin-top: 10px; }
      .actions button { border: 1px solid #8292b2; border-radius: 6px; padding: 4px 7px;
        color: inherit; background: #33456b; }
      .pill:focus-visible, .actions button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      [hidden] { display: none !important; }
    `;
    const wrap = element(document, "div");
    wrap.className = "wrap";
    const details = element(document, "div", "details");
    details.className = "card";
    details.hidden = true;
    const five = element(document, "div", "five-hour");
    const weekly = element(document, "div", "weekly");
    const refreshed = element(document, "div", "refreshed");
    const actions = element(document, "div");
    actions.className = "actions";
    const retry = element(document, "button", "retry", "Retry");
    retry.setAttribute("type", "button");
    const open = element(document, "button", "open-usage", "Open usage");
    open.setAttribute("type", "button");
    actions.append(retry, open);
    details.append(five, weekly, refreshed, actions);
    const pill = element(document, "button", "pill");
    pill.className = "pill";
    pill.setAttribute("type", "button");
    pill.setAttribute("aria-expanded", "false");
    pill.setAttribute("aria-label", "Codex 5-hour usage. Drag to move; click for details.");
    pill.style.cursor = "grab";
    pill.style.touchAction = "none";
    let drag = null;
    let suppressClick = false;
    const move = (event) => {
      if (!drag) return;
      const maxLeft = Math.max(0, globalScope.innerWidth - host.offsetWidth);
      const maxBottom = Math.max(0, globalScope.innerHeight - host.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, event.clientX - drag.offsetX));
      const bottom = Math.min(maxBottom, Math.max(0, globalScope.innerHeight - event.clientY - drag.offsetY));
      host.style.left = `${left}px`;
      host.style.right = "auto";
      host.style.bottom = `${bottom}px`;
      drag.moved = drag.moved || Math.abs(left - drag.startLeft) > 3 || Math.abs(bottom - drag.startBottom) > 3;
    };
    const stopDrag = (event) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      pill.style.cursor = "grab";
      if (pill.hasPointerCapture && pill.hasPointerCapture(event.pointerId)) pill.releasePointerCapture(event.pointerId);
      globalScope.removeEventListener("pointermove", move);
      globalScope.removeEventListener("pointerup", stopDrag);
      globalScope.removeEventListener("pointercancel", stopDrag);
      if (moved) {
        suppressClick = true;
        event.preventDefault();
        event.stopPropagation();
        chromeApi.storage.local.set({ [POSITION_KEY]: {
          left: Number.parseFloat(host.style.left),
          bottom: Number.parseFloat(host.style.bottom)
        } }).catch(() => {});
      }
    };
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = {
        offsetX: event.clientX - host.getBoundingClientRect().left,
        offsetY: event.clientY - host.getBoundingClientRect().top,
        startLeft: Number.parseFloat(host.style.left) || 0,
        startBottom: Number.parseFloat(host.style.bottom) || 0,
        moved: false
      };
      pill.style.cursor = "grabbing";
      if (pill.setPointerCapture) pill.setPointerCapture(event.pointerId);
      globalScope.addEventListener("pointermove", move);
      globalScope.addEventListener("pointerup", stopDrag);
      globalScope.addEventListener("pointercancel", stopDrag);
    });
    pill.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      details.hidden = !details.hidden;
      pill.setAttribute("aria-expanded", String(!details.hidden));
    });
    retry.addEventListener("click", () => chromeApi.runtime.sendMessage({ type: "usage:refresh" }));
    open.addEventListener("click", () => chromeApi.runtime.sendMessage({ type: "usage:openCodexAnalytics" }));
    wrap.append(details, pill);
    shadow.append(style, wrap);
    document.body.append(host);

    let lastState;
    function render(state) {
      lastState = state;
      const fiveValue = percent(state, "codex5h");
      const weeklyValue = percent(state, "codexWeekly");
      const hasValue = fiveValue !== "Unavailable" || weeklyValue !== "Unavailable";
      const stale = hasValue && isStale(state, now());
      const age = ChatGPTUsageModel.formatRelativeTime(successfulAt(state), now());
      pill.textContent = hasValue ? `Codex 5-hour: ${fiveValue}${stale ? " · Stale" : ""}` : "Codex usage: Unavailable";
      five.textContent = `5-hour: ${fiveValue}`;
      weekly.textContent = `Weekly: ${weeklyValue}`;
      refreshed.textContent = `Last refresh: ${age}${stale ? " · Stale" : ""}`;
    }

    const badge = { host, render };
    host.__chatGPTUsageBadge = badge;
    mounted.set(document, badge);
    let localUpdateReceived = false;
    chromeApi.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[ChatGPTUsageConfig.storageKeys.state]) {
        localUpdateReceived = true;
        render(changes[ChatGPTUsageConfig.storageKeys.state].newValue);
      }
    });
    setInterval(() => render(lastState), 60 * 1000);
    const data = await chromeApi.storage.local.get([ChatGPTUsageConfig.storageKeys.state, POSITION_KEY]);
    if (!localUpdateReceived) render(data[ChatGPTUsageConfig.storageKeys.state]);
    const savedPosition = data[POSITION_KEY];
    if (savedPosition && Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.bottom)) {
      host.style.left = `${Math.min(Math.max(0, savedPosition.left), Math.max(0, globalScope.innerWidth - host.offsetWidth))}px`;
      host.style.right = "auto";
      host.style.bottom = `${Math.min(Math.max(0, savedPosition.bottom), Math.max(0, globalScope.innerHeight - host.offsetHeight))}px`;
    }
    return badge;
  }

  globalScope.ChatGPTUsageBadge = { mount };
  if (typeof module !== "undefined" && module.exports) module.exports = { mount };
  if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    if (document.body) mount(document, chrome).catch(() => {});
    else document.addEventListener("DOMContentLoaded", () => mount(document, chrome).catch(() => {}), { once: true });
  }
})(typeof self !== "undefined" ? self : globalThis);

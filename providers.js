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
    const id = input.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) {
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
    const hostnames = input.hostnames.map((hostname) => hostname.toLowerCase());
    for (const provider of registry.values()) {
      if (provider.stateKey === input.stateKey) {
        throw new Error(`Provider stateKey is already registered: ${input.stateKey}`);
      }
      if (provider.retainedSignInTabKey === input.retainedSignInTabKey) {
        throw new Error(`Provider retainedSignInTabKey is already registered: ${input.retainedSignInTabKey}`);
      }
      const duplicateHostname = hostnames.find((hostname) => provider.hostnames.includes(hostname));
      if (duplicateHostname) {
        throw new Error(`Provider hostname is already registered: ${duplicateHostname}`);
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
      hostnames: Object.freeze(hostnames),
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
    for (const provider of listProviders()) {
      try {
        if (provider.isUsageUrl(url)) return provider;
      } catch {
        // A broken third-party provider cannot prevent later providers from matching.
      }
    }
    return undefined;
  }

  function providerForHostname(hostname) {
    const normalized = typeof hostname === "string" ? hostname.toLowerCase() : "";
    return listProviders().find((provider) => provider.hostnames.includes(normalized));
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

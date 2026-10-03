const { UsageProviders } = require("../../providers.js");

const FAKE_KEY = "fake:session";

function fakeProvider(overrides = {}) {
  return {
    id: "fake",
    name: "Fake",
    usageUrl: "https://fake.example/usage",
    hostnames: ["fake.example"],
    hostPatterns: ["https://fake.example/*"],
    stateKey: "aiUsageViewer.state.fake",
    retainedSignInTabKey: "aiUsageViewer.retainedSignInTab.fake",
    counters: [{
      key: FAKE_KEY,
      label: "Fake session usage",
      limitName: "session",
      windowMs: 5 * 60 * 60 * 1000
    }],
    messages: {
      loadFailed: "The extension could not create the temporary Fake usage tab.",
      readerUnresponsive: "The temporary Fake usage page did not respond after loading.",
      noNewData: "Fake usage rendered, but no new visible usage values were detected yet.",
      routeNotDetected: "The temporary tab responded, but the Fake usage view was not detected yet.",
      contentScriptMissing: "Fake usage content script did not respond.",
      loadTimeout: "Timed out loading Fake usage."
    },
    isUsageUrl: (url) => String(url).startsWith("https://fake.example/usage"),
    isUsagePageSnapshot: (snapshot) => Boolean(snapshot && snapshot.fakeUsagePage),
    hasVisibleUsage: (snapshot) => Boolean(snapshot && snapshot.usage
      && snapshot.usage[FAKE_KEY] && snapshot.usage[FAKE_KEY].value),
    hasParsedUsageLimit: (snapshot) => Number.isFinite(snapshot && snapshot.usage
      && snapshot.usage[FAKE_KEY] && snapshot.usage[FAKE_KEY].structured
      && snapshot.usage[FAKE_KEY].structured.remainingPercent),
    mergeUsageFields: (a, b) => ({ ...(a || {}), ...(b || {}) }),
    ...overrides
  };
}

function fakeSnapshot(remainingPercent, collectedAt, resetText = "in 2 hours") {
  return {
    status: "ok",
    loginStatus: "logged-in",
    fakeUsagePage: true,
    hostname: "fake.example",
    usage: {
      [FAKE_KEY]: {
        value: `${remainingPercent}%`,
        structured: { remainingPercent, resetText }
      }
    },
    domUsageVisible: true,
    collectedAt
  };
}

function withFakeProvider(run, overrides) {
  return withProvider(fakeProvider(overrides), run);
}

function withProvider(definition, run) {
  const provider = UsageProviders.registerProvider(definition);
  try {
    return run(provider);
  } finally {
    UsageProviders.unregisterProvider(provider.id);
  }
}

async function withFakeProviderAsync(run, overrides) {
  const provider = UsageProviders.registerProvider(fakeProvider(overrides));
  try {
    return await run(provider);
  } finally {
    UsageProviders.unregisterProvider(provider.id);
  }
}

module.exports = {
  FAKE_KEY,
  fakeProvider,
  fakeSnapshot,
  withFakeProvider,
  withFakeProviderAsync,
  withProvider
};

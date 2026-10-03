const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ChatGPTUsageConfig } = require("../usage-model.js");
const { UsageProviders } = require("../providers.js");
const { FAKE_KEY, fakeProvider, withFakeProvider, withProvider } = require("./helpers/fake-provider.js");

test("the built-in ChatGPT provider keeps its grandfathered keys and windows", () => {
  const chatgpt = UsageProviders.getProvider("chatgpt");
  assert.equal(chatgpt.name, "ChatGPT");
  assert.equal(chatgpt.stateKey, ChatGPTUsageConfig.storageKeys.state);
  assert.equal(chatgpt.retainedSignInTabKey, ChatGPTUsageConfig.storageKeys.retainedSignInTab);
  assert.deepEqual(
    chatgpt.counters.map(({ key, label, limitName, windowMs }) => ({ key, label, limitName, windowMs })),
    [
      { key: "codexWeekly", label: "Weekly usage", limitName: "weekly", windowMs: 7 * 24 * 3600000 },
      { key: "codex5h", label: "5-hour usage", limitName: "5-hour", windowMs: 5 * 3600000 }
    ]
  );
  assert.deepEqual([...chatgpt.hostnames], ["chatgpt.com"]);
  assert.deepEqual([...chatgpt.hostPatterns], ["https://chatgpt.com/*"]);
});

test("ChatGPT recognises only the Codex Analytics settings page", () => {
  const { isUsageUrl } = UsageProviders.getProvider("chatgpt");
  assert.equal(isUsageUrl("https://chatgpt.com/codex/cloud/settings/analytics"), true);
  assert.equal(isUsageUrl("https://chatgpt.com/codex/abc/settings/analytics?x=1"), true);
  assert.equal(isUsageUrl("https://chatgpt.com/"), false);
  assert.equal(isUsageUrl("https://example.com/codex/cloud/settings/analytics"), false);
  assert.equal(isUsageUrl("not a url"), false);
});

test("registerProvider rejects duplicate ids and malformed definitions", () => {
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ id: undefined })), /Provider id/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ id: "chatgpt" })), /already registered/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ id: "Bad Id" })), /Provider id/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ usageUrl: "" })), /usageUrl/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ counters: [] })), /counters/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ isUsageUrl: null })), /isUsageUrl/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({ messages: { loadFailed: "x" } })), /messages/);
  assert.equal(UsageProviders.getProvider("fake"), undefined);
});

test("provider-owned storage keys and hostnames are unique", () => {
  const chatgpt = UsageProviders.getProvider("chatgpt");
  try {
    assert.throws(() => UsageProviders.registerProvider(fakeProvider({
      stateKey: chatgpt.stateKey
    })), /stateKey/);
    assert.throws(() => UsageProviders.registerProvider(fakeProvider({
      retainedSignInTabKey: chatgpt.retainedSignInTabKey
    })), /retainedSignInTabKey/);
    assert.throws(() => UsageProviders.registerProvider(fakeProvider({
      hostnames: ["CHATGPT.COM"]
    })), /hostname/i);
  } finally {
    UsageProviders.unregisterProvider("fake");
  }
});

test("a throwing URL predicate cannot block later providers", () => {
  const throwing = fakeProvider({
    id: "throwing",
    usageUrl: "https://throwing.example/usage",
    hostnames: ["throwing.example"],
    hostPatterns: ["https://throwing.example/*"],
    stateKey: "aiUsageViewer.state.throwing",
    retainedSignInTabKey: "aiUsageViewer.retainedSignInTab.throwing",
    counters: [{
      key: "throwing:session",
      label: "Throwing session usage",
      limitName: "session",
      windowMs: 1000
    }],
    isUsageUrl() { throw new Error("broken provider predicate"); }
  });
  withProvider(throwing, () => {
    withFakeProvider((provider) => {
      assert.equal(UsageProviders.providerForUrl("https://fake.example/usage"), provider);
    });
  });
});

test("non-grandfathered counter keys must be namespaced and globally unique", () => {
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [{ key: "session", label: "Fake", limitName: "session", windowMs: 1000 }]
  })), /must start with "fake:"/);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    grandfatheredCounterKeys: true,
    counters: [{ key: "codexWeekly", label: "Fake", limitName: "weekly", windowMs: 1000 }]
  })), /duplicate counter key/i);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [
      { key: "fake:a", label: "A", limitName: "a", windowMs: 1000 },
      { key: "fake:a", label: "B", limitName: "b", windowMs: 1000 }
    ]
  })), /duplicate counter key/i);
  assert.throws(() => UsageProviders.registerProvider(fakeProvider({
    counters: [{ key: "fake:a", label: "A", limitName: "a", windowMs: 0 }]
  })), /windowMs/);
});

test("lookups cover counters, urls and hostnames, and unregister removes them", () => {
  withFakeProvider((provider) => {
    assert.deepEqual(UsageProviders.listProviders().map((p) => p.id), ["chatgpt", "fake"]);
    assert.equal(UsageProviders.counterDefinition(FAKE_KEY).windowMs, 5 * 3600000);
    assert.equal(UsageProviders.providerForCounterKey(FAKE_KEY), provider);
    assert.equal(UsageProviders.providerForCounterKey("codex5h").id, "chatgpt");
    assert.equal(UsageProviders.providerForUrl("https://fake.example/usage#x"), provider);
    assert.equal(UsageProviders.providerForHostname("fake.example"), provider);
    assert.equal(UsageProviders.providerForHostname("chatgpt.com").id, "chatgpt");
    assert.equal(UsageProviders.providerForHostname("nowhere.example"), undefined);
    const fake = UsageProviders.allCounters().find((counter) => counter.key === FAKE_KEY);
    assert.deepEqual(
      { providerId: fake.providerId, providerName: fake.providerName, limitName: fake.limitName },
      { providerId: "fake", providerName: "Fake", limitName: "session" }
    );
  });
  assert.equal(UsageProviders.getProvider("fake"), undefined);
  assert.equal(UsageProviders.counterDefinition(FAKE_KEY), undefined);
  assert.equal(UsageProviders.unregisterProvider("fake"), false);
});

test("new providers get namespaced default storage keys", () => {
  assert.deepEqual(UsageProviders.defaultStorageKeys("claude"), {
    stateKey: "aiUsageViewer.state.claude",
    retainedSignInTabKey: "aiUsageViewer.retainedSignInTab.claude"
  });
});

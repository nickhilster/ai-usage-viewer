const assert = require("node:assert/strict");
const { test } = require("node:test");

const { CodexCapacityMonitor: monitor } = require("../capacity-monitor.js");
const { FAKE_KEY, fakeSnapshot, withFakeProvider } = require("./helpers/fake-provider.js");

const NOW = "2026-09-29T12:00:00.000Z";

test("COUNTERS reflects the registry and keeps the {key,label} shape", () => {
  assert.deepEqual(monitor.COUNTERS, [
    { key: "codexWeekly", label: "Weekly usage" },
    { key: "codex5h", label: "5-hour usage" }
  ]);
  withFakeProvider(() => {
    assert.deepEqual(monitor.COUNTERS.map((counter) => counter.key), ["codexWeekly", "codex5h", FAKE_KEY]);
  });
  assert.equal(monitor.COUNTERS.length, 2);
});

test("a registered provider's counters are extracted from a snapshot", () => {
  withFakeProvider(() => {
    const available = monitor.extractAvailableCounters(fakeSnapshot(60, NOW, "in 2 hours"));
    assert.deepEqual(available, [{
      key: FAKE_KEY,
      label: "Fake session usage",
      remainingPercent: 60,
      resetText: "in 2 hours"
    }]);
  });
});

test("initial pace estimates use the provider's own window length", () => {
  withFakeProvider(() => {
    const now = Date.parse(NOW);
    const estimate = monitor.estimateDisplayedTimeRemaining({}, FAKE_KEY, 50, now, now);
    assert.equal(estimate.status, "nominal");
    assert.equal(estimate.durationMs, 0.5 * 5 * 3600000);
    assert.equal(
      monitor.formatPaceTooltip(estimate, FAKE_KEY),
      "Initial estimate from your remaining session capacity."
    );
  });
});

test("pace state has a slot for every registered counter", () => {
  withFakeProvider(() => {
    const state = monitor.normalizeMonitorState({ pace: { [FAKE_KEY]: [{ at: 1, remainingPercent: 50 }] } });
    assert.deepEqual(Object.keys(state.pace), ["codexWeekly", "codex5h", FAKE_KEY]);
    assert.deepEqual(state.pace[FAKE_KEY], [{ at: 1, remainingPercent: 50 }]);
  });
});

const { FAKE_KEY: KEY, fakeSnapshot: snap, withFakeProvider: withFake } = require("./helpers/fake-provider.js");

function chatgptPreviousState() {
  const before = Date.parse(NOW) - 5 * 60000;
  return {
    before,
    state: {
      version: 2,
      counters: {
        codexWeekly: {
          remainingPercent: 80, resetText: null, sessionId: "s",
          lastSeenAt: new Date(before).toISOString()
        }
      },
      pace: { codexWeekly: [{ at: before, remainingPercent: 80 }], codex5h: [] },
      paceSessionId: "s",
      availableKeys: ["codexWeekly"],
      updatedAt: new Date(before).toISOString()
    }
  };
}

test("a scoped evaluation leaves other providers' counters and pace untouched", () => {
  const { before, state } = chatgptPreviousState();
  withFake(() => {
    const scoped = monitor.evaluateSnapshot(snap(60, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(scoped.state.counters.codexWeekly.remainingPercent, 80);
    assert.equal(scoped.state.counters[KEY].remainingPercent, 60);
    assert.deepEqual(scoped.state.pace.codexWeekly, [{ at: before, remainingPercent: 80 }]);
    assert.deepEqual([...scoped.state.availableKeys].sort(), ["codexWeekly", KEY]);

    // Documents why scoping exists: an unscoped evaluation wipes the other provider's pace.
    const unscoped = monitor.evaluateSnapshot(snap(60, NOW), state, null, NOW, "s");
    assert.deepEqual(unscoped.state.pace.codexWeekly, []);
    assert.deepEqual(unscoped.state.availableKeys, [KEY]);
  });
});

test("the toolbar visual is the lowest remaining across providers", () => {
  const { state } = chatgptPreviousState();
  withFake(() => {
    const low = monitor.evaluateSnapshot(snap(30, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(low.visual.badgeText, "30");
    assert.equal(low.visual.counter.key, KEY);
    const high = monitor.evaluateSnapshot(snap(95, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.equal(high.visual.badgeText, "80");
    assert.equal(high.visual.counter.key, "codexWeekly");
  });
});

test("threshold events are raised only for the scoped provider's counters", () => {
  const { before, state } = chatgptPreviousState();
  state.counters[KEY] = {
    remainingPercent: 30, resetText: null, sessionId: "s",
    lastSeenAt: new Date(before).toISOString()
  };
  state.availableKeys = ["codexWeekly", KEY];
  withFake(() => {
    const result = monitor.evaluateSnapshot(snap(8, NOW), state, null, NOW, "s", { providerId: "fake" });
    assert.deepEqual(result.events.map((event) => [event.key, event.type]), [[KEY, "low"]]);
  });
});

test("an unknown provider scope changes nothing", () => {
  const { state } = chatgptPreviousState();
  const result = monitor.evaluateSnapshot(null, state, null, NOW, "s", { providerId: "nope" });
  assert.deepEqual(result.events, []);
  assert.equal(result.state.counters.codexWeekly.remainingPercent, 80);
  assert.deepEqual(result.state.availableKeys, ["codexWeekly"]);
});

test("removeProviderCounters clears one provider and keeps the rest", () => {
  const { before, state } = chatgptPreviousState();
  state.counters[KEY] = {
    remainingPercent: 30, resetText: null, sessionId: "s",
    lastSeenAt: new Date(before).toISOString()
  };
  state.pace[KEY] = [{ at: before, remainingPercent: 30 }];
  state.availableKeys = ["codexWeekly", KEY];
  withFake(() => {
    const next = monitor.removeProviderCounters(state, "fake", NOW);
    assert.deepEqual(Object.keys(next.counters), ["codexWeekly"]);
    assert.deepEqual(next.availableKeys, ["codexWeekly"]);
    assert.deepEqual(next.pace[KEY], []);
    assert.deepEqual(next.pace.codexWeekly, [{ at: before, remainingPercent: 80 }]);
    assert.equal(next.updatedAt, NOW);
    assert.equal(next.paceSessionId, "s");
  });
});

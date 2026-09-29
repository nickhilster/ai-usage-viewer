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

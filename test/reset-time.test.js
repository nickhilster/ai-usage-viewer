const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ChatGPTUsageModel: model } = require("../usage-model.js");
const { CodexCapacityMonitor: monitor } = require("../capacity-monitor.js");

const hour = 3600000;
const minute = 60000;
const day = 24 * hour;
const observed = new Date(2026, 8, 5, 12, 0).getTime();

test("reset countdowns share the approved compact duration wording", () => {
  assert.equal(model.formatResetCountdown(observed + 3 * hour + 20 * minute, observed), "3 hr 20 min");
  assert.equal(model.formatResetCountdown(observed + 42 * minute, observed), "42 min");
  assert.equal(model.formatResetCountdown(observed + 2 * day + 4 * hour, observed), "2 d 4 hr");
  assert.equal(model.formatResetCountdown(observed + 30000, observed), "<1 min");
  assert.equal(model.formatResetCountdown(observed - 1, observed), "Reset due · refresh usage");
  assert.equal(model.formatResetCountdown(null, observed), null);
});

test("relative reset durations are anchored to the observation, not popup opening", () => {
  for (const text of ["in 1 hr", "1 h", "en 1 hora", "60 minutes"]) {
    assert.equal(model.parseResetAt(text, observed), observed + hour, text);
  }
  assert.equal(model.parseResetAt("1 h 30 min", observed), observed + 1.5 * hour);
  assert.equal(model.parseResetAt("1.5 hours", observed), observed + 1.5 * hour);
  assert.equal(model.parseResetAt("1 día y 2 horas", observed), observed + 26 * hour);
});

test("English and Spanish clock and calendar resets retain their full date", () => {
  for (const text of ["13:00", "1:00 PM", "Today, 13:00", "hoy a las 13:00", "Sep 5, 2026, 1:00 PM", "5 septiembre 2026 13:00", "5 de septiembre de 2026 a las 13:00", "Sep 5, 13:00", "5 sep 13:00"]) {
    assert.equal(model.parseResetAt(text, observed), observed + hour, text);
  }
  assert.equal(model.parseResetAt("Tomorrow, 13:00", observed), observed + 25 * hour);
  assert.equal(model.parseResetAt("mañana a las 13:00", observed), observed + 25 * hour);
  assert.equal(model.parseResetAt("2026-09-05T13:00:00+02:00", observed), Date.parse("2026-09-05T11:00:00Z"));
});

test("midnight and year rollover are resolved once using the collection date", () => {
  const beforeMidnight = new Date(2026, 8, 5, 23, 30).getTime();
  assert.equal(model.parseResetAt("00:30", beforeMidnight), beforeMidnight + hour);
  const beforeNewYear = new Date(2026, 11, 31, 23, 30).getTime();
  assert.equal(model.parseResetAt("Jan 1, 00:30", beforeNewYear), beforeNewYear + hour);
  assert.equal(model.parseResetAt("Today, 11:00", observed), observed - hour);
  assert.equal(model.parseResetAt("Sep 5, 11:00", observed), observed - hour);
});

test("ambiguous or malformed reset times are not guessed", () => {
  for (const text of ["soon", "next week", "25:00", "12:60", "13:00 PM", "31 febrero 2026 13:00", "09/05 13:00", "some text 13:00"]) {
    assert.equal(model.parseResetAt(text, observed), null, text);
  }
  assert.equal(model.parseResetAt("13:00", NaN), null);
});

test("the visible-text extractor preserves reset dates, qualifiers and durations", () => {
  for (const text of ["in 1 hr", "1 h 30 min", "1.5 hours", "Today, 13:00", "mañana a las 13:00", "Sep 5, 13:00", "5 sep 13:00", "5 de septiembre de 2026 a las 13:00", "2026-09-05T13:00:00+02:00"]) {
    const metric = model.parseCodexUsageText(`5h limit\n50% remaining\nResets ${text}\nCredits remaining\n12`).codex5h;
    assert.equal(metric.structured.resetText, text, text);
    assert.notEqual(model.parseResetAt(metric.structured.resetText, observed), null, text);
  }
});

test("both a measured rate and a proportional estimate are capped by the reset", () => {
  for (const status of ["nominal", "estimated"]) {
    const result = monitor.limitEstimateToReset({ status, durationMs: 2.5 * hour }, observed + hour, observed);
    assert.equal(result.durationMs, hour);
    assert.equal(monitor.formatPaceEstimate(result), "≈ 1 hr left · resets then");
    assert.equal(monitor.limitEstimateToReset(result, observed + hour, observed + hour / 4).durationMs, 0.75 * hour);
  }
});

test("a shorter estimate stays shorter and an elapsed reset never rolls forward", () => {
  const short = { status: "estimated", durationMs: 0.5 * hour };
  assert.deepEqual(monitor.limitEstimateToReset(short, observed + hour, observed), short);
  const due = monitor.limitEstimateToReset(short, observed - hour, observed);
  assert.equal(due.durationMs, 0);
  assert.equal(monitor.formatPaceEstimate(due), "Reset due · refresh usage");
  assert.deepEqual(monitor.limitEstimateToReset({ status: "unavailable" }, observed + hour, observed), { status: "unavailable" });
});

test("display rounding cannot exceed the reset time", () => {
  const result = monitor.limitEstimateToReset({ status: "nominal", durationMs: 2 * hour }, observed + 59.9 * 60000, observed);
  assert.equal(monitor.formatPaceEstimate(result), "≈ 59 min left · resets then");
});

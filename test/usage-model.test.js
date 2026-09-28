const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const { ChatGPTUsageConfig, ChatGPTUsageModel } = require("../usage-model.js");

test("configuration provides the retained sign-in tab key", () => {
  assert.equal(
    ChatGPTUsageConfig.storageKeys.retainedSignInTab,
    "chatgptUsageMonitor.retainedSignInTab"
  );
});

test("configuration no longer exposes chat-message counters", () => {
  assert.equal("counters" in ChatGPTUsageConfig.storageKeys, false);
});

test("a current limit requires a parsed 5-hour or weekly percentage", () => {
  const hasLimit = ChatGPTUsageModel.hasParsedUsageLimit;
  assert.equal(hasLimit({ usage: { codexCredits: { structured: { remainingCredits: 12 } } } }), false);
  assert.equal(hasLimit({ usage: { codex5h: { value: "45% remaining" } } }), false);
  assert.equal(hasLimit({ usage: { codex5h: { structured: { remainingPercent: 0 } } } }), true);
  assert.equal(hasLimit({ usage: { codexWeekly: { structured: { remainingPercent: 80 } } } }), true);
});

test("refresh interval supports every whole minute from 1 to 60 and defaults to 15", () => {
  assert.equal(
    ChatGPTUsageConfig.storageKeys.refreshPeriodMinutes,
    "chatgptUsageMonitor.refreshPeriodMinutes"
  );
  assert.equal(ChatGPTUsageConfig.refreshPeriodMinimumMinutes, 1);
  assert.equal(ChatGPTUsageConfig.refreshPeriodMaximumMinutes, 60);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(undefined), 15);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(null), 15);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes("5"), 5);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(23), 23);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(60), 60);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(0), 1);
  assert.equal(ChatGPTUsageModel.normalizeRefreshPeriodMinutes(61), 60);
});

test("formatRelativeTime presents friendly refresh ages", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  assert.equal(ChatGPTUsageModel.formatRelativeTime("2026-08-24T11:59:40.000Z", now), "just now");
  assert.equal(ChatGPTUsageModel.formatRelativeTime("2026-08-24T11:55:00.000Z", now), "5 min ago");
  assert.equal(ChatGPTUsageModel.formatRelativeTime("2026-08-24T10:00:00.000Z", now), "2 h ago");
});

function readFixture(name) {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

const CASES = [
  {
    name: "Spanish standard wording",
    fixture: "es-standard.txt",
    expected: { codex5h: 72, codexWeekly: 18, credits: 123, bankedResets: 1 }
  },
  {
    name: "Spanish alternative wording",
    fixture: "es-variant.txt",
    expected: { codex5h: 71, codexWeekly: 17, credits: 124 }
  },
  {
    name: "English standard wording",
    fixture: "en-standard.txt",
    expected: { codex5h: 64, codexWeekly: 12, credits: 91, bankedResets: 2 }
  },
  {
    name: "English alternative wording",
    fixture: "en-variant.txt",
    expected: { codex5h: 63, codexWeekly: 11, credits: 92 }
  }
];

for (const { name, fixture, expected } of CASES) {
  test(`parseCodexUsageText parses ${name}`, () => {
    const usage = ChatGPTUsageModel.parseCodexUsageText(readFixture(fixture));

    assertPercentMetric(usage.codex5h, expected.codex5h);
    assertPercentMetric(usage.codexWeekly, expected.codexWeekly);
    assert.equal(usage.codexSpark5h, undefined);
    assert.equal(usage.codexSparkWeekly, undefined);
    assert.equal(usage.codexCredits.structured.remainingCredits, expected.credits);
    assert.equal(usage.remainingCredits.structured.remainingCredits, expected.credits);
    if (typeof expected.bankedResets === "number") {
      assert.equal(usage.bankedResets.structured.bankedResetCount, expected.bankedResets);
      assert.match(usage.bankedResets.structured.expiresText, /2026/);
    } else {
      assert.equal(usage.bankedResets.value, null);
    }
    assert.match(usage.codex5h.structured.resetText, /\d{1,2}:\d{2}/);
    assert.match(usage.codexWeekly.structured.resetText, /\d{1,2}:\d{2}/);
  });
}

test("parseCodexUsageText handles compact visible text", () => {
  const compactText = readFixture("en-standard.txt").replace(/\s+/g, " ");
  const usage = ChatGPTUsageModel.parseCodexUsageText(compactText);

  assert.equal(usage.codex5h.structured.remainingPercent, 64);
  assert.equal(usage.codexWeekly.structured.remainingPercent, 12);
  assert.equal(usage.codexSpark5h, undefined);
  assert.equal(usage.codexSparkWeekly, undefined);
  assert.equal(usage.codexCredits.structured.remainingCredits, 91);
  assert.equal(usage.bankedResets.structured.bankedResetCount, 2);
  assert.match(usage.bankedResets.structured.expiresText, /Jun 15, 2026/);
});

test("parseCodexUsageText exposes extraction confidence", () => {
  const standard = ChatGPTUsageModel.parseCodexUsageText(readFixture("en-standard.txt"));
  const variant = ChatGPTUsageModel.parseCodexUsageText(readFixture("es-variant.txt"));

  assert.equal(standard.codex5h.confidence, "high");
  assert.equal(standard.codex5h.structured.confidence, "high");
  assert.equal(standard.codexCredits.confidence, "high");
  assert.equal(variant.codex5h.confidence, "high");
  assert.equal(variant.codexCredits.confidence, "low");
});

test("credit parsing accepts an explicit zero balance", () => {
  const english = ChatGPTUsageModel.parseCodexUsageText("Credits remaining\n0");
  const spanish = ChatGPTUsageModel.parseCodexUsageText("Créditos restantes\n0");

  assert.equal(english.codexCredits.structured.remainingCredits, 0);
  assert.equal(english.codexCredits.confidence, "high");
  assert.equal(spanish.codexCredits.structured.remainingCredits, 0);
  assert.equal(spanish.codexCredits.confidence, "high");
});

test("credit parsing never borrows a reset date or time as the balance", () => {
  const usage = ChatGPTUsageModel.parseCodexUsageText(`
    Credits
    Resets Sep 8, 2026 at 8:32 AM
    Banked resets
    Expires Oct 4, 3:59 AM
  `);

  assert.equal(usage.codexCredits.value, null);
  assert.equal(usage.remainingCredits.value, null);
});

test("usage merging preserves a higher-confidence zero balance", () => {
  const confirmedZero = ChatGPTUsageModel.parseCodexUsageText("Credits remaining\n0").codexCredits;
  const ambiguousEight = {
    value: "Credits remaining: 8",
    confidence: "low",
    structured: {
      label: "Credits",
      remainingCredits: 8,
      confidence: "low"
    }
  };

  const preserved = ChatGPTUsageModel.mergeUsageFields(
    { codexCredits: confirmedZero },
    { codexCredits: ambiguousEight }
  );
  const corrected = ChatGPTUsageModel.mergeUsageFields(
    { codexCredits: ambiguousEight },
    { codexCredits: confirmedZero }
  );

  assert.equal(preserved.codexCredits.structured.remainingCredits, 0);
  assert.equal(corrected.codexCredits.structured.remainingCredits, 0);
});

test("parseCodexUsageText counts a Spanish full-reset card without an explicit number", () => {
  const usage = ChatGPTUsageModel.parseCodexUsageText(`
    Restablecimientos de límites de uso
    Usa un restablecimiento para recuperar tu límite de 5 horas, tu límite semanal o ambos.
    Restablecimiento completo
    Caduca el 21 de septiembre
    Usar restablecimiento
  `);

  assert.equal(usage.bankedResets.structured.bankedResetCount, 1);
  assert.equal(usage.bankedResets.structured.label, "Restablecimiento completo");
  assert.equal(usage.bankedResets.structured.countSource, "visible-card-count");
  assert.equal(usage.bankedResets.structured.expiresText, "21 de septiembre");
  assert.equal(usage.bankedResets.confidence, "medium");
});

test("a full-reset expiry date is never mistaken for the banked count", () => {
  const usage = ChatGPTUsageModel.parseCodexUsageText(`
    Restablecimiento completo
    Caduca el 21 de septiembre
    21 de septiembre
    21 de septiembre 2026-09-21
  `);

  assert.equal(usage.bankedResets.structured.bankedResetCount, 1);
  assert.equal(usage.bankedResets.structured.countSource, "visible-card-count");
  assert.equal(usage.bankedResets.structured.expiresText, "21 de septiembre");
});

test("TERMS groups English and Spanish extraction concepts", () => {
  assert.ok(ChatGPTUsageModel.TERMS.remaining.includes("remaining"));
  assert.ok(ChatGPTUsageModel.TERMS.remaining.includes("restante"));
  assert.ok(ChatGPTUsageModel.TERMS.weekly.includes("weekly"));
  assert.ok(ChatGPTUsageModel.TERMS.weekly.includes("semanal"));
  assert.ok(ChatGPTUsageModel.TERMS.hours5.includes("5 hours"));
  assert.ok(ChatGPTUsageModel.TERMS.hours5.includes("5 horas"));
  assert.ok(ChatGPTUsageModel.TERMS.bankedResets.includes("banked resets"));
  assert.ok(ChatGPTUsageModel.TERMS.bankedResets.includes("restablecimiento completo"));
});


test("normalizeMetricField prefers structured values", () => {
  const field = {
    value: "5h limit: 40% remaining; resets 14:30",
    structured: {
      label: "5h limit",
      remainingPercent: 40,
      resetText: "14:30"
    }
  };

  assert.deepEqual(ChatGPTUsageModel.normalizeMetricField(field, "5h limit"), field.structured);
});

function assertPercentMetric(field, expectedPercent) {
  assert.equal(field.structured.remainingPercent, expectedPercent);
  assert.ok(["high", "medium", "low"].includes(field.confidence));
  assert.equal(field.structured.confidence, field.confidence);
}

test("retired Spark limits cannot become general limits or visible stored usage", () => {
  const text = "GPT-5.3-Codex-Spark 5h usage\n1% remaining\nGPT-5.3-Codex-Spark weekly usage\n2% remaining";
  for (const input of [text, text.replace(/\n/g, " ")]) {
    const usage = ChatGPTUsageModel.parseCodexUsageText(input);
    assert.equal(usage.codex5h.value, null);
    assert.equal(usage.codexWeekly.value, null);
    assert.equal(usage.codexSpark5h, undefined);
    assert.equal(usage.codexSparkWeekly, undefined);
  }
  const retired = { codexSpark5h: { value: "1% remaining" }, codexSparkWeekly: { value: "2% remaining" } };
  assert.equal(ChatGPTUsageModel.hasVisibleUsage({ usage: retired }), false);
  const active = { codexWeekly: { value: "80% remaining" } };
  assert.deepEqual(ChatGPTUsageModel.mergeUsageFields({ ...retired, ...active }, retired), active);
});

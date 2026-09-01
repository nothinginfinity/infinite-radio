import { test } from "node:test";
import assert from "node:assert/strict";

import { SCORE_SCHEMA_VERSION, validateAndNormalizeScore, createFixtureScore } from "../src/score-schema.js";
import { computeTemporalCoverage, assertMusicalQuality, QUALITY_GATE_LIMITS } from "../src/quality-gate.js";

function trusted(overrides = {}) {
  return { channelId: "chan-1", creatorId: "creator-1", now: 1735689600000, ...overrides };
}

function scoreWith(overrides = {}) {
  return validateAndNormalizeScore(
    {
      schemaVersion: SCORE_SCHEMA_VERSION,
      compositionId: overrides.compositionId ?? "quality-test-comp",
      bpm: 120,
      timeSignature: overrides.timeSignature ?? { beatsPerBar: 4, beatUnit: 4 },
      key: { root: "C", mode: "minor" },
      bars: overrides.bars ?? 16,
      sections: [{ startBar: 0, lengthBars: overrides.bars ?? 16, label: "main" }],
      tracks: overrides.tracks,
      continuity: { motifIds: [], energy: 0.5 },
    },
    trusted(),
  );
}

test("a many-bar one-note-at-start score fails the quality coverage gate", () => {
  const score = scoreWith({
    bars: 16,
    tracks: [
      { id: "lead", patch: "saw_lead", events: [{ pitch: 60, start: 0, duration: 1, velocity: 0.7 }] },
    ],
  });
  assert.throws(() => assertMusicalQuality(score), /insufficient_temporal_coverage|no_final_section_activity/);
});

test("a sparse score with only early events fails the quality coverage gate", () => {
  const score = scoreWith({
    bars: 16,
    tracks: [
      {
        id: "lead",
        patch: "saw_lead",
        events: [
          { pitch: 60, start: 0, duration: 1, velocity: 0.7 },
          { pitch: 62, start: 2, duration: 1, velocity: 0.7 },
          { pitch: 64, start: 4, duration: 1, velocity: 0.7 },
        ],
      },
    ],
  });
  const coverage = computeTemporalCoverage(score);
  assert.ok(coverage.activeRatio < QUALITY_GATE_LIMITS.MIN_ACTIVE_WINDOW_RATIO || !coverage.finalSectionActive);
  assert.throws(() => assertMusicalQuality(score));
});

test("a sustained ambient event spanning most of the composition passes despite a single event", () => {
  const bars = 16;
  const beatsPerBar = 4;
  const totalBeats = bars * beatsPerBar;
  const score = scoreWith({
    bars,
    tracks: [
      {
        id: "pad",
        patch: "sine_pad",
        // One long sustained note covering ~98% of the declared timeline --
        // low event count, but genuinely covers the composition.
        events: [{ pitch: 57, start: 0, duration: totalBeats * 0.98, velocity: 0.5 }],
      },
    ],
  });
  const coverage = assertMusicalQuality(score);
  assert.equal(coverage.activeRatio, 1);
  assert.ok(coverage.finalSectionActive);
});

test("compound-meter coverage uses quarter-note beat units consistently with duration and playback", () => {
  const bars = 8;
  const quarterBeatsPerBar = 6 * (4 / 8);
  const score = scoreWith({
    bars,
    timeSignature: { beatsPerBar: 6, beatUnit: 8 },
    tracks: [
      {
        id: "pad",
        patch: "triangle_pad",
        events: Array.from({ length: bars }, (_, bar) => ({
          pitch: 57 + (bar % 3),
          start: bar * quarterBeatsPerBar,
          duration: quarterBeatsPerBar - 0.1,
          velocity: 0.55,
        })),
      },
    ],
  });
  const coverage = assertMusicalQuality(score);
  assert.equal(coverage.activeRatio, 1);
  assert.equal(coverage.finalSectionActive, true);
  assert.equal(score.durationSeconds, 12);
});

test("a rhythmically active fixture-style score passes the quality gate", () => {
  const score = createFixtureScore(trusted());
  const coverage = assertMusicalQuality(score);
  assert.equal(coverage.finalSectionActive, true);
  assert.ok(coverage.activeRatio >= QUALITY_GATE_LIMITS.MIN_ACTIVE_WINDOW_RATIO);
});

test("an accepted score must demonstrate activity into the final section/window", () => {
  const bars = 8;
  const score = scoreWith({
    bars,
    tracks: [
      {
        id: "lead",
        patch: "saw_lead",
        events: Array.from({ length: bars }, (_, bar) => ({
          pitch: 60 + (bar % 5),
          start: bar * 4,
          duration: 3.5,
          velocity: 0.7,
        })),
      },
    ],
  });
  const coverage = computeTemporalCoverage(score);
  assert.equal(coverage.windowCount, bars);
  assert.ok(coverage.active[coverage.windowCount - 1], "final window must show activity");
  assert.doesNotThrow(() => assertMusicalQuality(score));
});

test("a score with strong early/mid density but total silence at the end still fails", () => {
  const bars = 16;
  const score = scoreWith({
    bars,
    tracks: [
      {
        id: "lead",
        patch: "saw_lead",
        // Dense activity for the first 12 of 16 bars, nothing after --
        // overall ratio may look fine, but the ending is silent.
        events: Array.from({ length: 12 * 4 }, (_, i) => ({
          pitch: 60 + (i % 7),
          start: i,
          duration: 0.9,
          velocity: 0.7,
        })),
      },
    ],
  });
  const coverage = computeTemporalCoverage(score);
  assert.equal(coverage.finalSectionActive, false);
  assert.throws(() => assertMusicalQuality(score), /no_final_section_activity/);
});

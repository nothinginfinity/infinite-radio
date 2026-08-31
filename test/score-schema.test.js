import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCORE_SCHEMA_VERSION,
  validateAndNormalizeScore,
  createFixtureScore,
} from "../src/score-schema.js";

function baseTrusted(overrides = {}) {
  return { channelId: "chan-1", creatorId: "creator-1", now: 1735689600000, ...overrides };
}

function minimalValidRawScore(overrides = {}) {
  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    compositionId: "comp-1",
    bpm: 120,
    timeSignature: { beatsPerBar: 4, beatUnit: 4 },
    key: { root: "C", mode: "minor" },
    bars: 4,
    sections: [{ startBar: 0, lengthBars: 4, label: "loop" }],
    tracks: [
      {
        id: "lead",
        patch: "sine_lead",
        events: [{ pitch: 60, start: 0, duration: 1, velocity: 0.8 }],
      },
    ],
    continuity: { motifIds: [], energy: 0.5 },
    ...overrides,
  };
}

test("createFixtureScore produces a schema-valid, deterministic composition", () => {
  const trusted = baseTrusted();
  const scoreA = createFixtureScore(trusted);
  const scoreB = createFixtureScore(trusted);

  assert.equal(scoreA.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(scoreA.channelId, "chan-1");
  assert.equal(scoreA.creatorId, "creator-1");
  assert.ok(scoreA.tracks.length >= 2);
  assert.ok(scoreA.durationSeconds > 0);
  // Deterministic given identical trusted context/options (compositionId defaults off Date.now(),
  // so pin it explicitly to prove the underlying composition itself is deterministic).
  const pinned = { compositionId: "fixed-id" };
  const first = createFixtureScore(trusted, pinned);
  const second = createFixtureScore(trusted, pinned);
  assert.deepEqual(first, second);
  assert.notEqual(scoreB, undefined);
});

test("validateAndNormalizeScore accepts a minimal valid score and ignores model-supplied identity", () => {
  const raw = minimalValidRawScore({ channelId: "attacker-channel", creatorId: "attacker-creator" });
  const normalized = validateAndNormalizeScore(raw, baseTrusted());

  assert.equal(normalized.channelId, "chan-1");
  assert.equal(normalized.creatorId, "creator-1");
  assert.equal(normalized.compositionId, "comp-1");
  assert.equal(normalized.bars, 4);
  assert.equal(normalized.tracks.length, 1);
  assert.equal(normalized.tracks[0].events.length, 1);
});

test("rejects wrong or missing schema version", () => {
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ schemaVersion: "v0" }), baseTrusted()),
    /unsupported_schema_version/,
  );
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ schemaVersion: undefined }), baseTrusted()),
    /unsupported_schema_version/,
  );
});

test("rejects out-of-range bpm", () => {
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ bpm: 10 }), baseTrusted()),
    /invalid_bpm/,
  );
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ bpm: 999 }), baseTrusted()),
    /invalid_bpm/,
  );
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ bpm: Number.POSITIVE_INFINITY }), baseTrusted()),
    /invalid_bpm/,
  );
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ bpm: "fast" }), baseTrusted()),
    /invalid_bpm/,
  );
});

test("rejects non-finite and out-of-range note fields", () => {
  const badPitch = minimalValidRawScore({
    tracks: [{ id: "lead", patch: "sine_lead", events: [{ pitch: 200, start: 0, duration: 1 }] }],
  });
  assert.throws(() => validateAndNormalizeScore(badPitch, baseTrusted()), /invalid_note_pitch/);

  const negativeStart = minimalValidRawScore({
    tracks: [{ id: "lead", patch: "sine_lead", events: [{ pitch: 60, start: -1, duration: 1 }] }],
  });
  assert.throws(() => validateAndNormalizeScore(negativeStart, baseTrusted()), /invalid_note_start/);

  const infiniteDuration = minimalValidRawScore({
    tracks: [{ id: "lead", patch: "sine_lead", events: [{ pitch: 60, start: 0, duration: Number.POSITIVE_INFINITY }] }],
  });
  assert.throws(() => validateAndNormalizeScore(infiniteDuration, baseTrusted()), /invalid_note_duration/);
});

test("rejects unknown synth patches, drum patches, and effect types", () => {
  const badSynth = minimalValidRawScore({
    tracks: [{ id: "lead", patch: "totally_made_up_patch", events: [{ pitch: 60, start: 0, duration: 1 }] }],
  });
  assert.throws(() => validateAndNormalizeScore(badSynth, baseTrusted()), /invalid_synth_patch/);

  const badDrum = minimalValidRawScore({
    tracks: [{ id: "drums", isDrumTrack: true, drumEvents: [{ patch: "cowbell", start: 0 }] }],
  });
  assert.throws(() => validateAndNormalizeScore(badDrum, baseTrusted()), /invalid_drum_patch/);

  const badEffect = minimalValidRawScore({
    tracks: [{
      id: "lead",
      patch: "sine_lead",
      events: [{ pitch: 60, start: 0, duration: 1 }],
      effects: [{ type: "flux_capacitor", amount: 1 }],
    }],
  });
  assert.throws(() => validateAndNormalizeScore(badEffect, baseTrusted()), /invalid_effect_type/);
});

test("enforces composition length ceiling", () => {
  const tooLong = minimalValidRawScore({
    bpm: 40,
    bars: 64,
    timeSignature: { beatsPerBar: 16, beatUnit: 1 },
  });
  assert.throws(() => validateAndNormalizeScore(tooLong, baseTrusted()), /composition_too_long/);
});

test("enforces track and event count ceilings", () => {
  const tooManyTracks = minimalValidRawScore({
    tracks: Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      patch: "sine_lead",
      events: [{ pitch: 60, start: 0, duration: 1 }],
    })),
  });
  assert.throws(() => validateAndNormalizeScore(tooManyTracks, baseTrusted()), /too_many_tracks/);

  const tooManyEvents = minimalValidRawScore({
    tracks: [{
      id: "lead",
      patch: "sine_lead",
      events: Array.from({ length: 5000 }, (_, i) => ({ pitch: 60, start: i, duration: 0.1 })),
    }],
  });
  assert.throws(() => validateAndNormalizeScore(tooManyEvents, baseTrusted()), /too_many_events_in_track/);
});

test("rejects a score with zero tracks or zero events", () => {
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ tracks: [] }), baseTrusted()),
    /at_least_one_track_required/,
  );
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore({ tracks: [{ id: "lead", patch: "sine_lead", events: [] }] }), baseTrusted()),
    /at_least_one_event_required/,
  );
});

test("rejects duplicate track ids", () => {
  const dup = minimalValidRawScore({
    tracks: [
      { id: "lead", patch: "sine_lead", events: [{ pitch: 60, start: 0, duration: 1 }] },
      { id: "lead", patch: "saw_lead", events: [{ pitch: 62, start: 0, duration: 1 }] },
    ],
  });
  assert.throws(() => validateAndNormalizeScore(dup, baseTrusted()), /duplicate_track_id/);
});

test("rejects sections outside the composition's bar range", () => {
  const outOfBounds = minimalValidRawScore({
    sections: [{ startBar: 2, lengthBars: 4, label: "overflow" }],
  });
  assert.throws(() => validateAndNormalizeScore(outOfBounds, baseTrusted()), /section_out_of_bounds|invalid_section_length/);
});

test("caps continuity motif ids and transition hint length", () => {
  const tooManyMotifs = minimalValidRawScore({
    continuity: { motifIds: Array.from({ length: 20 }, (_, i) => `motif-${i}`), energy: 0.5 },
  });
  assert.throws(() => validateAndNormalizeScore(tooManyMotifs, baseTrusted()), /too_many_motif_ids/);

  const longHint = minimalValidRawScore({
    continuity: { motifIds: [], energy: 0.5, transitionHint: "x".repeat(1000) },
  });
  const normalized = validateAndNormalizeScore(longHint, baseTrusted());
  assert.ok(normalized.continuity.transitionHint.length <= 280);
});

test("requires a trusted channelId and never trusts model-supplied identity for it", () => {
  assert.throws(
    () => validateAndNormalizeScore(minimalValidRawScore(), {}),
    /channel_id_required/,
  );
});

test("rejects non-object and malformed top-level input", () => {
  assert.throws(() => validateAndNormalizeScore(null, baseTrusted()), /score_object_required/);
  assert.throws(() => validateAndNormalizeScore("not json", baseTrusted()), /score_object_required/);
  assert.throws(() => validateAndNormalizeScore([], baseTrusted()), /score_object_required/);
});

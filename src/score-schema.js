// infinite-radio-score-v1
//
// Canonical structured-composition contract for Infinite Radio V0.3.1.
//
// An LLM (or the deterministic fixture composer) may only ever produce
// schema-constrained JSON matching this contract. That JSON is untrusted
// data: it is never eval'd, never treated as executable code, and never
// trusted for channel/creator identity. `validateAndNormalizeScore` is the
// single choke point every composer output must pass through before it is
// persisted or handed to the browser WebAudio renderer.

export const SCORE_SCHEMA_VERSION = "infinite-radio-score-v1";

export const SYNTH_PATCHES = Object.freeze([
  "sine_lead",
  "triangle_lead",
  "square_lead",
  "saw_lead",
  "sine_pad",
  "triangle_pad",
  "saw_pad",
  "sub_bass",
  "saw_bass",
  "pluck",
]);

export const DRUM_PATCHES = Object.freeze([
  "kick",
  "snare",
  "hat_closed",
  "hat_open",
  "noise_perc",
]);

export const EFFECT_TYPES = Object.freeze([
  "filter_lowpass",
  "filter_highpass",
  "delay",
  "reverb_short",
  "pan",
]);

export const SCALE_MODES = Object.freeze([
  "major",
  "minor",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "locrian",
  "minor_pentatonic",
  "major_pentatonic",
]);

export const PITCH_CLASSES = Object.freeze([
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
]);

export const SCORE_LIMITS = Object.freeze({
  MIN_BPM: 40,
  MAX_BPM: 220,
  MIN_BARS: 1,
  MAX_BARS: 64,
  MAX_SECTIONS: 16,
  MAX_TRACKS: 12,
  MAX_EVENTS_PER_TRACK: 512,
  MAX_TOTAL_EVENTS: 4096,
  MAX_EFFECTS_PER_TRACK: 4,
  MAX_DURATION_SECONDS: 480,
  MIN_MIDI_PITCH: 0,
  MAX_MIDI_PITCH: 127,
  MIN_VELOCITY: 0,
  MAX_VELOCITY: 1,
  MAX_MOTIF_IDS: 16,
  MAX_MOTIF_ID_LENGTH: 64,
  MAX_TRANSITION_HINT_LENGTH: 280,
  MAX_PROMPT_SUMMARY_LENGTH: 400,
  MAX_STRING_ID_LENGTH: 128,
});

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function requireStringId(value, code, maxLength = SCORE_LIMITS.MAX_STRING_ID_LENGTH) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new Error(code);
  }
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(code);
  }
  return normalized;
}

function requireFiniteNumber(value, code) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(code);
  }
  return num;
}

function requireFiniteInRange(value, min, max, code) {
  const num = requireFiniteNumber(value, code);
  if (num < min || num > max) {
    throw new Error(code);
  }
  return num;
}

function requireIntInRange(value, min, max, code) {
  const num = requireFiniteInRange(value, min, max, code);
  if (!Number.isInteger(num)) {
    throw new Error(code);
  }
  return num;
}

function requireEnum(value, allowed, code) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(code);
  }
  return value;
}

function requireNonNegativeFinite(value, code) {
  const num = requireFiniteNumber(value, code);
  if (num < 0) {
    throw new Error(code);
  }
  return num;
}

// ---------------------------------------------------------------------------
// Structural normalizers
// ---------------------------------------------------------------------------

function normalizeTimeSignature(raw) {
  const value = raw ?? {};
  const beatsPerBar = requireIntInRange(value.beatsPerBar ?? 4, 1, 16, "invalid_time_signature");
  const beatUnit = requireEnum(String(value.beatUnit ?? 4), ["1", "2", "4", "8", "16"], "invalid_time_signature");
  return { beatsPerBar, beatUnit: Number(beatUnit) };
}

function normalizeKey(raw) {
  const value = raw ?? {};
  const root = requireEnum(value.root ?? "C", PITCH_CLASSES, "invalid_key_root");
  const mode = requireEnum(value.mode ?? "minor", SCALE_MODES, "invalid_key_mode");
  return { root, mode };
}

function normalizeSections(raw, totalBars) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > SCORE_LIMITS.MAX_SECTIONS) {
    throw new Error("too_many_sections");
  }
  return list.map((section, index) => {
    const startBar = requireIntInRange(section?.startBar, 0, totalBars - 1, "invalid_section_start_bar");
    const lengthBars = requireIntInRange(section?.lengthBars, 1, totalBars, "invalid_section_length");
    if (startBar + lengthBars > totalBars) {
      throw new Error("section_out_of_bounds");
    }
    const label = typeof section?.label === "string" ? section.label.slice(0, 32) : `section_${index}`;
    const energy = section?.energy === undefined
      ? null
      : requireFiniteInRange(section.energy, 0, 1, "invalid_section_energy");
    return { startBar, lengthBars, label, energy };
  });
}

function normalizeNoteEvent(raw) {
  const pitch = requireIntInRange(
    raw?.pitch,
    SCORE_LIMITS.MIN_MIDI_PITCH,
    SCORE_LIMITS.MAX_MIDI_PITCH,
    "invalid_note_pitch",
  );
  const start = requireNonNegativeFinite(raw?.start, "invalid_note_start");
  const duration = requireFiniteInRange(raw?.duration, 0.0001, 64, "invalid_note_duration");
  const velocity = requireFiniteInRange(
    raw?.velocity ?? 0.8,
    SCORE_LIMITS.MIN_VELOCITY,
    SCORE_LIMITS.MAX_VELOCITY,
    "invalid_note_velocity",
  );
  return { pitch, start, duration, velocity };
}

function normalizeDrumEvent(raw) {
  const patch = requireEnum(raw?.patch, DRUM_PATCHES, "invalid_drum_patch");
  const start = requireNonNegativeFinite(raw?.start, "invalid_drum_start");
  const velocity = requireFiniteInRange(
    raw?.velocity ?? 0.8,
    SCORE_LIMITS.MIN_VELOCITY,
    SCORE_LIMITS.MAX_VELOCITY,
    "invalid_drum_velocity",
  );
  return { patch, start, velocity };
}

function normalizeEffect(raw) {
  const type = requireEnum(raw?.type, EFFECT_TYPES, "invalid_effect_type");
  const amount = requireFiniteInRange(raw?.amount ?? 0.3, 0, 1, "invalid_effect_amount");
  return { type, amount };
}

function normalizeTrack(raw, totalBars) {
  const id = requireStringId(raw?.id, "track_id_required");
  const isDrumTrack = Boolean(raw?.isDrumTrack);
  const patch = isDrumTrack
    ? "drum_kit"
    : requireEnum(raw?.patch, SYNTH_PATCHES, "invalid_synth_patch");

  const rawEvents = Array.isArray(raw?.events) ? raw.events : [];
  const rawDrumEvents = Array.isArray(raw?.drumEvents) ? raw.drumEvents : [];
  if (rawEvents.length + rawDrumEvents.length > SCORE_LIMITS.MAX_EVENTS_PER_TRACK) {
    throw new Error("too_many_events_in_track");
  }

  const maxStart = totalBars * 16; // generous upper bound in beats; fine-grained check happens via duration ceiling
  const events = rawEvents.map((event) => {
    const normalized = normalizeNoteEvent(event);
    if (normalized.start > maxStart) {
      throw new Error("note_start_out_of_bounds");
    }
    return normalized;
  });
  const drumEvents = rawDrumEvents.map((event) => {
    const normalized = normalizeDrumEvent(event);
    if (normalized.start > maxStart) {
      throw new Error("drum_start_out_of_bounds");
    }
    return normalized;
  });

  const rawEffects = Array.isArray(raw?.effects) ? raw.effects : [];
  if (rawEffects.length > SCORE_LIMITS.MAX_EFFECTS_PER_TRACK) {
    throw new Error("too_many_effects_in_track");
  }
  const effects = rawEffects.map(normalizeEffect);

  const pan = raw?.pan === undefined ? 0 : requireFiniteInRange(raw.pan, -1, 1, "invalid_track_pan");
  const gain = raw?.gain === undefined ? 0.8 : requireFiniteInRange(raw.gain, 0, 1.5, "invalid_track_gain");

  return { id, patch, isDrumTrack, pan, gain, events, drumEvents, effects };
}

function normalizeTracks(raw, totalBars) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0) {
    throw new Error("at_least_one_track_required");
  }
  if (list.length > SCORE_LIMITS.MAX_TRACKS) {
    throw new Error("too_many_tracks");
  }
  const seenIds = new Set();
  const tracks = list.map((track) => {
    const normalized = normalizeTrack(track, totalBars);
    if (seenIds.has(normalized.id)) {
      throw new Error("duplicate_track_id");
    }
    seenIds.add(normalized.id);
    return normalized;
  });

  const totalEvents = tracks.reduce(
    (sum, track) => sum + track.events.length + track.drumEvents.length,
    0,
  );
  if (totalEvents > SCORE_LIMITS.MAX_TOTAL_EVENTS) {
    throw new Error("too_many_events");
  }
  if (totalEvents === 0) {
    throw new Error("at_least_one_event_required");
  }

  return tracks;
}

function normalizeContinuity(raw) {
  const value = raw ?? {};
  const rawMotifIds = Array.isArray(value.motifIds) ? value.motifIds : [];
  if (rawMotifIds.length > SCORE_LIMITS.MAX_MOTIF_IDS) {
    throw new Error("too_many_motif_ids");
  }
  const motifIds = rawMotifIds.map((id) => requireStringId(id, "invalid_motif_id", SCORE_LIMITS.MAX_MOTIF_ID_LENGTH));

  const energy = value.energy === undefined
    ? 0.5
    : requireFiniteInRange(value.energy, 0, 1, "invalid_continuity_energy");

  const transitionHint = value.transitionHint === undefined || value.transitionHint === null
    ? null
    : String(value.transitionHint).slice(0, SCORE_LIMITS.MAX_TRANSITION_HINT_LENGTH);

  const previousCompositionId = value.previousCompositionId
    ? requireStringId(value.previousCompositionId, "invalid_previous_composition_id")
    : null;

  return { motifIds, energy, transitionHint, previousCompositionId };
}

function normalizeSeed(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return requireStringId(String(raw), "invalid_seed", 64);
}

function normalizeProvenance(raw) {
  const value = raw ?? {};
  const composer = typeof value.composer === "string" ? value.composer.slice(0, 64) : "unknown";
  const model = typeof value.model === "string" ? value.model.slice(0, 128) : null;
  const promptSummary = typeof value.promptSummary === "string"
    ? value.promptSummary.slice(0, SCORE_LIMITS.MAX_PROMPT_SUMMARY_LENGTH)
    : null;
  return { composer, model, promptSummary };
}

function computeDurationSeconds(bpm, timeSignature, bars) {
  const secondsPerBeat = 60 / bpm;
  const beatsPerBar = timeSignature.beatsPerBar * (4 / timeSignature.beatUnit);
  return secondsPerBeat * beatsPerBar * bars;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an untrusted composer-produced score.
 *
 * `trusted.channelId` (and optionally `trusted.creatorId`) come from the
 * caller's own runtime context, never from `rawScore`. Any channel/creator
 * identity embedded in `rawScore` is ignored -- it can never override the
 * trusted values.
 */
export function validateAndNormalizeScore(rawScore, trusted = {}) {
  const channelId = requireStringId(trusted.channelId, "channel_id_required");
  const creatorId = trusted.creatorId
    ? requireStringId(trusted.creatorId, "creator_id_required")
    : null;

  if (!rawScore || typeof rawScore !== "object" || Array.isArray(rawScore)) {
    throw new Error("score_object_required");
  }
  if (rawScore.schemaVersion !== SCORE_SCHEMA_VERSION) {
    throw new Error("unsupported_schema_version");
  }

  const compositionId = requireStringId(rawScore.compositionId, "composition_id_required");
  const bpm = requireFiniteInRange(rawScore.bpm, SCORE_LIMITS.MIN_BPM, SCORE_LIMITS.MAX_BPM, "invalid_bpm");
  const timeSignature = normalizeTimeSignature(rawScore.timeSignature);
  const key = normalizeKey(rawScore.key);
  const bars = requireIntInRange(rawScore.bars, SCORE_LIMITS.MIN_BARS, SCORE_LIMITS.MAX_BARS, "invalid_bars");
  const sections = normalizeSections(rawScore.sections, bars);
  const tracks = normalizeTracks(rawScore.tracks, bars);
  const continuity = normalizeContinuity(rawScore.continuity);
  const seed = normalizeSeed(rawScore.seed);
  const provenance = normalizeProvenance(rawScore.provenance);
  const durationSeconds = computeDurationSeconds(bpm, timeSignature, bars);
  if (durationSeconds > SCORE_LIMITS.MAX_DURATION_SECONDS) {
    throw new Error("composition_too_long");
  }

  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    compositionId,
    channelId,
    creatorId,
    seed,
    provenance,
    bpm,
    timeSignature,
    key,
    bars,
    sections,
    tracks,
    continuity,
    durationSeconds,
    createdAt: new Date(trusted.now ?? Date.now()).toISOString(),
  };
}

/**
 * Deterministic fixture composer. Produces a schema-valid
 * infinite-radio-score-v1 composition without calling any model, so CI and
 * live acceptance never depend on Workers AI availability, and channels have
 * a safe fallback when a real composer call fails or returns invalid data.
 */
export function createFixtureScore(trusted = {}, options = {}) {
  const bpm = options.bpm ?? 118;
  const bars = options.bars ?? 8;
  const root = options.root ?? "A";
  const mode = options.mode ?? "minor_pentatonic";
  const compositionId = options.compositionId ?? `fixture:${trusted.channelId ?? "channel"}:${Date.now()}`;

  const rootPitchIndex = PITCH_CLASSES.indexOf(root);
  const basePitch = 57 + (rootPitchIndex >= 0 ? rootPitchIndex : 0); // around A3
  const scaleSteps = [0, 3, 5, 7, 10]; // minor-pentatonic-ish relative steps, degrades gracefully for other modes

  // The deterministic fallback should still sound like an arranged musical
  // idea rather than a metronomic schema demo. These four phrase shapes are
  // intentionally deterministic, but rotate rhythm, contour, articulation,
  // dynamics, bass movement, harmony, and drum accents across bars.
  const phraseRhythms = [
    [0, 0.75, 1.5, 2.5, 3.25],
    [0, 1, 1.75, 2.75],
    [0.5, 1.25, 2, 3, 3.5],
    [0, 0.5, 1.5, 2.25, 3.5],
  ];
  const leadEvents = [];
  const harmonyEvents = [];
  const bassEvents = [];
  const drumEvents = [];
  const halfway = Math.max(1, Math.floor(bars / 2));

  for (let bar = 0; bar < bars; bar += 1) {
    const rhythm = phraseRhythms[bar % phraseRhythms.length];
    const variation = bar >= halfway ? 1 : 0;
    rhythm.forEach((beat, index) => {
      const step = scaleSteps[(bar * 2 + index + variation) % scaleSteps.length];
      const phrasePeak = bar % 4 === 3 && index === rhythm.length - 1 ? 12 : 0;
      leadEvents.push({
        pitch: basePitch + step + phrasePeak,
        start: bar * 4 + beat,
        duration: index % 3 === 1 ? 0.45 : index === rhythm.length - 1 ? 0.7 : 0.6,
        velocity: Math.min(0.92, 0.5 + 0.08 * ((bar + index) % 4) + (variation ? 0.05 : 0)),
      });
    });

    // Quiet chordal bed: overlapping scale tones make the fallback harmonically
    // fuller without depending on samples, arbitrary DSP, or model output.
    const chordSteps = variation ? [0, 5, 10] : [0, 3, 7];
    chordSteps.forEach((step, index) => {
      harmonyEvents.push({
        pitch: basePitch - 12 + step,
        start: bar * 4,
        duration: 3.75,
        velocity: 0.26 + index * 0.04 + (variation ? 0.04 : 0),
      });
    });

    bassEvents.push({
      pitch: basePitch - 24,
      start: bar * 4,
      duration: 2.1,
      velocity: 0.72 + (bar % 2) * 0.05,
    });
    bassEvents.push({
      pitch: basePitch - 24 + (bar % 2 ? 7 : 5),
      start: bar * 4 + 2.5,
      duration: 1.2,
      velocity: 0.58 + variation * 0.06,
    });

    drumEvents.push({ patch: "kick", start: bar * 4, velocity: 0.9 });
    drumEvents.push({ patch: "kick", start: bar * 4 + (bar % 2 ? 2.5 : 2), velocity: 0.72 });
    if (bar % 4 === 3) drumEvents.push({ patch: "kick", start: bar * 4 + 3.5, velocity: 0.62 });
    drumEvents.push({ patch: "snare", start: bar * 4 + 1, velocity: 0.76 });
    drumEvents.push({ patch: "snare", start: bar * 4 + 3, velocity: 0.84 + variation * 0.04 });
    for (let eighth = 0; eighth < 8; eighth += 1) {
      const isLast = eighth === 7;
      drumEvents.push({
        patch: isLast && bar % 2 === 1 ? "hat_open" : "hat_closed",
        start: bar * 4 + eighth * 0.5,
        velocity: 0.28 + (eighth % 2 === 0 ? 0.13 : 0.04) + variation * 0.03,
      });
    }
  }

  const firstSectionBars = bars >= 8 ? Math.floor(bars / 2) : bars;
  const sections = bars >= 8
    ? [
        { startBar: 0, lengthBars: firstSectionBars, label: "fixture_theme", energy: 0.48 },
        { startBar: firstSectionBars, lengthBars: bars - firstSectionBars, label: "fixture_variation", energy: 0.64 },
      ]
    : [{ startBar: 0, lengthBars: bars, label: "fixture_theme", energy: 0.54 }];

  const rawScore = {
    schemaVersion: SCORE_SCHEMA_VERSION,
    compositionId,
    bpm,
    timeSignature: { beatsPerBar: 4, beatUnit: 4 },
    key: { root, mode },
    bars,
    sections,
    tracks: [
      { id: "lead", patch: "saw_lead", pan: 0.12, gain: 0.68, events: leadEvents, effects: [{ type: "filter_lowpass", amount: 0.3 }, { type: "delay", amount: 0.18 }] },
      { id: "harmony", patch: "triangle_pad", pan: -0.16, gain: 0.42, events: harmonyEvents, effects: [{ type: "filter_lowpass", amount: 0.52 }, { type: "reverb_short", amount: 0.28 }] },
      { id: "bass", patch: "sub_bass", pan: -0.04, gain: 0.78, events: bassEvents, effects: [] },
      { id: "drums", isDrumTrack: true, pan: 0.08, gain: 0.88, drumEvents, effects: [] },
    ],
    continuity: {
      motifIds: options.motifIds ?? ["fixture_phrase_v2"],
      energy: bars >= 8 ? 0.6 : 0.54,
      transitionHint: null,
      previousCompositionId: options.previousCompositionId ?? null,
    },
    seed: options.seed ?? "fixture",
    provenance: { composer: "fixture", model: null, promptSummary: null },
  };

  return validateAndNormalizeScore(rawScore, trusted);
}

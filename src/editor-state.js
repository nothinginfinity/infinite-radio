import {
  EFFECT_TYPES,
  SCORE_LIMITS,
  SYNTH_PATCHES,
  validateAndNormalizeScore,
} from "./score-schema.js";

export const EDITOR_HISTORY_LIMIT = 64;

export const EDIT_COMMANDS = Object.freeze({
  SET_TEMPO: "SetTempo",
  SET_TRACK_GAIN: "SetTrackGain",
  SET_TRACK_PAN: "SetTrackPan",
  SET_TRACK_PATCH: "SetTrackPatch",
  SET_EFFECT_AMOUNT: "SetEffectAmount",
  TRANSPOSE: "Transpose",
  CHANGE_VELOCITY: "ChangeVelocity",
  EDIT_NOTE: "EditNote",
  SET_SECTION_ENERGY: "SetSectionEnergy",
  TRANSFORM_SECTION: "TransformSection",
  DUPLICATE_SECTION: "DuplicateSection",
  MOVE_SECTION: "MoveSection",
  RESIZE_SECTION: "ResizeSection",
  SEMANTIC_MACRO: "SemanticMacro",
});

const BRIGHTER_PATCH = Object.freeze({
  sine_lead: "triangle_lead",
  triangle_lead: "saw_lead",
  square_lead: "saw_lead",
  saw_lead: "saw_lead",
  sine_pad: "triangle_pad",
  triangle_pad: "saw_pad",
  saw_pad: "saw_pad",
  sub_bass: "saw_bass",
  saw_bass: "saw_bass",
  pluck: "pluck",
});

const DARKER_PATCH = Object.freeze({
  sine_lead: "sine_lead",
  triangle_lead: "sine_lead",
  square_lead: "triangle_lead",
  saw_lead: "triangle_lead",
  sine_pad: "sine_pad",
  triangle_pad: "sine_pad",
  saw_pad: "triangle_pad",
  sub_bass: "sub_bass",
  saw_bass: "sub_bass",
  pluck: "triangle_lead",
});

function clone(value) {
  return structuredClone(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function assertFinite(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return number;
}

function trustedIdentity(score) {
  const parsedCreatedAt = Date.parse(score?.createdAt ?? "");
  return {
    channelId: score?.channelId,
    creatorId: score?.creatorId ?? undefined,
    now: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0,
  };
}

function validateCandidate(candidate, baseScore) {
  return validateAndNormalizeScore(candidate, trustedIdentity(baseScore));
}

function findTrack(score, trackId) {
  const track = score.tracks.find((item) => item.id === trackId);
  if (!track) throw new Error("editor_track_not_found");
  return track;
}

function findSectionIndex(score, command) {
  if (Number.isInteger(command.sectionIndex)) {
    if (!score.sections[command.sectionIndex]) throw new Error("editor_section_not_found");
    return command.sectionIndex;
  }
  if (typeof command.label === "string") {
    const sectionIndex = score.sections.findIndex((item) => item.label === command.label);
    if (sectionIndex < 0) throw new Error("editor_section_not_found");
    return sectionIndex;
  }
  throw new Error("editor_section_required");
}

function findSection(score, command) {
  return score.sections[findSectionIndex(score, command)];
}

function beatsPerBar(score) {
  return score.timeSignature.beatsPerBar * (4 / score.timeSignature.beatUnit);
}

function sectionBeatRange(score, section) {
  const unit = beatsPerBar(score);
  return {
    startBeat: section.startBar * unit,
    endBeat: (section.startBar + section.lengthBars) * unit,
  };
}

function assertLinearSectionLayout(score) {
  if (!Array.isArray(score.sections) || score.sections.length === 0) {
    throw new Error("editor_section_layout_required");
  }
  let nextStartBar = 0;
  for (const section of score.sections) {
    if (section.startBar !== nextStartBar) throw new Error("editor_section_layout_not_linear");
    nextStartBar += section.lengthBars;
  }
  if (nextStartBar !== score.bars) throw new Error("editor_section_layout_not_linear");
  return score.sections;
}

function resetSectionStarts(score) {
  let startBar = 0;
  for (const section of score.sections) {
    section.startBar = startBar;
    startBar += section.lengthBars;
  }
}

function sortTrackEvents(score) {
  for (const track of score.tracks) {
    track.events?.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    track.drumEvents?.sort((a, b) => a.start - b.start || a.patch.localeCompare(b.patch));
  }
}

function copiedSectionLabel(score, label) {
  const labels = new Set(score.sections.map((section) => section.label));
  const base = String(label || "section").slice(0, 24);
  for (let copyNumber = 1; copyNumber <= SCORE_LIMITS.MAX_SECTIONS; copyNumber += 1) {
    const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!labels.has(candidate)) return candidate;
  }
  throw new Error("editor_section_label_exhausted");
}

function sectionIndexForBeat(ranges, beat) {
  const index = ranges.findIndex(({ startBeat, endBeat }) => beat >= startBeat && beat < endBeat);
  if (index < 0) throw new Error("editor_section_event_outside_layout");
  return index;
}

function applySectionDuplicate(candidate, command) {
  assertLinearSectionLayout(candidate);
  const sectionIndex = findSectionIndex(candidate, command);
  const section = candidate.sections[sectionIndex];
  if (candidate.sections.length >= SCORE_LIMITS.MAX_SECTIONS) throw new Error("editor_section_limit_reached");
  if (candidate.bars + section.lengthBars > SCORE_LIMITS.MAX_BARS) throw new Error("editor_bar_limit_reached");

  const { startBeat, endBeat } = sectionBeatRange(candidate, section);
  const insertedBeats = section.lengthBars * beatsPerBar(candidate);
  for (const track of candidate.tracks) {
    const noteCopies = (track.events ?? [])
      .filter((event) => event.start >= startBeat && event.start < endBeat)
      .map((event) => ({ ...event, start: event.start + insertedBeats }));
    const drumCopies = (track.drumEvents ?? [])
      .filter((event) => event.start >= startBeat && event.start < endBeat)
      .map((event) => ({ ...event, start: event.start + insertedBeats }));
    for (const event of track.events ?? []) {
      if (event.start >= endBeat) event.start += insertedBeats;
    }
    for (const event of track.drumEvents ?? []) {
      if (event.start >= endBeat) event.start += insertedBeats;
    }
    track.events?.push(...noteCopies);
    track.drumEvents?.push(...drumCopies);
  }

  candidate.sections.splice(sectionIndex + 1, 0, {
    ...clone(section),
    label: copiedSectionLabel(candidate, section.label),
  });
  candidate.bars += section.lengthBars;
  resetSectionStarts(candidate);
  sortTrackEvents(candidate);
}

function applySectionMove(candidate, command) {
  assertLinearSectionLayout(candidate);
  const sectionIndex = findSectionIndex(candidate, command);
  const direction = assertFinite(command.direction, "editor_section_move_direction_required");
  if (!Number.isInteger(direction) || Math.abs(direction) !== 1) throw new Error("editor_section_move_direction_invalid");
  const targetIndex = sectionIndex + direction;
  if (targetIndex < 0 || targetIndex >= candidate.sections.length) throw new Error("editor_section_move_out_of_range");

  const unit = beatsPerBar(candidate);
  const originalSections = candidate.sections.map((section) => clone(section));
  const originalRanges = originalSections.map((section) => sectionBeatRange(candidate, section));
  const order = originalSections.map((_, index) => index);
  [order[sectionIndex], order[targetIndex]] = [order[targetIndex], order[sectionIndex]];
  const newStartBeat = new Map();
  let cursorBar = 0;
  for (const originalIndex of order) {
    newStartBeat.set(originalIndex, cursorBar * unit);
    cursorBar += originalSections[originalIndex].lengthBars;
  }

  for (const track of candidate.tracks) {
    for (const event of [...(track.events ?? []), ...(track.drumEvents ?? [])]) {
      const originalIndex = sectionIndexForBeat(originalRanges, event.start);
      event.start = newStartBeat.get(originalIndex) + (event.start - originalRanges[originalIndex].startBeat);
    }
  }
  candidate.sections = order.map((originalIndex) => clone(originalSections[originalIndex]));
  resetSectionStarts(candidate);
  sortTrackEvents(candidate);
}

function applySectionResize(candidate, command) {
  assertLinearSectionLayout(candidate);
  const sectionIndex = findSectionIndex(candidate, command);
  const section = candidate.sections[sectionIndex];
  const deltaBars = assertFinite(command.deltaBars, "editor_section_resize_delta_required");
  if (!Number.isInteger(deltaBars) || Math.abs(deltaBars) !== 1) throw new Error("editor_section_resize_delta_invalid");
  if (deltaBars < 0 && section.lengthBars <= 1) throw new Error("editor_section_min_length");
  if (deltaBars > 0 && candidate.bars >= SCORE_LIMITS.MAX_BARS) throw new Error("editor_bar_limit_reached");

  const unit = beatsPerBar(candidate);
  const { endBeat } = sectionBeatRange(candidate, section);
  const finalBarStart = endBeat - unit;
  if (deltaBars > 0) {
    for (const track of candidate.tracks) {
      const noteCopies = (track.events ?? [])
        .filter((event) => event.start >= finalBarStart && event.start < endBeat)
        .map((event) => ({ ...event, start: event.start + unit }));
      const drumCopies = (track.drumEvents ?? [])
        .filter((event) => event.start >= finalBarStart && event.start < endBeat)
        .map((event) => ({ ...event, start: event.start + unit }));
      for (const event of track.events ?? []) if (event.start >= endBeat) event.start += unit;
      for (const event of track.drumEvents ?? []) if (event.start >= endBeat) event.start += unit;
      track.events?.push(...noteCopies);
      track.drumEvents?.push(...drumCopies);
    }
  } else {
    for (const track of candidate.tracks) {
      track.events = (track.events ?? []).flatMap((event) => {
        if (event.start >= finalBarStart && event.start < endBeat) return [];
        const next = { ...event };
        if (next.start >= endBeat) next.start -= unit;
        if (next.start < finalBarStart && next.start + next.duration > finalBarStart) {
          next.duration = Math.max(0.0001, finalBarStart - next.start);
        }
        return [next];
      });
      track.drumEvents = (track.drumEvents ?? []).flatMap((event) => {
        if (event.start >= finalBarStart && event.start < endBeat) return [];
        const next = { ...event };
        if (next.start >= endBeat) next.start -= unit;
        return [next];
      });
    }
  }

  section.lengthBars += deltaBars;
  candidate.bars += deltaBars;
  resetSectionStarts(candidate);
  sortTrackEvents(candidate);
}

function applySectionTransform(candidate, command) {
  const transform = String(command.transform ?? "").trim().toLowerCase();
  if (transform !== "lift" && transform !== "drop") {
    throw new Error("editor_section_transform_unsupported");
  }
  const section = findSection(candidate, command);
  const direction = transform === "lift" ? 1 : -1;
  const amount = clamp(assertFinite(command.amount ?? 0.65, "editor_section_transform_amount_required"), 0, 1);
  const energyDelta = 0.08 + amount * 0.12;
  const velocityDelta = 0.05 + amount * 0.1;
  const baseEnergy = section.energy ?? candidate.continuity.energy ?? 0.5;
  section.energy = clamp(baseEnergy + direction * energyDelta, 0, 1);

  const { startBeat, endBeat } = sectionBeatRange(candidate, section);
  for (const track of candidate.tracks) {
    for (const event of track.events ?? []) {
      if (event.start >= startBeat && event.start < endBeat) {
        event.velocity = clamp(event.velocity + direction * velocityDelta, 0, 1);
      }
    }
    for (const event of track.drumEvents ?? []) {
      if (event.start >= startBeat && event.start < endBeat) {
        event.velocity = clamp(event.velocity + direction * velocityDelta, 0, 1);
      }
    }
  }
}

function setEffectAmount(track, effectType, amount, { create = false } = {}) {
  if (!EFFECT_TYPES.includes(effectType)) throw new Error("editor_effect_unsupported");
  const bounded = clamp(assertFinite(amount, "editor_effect_amount_required"), 0, 1);
  const effect = track.effects.find((item) => item.type === effectType);
  if (effect) {
    effect.amount = bounded;
    return;
  }
  if (!create) throw new Error("editor_effect_not_found");
  if (track.effects.length >= 4) throw new Error("too_many_effects_in_track");
  track.effects.push({ type: effectType, amount: bounded });
}

function applySemanticMacro(candidate, command) {
  const macro = String(command.macro ?? "").trim().toLowerCase();
  const amount = clamp(command.amount ?? 0.5, 0, 1);
  const trackId = command.trackId ?? null;
  const tracks = trackId ? [findTrack(candidate, trackId)] : candidate.tracks;

  if (macro === "brighter" || macro === "darker") {
    const patchMap = macro === "brighter" ? BRIGHTER_PATCH : DARKER_PATCH;
    for (const track of tracks) {
      if (track.isDrumTrack) continue;
      track.patch = patchMap[track.patch] ?? track.patch;
      const lowpass = track.effects.find((effect) => effect.type === "filter_lowpass");
      if (lowpass) {
        lowpass.amount = clamp(lowpass.amount + (macro === "brighter" ? -1 : 1) * (0.15 + amount * 0.35), 0, 1);
      }
    }
    return;
  }

  if (macro === "more_energy" || macro === "calmer") {
    const direction = macro === "more_energy" ? 1 : -1;
    const velocityDelta = direction * (0.08 + amount * 0.22);
    for (const track of tracks) {
      for (const event of track.events ?? []) event.velocity = clamp(event.velocity + velocityDelta, 0, 1);
      for (const event of track.drumEvents ?? []) event.velocity = clamp(event.velocity + velocityDelta, 0, 1);
    }
    for (const section of candidate.sections) {
      if (section.energy !== null) section.energy = clamp(section.energy + direction * (0.08 + amount * 0.2), 0, 1);
    }
    candidate.continuity.energy = clamp(candidate.continuity.energy + direction * (0.08 + amount * 0.2), 0, 1);
    return;
  }

  if (macro === "spacious" || macro === "dry") {
    const target = macro === "spacious" ? 0.35 + amount * 0.55 : Math.max(0, 0.2 - amount * 0.2);
    for (const track of tracks) {
      if (macro === "spacious") {
        setEffectAmount(track, "reverb_short", target, { create: true });
      } else {
        const reverb = track.effects.find((effect) => effect.type === "reverb_short");
        if (reverb) reverb.amount = target;
      }
      const delay = track.effects.find((effect) => effect.type === "delay");
      if (delay) delay.amount = macro === "spacious" ? clamp(delay.amount + 0.12 + amount * 0.28, 0, 1) : target;
    }
    return;
  }

  throw new Error("editor_macro_unsupported");
}

/**
 * Apply one deterministic V0.5 EditCommand to a validated score.
 *
 * The input is never mutated. The returned candidate re-enters the canonical
 * score validator before it can be used for preview, so manual editing does
 * not create a second, weaker score contract.
 */
export function applyEditCommand(score, command) {
  if (!score || typeof score !== "object") throw new Error("editor_score_required");
  if (!command || typeof command !== "object") throw new Error("editor_command_required");

  const candidate = clone(score);

  switch (command.type) {
    case EDIT_COMMANDS.SET_TEMPO: {
      candidate.bpm = assertFinite(command.bpm, "editor_bpm_required");
      break;
    }
    case EDIT_COMMANDS.SET_TRACK_GAIN: {
      findTrack(candidate, command.trackId).gain = assertFinite(command.gain, "editor_gain_required");
      break;
    }
    case EDIT_COMMANDS.SET_TRACK_PAN: {
      findTrack(candidate, command.trackId).pan = assertFinite(command.pan, "editor_pan_required");
      break;
    }
    case EDIT_COMMANDS.SET_TRACK_PATCH: {
      const track = findTrack(candidate, command.trackId);
      if (track.isDrumTrack) throw new Error("editor_drum_patch_requires_event_edit");
      if (!SYNTH_PATCHES.includes(command.patch)) throw new Error("editor_patch_unsupported");
      track.patch = command.patch;
      break;
    }
    case EDIT_COMMANDS.SET_EFFECT_AMOUNT: {
      const track = findTrack(candidate, command.trackId);
      setEffectAmount(track, command.effectType, command.amount, { create: Boolean(command.create) });
      break;
    }
    case EDIT_COMMANDS.TRANSPOSE: {
      const semitones = assertFinite(command.semitones, "editor_semitones_required");
      if (!Number.isInteger(semitones) || Math.abs(semitones) > 36) throw new Error("editor_transpose_out_of_range");
      const tracks = command.trackId ? [findTrack(candidate, command.trackId)] : candidate.tracks;
      for (const track of tracks) {
        if (track.isDrumTrack) continue;
        for (const event of track.events) event.pitch += semitones;
      }
      break;
    }
    case EDIT_COMMANDS.CHANGE_VELOCITY: {
      const track = findTrack(candidate, command.trackId);
      const list = command.drum ? track.drumEvents : track.events;
      if (!Number.isInteger(command.eventIndex) || !list?.[command.eventIndex]) throw new Error("editor_event_not_found");
      list[command.eventIndex].velocity = assertFinite(command.velocity, "editor_velocity_required");
      break;
    }
    case EDIT_COMMANDS.EDIT_NOTE: {
      const track = findTrack(candidate, command.trackId);
      if (track.isDrumTrack) throw new Error("editor_note_track_required");
      if (!Number.isInteger(command.eventIndex) || !track.events?.[command.eventIndex]) throw new Error("editor_event_not_found");
      const hasPitch = command.pitch !== undefined;
      const hasDuration = command.duration !== undefined;
      const hasVelocity = command.velocity !== undefined;
      if (!hasPitch && !hasDuration && !hasVelocity) throw new Error("editor_note_edit_required");
      const event = track.events[command.eventIndex];
      if (hasPitch) {
        const pitch = assertFinite(command.pitch, "editor_note_pitch_required");
        if (!Number.isInteger(pitch) || pitch < SCORE_LIMITS.MIN_MIDI_PITCH || pitch > SCORE_LIMITS.MAX_MIDI_PITCH) {
          throw new Error("editor_note_pitch_out_of_range");
        }
        event.pitch = pitch;
      }
      if (hasDuration) {
        const duration = assertFinite(command.duration, "editor_note_duration_required");
        const timelineBeats = candidate.bars * beatsPerBar(candidate);
        const maxDuration = Math.min(64, timelineBeats - event.start);
        if (duration < 0.0001 || duration > maxDuration) throw new Error("editor_note_duration_out_of_range");
        event.duration = duration;
      }
      if (hasVelocity) {
        const velocity = assertFinite(command.velocity, "editor_note_velocity_required");
        if (velocity < SCORE_LIMITS.MIN_VELOCITY || velocity > SCORE_LIMITS.MAX_VELOCITY) {
          throw new Error("editor_note_velocity_out_of_range");
        }
        event.velocity = velocity;
      }
      break;
    }
    case EDIT_COMMANDS.SET_SECTION_ENERGY: {
      findSection(candidate, command).energy = assertFinite(command.energy, "editor_section_energy_required");
      break;
    }
    case EDIT_COMMANDS.TRANSFORM_SECTION: {
      applySectionTransform(candidate, command);
      break;
    }
    case EDIT_COMMANDS.DUPLICATE_SECTION: {
      applySectionDuplicate(candidate, command);
      break;
    }
    case EDIT_COMMANDS.MOVE_SECTION: {
      applySectionMove(candidate, command);
      break;
    }
    case EDIT_COMMANDS.RESIZE_SECTION: {
      applySectionResize(candidate, command);
      break;
    }
    case EDIT_COMMANDS.SEMANTIC_MACRO: {
      applySemanticMacro(candidate, command);
      break;
    }
    default:
      throw new Error("editor_command_unsupported");
  }

  return validateCandidate(candidate, score);
}

function normalizeHistoryLimit(value) {
  const number = Number(value ?? EDITOR_HISTORY_LIMIT);
  if (!Number.isFinite(number)) return EDITOR_HISTORY_LIMIT;
  return Math.max(1, Math.min(256, Math.trunc(number)));
}

export function createEditorSession(score, options = {}) {
  const baseScore = validateCandidate(clone(score), score);
  return {
    baseScore,
    draftScore: clone(baseScore),
    history: [],
    future: [],
    maxHistory: normalizeHistoryLimit(options.maxHistory),
    // Monotonically increasing per-session revision. Bumped on every
    // state-changing operation (edit/undo/redo/reset), never on reads.
    // Callers that mutate a session across a network hop (server-side draft
    // routes, future tool/MCP dispatch) should pass the last revision they
    // observed back as an expected-revision guard and fail closed on
    // mismatch, since a human browser session, an internal co-producer LLM,
    // and an external MCP agent can otherwise race on stale coordinates.
    revision: 0,
  };
}

export function dispatchEdit(session, command) {
  const next = applyEditCommand(session.draftScore, command);
  const history = [...session.history, clone(session.draftScore)].slice(-session.maxHistory);
  return {
    ...session,
    draftScore: next,
    history,
    future: [],
    revision: (session.revision ?? 0) + 1,
  };
}

export function undoEdit(session) {
  if (session.history.length === 0) return session;
  const history = session.history.slice(0, -1);
  const draftScore = clone(session.history.at(-1));
  return {
    ...session,
    draftScore,
    history,
    future: [clone(session.draftScore), ...session.future].slice(0, session.maxHistory),
    revision: (session.revision ?? 0) + 1,
  };
}

export function redoEdit(session) {
  if (session.future.length === 0) return session;
  const [nextDraft, ...future] = session.future;
  const history = [...session.history, clone(session.draftScore)].slice(-session.maxHistory);
  return {
    ...session,
    draftScore: clone(nextDraft),
    history,
    future,
    revision: (session.revision ?? 0) + 1,
  };
}

export function resetDraft(session) {
  if (!draftHasChanges(session)) return session;
  const history = [...session.history, clone(session.draftScore)].slice(-session.maxHistory);
  return {
    ...session,
    draftScore: clone(session.baseScore),
    history,
    future: [],
    revision: (session.revision ?? 0) + 1,
  };
}

export function draftHasChanges(session) {
  return JSON.stringify(session.baseScore) !== JSON.stringify(session.draftScore);
}

export function previewScore(session, mode = "draft") {
  return clone(mode === "original" ? session.baseScore : session.draftScore);
}

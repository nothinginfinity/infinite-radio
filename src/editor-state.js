import {
  EFFECT_TYPES,
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
  SET_SECTION_ENERGY: "SetSectionEnergy",
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

function findSection(score, command) {
  if (Number.isInteger(command.sectionIndex)) {
    const section = score.sections[command.sectionIndex];
    if (!section) throw new Error("editor_section_not_found");
    return section;
  }
  if (typeof command.label === "string") {
    const section = score.sections.find((item) => item.label === command.label);
    if (!section) throw new Error("editor_section_not_found");
    return section;
  }
  throw new Error("editor_section_required");
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
    case EDIT_COMMANDS.SET_SECTION_ENERGY: {
      findSection(candidate, command).energy = assertFinite(command.energy, "editor_section_energy_required");
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
  };
}

export function draftHasChanges(session) {
  return JSON.stringify(session.baseScore) !== JSON.stringify(session.draftScore);
}

export function previewScore(session, mode = "draft") {
  return clone(mode === "original" ? session.baseScore : session.draftScore);
}

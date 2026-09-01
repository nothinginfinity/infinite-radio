import test from "node:test";
import assert from "node:assert/strict";

import {
  EDIT_COMMANDS,
  applyEditCommand,
  createEditorSession,
  dispatchEdit,
  draftHasChanges,
  previewScore,
  redoEdit,
  resetDraft,
  undoEdit,
} from "../src/editor-state.js";
import { createFixtureScore, validateAndNormalizeScore } from "../src/score-schema.js";

function fixture() {
  return createFixtureScore(
    { channelId: "editor-channel", creatorId: "editor-creator", now: 1000 },
    { compositionId: "editor-fixture", bars: 8, bpm: 118 },
  );
}

function validate(score) {
  return validateAndNormalizeScore(score, {
    channelId: score.channelId,
    creatorId: score.creatorId,
    now: Date.parse(score.createdAt),
  });
}

test("EditCommand returns a new validated score and never mutates the input", () => {
  const base = fixture();
  const snapshot = structuredClone(base);
  const edited = applyEditCommand(base, { type: EDIT_COMMANDS.SET_TEMPO, bpm: 132 });

  assert.deepEqual(base, snapshot);
  assert.equal(edited.bpm, 132);
  assert.ok(edited.durationSeconds < base.durationSeconds);
  assert.doesNotThrow(() => validate(edited));
});

test("track mix, patch, and transpose edits remain inside the canonical score contract", () => {
  const base = fixture();
  let draft = applyEditCommand(base, { type: EDIT_COMMANDS.SET_TRACK_GAIN, trackId: "lead", gain: 0.42 });
  draft = applyEditCommand(draft, { type: EDIT_COMMANDS.SET_TRACK_PAN, trackId: "lead", pan: -0.35 });
  draft = applyEditCommand(draft, { type: EDIT_COMMANDS.SET_TRACK_PATCH, trackId: "lead", patch: "triangle_lead" });
  draft = applyEditCommand(draft, { type: EDIT_COMMANDS.TRANSPOSE, trackId: "lead", semitones: 12 });

  const lead = draft.tracks.find((track) => track.id === "lead");
  const originalLead = base.tracks.find((track) => track.id === "lead");
  assert.equal(lead.gain, 0.42);
  assert.equal(lead.pan, -0.35);
  assert.equal(lead.patch, "triangle_lead");
  assert.equal(lead.events[0].pitch, originalLead.events[0].pitch + 12);
  assert.doesNotThrow(() => validate(draft));
});

test("section energy edits stay validated and participate in local history", () => {
  const base = fixture();
  const originalEnergy = base.sections[1].energy;
  let session = createEditorSession(base);

  session = dispatchEdit(session, {
    type: EDIT_COMMANDS.SET_SECTION_ENERGY,
    sectionIndex: 1,
    energy: 0.91,
  });

  assert.equal(base.sections[1].energy, originalEnergy);
  assert.equal(session.draftScore.sections[1].energy, 0.91);
  assert.equal(draftHasChanges(session), true);
  assert.doesNotThrow(() => validate(session.draftScore));

  session = undoEdit(session);
  assert.equal(session.draftScore.sections[1].energy, originalEnergy);
  session = redoEdit(session);
  assert.equal(session.draftScore.sections[1].energy, 0.91);
});

test("section Lift and Drop reshape only the selected section and share local history", () => {
  const base = fixture();
  const sectionIndex = 1;
  const section = base.sections[sectionIndex];
  const beatsPerBar = base.timeSignature.beatsPerBar * (4 / base.timeSignature.beatUnit);
  const startBeat = section.startBar * beatsPerBar;
  const endBeat = (section.startBar + section.lengthBars) * beatsPerBar;
  const lead = base.tracks.find((track) => track.id === "lead");
  const drums = base.tracks.find((track) => track.id === "drums");
  const leadInsideIndex = lead.events.findIndex((event) => event.start >= startBeat && event.start < endBeat);
  const leadOutsideIndex = lead.events.findIndex((event) => event.start < startBeat);
  const drumInsideIndex = drums.drumEvents.findIndex((event) => event.start >= startBeat && event.start < endBeat);
  const drumOutsideIndex = drums.drumEvents.findIndex((event) => event.start < startBeat);
  assert.ok(leadInsideIndex >= 0 && leadOutsideIndex >= 0 && drumInsideIndex >= 0 && drumOutsideIndex >= 0);

  const lifted = applyEditCommand(base, {
    type: EDIT_COMMANDS.TRANSFORM_SECTION,
    sectionIndex,
    transform: "lift",
    amount: 0.65,
  });
  assert.ok(lifted.sections[sectionIndex].energy > base.sections[sectionIndex].energy);
  assert.ok(lifted.tracks.find((track) => track.id === "lead").events[leadInsideIndex].velocity > lead.events[leadInsideIndex].velocity);
  assert.ok(lifted.tracks.find((track) => track.id === "drums").drumEvents[drumInsideIndex].velocity > drums.drumEvents[drumInsideIndex].velocity);
  assert.equal(lifted.tracks.find((track) => track.id === "lead").events[leadOutsideIndex].velocity, lead.events[leadOutsideIndex].velocity);
  assert.equal(lifted.tracks.find((track) => track.id === "drums").drumEvents[drumOutsideIndex].velocity, drums.drumEvents[drumOutsideIndex].velocity);
  assert.equal(lifted.continuity.energy, base.continuity.energy);
  assert.doesNotThrow(() => validate(lifted));

  const dropped = applyEditCommand(base, {
    type: EDIT_COMMANDS.TRANSFORM_SECTION,
    sectionIndex,
    transform: "drop",
    amount: 0.65,
  });
  assert.ok(dropped.sections[sectionIndex].energy < base.sections[sectionIndex].energy);
  assert.ok(dropped.tracks.find((track) => track.id === "lead").events[leadInsideIndex].velocity < lead.events[leadInsideIndex].velocity);
  assert.equal(dropped.tracks.find((track) => track.id === "lead").events[leadOutsideIndex].velocity, lead.events[leadOutsideIndex].velocity);
  assert.doesNotThrow(() => validate(dropped));

  let session = createEditorSession(base);
  session = dispatchEdit(session, {
    type: EDIT_COMMANDS.TRANSFORM_SECTION,
    sectionIndex,
    transform: "lift",
    amount: 0.65,
  });
  const liftedEnergy = session.draftScore.sections[sectionIndex].energy;
  session = undoEdit(session);
  assert.equal(session.draftScore.sections[sectionIndex].energy, base.sections[sectionIndex].energy);
  session = redoEdit(session);
  assert.equal(session.draftScore.sections[sectionIndex].energy, liftedEnergy);

  assert.throws(
    () => applyEditCommand(base, { type: EDIT_COMMANDS.TRANSFORM_SECTION, sectionIndex, transform: "explode" }),
    /editor_section_transform_unsupported/,
  );
});

test("semantic brightness, energy, and space macros are deterministic validated transforms", () => {
  const base = fixture();
  const dryDraft = applyEditCommand(base, { type: EDIT_COMMANDS.SEMANTIC_MACRO, macro: "dry", amount: 0.8 });
  assert.ok(dryDraft.tracks.every((track) => track.effects.every((effect) => effect.type !== "reverb_short" || effect.amount <= 0.04)));
  assert.doesNotThrow(() => validate(dryDraft));

  let draft = applyEditCommand(base, { type: EDIT_COMMANDS.SEMANTIC_MACRO, macro: "brighter", amount: 0.75 });
  draft = applyEditCommand(draft, { type: EDIT_COMMANDS.SEMANTIC_MACRO, macro: "more_energy", amount: 0.5 });
  draft = applyEditCommand(draft, { type: EDIT_COMMANDS.SEMANTIC_MACRO, macro: "spacious", amount: 0.6 });

  const lead = draft.tracks.find((track) => track.id === "lead");
  assert.equal(lead.patch, "saw_lead");
  assert.ok(lead.events[0].velocity > base.tracks[0].events[0].velocity);
  assert.ok(draft.continuity.energy > base.continuity.energy);
  assert.ok(draft.tracks.every((track) => track.effects.some((effect) => effect.type === "reverb_short")));
  assert.doesNotThrow(() => validate(draft));
});

test("editor session supports local undo, redo, reset, and Original/Draft A-B preview", () => {
  const base = fixture();
  const baseBassGain = base.tracks.find((track) => track.id === "bass").gain;
  let session = createEditorSession(base);
  assert.equal(draftHasChanges(session), false);

  session = dispatchEdit(session, { type: EDIT_COMMANDS.SET_TEMPO, bpm: 140 });
  session = dispatchEdit(session, { type: EDIT_COMMANDS.SET_TRACK_GAIN, trackId: "bass", gain: 0.3 });
  assert.equal(session.draftScore.bpm, 140);
  assert.equal(draftHasChanges(session), true);
  assert.equal(previewScore(session, "original").bpm, 118);
  assert.equal(previewScore(session, "draft").bpm, 140);

  session = undoEdit(session);
  assert.equal(session.draftScore.tracks.find((track) => track.id === "bass").gain, baseBassGain);
  assert.equal(session.draftScore.bpm, 140);

  session = redoEdit(session);
  assert.equal(session.draftScore.tracks.find((track) => track.id === "bass").gain, 0.3);

  session = resetDraft(session);
  assert.equal(session.draftScore.bpm, 118);
  assert.equal(draftHasChanges(session), false);
  assert.deepEqual(session.baseScore, base);
});

test("history is bounded and pointer-like repeated local edits do not imply persistence", () => {
  let session = createEditorSession(fixture(), { maxHistory: 3 });
  for (const bpm of [120, 122, 124, 126, 128]) {
    session = dispatchEdit(session, { type: EDIT_COMMANDS.SET_TEMPO, bpm });
  }
  assert.equal(session.history.length, 3);
  assert.equal(session.draftScore.bpm, 128);
});

test("invalid edits fail closed instead of producing a previewable invalid score", () => {
  const base = fixture();
  assert.throws(
    () => applyEditCommand(base, { type: EDIT_COMMANDS.SET_TEMPO, bpm: 999 }),
    /invalid_bpm/,
  );
  assert.throws(
    () => applyEditCommand(base, { type: EDIT_COMMANDS.TRANSPOSE, trackId: "lead", semitones: 48 }),
    /editor_transpose_out_of_range/,
  );
  assert.throws(
    () => applyEditCommand(base, { type: EDIT_COMMANDS.SET_TRACK_PATCH, trackId: "lead", patch: "arbitrary_dsp" }),
    /editor_patch_unsupported/,
  );
});

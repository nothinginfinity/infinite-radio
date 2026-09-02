import test from "node:test";
import assert from "node:assert/strict";

import { ChannelConductor } from "../src/index.js";
import { createFixtureScore } from "../src/score-schema.js";

class MemoryStorage {
  constructor(seed = new Map()) {
    this.seed = seed;
  }

  async get(key) {
    const value = this.seed.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.seed.set(key, structuredClone(value));
  }
}

function makeCtx(storage) {
  return {
    storage,
    getWebSockets() {
      return [];
    },
    acceptWebSocket() {},
  };
}

function channelRequest(path, { method = "GET", body, channelId = "alpha", creatorId = "creator-a" } = {}) {
  const headers = new Headers({
    "x-channel-id": channelId,
    "x-creator-id": creatorId,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://channel.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedChannelWithComposition(storage, { channelId = "alpha", creatorId = "creator-a" } = {}) {
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId }, channelId, creatorId }));
  const state = await storage.get("channel-state");
  const score = createFixtureScore({ channelId, creatorId });
  state.currentComposition = score;
  state.currentCompositionStartedAt = new Date().toISOString();
  await storage.put("channel-state", state);
  return score;
}

// V0.6 Step 1 / 1b: these tests cover the authoritative server-side draft
// session on ChannelConductor -- the wiring around editor-state.js's
// createEditorSession/dispatchEdit/undoEdit/redoEdit/resetDraft/previewScore,
// the draft revision guard, and opaque note_ref addressing added per
// chatgpt:infinite-radio's design review (msg:6c8119a9-a83e-499e-80a6-58c9e16a51fc).
// The reducer's own edit semantics are already covered by
// test/editor-state.test.js.

test("draft/start creates an authoritative session cloned from the current composition", async () => {
  const storage = new MemoryStorage();
  const score = await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});

  const response = await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.hasChanges, false);
  assert.equal(body.revision, 0);
  assert.equal(body.baseScore.compositionId, score.compositionId);
  assert.equal(body.draftScore.compositionId, score.compositionId);
});

test("draft/start without a current composition is rejected", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" } }));

  const response = await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_no_current_composition");
});

test("draft edit -> undo -> redo round-trips through the deterministic reducer, validator, and revision counter", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  let response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 140 } },
  }));
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, true);
  assert.equal(body.draftScore.bpm, 140);
  assert.equal(body.revision, 1);
  assert.equal(body.historyLength, 1);

  response = await conductor.fetch(channelRequest("/draft/undo", { method: "POST", body: { expectedRevision: 1 } }));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, false);
  assert.equal(body.revision, 2);
  assert.notEqual(body.draftScore.bpm, 140);

  response = await conductor.fetch(channelRequest("/draft/redo", { method: "POST", body: { expectedRevision: 2 } }));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, true);
  assert.equal(body.revision, 3);
  assert.equal(body.draftScore.bpm, 140);
});

test("draft/edit without expectedRevision is rejected", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { command: { type: "SetTempo", bpm: 140 } },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_expected_revision_required");
});

test("draft/edit against a stale revision fails closed with draft_revision_conflict and leaves the draft unchanged", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 140 } },
  }));

  // Simulates a second actor (human browser, internal LLM, or external MCP
  // agent) racing on the pre-edit revision.
  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 200 } },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_revision_conflict");

  const stateResponse = await conductor.fetch(channelRequest("/draft", { method: "GET" }));
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.draftScore.bpm, 140);
  assert.equal(stateBody.revision, 1);
});

test("draft edit rejects an invalid EditCommand without mutating the draft or the revision", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "EditNote", trackId: "does-not-exist", eventIndex: 0, pitch: 60 } },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "editor_track_not_found");

  const stateResponse = await conductor.fetch(channelRequest("/draft", { method: "GET" }));
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.hasChanges, false);
  assert.equal(stateBody.revision, 0);
});

test("draft/reset discards local changes, restores the base score, and advances the revision", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 150 } },
  }));

  const response = await conductor.fetch(channelRequest("/draft/reset", { method: "POST", body: { expectedRevision: 1 } }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, false);
  assert.equal(body.revision, 2);
  assert.notEqual(body.draftScore.bpm, 150);
});

test("draft/preview returns original vs draft without mutating session state", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 160 } },
  }));

  const draftResponse = await conductor.fetch(channelRequest("/draft/preview?mode=draft", { method: "GET" }));
  const draftBody = await draftResponse.json();
  assert.equal(draftBody.score.bpm, 160);
  assert.equal(draftBody.revision, 1);

  const originalResponse = await conductor.fetch(channelRequest("/draft/preview?mode=original", { method: "GET" }));
  const originalBody = await originalResponse.json();
  assert.notEqual(originalBody.score.bpm, 160);
});

test("draft routes require an already-started session", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});

  const response = await conductor.fetch(channelRequest("/draft", { method: "GET" }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_not_started");
});

test("draft session is scoped per channel and survives Durable Object reconstruction", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const first = new ChannelConductor(makeCtx(storage), {});
  await first.fetch(channelRequest("/draft/start", { method: "POST" }));
  await first.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 133 } },
  }));

  const restarted = new ChannelConductor(makeCtx(storage), {});
  const response = await restarted.fetch(channelRequest("/draft", { method: "GET" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.draftScore.bpm, 133);
  assert.equal(body.revision, 1);
});

test("GET /draft/notes returns an opaque note_ref per melodic note, scoped to a section when requested", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const allNotes = await (await conductor.fetch(channelRequest("/draft/notes", { method: "GET" }))).json();
  assert.equal(allNotes.ok, true);
  assert.equal(allNotes.revision, 0);
  assert.ok(allNotes.notes.length > 0);
  assert.ok(allNotes.notes.every((note) => typeof note.noteRef === "string" && note.noteRef.length > 0));
  assert.ok(allNotes.notes.every((note) => note.trackId !== "drums"));

  const sectionNotes = await (await conductor.fetch(channelRequest("/draft/notes?sectionIndex=0", { method: "GET" }))).json();
  assert.ok(sectionNotes.notes.length > 0);
  assert.ok(sectionNotes.notes.length <= allNotes.notes.length);

  const unknownSection = await conductor.fetch(channelRequest("/draft/notes?sectionIndex=999", { method: "GET" }));
  assert.equal(unknownSection.status, 400);
  assert.equal((await unknownSection.json()).error, "draft_section_not_found");
});

test("note_ref resolves to the exact note through EditNote and is rejected once stale", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const notesPayload = await (await conductor.fetch(channelRequest("/draft/notes?trackId=lead", { method: "GET" }))).json();
  const target = notesPayload.notes[0];

  const editResponse = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: {
      expectedRevision: 0,
      command: { type: "EditNote", noteRef: target.noteRef, velocity: 0.31 },
    },
  }));
  const editBody = await editResponse.json();
  assert.equal(editResponse.status, 200);
  assert.equal(editBody.revision, 1);
  const editedTrack = editBody.draftScore.tracks.find((track) => track.id === "lead");
  assert.equal(editedTrack.events[target.eventIndex].velocity, 0.31);

  // The revision has now advanced, so the same note_ref (still encoding
  // revision 0) must be rejected as stale rather than silently reapplied.
  const staleResponse = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: {
      expectedRevision: 1,
      command: { type: "EditNote", noteRef: target.noteRef, velocity: 0.9 },
    },
  }));
  const staleBody = await staleResponse.json();
  assert.equal(staleResponse.status, 400);
  assert.equal(staleBody.error, "draft_note_ref_stale");
});

test("a forged or malformed note_ref is rejected as invalid", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: {
      expectedRevision: 0,
      command: { type: "EditNote", noteRef: "not-a-valid-ref", velocity: 0.5 },
    },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_note_ref_invalid");
});

test("concurrent draft/edit requests with the same expectedRevision serialize: exactly one succeeds, one conflicts, no lost update", async () => {
  // Regression test for the race flagged by chatgpt:infinite-radio
  // (msg:ddc1d7c2-5b57-4c31-9be9-831dfb8e5ba1): without a serialized draft
  // mutation boundary, two concurrent callers could each load revision N,
  // both pass the expectedRevision check before either persisted, and one
  // edit would be silently lost. runDraftMutation's promise-tail queue must
  // make that impossible regardless of how the two requests interleave.
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const [firstResponse, secondResponse] = await Promise.all([
    conductor.fetch(channelRequest("/draft/edit", {
      method: "POST",
      body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 150 } },
    })),
    conductor.fetch(channelRequest("/draft/edit", {
      method: "POST",
      body: { expectedRevision: 0, command: { type: "SetTempo", bpm: 190 } },
    })),
  ]);
  const [firstBody, secondBody] = await Promise.all([firstResponse.json(), secondResponse.json()]);

  const statuses = [firstResponse.status, secondResponse.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 400]);

  const succeededBody = firstResponse.status === 200 ? firstBody : secondBody;
  const conflictedBody = firstResponse.status === 200 ? secondBody : firstBody;
  assert.equal(conflictedBody.error, "draft_revision_conflict");
  assert.equal(succeededBody.revision, 1);
  assert.ok(succeededBody.draftScore.bpm === 150 || succeededBody.draftScore.bpm === 190);

  // The persisted draft must reflect exactly the one edit that won -- not a
  // merge, not the loser, and the revision must not have advanced twice.
  const finalState = await (await conductor.fetch(channelRequest("/draft", { method: "GET" }))).json();
  assert.equal(finalState.revision, 1);
  assert.equal(finalState.draftScore.bpm, succeededBody.draftScore.bpm);
});

test("noteRef is only meaningful for EditNote commands", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  const notesPayload = await (await conductor.fetch(channelRequest("/draft/notes?trackId=lead", { method: "GET" }))).json();

  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: {
      expectedRevision: 0,
      command: { type: "SetTempo", bpm: 140, noteRef: notesPayload.notes[0].noteRef },
    },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "draft_note_ref_unsupported");
});

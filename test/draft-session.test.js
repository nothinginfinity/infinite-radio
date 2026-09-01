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

// V0.6 Step 1: these tests cover the new authoritative server-side draft
// session on ChannelConductor -- the wiring around editor-state.js's
// createEditorSession/dispatchEdit/undoEdit/redoEdit/resetDraft/previewScore,
// not the reducer's internal edit semantics, which are already covered by
// test/editor-state.test.js.

test("draft/start creates an authoritative session cloned from the current composition", async () => {
  const storage = new MemoryStorage();
  const score = await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});

  const response = await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.hasChanges, false);
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

test("draft edit -> undo -> redo round-trips through the deterministic reducer and validator", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  let response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { command: { type: "SetTempo", bpm: 140 } },
  }));
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, true);
  assert.equal(body.draftScore.bpm, 140);
  assert.equal(body.historyLength, 1);

  response = await conductor.fetch(channelRequest("/draft/undo", { method: "POST" }));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, false);
  assert.notEqual(body.draftScore.bpm, 140);

  response = await conductor.fetch(channelRequest("/draft/redo", { method: "POST" }));
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, true);
  assert.equal(body.draftScore.bpm, 140);
});

test("draft edit rejects an invalid EditCommand without mutating the draft", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));

  const response = await conductor.fetch(channelRequest("/draft/edit", {
    method: "POST",
    body: { command: { type: "EditNote", trackId: "does-not-exist", eventIndex: 0, pitch: 60 } },
  }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "editor_track_not_found");

  const stateResponse = await conductor.fetch(channelRequest("/draft", { method: "GET" }));
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.hasChanges, false);
});

test("draft/reset discards local changes and restores the base score", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  await conductor.fetch(channelRequest("/draft/edit", { method: "POST", body: { command: { type: "SetTempo", bpm: 150 } } }));

  const response = await conductor.fetch(channelRequest("/draft/reset", { method: "POST" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hasChanges, false);
  assert.notEqual(body.draftScore.bpm, 150);
});

test("draft/preview returns original vs draft without mutating session state", async () => {
  const storage = new MemoryStorage();
  await seedChannelWithComposition(storage);
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(channelRequest("/draft/start", { method: "POST" }));
  await conductor.fetch(channelRequest("/draft/edit", { method: "POST", body: { command: { type: "SetTempo", bpm: 160 } } }));

  const draftResponse = await conductor.fetch(channelRequest("/draft/preview?mode=draft", { method: "GET" }));
  const draftBody = await draftResponse.json();
  assert.equal(draftBody.score.bpm, 160);

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
  await first.fetch(channelRequest("/draft/edit", { method: "POST", body: { command: { type: "SetTempo", bpm: 133 } } }));

  const restarted = new ChannelConductor(makeCtx(storage), {});
  const response = await restarted.fetch(channelRequest("/draft", { method: "GET" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.draftScore.bpm, 133);
});

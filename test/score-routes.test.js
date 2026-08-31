import test from "node:test";
import assert from "node:assert/strict";

import { ChannelConductor } from "../src/index.js";
import { SCORE_SCHEMA_VERSION } from "../src/score-schema.js";

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

function fakeAiEnv(overrides = {}) {
  return {
    AI: {
      async run() {
        return {
          response: JSON.stringify({
            schemaVersion: SCORE_SCHEMA_VERSION,
            compositionId: "ai-comp-1",
            bpm: 120,
            timeSignature: { beatsPerBar: 4, beatUnit: 4 },
            key: { root: "E", mode: "minor" },
            bars: 4,
            sections: [{ startBar: 0, lengthBars: 4, label: "loop" }],
            tracks: [
              { id: "lead", patch: "sine_lead", events: [{ pitch: 64, start: 0, duration: 1, velocity: 0.7 }] },
            ],
            continuity: { motifIds: ["riser"], energy: 0.6 },
          }),
        };
      },
    },
    ...overrides,
  };
}

async function initChannel(conductor) {
  const response = await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" } }));
  assert.equal(response.status, 201);
}

test("/score/next composes via Workers AI, queues the score, and updates continuity", async () => {
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv());
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  assert.equal(response.status, 201);
  const payload = await response.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.source, "workers-ai");
  assert.equal(payload.fell_back, false);
  assert.equal(payload.score.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(payload.score.channelId, "alpha");
  assert.equal(payload.composition_buffer_count, 1);
  assert.equal(payload.state.lastCompositionId, "ai-comp-1");
  assert.ok(payload.state.bible.recurringMotifs.includes("riser"));
});

test("/score/next falls back to the fixture composer when the AI binding is missing", async () => {
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), {});
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  assert.equal(response.status, 201);
  const payload = await response.json();

  assert.equal(payload.source, "fixture");
  assert.equal(payload.fell_back, true);
  assert.equal(payload.fallback_reason, "ai_binding_unavailable");
  assert.equal(payload.score.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(payload.score.channelId, "alpha");
});

test("/score/select pops the queued composition FIFO and empties correctly", async () => {
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv());
  await initChannel(conductor);

  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));

  const selectResponse = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  assert.equal(selectResponse.status, 200);
  const selectPayload = await selectResponse.json();
  assert.equal(selectPayload.score.compositionId, "ai-comp-1");
  assert.equal(selectPayload.composition_buffer_count, 0);

  const emptyResponse = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  assert.equal(emptyResponse.status, 400);
  const emptyPayload = await emptyResponse.json();
  assert.equal(emptyPayload.error, "composition_queue_empty");
});

test("/score/next is channel-scoped: a second channel gets its own independent queue", async () => {
  const conductorAlpha = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv());
  const conductorBeta = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv());
  await conductorAlpha.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" }, channelId: "alpha" }));
  await conductorBeta.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-b" }, channelId: "beta" }));

  await conductorAlpha.fetch(channelRequest("/score/next", { method: "POST", body: {}, channelId: "alpha", creatorId: "creator-a" }));

  const betaState = await (await conductorBeta.fetch(channelRequest("/state", { channelId: "beta", creatorId: "creator-b" }))).json();
  assert.equal(betaState.state.compositionQueue.length, 0);

  const alphaState = await (await conductorAlpha.fetch(channelRequest("/state", { channelId: "alpha", creatorId: "creator-a" }))).json();
  assert.equal(alphaState.state.compositionQueue.length, 1);
  assert.equal(alphaState.state.compositionQueue[0].channelId, "alpha");
});

import test from "node:test";
import assert from "node:assert/strict";

import worker, { ChannelConductor } from "../src/index.js";
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
              // Sustained note spanning the whole declared 4-bar/16-beat
              // timeline so this fixture passes the musical
              // temporal-coverage quality gate, not just schema validation.
              { id: "lead", patch: "sine_lead", events: [{ pitch: 64, start: 0, duration: 16, velocity: 0.7 }] },
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

test("/score/next queues a future score without advancing continuity until selection", async () => {
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
  assert.equal(payload.state.currentComposition, null);
  assert.equal(payload.state.lastCompositionId, null);
  assert.equal(payload.state.bible.recurringMotifs.includes("riser"), false);

  const selectedResponse = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  const selected = await selectedResponse.json();
  assert.equal(selected.score.compositionId, "ai-comp-1");
  assert.equal(selected.state.currentComposition.compositionId, "ai-comp-1");
  assert.equal(selected.state.lastCompositionId, "ai-comp-1");
  assert.ok(selected.state.bible.recurringMotifs.includes("riser"));
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

test("/score/prebuffer serializes concurrent requests and keeps exactly one future score ready", async () => {
  const env = fakeAiEnv();
  const originalRun = env.AI.run;
  let calls = 0;
  env.AI.run = async (...args) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return originalRun(...args);
  };
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), env);
  await initChannel(conductor);

  const [first, second] = await Promise.all([
    conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: { listenerIntent: { surface: "test" } } })),
    conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: { listenerIntent: { surface: "test" } } })),
  ]);
  const firstPayload = await first.json();
  const secondPayload = await second.json();

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(calls, 1);
  assert.equal(firstPayload.composition_buffer_count, 1);
  assert.equal(secondPayload.composition_buffer_count, 1);
  assert.equal([firstPayload.created, secondPayload.created].filter(Boolean).length, 1);
  const state = await (await conductor.fetch(channelRequest("/state"))).json();
  assert.equal(state.state.compositionQueue.length, 1);
});

test("/score/prebuffer replace reshapes only the future score and preserves the current continuity anchor", async () => {
  const env = fakeAiEnv();
  const originalRun = env.AI.run;
  let calls = 0;
  env.AI.run = async (...args) => {
    calls += 1;
    const result = await originalRun(...args);
    const score = JSON.parse(result.response);
    score.compositionId = `ai-comp-${calls}`;
    score.continuity = { motifIds: [`motif-${calls}`], energy: 0.4 + calls * 0.1 };
    return { response: JSON.stringify(score) };
  };
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), env);
  await initChannel(conductor);

  const firstBuffer = await conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: { listenerIntent: { text: "first" } } }));
  assert.equal(firstBuffer.status, 201);
  const firstPayload = await firstBuffer.json();
  assert.equal(firstPayload.buffered_composition_id, "ai-comp-1");

  const selectedResponse = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  const selected = await selectedResponse.json();
  assert.equal(selected.score.compositionId, "ai-comp-1");
  assert.equal(selected.state.currentComposition.compositionId, "ai-comp-1");
  assert.equal(selected.state.lastCompositionId, "ai-comp-1");
  assert.ok(selected.state.bible.recurringMotifs.includes("motif-1"));

  const secondBuffer = await conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: { listenerIntent: { text: "second" } } }));
  const secondPayload = await secondBuffer.json();
  assert.equal(secondPayload.buffered_composition_id, "ai-comp-2");
  assert.equal(secondPayload.state.currentComposition.compositionId, "ai-comp-1");
  assert.equal(secondPayload.state.lastCompositionId, "ai-comp-1");
  assert.equal(secondPayload.state.bible.recurringMotifs.includes("motif-2"), false);

  const replacement = await conductor.fetch(channelRequest("/score/prebuffer", {
    method: "POST",
    body: { replace: true, listenerIntent: { surface: "v04_visual_steering", text: "brighter and stranger next" } },
  }));
  assert.equal(replacement.status, 201);
  const replacementPayload = await replacement.json();
  assert.equal(replacementPayload.created, true);
  assert.equal(replacementPayload.replaced, true);
  assert.equal(replacementPayload.previous_buffered_composition_id, "ai-comp-2");
  assert.equal(replacementPayload.buffered_composition_id, "ai-comp-3");
  assert.equal(replacementPayload.composition_buffer_count, 1);
  assert.equal(replacementPayload.state.currentComposition.compositionId, "ai-comp-1");
  assert.equal(replacementPayload.state.lastCompositionId, "ai-comp-1");
  assert.equal(replacementPayload.state.bible.recurringMotifs.includes("motif-3"), false);
  assert.equal(calls, 3);
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

test("root serves V0.4 Visual + Score projections with future-only steering and no editor mutation path", async () => {
  const response = await worker.fetch(new Request("https://infinite-radio.test/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();

  assert.match(html, /data-step="v0\.4-step-1"/);
  assert.match(html, /class ScoreRenderer/);
  assert.match(html, /infinite-radio-score-v1/);
  assert.match(html, /const canonicalState=/);
  assert.match(html, /const viewState=/);
  assert.match(html, /const stationState=/);
  assert.match(html, /currentComposition/);
  assert.match(html, /Visual/);
  assert.match(html, /Steer next/);
  assert.match(html, /scoreMetrics/);
  assert.match(html, /steeringPrompt/);
  assert.match(html, /drawVisualProjection/);
  assert.match(html, /replace:true/);
  assert.match(html, /navigator\.audioSession/);
  assert.match(html, /audioSession\.type=\"playback\"/);
  assert.match(html, /unlockFromGesture/);
  assert.match(html, /audio_context_/);
  assert.match(html, /id=\"audio-chip\"/);
  assert.match(html, /Tap Play to restore audio/);
  assert.match(html, /score playing now is never edited/i);
  assert.match(html, /id="library-open"/);
  assert.match(html, /id="library-sheet"/);
  assert.match(html, /\/score\/library/);
  assert.match(html, /library replay/);
  assert.match(html, /id="return-live"/);
  assert.doesNotMatch(html, /EditCommand/);
  assert.doesNotMatch(html, /ScoreReducer/);
  assert.doesNotMatch(html, /\beval\s*\(/);
  assert.doesNotMatch(html, /new Function\s*\(/);
  assert.doesNotMatch(html, /AudioWorklet/);
});

test("health advertises the structured-composition browser-synth runtime", async () => {
  const response = await worker.fetch(new Request("https://infinite-radio.test/health"), {});
  const payload = await response.json();
  assert.equal(payload.version, "0.3.1");
  assert.equal(payload.runtime, "structured-composition-browser-synth");
});

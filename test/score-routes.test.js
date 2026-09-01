import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

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

test("legacy persisted channels are hydrated before structured composition generation", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), fakeAiEnv());
  await initChannel(conductor);

  const legacy = await storage.get("channel-state");
  legacy.schemaVersion = 2;
  delete legacy.compositionQueue;
  delete legacy.currentComposition;
  delete legacy.currentCompositionStartedAt;
  delete legacy.lastCompositionId;
  delete legacy.lastTransitionHint;
  delete legacy.counters.compositionsQueued;
  delete legacy.counters.compositionFallbacks;
  await storage.put("channel-state", legacy);

  const response = await conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: {} }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.composition_buffer_count, 1);
  assert.equal(payload.source, "workers-ai");

  const repaired = await storage.get("channel-state");
  assert.equal(repaired.schemaVersion, 3);
  assert.equal(repaired.compositionQueue.length, 1);
  assert.equal(repaired.currentComposition, null);
  assert.equal(repaired.lastCompositionId, null);
  assert.equal(repaired.counters.compositionsQueued, 1);
  assert.equal(repaired.counters.compositionFallbacks, 0);
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

test("/playback/rejoin advances an expired canonical score exactly once and returns the new live position", async () => {
  const storage = new MemoryStorage();
  const env = fakeAiEnv();
  const originalRun = env.AI.run;
  let calls = 0;
  env.AI.run = async (...args) => {
    calls += 1;
    const result = await originalRun(...args);
    const score = JSON.parse(result.response);
    score.compositionId = `rejoin-comp-${calls}`;
    return { response: JSON.stringify(score) };
  };
  const conductor = new ChannelConductor(makeCtx(storage), env);
  await initChannel(conductor);

  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  const firstSelection = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  const first = await firstSelection.json();
  assert.equal(first.score.compositionId, "rejoin-comp-1");
  assert.ok(first.playback.started_at);

  await conductor.fetch(channelRequest("/score/prebuffer", { method: "POST", body: {} }));
  const persisted = await storage.get("channel-state");
  persisted.currentCompositionStartedAt = new Date(
    Date.now() - (persisted.currentComposition.durationSeconds + 2) * 1000,
  ).toISOString();
  await storage.put("channel-state", persisted);

  const rejoinResponse = await conductor.fetch(channelRequest("/playback/rejoin", { method: "POST", body: {} }));
  assert.equal(rejoinResponse.status, 200);
  const rejoined = await rejoinResponse.json();
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.advanced, true);
  assert.equal(rejoined.state.currentComposition.compositionId, "rejoin-comp-2");
  assert.equal(rejoined.state.compositionQueue.length, 0);
  assert.equal(rejoined.playback.composition_id, "rejoin-comp-2");
  assert.ok(rejoined.playback.position_seconds >= 0);
  assert.ok(rejoined.playback.position_seconds < 1);
  assert.equal(rejoined.playback.ended, false);

  const replayResponse = await conductor.fetch(channelRequest("/playback/rejoin", { method: "POST", body: {} }));
  const replay = await replayResponse.json();
  assert.equal(replay.advanced, false);
  assert.equal(replay.state.currentComposition.compositionId, "rejoin-comp-2");
});

test("/playback/rejoin repairs legacy current state that predates the authoritative start clock", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), fakeAiEnv());
  await initChannel(conductor);
  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  const legacy = await storage.get("channel-state");
  delete legacy.currentCompositionStartedAt;
  await storage.put("channel-state", legacy);

  const response = await conductor.fetch(channelRequest("/playback/rejoin", { method: "POST", body: {} }));
  const payload = await response.json();
  assert.equal(payload.advanced, false);
  assert.equal(payload.state.currentComposition.compositionId, "ai-comp-1");
  assert.ok(payload.playback.started_at);
  assert.ok(payload.playback.position_seconds < 1);
  const repaired = await storage.get("channel-state");
  assert.equal(repaired.currentCompositionStartedAt, payload.playback.started_at);
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

test("root serves V0.5 focused local editor over replay-safe live continuity", async () => {
  const response = await worker.fetch(new Request("https://infinite-radio.test/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();

  assert.match(html, /data-step="v0\.5-editor"/);
  assert.match(html, /id="score-attribution"/);
  assert.match(html, /id="attr-provenance"/);
  assert.match(html, /id="attr-prompt"/);
  assert.match(html, /id="attr-channel"/);
  assert.match(html, /function renderAttribution\(score\)/);
  assert.match(html, /function composerLabel\(composer\)/);
  assert.match(html, /class="queue-preview"/);
  assert.match(html, /id="queue-card"/);
  assert.match(html, /id="queue-provenance-chip"/);
  assert.match(html, /id="queue-fallback-chip"/);
  assert.match(html, /function renderQueuePreview\(score\)/);
  assert.match(html, /Deterministic fixture fallback/);
  assert.match(html, /class ScoreRenderer/);
  const clientScriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(clientScriptMatch, "root must emit one inline browser script");
  assert.doesNotThrow(() => new vm.Script(clientScriptMatch[1]), "emitted browser script must parse");
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
  assert.match(html, /id="edit-open"/);
  assert.match(html, /id="editor-sheet"/);
  assert.match(html, /data-editor-preview="original"/);
  assert.match(html, /data-editor-preview="draft"/);
  assert.match(html, /data-editor-macro="brighter"/);
  assert.match(html, /data-editor-macro="dry"/);
  assert.match(html, /async function openEditor\(\)/);
  assert.match(html, /async function previewEditorScore\(\)/);
  assert.match(html, /async function exitEditor\(\)/);
  assert.match(html, /viewState\.editing/);
  assert.match(html, /Back to live discards the local preview/);
  assert.match(html, /const CROSSFADE_SECONDS=4/);
  assert.match(html, /adoptContext\(sharedContext\)/);
  assert.match(html, /rampMasterTo\(value,seconds=0\)/);
  assert.match(html, /startDualDeckCrossfade\(session\)/);
  assert.match(html, /crossfadeInFlight/);
  assert.match(html, /incoming\.adoptContext\(outgoing\.ctx\)/);
  assert.match(html, /outgoing\.rampMasterTo\(0,CROSSFADE_SECONDS\)/);
  assert.match(html, /incoming\.rampMasterTo\(\.5,CROSSFADE_SECONDS\)/);
  assert.match(html, /this\.master\.context!==this\.ctx/);
  assert.match(html, /crossfadeEpoch/);
  assert.match(html, /crossfadeAttemptedCompositionId/);
  assert.match(html, /function settleCrossfade/);
  assert.match(html, /seek\(seconds\)/);
  assert.match(html, /\/playback\/rejoin/);
  assert.match(html, /applyPlaybackSnapshot/);
  assert.match(html, /rejoinLiveState/);
  assert.match(html, /position synced/);
  assert.match(html, /async function resyncLiveAfterPlay\(session\)/);
  const playStart = html.indexOf("async function play(){");
  const unlockIndex = html.indexOf("await renderer.unlockFromGesture()", playStart);
  const firstRendererPlayIndex = html.indexOf("await renderer.play()", playStart);
  const liveResyncIndex = html.indexOf("void resyncLiveAfterPlay(stationState.session)", playStart);
  assert.ok(playStart >= 0);
  assert.ok(unlockIndex > playStart, "Play must unlock WebAudio inside the tap handler");
  assert.ok(firstRendererPlayIndex > unlockIndex, "audible scheduling must begin immediately after WebAudio unlock");
  assert.ok(liveResyncIndex > firstRendererPlayIndex, "live network rejoin must happen only after audible scheduling begins");
  assert.match(html, /resumeIfPlaying&&wasPlaying&&!payload\.playback\.ended/);
  assert.match(html, /params\.has\("channel"\)&&params\.has\("creator"\)/);
  assert.match(html, /const livePlayback=!viewState\.replaying&&!viewState\.editing/);
  assert.match(html, /stationState\.autoAdvance=livePlayback/);
  assert.match(html, /Playing library replay · live continuity unchanged/);
  assert.match(html, /Crossfade unavailable · end transition fallback remains active/);
  assert.match(html, /stationState\.queuedCount<1&&!viewState\.replaying&&!viewState\.editing/);
  assert.match(html, /stationState\.autoAdvance&&!viewState\.replaying&&!viewState\.editing&&!stationState\.endedHandled/);
  const crossfadeStart = html.indexOf("async function startDualDeckCrossfade");
  const selectionIndex = html.indexOf('await api("/score/select","POST")', crossfadeStart);
  const contextAdoptIndex = html.indexOf("incoming.adoptContext(outgoing.ctx)", crossfadeStart);
  const incomingPlayIndex = html.indexOf("await incoming.play()", crossfadeStart);
  assert.ok(crossfadeStart >= 0);
  assert.ok(selectionIndex > crossfadeStart, "crossfade must atomically select the FIFO score first");
  assert.ok(contextAdoptIndex > selectionIndex, "incoming deck must adopt the shared context only after selection");
  assert.ok(incomingPlayIndex > contextAdoptIndex, "incoming audio must not start before server selection");
  assert.doesNotMatch(html, /EditCommand/);
  assert.doesNotMatch(html, /ScoreReducer/);
  assert.doesNotMatch(html, /\beval\s*\(/);
  assert.doesNotMatch(html, /new Function\s*\(/);
  assert.doesNotMatch(html, /AudioWorklet/);
});

test("channel proxy preserves bounded library query parameters for the Durable Object", async () => {
  let forwardedUrl = null;
  let forwardedChannelId = null;
  const env = {
    CHANNEL_CONDUCTOR: {
      idFromName(channelId) {
        return channelId;
      },
      get() {
        return {
          async fetch(request) {
            forwardedUrl = request.url;
            forwardedChannelId = request.headers.get("x-channel-id");
            return new Response("ok", { status: 200 });
          },
        };
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://infinite-radio.test/api/channels/alpha/score/library?limit=1&before=2026-08-31T13%3A00%3A00.000Z"),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedChannelId, "alpha");
  const forwarded = new URL(forwardedUrl);
  assert.equal(forwarded.pathname, "/score/library");
  assert.equal(forwarded.searchParams.get("limit"), "1");
  assert.equal(forwarded.searchParams.get("before"), "2026-08-31T13:00:00.000Z");
});

test("health advertises the structured-composition browser-synth runtime", async () => {
  const response = await worker.fetch(new Request("https://infinite-radio.test/health"), {});
  const payload = await response.json();
  assert.equal(payload.version, "0.3.1");
  assert.equal(payload.runtime, "structured-composition-browser-synth");
});

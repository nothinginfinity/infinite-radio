import assert from "node:assert/strict";

function githubAnnotationText(value) {
  return String(value ?? "unknown live-acceptance failure")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

process.on("uncaughtExceptionMonitor", (error) => {
  console.error(`::error title=Live acceptance failed::${githubAnnotationText(error?.stack ?? error)}`);
});

const baseUrl = process.env.LIVE_URL ?? "https://infinite-radio.jaredtechfit.workers.dev";
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const channelA = `accept-a-${runId}`;
const channelB = `accept-b-${runId}`;
const channelModel = `accept-model-${runId}`;
const creatorA = `creator-a-${runId}`;
const creatorB = `creator-b-${runId}`;
const creatorModel = `creator-model-${runId}`;

async function call(path, { method = "GET", creatorId, providerKey, body, expected = [200] } = {}) {
  const headers = {};
  if (creatorId) headers["x-creator-id"] = creatorId;
  if (providerKey) headers["x-provider-key"] = providerKey;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  assert.ok(
    expected.includes(response.status),
    `${method} ${path} expected ${expected.join("/")} got ${response.status}: ${text}`,
  );
  return { response, data };
}

const health = await call("/health");
assert.equal(health.data.ok, true);
assert.equal(health.data.version, "0.3.1");
assert.equal(health.data.runtime, "structured-composition-browser-synth");
assert.equal(health.data.bindings.channelConductor, true);
assert.equal(health.data.bindings.d1, true);
assert.equal(health.data.bindings.r2, true);
assert.equal(health.data.bindings.workersAI, true);
assert.deepEqual(health.data.musicProviders, ["fixture", "fal-cassetteai", "fal-stable-audio"]);

const player = await call("/");
assert.match(player.data.raw, /data-step="v0\.4-step-1"/);
assert.match(player.data.raw, /class ScoreRenderer/);
assert.match(player.data.raw, /infinite-radio-score-v1/);
assert.match(player.data.raw, /const canonicalState=/);
assert.match(player.data.raw, /const viewState=/);
assert.match(player.data.raw, /const stationState=/);
assert.match(player.data.raw, /\/score\/prebuffer/);
assert.match(player.data.raw, /ensureNextBuffered/);
assert.match(player.data.raw, /advanceAfterEnd/);
assert.match(player.data.raw, /currentComposition/);
assert.match(player.data.raw, /drawVisualProjection/);
assert.match(player.data.raw, /scoreMetrics/);
assert.match(player.data.raw, /steeringPrompt/);
assert.match(player.data.raw, /Steer next/);
assert.match(player.data.raw, /replace:true/);
assert.match(player.data.raw, /navigator\.audioSession/);
assert.match(player.data.raw, /audioSession\.type=\"playback\"/);
assert.match(player.data.raw, /unlockFromGesture/);
assert.match(player.data.raw, /audio_context_/);
assert.match(player.data.raw, /id=\"audio-chip\"/);
assert.doesNotMatch(player.data.raw, /EditCommand/);
assert.doesNotMatch(player.data.raw, /ScoreReducer/);
assert.doesNotMatch(player.data.raw, /\beval\s*\(/);
assert.doesNotMatch(player.data.raw, /new Function\s*\(/);
assert.doesNotMatch(player.data.raw, /AudioWorklet/);

for (const [channelId, creatorId] of [
  [channelA, creatorA],
  [channelB, creatorB],
  [channelModel, creatorModel],
]) {
  const init = await call(`/api/channels/${channelId}/init`, {
    method: "POST",
    creatorId,
    expected: [201],
    body: {
      creatorId,
      policy: {
        bufferTargetSeconds: 90,
        generationCapPerHour: 120,
      },
    },
  });
  assert.equal(init.data.ok, true);
  assert.equal(init.data.state.channelId, channelId);
  assert.equal(init.data.state.creatorId, creatorId);
  assert.equal(init.data.state.policy.provider, "fixture");
  assert.equal(init.data.state.policy.credentialRef, null);
}

const composed = await call(`/api/channels/${channelA}/score/next`, {
  method: "POST",
  creatorId: creatorA,
  expected: [201],
  body: { listenerIntent: { surface: "live-acceptance-step5" } },
});
assert.equal(composed.data.ok, true);
assert.equal(composed.data.score.schemaVersion, "infinite-radio-score-v1");
assert.equal(composed.data.score.channelId, channelA);
assert.ok(["workers-ai", "fixture"].includes(composed.data.source));
assert.equal(composed.data.composition_buffer_count, 1);

const selectedScore = await call(`/api/channels/${channelA}/score/select`, {
  method: "POST",
  creatorId: creatorA,
});
assert.equal(selectedScore.data.ok, true);
assert.equal(selectedScore.data.score.compositionId, composed.data.score.compositionId);
assert.equal(selectedScore.data.composition_buffer_count, 0);
assert.equal(selectedScore.data.state.currentComposition.compositionId, composed.data.score.compositionId);
assert.equal(selectedScore.data.state.lastCompositionId, composed.data.score.compositionId);
const currentCompositionIdBeforeSteering = selectedScore.data.state.currentComposition.compositionId;

const prebuffered = await call(`/api/channels/${channelA}/score/prebuffer`, {
  method: "POST",
  creatorId: creatorA,
  expected: [201],
  body: { listenerIntent: { surface: "live-acceptance-step6-prebuffer" } },
});
assert.equal(prebuffered.data.ok, true);
assert.equal(prebuffered.data.created, true);
assert.equal(prebuffered.data.composition_buffer_count, 1);
assert.ok(prebuffered.data.buffered_composition_id);
assert.ok(["workers-ai", "fixture"].includes(prebuffered.data.source));

const prebufferReplay = await call(`/api/channels/${channelA}/score/prebuffer`, {
  method: "POST",
  creatorId: creatorA,
  expected: [200],
  body: { listenerIntent: { surface: "live-acceptance-step6-prebuffer" } },
});
assert.equal(prebufferReplay.data.ok, true);
assert.equal(prebufferReplay.data.created, false);
assert.equal(prebufferReplay.data.composition_buffer_count, 1);
assert.equal(prebufferReplay.data.buffered_composition_id, prebuffered.data.buffered_composition_id);

const steeredFuture = await call(`/api/channels/${channelA}/score/prebuffer`, {
  method: "POST",
  creatorId: creatorA,
  expected: [201],
  body: {
    replace: true,
    listenerIntent: {
      surface: "v04-visual-steering-live-acceptance",
      text: "Listener steering for the NEXT composition only. Energy intense. Brightness bright. Density balanced. Space spacious. Harmonic tension colorful. Preserve channel identity.",
    },
  },
});
assert.equal(steeredFuture.data.ok, true);
assert.equal(steeredFuture.data.created, true);
assert.equal(steeredFuture.data.replaced, true);
assert.equal(steeredFuture.data.previous_buffered_composition_id, prebuffered.data.buffered_composition_id);
assert.notEqual(steeredFuture.data.buffered_composition_id, prebuffered.data.buffered_composition_id);
assert.equal(steeredFuture.data.composition_buffer_count, 1);
assert.equal(steeredFuture.data.state.currentComposition.compositionId, currentCompositionIdBeforeSteering);
assert.equal(steeredFuture.data.state.lastCompositionId, currentCompositionIdBeforeSteering);
const stateAfterSteering = await call(`/api/channels/${channelA}/state`, { creatorId: creatorA });
assert.equal(stateAfterSteering.data.state.currentComposition.compositionId, currentCompositionIdBeforeSteering);
assert.equal(stateAfterSteering.data.state.lastCompositionId, currentCompositionIdBeforeSteering);
assert.equal(stateAfterSteering.data.state.compositionQueue.length, 1);
assert.equal(stateAfterSteering.data.state.compositionQueue[0].compositionId, steeredFuture.data.buffered_composition_id);

const modelAttempts = [];
let realModelComposition = null;
for (let attempt = 1; attempt <= 6 && !realModelComposition; attempt += 1) {
  const candidate = await call(`/api/channels/${channelModel}/score/next`, {
    method: "POST",
    creatorId: creatorModel,
    expected: [201],
    body: {
      listenerIntent: {
        surface: "live-acceptance-step7-real-model",
        text: `Original acceptance composition ${attempt}: luminous synthetic pulse, coherent motif, clean transition.`,
      },
    },
  });
  assert.equal(candidate.data.ok, true);
  assert.equal(candidate.data.score.schemaVersion, "infinite-radio-score-v1");
  assert.equal(candidate.data.score.channelId, channelModel);
  modelAttempts.push({
    attempt,
    source: candidate.data.source,
    fellBack: candidate.data.fell_back,
    fallbackReason: candidate.data.fallback_reason,
    compositionId: candidate.data.score.compositionId,
  });
  if (candidate.data.source === "workers-ai") realModelComposition = candidate;
}
assert.ok(realModelComposition, `real Workers AI composition unavailable after bounded retries: ${JSON.stringify(modelAttempts)}`);
assert.equal(realModelComposition.data.fell_back, false);
assert.equal(realModelComposition.data.score.provenance.composer, "workers-ai");
assert.equal(realModelComposition.data.score.provenance.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");

const modelState = await call(`/api/channels/${channelModel}/state`, { creatorId: creatorModel });
const realCompositionId = realModelComposition.data.score.compositionId;
assert.ok(modelState.data.state.compositionQueue.some((score) => score.compositionId === realCompositionId));
assert.equal(modelState.data.state.channelId, channelModel);
assert.equal(modelState.data.state.creatorId, creatorModel);

const untouchedModelIsolationState = await call(`/api/channels/${channelB}/state`, { creatorId: creatorB });
assert.equal(untouchedModelIsolationState.data.state.compositionQueue.length, 0);
assert.equal(JSON.stringify(untouchedModelIsolationState.data.state).includes(realCompositionId), false);

let selectedRealComposition = null;
for (let index = 0; index < modelState.data.state.compositionQueue.length; index += 1) {
  const selection = await call(`/api/channels/${channelModel}/score/select`, {
    method: "POST",
    creatorId: creatorModel,
  });
  if (selection.data.score.compositionId === realCompositionId) {
    selectedRealComposition = selection.data.score;
    break;
  }
}
assert.ok(selectedRealComposition, "real Workers AI composition was persisted but could not be selected by the player API");
assert.equal(selectedRealComposition.provenance.composer, "workers-ai");

const acceptanceProviderKey = `acceptance-key-${runId}`;
const providerConfigured = await call(`/api/channels/${channelA}/provider`, {
  method: "POST",
  creatorId: creatorA,
  providerKey: acceptanceProviderKey,
  body: {
    provider: "fal-cassetteai",
    generationCapPerHour: 5,
    generationCapPerDay: 10,
  },
});
assert.equal(providerConfigured.data.ok, true);
assert.equal(providerConfigured.data.policy.provider, "fal-cassetteai");
assert.match(providerConfigured.data.policy.credentialRef, /^fal-cassetteai:sha256:[a-f0-9]{64}$/);
assert.equal(JSON.stringify(providerConfigured.data).includes(acceptanceProviderKey), false);

const wrongCredential = await call(`/api/channels/${channelA}/generation/next`, {
  method: "POST",
  creatorId: creatorA,
  providerKey: `${acceptanceProviderKey}-wrong`,
  expected: [400],
  body: { durationSeconds: 30 },
});
assert.equal(wrongCredential.data.error, "credential_scope_violation");

const fixtureRestored = await call(`/api/channels/${channelA}/provider`, {
  method: "POST",
  creatorId: creatorA,
  body: { provider: "fixture" },
});
assert.equal(fixtureRestored.data.policy.provider, "fixture");
assert.equal(fixtureRestored.data.policy.model, "fixture");
assert.equal(fixtureRestored.data.policy.credentialRef, null);

const promptBody = {
  idempotencyKey: `prompt-${runId}`,
  userId: "acceptance-listener",
  text: "A bright synthetic pulse with a surreal late-night transition.",
  votes: 7,
};

const firstPrompt = await call(`/api/channels/${channelA}/prompts`, {
  method: "POST",
  creatorId: creatorA,
  expected: [202],
  body: promptBody,
});
assert.equal(firstPrompt.data.deduped, false);

const promptReplayQueued = await call(`/api/channels/${channelA}/prompts`, {
  method: "POST",
  creatorId: creatorA,
  expected: [200],
  body: promptBody,
});
assert.equal(promptReplayQueued.data.deduped, true);
assert.equal(promptReplayQueued.data.prompt.idempotencyKey, promptBody.idempotencyKey);

const tickA = await call(`/api/channels/${channelA}/conductor/tick`, {
  method: "POST",
  creatorId: creatorA,
  body: { durationSeconds: 30, maxTracks: 3 },
});
assert.equal(tickA.data.ok, true);
assert.equal(tickA.data.created.length, 3);
for (const item of tickA.data.created) {
  assert.ok(item.asset_key.startsWith(`channels/${channelA}/`));
}

const promptReplayConsumed = await call(`/api/channels/${channelA}/prompts`, {
  method: "POST",
  creatorId: creatorA,
  expected: [200],
  body: promptBody,
});
assert.equal(promptReplayConsumed.data.deduped, true);

const playbackA = await call(`/api/channels/${channelA}/playback/next`, {
  method: "POST",
  creatorId: creatorA,
});
assert.equal(playbackA.data.ok, true);
assert.equal(playbackA.data.track.channelId, channelA);
assert.ok(playbackA.data.track.assetKey.startsWith(`channels/${channelA}/`));

const tickB = await call(`/api/channels/${channelB}/conductor/tick`, {
  method: "POST",
  creatorId: creatorB,
  body: { durationSeconds: 30, maxTracks: 3 },
});
assert.equal(tickB.data.created.length, 3);
for (const item of tickB.data.created) {
  assert.ok(item.asset_key.startsWith(`channels/${channelB}/`));
  assert.ok(!item.asset_key.includes(channelA));
}

const stateA1 = await call(`/api/channels/${channelA}/state`, { creatorId: creatorA });
const stateA2 = await call(`/api/channels/${channelA}/state`, { creatorId: creatorA });
const stateB = await call(`/api/channels/${channelB}/state`, { creatorId: creatorB });

assert.equal(stateA1.data.state.channelId, channelA);
assert.equal(stateA2.data.state.channelId, channelA);
assert.equal(stateB.data.state.channelId, channelB);
assert.equal(stateA2.data.state.creatorId, creatorA);
assert.equal(stateB.data.state.creatorId, creatorB);
assert.ok(stateA2.data.state.counters.promptReplays >= 2);
assert.ok(stateA2.data.state.counters.fixtureTracks >= 3);
assert.ok(stateB.data.state.counters.fixtureTracks >= 3);

for (const track of [
  stateA2.data.state.currentTrack,
  ...stateA2.data.state.readyQueue,
]) {
  if (!track) continue;
  assert.equal(track.channelId, channelA);
  assert.ok(track.assetKey.startsWith(`channels/${channelA}/`));
}
for (const track of [
  stateB.data.state.currentTrack,
  ...stateB.data.state.readyQueue,
]) {
  if (!track) continue;
  assert.equal(track.channelId, channelB);
  assert.ok(track.assetKey.startsWith(`channels/${channelB}/`));
}

const foreign = await call(`/api/channels/${channelA}/state`, {
  creatorId: creatorB,
  expected: [400],
});
assert.equal(foreign.data.ok, false);
assert.equal(foreign.data.error, "channel_owner_required");

const brief = await call(`/api/channels/${channelA}/brief`, {
  method: "POST",
  creatorId: creatorA,
  body: { prompt: "Keep the next transition coherent and concise." },
});
assert.equal(brief.data.ok, true);
assert.equal(brief.data.workers_ai_available, true);
assert.ok(["workers-ai", "deterministic-fallback"].includes(brief.data.source));

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  runId,
  channelA,
  channelB,
  health: health.data,
  channelAState: {
    status: stateA2.data.state.status,
    readyBufferSeconds: stateA2.data.state.readyBufferSeconds,
    counters: stateA2.data.state.counters,
  },
  channelBState: {
    status: stateB.data.state.status,
    readyBufferSeconds: stateB.data.state.readyBufferSeconds,
    counters: stateB.data.state.counters,
  },
  briefSource: brief.data.source,
  scoreSource: composed.data.source,
  scoreCompositionId: composed.data.score.compositionId,
  prebufferedCompositionId: prebuffered.data.buffered_composition_id,
  steeredBufferedCompositionId: steeredFuture.data.buffered_composition_id,
  currentCompositionIdAfterSteering: stateAfterSteering.data.state.currentComposition.compositionId,
  realWorkersAiCompositionId: realCompositionId,
  realWorkersAiAttempts: modelAttempts,
}, null, 2));

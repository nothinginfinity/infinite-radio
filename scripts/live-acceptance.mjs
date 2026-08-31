import assert from "node:assert/strict";

const baseUrl = process.env.LIVE_URL ?? "https://infinite-radio.jaredtechfit.workers.dev";
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const channelA = `accept-a-${runId}`;
const channelB = `accept-b-${runId}`;
const creatorA = `creator-a-${runId}`;
const creatorB = `creator-b-${runId}`;

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
assert.equal(health.data.version, "0.3.0");
assert.equal(health.data.runtime, "channel-first-byok");
assert.equal(health.data.bindings.channelConductor, true);
assert.equal(health.data.bindings.d1, true);
assert.equal(health.data.bindings.r2, true);
assert.equal(health.data.bindings.workersAI, true);
assert.deepEqual(health.data.musicProviders, ["fixture", "fal-cassetteai", "fal-stable-audio"]);

for (const [channelId, creatorId] of [
  [channelA, creatorA],
  [channelB, creatorB],
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
}, null, 2));

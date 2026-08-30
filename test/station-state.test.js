import test from "node:test";
import assert from "node:assert/strict";

import {
  MUSIC_PROVIDERS,
  assertChannelOwner,
  assertProviderReady,
  channelAssetKey,
  chooseNextPlayable,
  compileStationBrief,
  completeFixtureGeneration,
  completeMusicGeneration,
  createChannelState,
  createGenerationJob,
  createStationState,
  ensureFixtureBuffer,
  failGeneration,
  needsGeneration,
  queueReadyTrack,
  readyBufferSeconds,
  selectNextPrompt,
  submitPrompt,
  updateChannelPolicy,
} from "../src/station-state.js";

test("higher-voted prompt wins without coupling selection to generation", () => {
  let state = createChannelState({ channelId: "alpha", creatorId: "creator-a" });
  state = submitPrompt(state, {
    id: "a",
    userId: "u1",
    text: "banana techno",
    votes: 2,
    createdAt: "2026-08-30T00:00:00.000Z",
  }).state;
  state = submitPrompt(state, {
    id: "b",
    userId: "u2",
    text: "goth sumo anthem",
    votes: 9,
    createdAt: "2026-08-30T00:01:00.000Z",
  }).state;

  const result = selectNextPrompt(state);
  assert.equal(result.selected.id, "b");
  assert.equal(result.selected.channelId, "alpha");
  assert.equal(result.state.promptQueue.length, 1);
});

test("idempotent prompt replay does not duplicate queue work", () => {
  const state = createChannelState({ channelId: "alpha", creatorId: "creator-a" });
  const first = submitPrompt(state, {
    idempotencyKey: "request-1",
    userId: "u1",
    text: "space whale dub",
  });
  const replay = submitPrompt(first.state, {
    idempotencyKey: "request-1",
    userId: "u1",
    text: "space whale dub",
  });

  assert.equal(replay.deduped, true);
  assert.equal(replay.state.promptQueue.length, 1);
  assert.equal(replay.state.counters.promptsAccepted, 1);
  assert.equal(replay.state.counters.promptReplays, 1);
  assert.throws(
    () => submitPrompt(replay.state, {
      idempotencyKey: "request-1",
      userId: "u1",
      text: "different payload",
    }),
    /idempotency_conflict/,
  );
});

test("ready buffer drives generation pressure per channel", () => {
  let state = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: { bufferTargetSeconds: 60 },
  });
  assert.equal(needsGeneration(state), true);

  state = queueReadyTrack(state, { id: "t1", durationSeconds: 30 });
  state = queueReadyTrack(state, { id: "t2", durationSeconds: 31 });

  assert.equal(readyBufferSeconds(state), 61);
  assert.equal(needsGeneration(state), false);
});

test("channel ownership, credential refs, queues, and asset namespaces cannot cross", () => {
  let alpha = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: { credentialRef: "cred:alpha" },
  });
  const beta = createChannelState({
    channelId: "beta",
    creatorId: "creator-b",
    policy: { credentialRef: "cred:beta" },
  });

  assert.equal(assertChannelOwner(alpha, "creator-a"), true);
  assert.throws(() => assertChannelOwner(alpha, "creator-b"), /channel_owner_required/);

  const submitted = submitPrompt(alpha, { id: "p1", text: "alpha-only" });
  alpha = submitted.state;
  assert.equal(alpha.promptQueue.length, 1);
  assert.equal(beta.promptQueue.length, 0);

  assert.throws(
    () => createGenerationJob(alpha, submitted.prompt, { credentialRef: "cred:beta" }),
    /credential_scope_violation/,
  );
  assert.match(channelAssetKey("alpha", "fixture/a.json"), /^channels\/alpha\//);
  assert.match(channelAssetKey("beta", "fixture/b.json"), /^channels\/beta\//);
});

test("fixture generation jobs are idempotent and channel-scoped", () => {
  let state = createChannelState({ channelId: "alpha", creatorId: "creator-a" });
  const submitted = submitPrompt(state, { id: "p1", text: "synthetic brass" });
  state = submitted.state;

  const first = createGenerationJob(state, submitted.prompt, { now: "2026-08-30T20:00:00.000Z" });
  const replay = createGenerationJob(first.state, submitted.prompt, { now: "2026-08-30T20:00:01.000Z" });

  assert.equal(first.deduped, false);
  assert.equal(replay.deduped, true);
  assert.equal(replay.state.generationJobs.length, 1);
  assert.equal(replay.job.channelId, "alpha");
});

test("two channels simulate 30 minutes concurrently with no state or asset crossover", () => {
  let alpha = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: { bufferTargetSeconds: 120, generationCapPerHour: 100 },
  });
  let beta = createChannelState({
    channelId: "beta",
    creatorId: "creator-b",
    policy: { bufferTargetSeconds: 120, generationCapPerHour: 100 },
  });

  alpha = ensureFixtureBuffer(alpha, { now: "2026-08-30T20:00:00.000Z" }).state;
  beta = ensureFixtureBuffer(beta, { now: "2026-08-30T20:00:00.000Z" }).state;

  for (let segment = 0; segment < 60; segment += 1) {
    const alphaNext = chooseNextPlayable(alpha);
    const betaNext = chooseNextPlayable(beta);
    assert.equal(alphaNext.source, "ready");
    assert.equal(betaNext.source, "ready");
    assert.equal(alphaNext.track.channelId, "alpha");
    assert.equal(betaNext.track.channelId, "beta");
    assert.match(alphaNext.track.assetKey, /^channels\/alpha\//);
    assert.match(betaNext.track.assetKey, /^channels\/beta\//);
    alpha = ensureFixtureBuffer(alphaNext.state, {
      now: `2026-08-30T20:${String(segment).padStart(2, "0")}:00.000Z`,
    }).state;
    beta = ensureFixtureBuffer(betaNext.state, {
      now: `2026-08-30T20:${String(segment).padStart(2, "0")}:00.000Z`,
    }).state;
  }

  assert.notEqual(alpha.channelId, beta.channelId);
  assert.equal(alpha.counters.archiveFallbacks, 0);
  assert.equal(beta.counters.archiveFallbacks, 0);
  assert.ok(alpha.counters.fixtureTracks >= 60);
  assert.ok(beta.counters.fixtureTracks >= 60);
});

test("playback prefers ready audio and falls back only to same-channel archive", () => {
  let state = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    readyQueue: [{ id: "fresh", channelId: "alpha", durationSeconds: 25 }],
    archive: [{ id: "archive", channelId: "alpha", durationSeconds: 30 }],
  });

  let next = chooseNextPlayable(state);
  assert.equal(next.source, "ready");
  assert.equal(next.track.id, "fresh");

  next = chooseNextPlayable(next.state);
  assert.equal(next.source, "archive");
  assert.equal(next.track.id, "archive");
  assert.equal(next.state.counters.archiveFallbacks, 1);

  const bad = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    archive: [{ id: "foreign", channelId: "beta", durationSeconds: 30 }],
  });
  assert.throws(() => chooseNextPlayable(bad), /channel_scope_violation/);
});

test("channel brief carries continuity and provider policy without raw secrets", () => {
  const state = createStationState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: { provider: "fixture", credentialRef: "cred:alpha" },
    bible: {
      era: "banana-war",
      genreTags: ["industrial", "darkwave"],
      recurringMotifs: ["banana monarchy"],
    },
  });

  const brief = compileStationBrief(state, {
    channelId: "alpha",
    userId: "jared",
    text: "country song about Steve the dog",
  });

  assert.equal(brief.channelId, "alpha");
  assert.equal(brief.listenerId, "jared");
  assert.equal(brief.continuity.era, "banana-war");
  assert.deepEqual(brief.continuity.genreTags, ["industrial", "darkwave"]);
  assert.equal(brief.providerPolicy.credentialRef, "cred:alpha");
  assert.match(brief.instruction, /short radio segment/i);
  assert.equal(JSON.stringify(brief).includes("api_key"), false);
});

test("provider policy accepts only opaque refs and clears them on fixture fallback", () => {
  let state = createChannelState({ channelId: "alpha", creatorId: "creator-a" });
  assert.throws(
    () => updateChannelPolicy(state, { provider: MUSIC_PROVIDERS.FAL_CASSETTEAI, apiKey: "raw-secret" }),
    /raw_provider_secret_forbidden/,
  );
  assert.throws(
    () => updateChannelPolicy(state, { provider: MUSIC_PROVIDERS.FAL_CASSETTEAI }),
    /credential_ref_required/,
  );

  state = updateChannelPolicy(state, {
    provider: MUSIC_PROVIDERS.FAL_CASSETTEAI,
    credentialRef: "fal-cassetteai:sha256:abc",
    generationCapPerHour: 5,
    generationCapPerDay: 10,
  });
  assert.equal(state.policy.provider, MUSIC_PROVIDERS.FAL_CASSETTEAI);
  assert.equal(state.policy.model, "cassetteai/music-generator");
  assert.equal(state.policy.credentialRef, "fal-cassetteai:sha256:abc");

  state = updateChannelPolicy(state, {
    provider: MUSIC_PROVIDERS.FIXTURE,
    credentialRef: null,
  });
  assert.equal(state.policy.provider, MUSIC_PROVIDERS.FIXTURE);
  assert.equal(state.policy.model, "fixture");
  assert.equal(state.policy.credentialRef, null);
});

test("hourly and daily provider caps are both enforced", () => {
  let state = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: {
      provider: MUSIC_PROVIDERS.FAL_CASSETTEAI,
      credentialRef: "fal-cassetteai:sha256:abc",
      generationCapPerHour: 2,
      generationCapPerDay: 2,
    },
  });
  for (let index = 0; index < 2; index += 1) {
    const submitted = submitPrompt(state, { id: `p${index}`, text: `prompt ${index}` });
    state = submitted.state;
    const selected = selectNextPrompt(state);
    state = createGenerationJob(selected.state, selected.selected, {
      now: "2026-08-30T20:00:00.000Z",
      credentialRef: state.policy.credentialRef,
    }).state;
  }
  const submitted = submitPrompt(state, { id: "p3", text: "prompt 3" });
  const selected = selectNextPrompt(submitted.state);
  assert.throws(
    () => createGenerationJob(selected.state, selected.selected, {
      now: "2026-08-30T20:10:00.000Z",
      credentialRef: state.policy.credentialRef,
    }),
    /generation_cap_reached/,
  );

  const nextHour = {
    ...state,
    generationWindow: { startedAt: "2026-08-30T19:00:00.000Z", count: 2 },
  };
  const submittedLater = submitPrompt(nextHour, { id: "p4", text: "prompt 4" });
  const selectedLater = selectNextPrompt(submittedLater.state);
  assert.throws(
    () => createGenerationJob(selectedLater.state, selectedLater.selected, {
      now: "2026-08-30T21:00:00.000Z",
      credentialRef: state.policy.credentialRef,
    }),
    /daily_generation_cap_reached/,
  );
});

test("real generated audio reaches ready only inside the authorized channel namespace", () => {
  let state = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: {
      provider: MUSIC_PROVIDERS.FAL_CASSETTEAI,
      credentialRef: "fal-cassetteai:sha256:abc",
    },
  });
  const submitted = submitPrompt(state, { id: "music-1", text: "midnight synth choir" });
  const selected = selectNextPrompt(submitted.state);
  const scheduled = createGenerationJob(selected.state, selected.selected, {
    credentialRef: state.policy.credentialRef,
    now: "2026-08-30T20:00:00.000Z",
  });
  assert.throws(
    () => completeMusicGeneration(scheduled.state, scheduled.job.id, {
      assetKey: "channels/beta/generated/foreign.wav",
      durationSeconds: 30,
    }),
    /channel_scope_violation/,
  );
  const completed = completeMusicGeneration(scheduled.state, scheduled.job.id, {
    assetKey: `channels/alpha/generated/${scheduled.job.id}.wav`,
    durationSeconds: 30,
    contentType: "audio/wav",
    receiptId: `receipt:${scheduled.job.id}`,
    now: "2026-08-30T20:00:05.000Z",
  });
  assert.equal(completed.track.channelId, "alpha");
  assert.equal(completed.state.readyQueue.length, 1);
  assert.equal(completed.state.generationJobs[0].status, "ready");
  assert.equal(completed.state.generationJobs[0].receiptId, `receipt:${scheduled.job.id}`);
  assert.equal(completed.state.providerHealth.status, "healthy");
});

test("provider failure marks health degraded without leaking credentials", () => {
  let state = createChannelState({
    channelId: "alpha",
    creatorId: "creator-a",
    policy: {
      provider: MUSIC_PROVIDERS.FAL_CASSETTEAI,
      credentialRef: "fal-cassetteai:sha256:abc",
    },
  });
  const submitted = submitPrompt(state, { id: "music-2", text: "broken provider" });
  const selected = selectNextPrompt(submitted.state);
  const scheduled = createGenerationJob(selected.state, selected.selected, {
    credentialRef: state.policy.credentialRef,
  });
  const failed = failGeneration(
    scheduled.state,
    scheduled.job.id,
    "provider_offline",
    "2026-08-30T20:00:00.000Z",
  );
  assert.equal(failed.generationJobs[0].status, "failed");
  assert.equal(failed.providerHealth.status, "degraded");
  assert.equal(failed.providerHealth.lastError, "provider_offline");
  assert.equal(failed.providerHealth.retryAfter, "2026-08-30T20:00:05.000Z");
  assert.throws(
    () => assertProviderReady(failed, "2026-08-30T20:00:04.000Z"),
    /provider_backoff_active/,
  );
  assert.equal(assertProviderReady(failed, "2026-08-30T20:00:05.000Z"), true);
  assert.equal(JSON.stringify(failed).includes("raw-secret"), false);
});

test("late prompt and generation retries remain idempotent after playback consumption", () => {
  let state = createChannelState({ channelId: "alpha", creatorId: "creator-a" });
  const first = submitPrompt(state, {
    idempotencyKey: "late-1",
    userId: "u1",
    text: "glass cathedral",
  });
  state = first.state;

  const selected = selectNextPrompt(state);
  state = selected.state;
  const scheduled = createGenerationJob(state, selected.selected, {
    now: "2026-08-30T20:00:00.000Z",
  });
  state = scheduled.state;
  const completed = completeFixtureGeneration(state, scheduled.job.id, {
    now: "2026-08-30T20:00:01.000Z",
  });
  state = completed.state;
  const originalAssetKey = completed.track.assetKey;

  const played = chooseNextPlayable(state);
  state = { ...played.state, currentTrack: null };

  const promptReplay = submitPrompt(state, {
    idempotencyKey: "late-1",
    userId: "u1",
    text: "glass cathedral",
  });
  assert.equal(promptReplay.deduped, true);
  assert.equal(
    promptReplay.state.promptQueue.some((p) => p.idempotencyKey === "late-1"),
    false,
  );

  const generationReplay = completeFixtureGeneration(
    promptReplay.state,
    scheduled.job.id,
    { now: "2026-08-30T20:05:00.000Z" },
  );
  assert.equal(generationReplay.deduped, true);
  assert.equal(generationReplay.track.assetKey, originalAssetKey);
  assert.equal(generationReplay.state.readyQueue.length, 0);
  assert.equal(
    generationReplay.state.generationJobs.filter((job) => job.id === scheduled.job.id).length,
    1,
  );
});

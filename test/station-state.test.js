import test from "node:test";
import assert from "node:assert/strict";

import {
  assertChannelOwner,
  channelAssetKey,
  chooseNextPlayable,
  compileStationBrief,
  createChannelState,
  createGenerationJob,
  createStationState,
  ensureFixtureBuffer,
  needsGeneration,
  queueReadyTrack,
  readyBufferSeconds,
  selectNextPrompt,
  submitPrompt,
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

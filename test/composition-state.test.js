import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createChannelState,
  queueComposition,
  selectNextComposition,
  compositionBufferCount,
} from "../src/station-state.js";
import { createFixtureScore } from "../src/score-schema.js";

function baseState(overrides = {}) {
  return createChannelState({ channelId: "alpha", creatorId: "creator-a", ...overrides });
}

function trustedFor(state) {
  return { channelId: state.channelId, creatorId: state.creatorId };
}

test("queueComposition appends a validated score and updates continuity", () => {
  const state = baseState();
  const score = createFixtureScore(trustedFor(state), { motifIds: ["riser_a"] });

  const next = queueComposition(state, score);

  assert.equal(next.compositionQueue.length, 1);
  assert.equal(next.compositionQueue[0].compositionId, score.compositionId);
  assert.equal(next.lastCompositionId, score.compositionId);
  assert.ok(next.bible.recurringMotifs.includes("riser_a"));
  assert.equal(next.bible.energy, score.continuity.energy);
  assert.equal(next.counters.compositionsQueued, 1);
  assert.equal(next.counters.compositionFallbacks, 1); // fixture composer scores count as fallbacks
});

test("queueComposition merges and caps recurring motifs without duplicates", () => {
  let state = baseState({ bible: { recurringMotifs: ["m1", "m2"] } });
  const score = createFixtureScore(trustedFor(state), { motifIds: ["m2", "m3"] });

  state = queueComposition(state, score);

  assert.deepEqual(state.bible.recurringMotifs, ["m1", "m2", "m3"]);
});

test("queueComposition rejects a composition scoped to a different channel", () => {
  const state = baseState();
  const foreignScore = createFixtureScore({ channelId: "other-channel" });
  assert.throws(() => queueComposition(state, foreignScore), /channel_scope_violation/);
});

test("queueComposition rejects malformed or wrong-schema input", () => {
  const state = baseState();
  assert.throws(() => queueComposition(state, null), /valid_composition_required/);
  assert.throws(
    () => queueComposition(state, { compositionId: "x", schemaVersion: "not-the-right-schema" }),
    /valid_composition_required/,
  );
});

test("selectNextComposition pops compositions in FIFO order and empties cleanly", () => {
  let state = baseState();
  const scoreA = createFixtureScore(trustedFor(state), { compositionId: "comp-a" });
  const scoreB = createFixtureScore(trustedFor(state), { compositionId: "comp-b" });
  state = queueComposition(state, scoreA);
  state = queueComposition(state, scoreB);

  const first = selectNextComposition(state);
  assert.equal(first.selected.compositionId, "comp-a");
  assert.equal(compositionBufferCount(first.state), 1);

  const second = selectNextComposition(first.state);
  assert.equal(second.selected.compositionId, "comp-b");
  assert.equal(compositionBufferCount(second.state), 0);

  const empty = selectNextComposition(second.state);
  assert.equal(empty.selected, null);
  assert.equal(compositionBufferCount(empty.state), 0);
});

test("a freshly created channel state starts with an empty composition queue and null continuity", () => {
  const state = baseState();
  assert.deepEqual(state.compositionQueue, []);
  assert.equal(state.lastCompositionId, null);
  assert.equal(state.lastTransitionHint, null);
  assert.equal(state.counters.compositionsQueued, 0);
  assert.equal(state.counters.compositionFallbacks, 0);
});

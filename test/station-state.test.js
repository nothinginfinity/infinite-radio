import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseNextPlayable,
  compileStationBrief,
  createStationState,
  enqueuePrompt,
  needsGeneration,
  queueReadyTrack,
  readyBufferSeconds,
  selectNextPrompt,
} from "../src/station-state.js";

test("higher-voted prompt wins without coupling selection to generation", () => {
  let state = createStationState();
  state = enqueuePrompt(state, {
    id: "a",
    userId: "u1",
    text: "banana techno",
    votes: 2,
    createdAt: "2026-08-30T00:00:00.000Z",
  });
  state = enqueuePrompt(state, {
    id: "b",
    userId: "u2",
    text: "goth sumo anthem",
    votes: 9,
    createdAt: "2026-08-30T00:01:00.000Z",
  });

  const result = selectNextPrompt(state);
  assert.equal(result.selected.id, "b");
  assert.equal(result.state.promptQueue.length, 1);
});

test("ready buffer drives generation pressure", () => {
  let state = createStationState({ bufferTargetSeconds: 60 });
  assert.equal(needsGeneration(state), true);

  state = queueReadyTrack(state, { id: "t1", durationSeconds: 30 });
  state = queueReadyTrack(state, { id: "t2", durationSeconds: 31 });

  assert.equal(readyBufferSeconds(state), 61);
  assert.equal(needsGeneration(state), false);
});

test("playback prefers ready audio and falls back to archive", () => {
  let state = createStationState({
    readyQueue: [{ id: "fresh", durationSeconds: 25 }],
    archive: [{ id: "archive", durationSeconds: 30 }],
  });

  let next = chooseNextPlayable(state);
  assert.equal(next.source, "ready");
  assert.equal(next.track.id, "fresh");

  next = chooseNextPlayable(next.state);
  assert.equal(next.source, "archive");
  assert.equal(next.track.id, "archive");
  assert.equal(next.state.counters.archiveFallbacks, 1);
});

test("station brief carries continuity without pretending clips are frame-chained", () => {
  const state = createStationState({
    bible: {
      era: "banana-war",
      genreTags: ["industrial", "darkwave"],
      recurringMotifs: ["banana monarchy"],
    },
  });

  const brief = compileStationBrief(state, {
    userId: "jared",
    text: "country song about Steve the dog",
  });

  assert.equal(brief.listenerId, "jared");
  assert.equal(brief.continuity.era, "banana-war");
  assert.deepEqual(brief.continuity.genreTags, ["industrial", "darkwave"]);
  assert.match(brief.instruction, /short radio segment/i);
});

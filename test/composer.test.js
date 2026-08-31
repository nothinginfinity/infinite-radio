import { test } from "node:test";
import assert from "node:assert/strict";

import { SCORE_SCHEMA_VERSION } from "../src/score-schema.js";
import {
  buildComposerContext,
  composeWithWorkersAI,
  composeChannelScore,
} from "../src/composer.js";

function trusted(overrides = {}) {
  return { channelId: "chan-1", creatorId: "creator-1", now: 1735689600000, ...overrides };
}

function validRawScoreJson(overrides = {}) {
  return JSON.stringify({
    schemaVersion: SCORE_SCHEMA_VERSION,
    compositionId: "model-comp-1",
    bpm: 122,
    timeSignature: { beatsPerBar: 4, beatUnit: 4 },
    key: { root: "D", mode: "dorian" },
    bars: 4,
    sections: [{ startBar: 0, lengthBars: 4, label: "loop" }],
    tracks: [
      { id: "lead", patch: "saw_lead", events: [{ pitch: 62, start: 0, duration: 1, velocity: 0.7 }] },
    ],
    continuity: { motifIds: ["m1"], energy: 0.6 },
    ...overrides,
  });
}

function fakeEnvWithResponse(text) {
  return { AI: { run: async () => ({ response: text }) } };
}

function fakeEnvWithChatCompletionShape(text) {
  return {
    AI: {
      run: async () => ({
        choices: [{ finish_reason: "stop", index: 0, message: { content: text } }],
      }),
    },
  };
}

function fakeEnvThatThrows(message = "model_unavailable") {
  return {
    AI: {
      run: async () => {
        throw new Error(message);
      },
    },
  };
}

test("buildComposerContext extracts only bounded fields from channel state", () => {
  const state = {
    bible: {
      identity: "Late night synth station",
      era: "chapter_2",
      genreTags: ["synthwave", "ambient", "x", "y", "z", "1", "2", "3", "4", "5"],
      energy: 0.7,
      tempoRange: [90, 130],
      recurringMotifs: ["riser_motif"],
    },
    lastCompositionId: "prev-comp",
    lastTransitionHint: "fade into a brighter chord",
  };
  const context = buildComposerContext(state, { text: "play something dreamy" });

  assert.equal(context.identity, "Late night synth station");
  assert.equal(context.era, "chapter_2");
  assert.equal(context.genreTags.length, 8); // capped
  assert.deepEqual(context.tempoRange, [90, 130]);
  assert.equal(context.previousCompositionId, "prev-comp");
  assert.equal(context.transitionHint, "fade into a brighter chord");
  assert.equal(context.listenerPrompt, "play something dreamy");
  // No identity/secret fields leak through.
  assert.equal(context.channelId, undefined);
  assert.equal(context.creatorId, undefined);
});

test("buildComposerContext defaults gracefully when channel state is sparse", () => {
  const context = buildComposerContext({}, {});
  assert.equal(context.identity, "");
  assert.equal(context.era, "origin");
  assert.deepEqual(context.genreTags, []);
  assert.equal(context.previousCompositionId, null);
  assert.equal(context.listenerPrompt, null);
});

test("composeWithWorkersAI validates and normalizes a valid model response", async () => {
  const env = fakeEnvWithResponse(validRawScoreJson());
  const score = await composeWithWorkersAI(env, trusted(), buildComposerContext({}));

  assert.equal(score.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(score.channelId, "chan-1");
  assert.equal(score.provenance.composer, "workers-ai");
  assert.equal(score.compositionId, "model-comp-1");
});

test("composeWithWorkersAI strips markdown code fences before parsing", async () => {
  const fenced = "```json\n" + validRawScoreJson() + "\n```";
  const env = fakeEnvWithResponse(fenced);
  const score = await composeWithWorkersAI(env, trusted(), buildComposerContext({}));
  assert.equal(score.schemaVersion, SCORE_SCHEMA_VERSION);
});

test("composeWithWorkersAI reads OpenAI-style choices[0].message.content responses", async () => {
  const env = fakeEnvWithChatCompletionShape(validRawScoreJson());
  const score = await composeWithWorkersAI(env, trusted(), buildComposerContext({}));
  assert.equal(score.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(score.compositionId, "model-comp-1");
});

test("composeWithWorkersAI never trusts model-supplied channel/creator identity", async () => {
  const env = fakeEnvWithResponse(
    validRawScoreJson({ channelId: "attacker-channel", creatorId: "attacker-creator" }),
  );
  const score = await composeWithWorkersAI(env, trusted(), buildComposerContext({}));
  assert.equal(score.channelId, "chan-1");
  assert.equal(score.creatorId, "creator-1");
});

test("composeWithWorkersAI throws when the AI binding is missing", async () => {
  await assert.rejects(
    () => composeWithWorkersAI({}, trusted(), buildComposerContext({})),
    /ai_binding_unavailable/,
  );
});

test("composeWithWorkersAI throws on unparseable model output rather than eval'ing it", async () => {
  const env = fakeEnvWithResponse("not json at all, definitely not eval-safe either { ");
  await assert.rejects(
    () => composeWithWorkersAI(env, trusted(), buildComposerContext({})),
    /composer_output_not_json/,
  );
});

test("composeWithWorkersAI throws when model JSON violates schema bounds", async () => {
  const env = fakeEnvWithResponse(validRawScoreJson({ bpm: 999 }));
  await assert.rejects(
    () => composeWithWorkersAI(env, trusted(), buildComposerContext({})),
    /invalid_bpm/,
  );
});

test("composeChannelScore falls back to the fixture composer when the model call throws", async () => {
  const env = fakeEnvThatThrows("upstream_500");
  const result = await composeChannelScore(env, trusted(), buildComposerContext({}));

  assert.equal(result.fellBack, true);
  assert.equal(result.source, "fixture");
  assert.equal(result.fallbackReason, "upstream_500");
  assert.equal(result.score.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.equal(result.score.channelId, "chan-1");
});

test("composeChannelScore falls back to the fixture composer when model output is invalid", async () => {
  const env = fakeEnvWithResponse(validRawScoreJson({ bpm: 5 }));
  const result = await composeChannelScore(env, trusted(), buildComposerContext({}));

  assert.equal(result.fellBack, true);
  assert.equal(result.source, "fixture");
  assert.match(result.fallbackReason, /invalid_bpm/);
  assert.equal(result.score.schemaVersion, SCORE_SCHEMA_VERSION);
});

test("composeChannelScore does not fall back when the model response is valid", async () => {
  const env = fakeEnvWithResponse(validRawScoreJson());
  const result = await composeChannelScore(env, trusted(), buildComposerContext({}));

  assert.equal(result.fellBack, false);
  assert.equal(result.source, "workers-ai");
  assert.equal(result.fallbackReason, null);
});

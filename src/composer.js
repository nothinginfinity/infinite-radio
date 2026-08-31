// Workers AI composition adapter for infinite-radio-score-v1.
//
// The model may only ever return schema-constrained JSON text. That text is
// untrusted: it is parsed with JSON.parse (never eval'd, never executed),
// and always passed through validateAndNormalizeScore before it is trusted
// as a playable composition. Any failure anywhere in this pipeline --
// missing binding, unreadable response, invalid JSON, or a schema/bounds
// violation -- fails closed to the deterministic fixture composer so a
// channel never goes unplayable and listener intent is never lost.

import {
  SCORE_SCHEMA_VERSION,
  SYNTH_PATCHES,
  DRUM_PATCHES,
  EFFECT_TYPES,
  SCALE_MODES,
  PITCH_CLASSES,
  SCORE_LIMITS,
  validateAndNormalizeScore,
  createFixtureScore,
} from "./score-schema.js";

export const DEFAULT_COMPOSER_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function buildSchemaInstructions() {
  return [
    `Return ONLY a single JSON object matching the "${SCORE_SCHEMA_VERSION}" schema. No markdown, no prose, no code fences -- JSON only, nothing before or after it.`,
    `Required top-level fields: schemaVersion (must equal "${SCORE_SCHEMA_VERSION}"), compositionId (string), bpm (number ${SCORE_LIMITS.MIN_BPM}-${SCORE_LIMITS.MAX_BPM}), timeSignature ({beatsPerBar, beatUnit}), key ({root, mode}), bars (integer 1-${SCORE_LIMITS.MAX_BARS}), sections ([{startBar,lengthBars,label,energy}]), tracks, continuity ({motifIds,energy,transitionHint,previousCompositionId}), seed, provenance ({composer,model,promptSummary}).`,
    `Each track: {id, patch, events:[{pitch,start,duration,velocity}], effects:[{type,amount}], pan, gain}. A drum track instead sets isDrumTrack:true and drumEvents:[{patch,start,velocity}].`,
    `Allowed key roots: ${PITCH_CLASSES.join(", ")}. Allowed key modes: ${SCALE_MODES.join(", ")}.`,
    `Allowed synth patch ids (non-drum tracks): ${SYNTH_PATCHES.join(", ")}.`,
    `Allowed drum patch ids: ${DRUM_PATCHES.join(", ")}.`,
    `Allowed effect types: ${EFFECT_TYPES.join(", ")}, each with amount 0-1.`,
    `pitch is a MIDI note number ${SCORE_LIMITS.MIN_MIDI_PITCH}-${SCORE_LIMITS.MAX_MIDI_PITCH}. start and duration are in beats (start >= 0, duration > 0). velocity is 0-1.`,
    `Compose at most ${SCORE_LIMITS.MAX_TRACKS} tracks and ${SCORE_LIMITS.MAX_TOTAL_EVENTS} total events across all tracks combined. Keep total composition duration under ${SCORE_LIMITS.MAX_DURATION_SECONDS} seconds.`,
    "Do not include channelId, creatorId, or any other identity field. Identity is supplied by the runtime; any identity value you include is ignored.",
  ].join("\n");
}

/**
 * Pure extraction of the bounded musical context the composer is allowed to
 * see, per plan rule 3: channel genre DNA, allowed instruments/patches,
 * BPM/key constraints, previous motif/transition summary, current energy
 * target, and selected listener intent. Never includes secrets or raw
 * runtime/channel-ownership identity.
 */
export function buildComposerContext(channelState, listenerIntent = {}) {
  const bible = channelState?.bible ?? {};
  const genreTags = Array.isArray(bible.genreTags) ? bible.genreTags.slice(0, 8) : [];
  const tempoRange = Array.isArray(bible.tempoRange) && bible.tempoRange.length === 2
    ? bible.tempoRange
    : [SCORE_LIMITS.MIN_BPM, SCORE_LIMITS.MAX_BPM];
  const recurringMotifs = Array.isArray(bible.recurringMotifs) ? bible.recurringMotifs.slice(0, 8) : [];

  return {
    identity: typeof bible.identity === "string" ? bible.identity.slice(0, 280) : "",
    era: typeof bible.era === "string" ? bible.era.slice(0, 64) : "origin",
    genreTags,
    energyTarget: Number.isFinite(bible.energy) ? bible.energy : 0.5,
    tempoRange,
    recurringMotifs,
    previousCompositionId: channelState?.lastCompositionId ?? null,
    transitionHint: typeof channelState?.lastTransitionHint === "string"
      ? channelState.lastTransitionHint.slice(0, SCORE_LIMITS.MAX_TRANSITION_HINT_LENGTH)
      : null,
    listenerPrompt: typeof listenerIntent?.text === "string" ? listenerIntent.text.slice(0, 400) : null,
  };
}

function buildUserPrompt(context) {
  return JSON.stringify({
    identity: context.identity,
    era: context.era,
    genreTags: context.genreTags,
    energyTarget: context.energyTarget,
    tempoRange: context.tempoRange,
    recurringMotifs: context.recurringMotifs,
    previousCompositionId: context.previousCompositionId,
    transitionHint: context.transitionHint,
    listenerPrompt: context.listenerPrompt,
  });
}

function extractResponseText(aiResult) {
  if (typeof aiResult === "string") return aiResult;
  if (aiResult && typeof aiResult.response === "string") return aiResult.response;
  if (aiResult?.result && typeof aiResult.result.response === "string") return aiResult.result.response;
  throw new Error("composer_response_unreadable");
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function parseComposerJson(text) {
  const candidate = stripCodeFences(text);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("composer_output_not_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("composer_output_not_json");
  }
  return parsed;
}

/**
 * Call Workers AI and return a validated, normalized score. Throws on any
 * failure -- callers that want fail-closed behavior should use
 * `composeChannelScore` instead of calling this directly.
 */
export async function composeWithWorkersAI(env, trusted, context, options = {}) {
  if (!env?.AI || typeof env.AI.run !== "function") {
    throw new Error("ai_binding_unavailable");
  }
  const model = options.model ?? DEFAULT_COMPOSER_MODEL;
  const compositionId = options.compositionId ?? `ai:${trusted.channelId}:${crypto.randomUUID()}`;

  const aiResult = await env.AI.run(model, {
    messages: [
      { role: "system", content: buildSchemaInstructions() },
      { role: "user", content: buildUserPrompt(context) },
    ],
    max_tokens: options.maxTokens ?? 2048,
  });

  const text = extractResponseText(aiResult);
  const parsed = parseComposerJson(text);
  if (parsed.compositionId === undefined || parsed.compositionId === null) {
    parsed.compositionId = compositionId;
  }
  parsed.provenance = {
    ...(parsed.provenance && typeof parsed.provenance === "object" ? parsed.provenance : {}),
    composer: "workers-ai",
    model,
    promptSummary: context.listenerPrompt ?? context.identity ?? null,
  };

  return validateAndNormalizeScore(parsed, trusted);
}

/**
 * Fail-closed orchestration: try the real Workers AI composer, and on ANY
 * failure (binding unavailable, network/model error, unreadable response,
 * invalid JSON, or a schema/bounds violation) fall back to the deterministic
 * fixture composer instead of leaving the channel unplayable or losing
 * listener intent. The fallback reason is reported, never swallowed.
 */
export async function composeChannelScore(env, trusted, context, options = {}) {
  try {
    const score = await composeWithWorkersAI(env, trusted, context, options);
    return { score, source: "workers-ai", fellBack: false, fallbackReason: null };
  } catch (error) {
    const fixtureScore = createFixtureScore(trusted, {
      previousCompositionId: context?.previousCompositionId ?? null,
      motifIds: context?.recurringMotifs?.length ? context.recurringMotifs : undefined,
    });
    return {
      score: fixtureScore,
      source: "fixture",
      fellBack: true,
      fallbackReason: String(error?.message ?? "composer_failed"),
    };
  }
}

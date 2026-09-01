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
import { assertMusicalQuality } from "./quality-gate.js";

export const DEFAULT_COMPOSER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Bounded retry ceiling for composeChannelScore: this many total attempts
// (including the first) are made against the real composer before falling
// back to the deterministic fixture. This is a hard ceiling, not a
// guideline -- composeChannelScore never loops beyond it regardless of how
// many attempts fail, so a flaky or consistently sparse model can never
// leave a channel hanging or spam the AI binding unboundedly.
export const MAX_COMPOSER_ATTEMPTS = 2;

function buildSchemaInstructions() {
  return [
    `Return ONLY a single JSON object matching the "${SCORE_SCHEMA_VERSION}" schema. No markdown, no prose, no code fences -- JSON only, nothing before or after it.`,
    `Required top-level fields: schemaVersion (must equal "${SCORE_SCHEMA_VERSION}"), compositionId (string), bpm (number ${SCORE_LIMITS.MIN_BPM}-${SCORE_LIMITS.MAX_BPM}), timeSignature ({beatsPerBar, beatUnit}), key ({root, mode}), bars (integer 1-${SCORE_LIMITS.MAX_BARS}), sections ([{startBar,lengthBars,label,energy}]), tracks, continuity ({motifIds,energy,transitionHint,previousCompositionId}), seed, provenance ({composer,model,promptSummary}).`,
    "For sections: every section's startBar + lengthBars must be <= bars (the total bar count). The simplest valid choice is exactly one section: {\"startBar\": 0, \"lengthBars\": <bars>, \"label\": \"main\"}. Do not create sections that extend past the end of the composition.",
    `Each track: {id, patch, events:[{pitch,start,duration,velocity}], effects:[{type,amount}], pan, gain}. A drum track instead sets isDrumTrack:true and drumEvents:[{patch,start,velocity}].`,
    `Allowed key roots: ${PITCH_CLASSES.join(", ")}. Allowed key modes: ${SCALE_MODES.join(", ")}.`,
    `Allowed synth patch ids (non-drum tracks): ${SYNTH_PATCHES.join(", ")}.`,
    `Allowed drum patch ids: ${DRUM_PATCHES.join(", ")}.`,
    `Allowed effect types: ${EFFECT_TYPES.join(", ")}, each with amount 0-1.`,
    `pitch is a MIDI note number ${SCORE_LIMITS.MIN_MIDI_PITCH}-${SCORE_LIMITS.MAX_MIDI_PITCH}. start and duration are in beats (start >= 0, duration > 0). velocity is 0-1.`,
    `Compose at most ${SCORE_LIMITS.MAX_TRACKS} tracks and ${SCORE_LIMITS.MAX_TOTAL_EVENTS} total events across all tracks combined. Keep total composition duration under ${SCORE_LIMITS.MAX_DURATION_SECONDS} seconds.`,
    "Prefer a compact declared length of 4 or 8 bars unless the musical idea genuinely needs longer. In 4/4, 4 bars spans beats 0-16 and 8 bars spans beats 0-32.",
    "Events must create audible activity across the declared timeline, not just at the beginning. Ensure activity reaches the middle AND final bars; one sustained pad/drone spanning those beats is valid coverage.",
    "Never declare more bars than the events actually occupy. Example: if the latest audible event ends near beat 16 in 4/4, use bars:4 rather than bars:16. If bars:16, activity must extend into the final bars near beats 56-64.",
    "Compose MUSICAL ROLES, not just valid events. For beat-driven material usually use complementary rhythm/drum, bass, harmony/pad/keys, and lead/texture roles when appropriate; ambient, solo, or minimal material may intentionally use fewer roles. Do not add tracks merely to satisfy a count.",
    "Treat identity, genreTags, era, energyTarget, recurringMotifs, transitionHint, and listenerPrompt as real compositional constraints. Choose rhythm, register, patch, density, articulation, and effects that support them instead of producing a generic loop with renamed metadata.",
    "Develop a recognizable motif and vary it. Repetition should establish identity, then change at least one of rhythm, contour, register, duration, velocity, orchestration, or harmony; avoid copy-pasting the exact same bar across the entire score unless strict repetition is musically intentional.",
    "Use DYNAMICS: vary note/drum velocity and density across phrases. Avoid every event having the same velocity and avoid every track entering on beat 0. Strategic rests, pickups, staggered entrances, and phrase endings are encouraged.",
    "For 8+ bars, prefer 2-4 coherent sections or phrase regions when the style supports it. Create audible contrast between sections using energy, register, rhythm, orchestration, density, or effects while preserving a recognizable musical identity. A genuinely minimal/ambient piece may evolve more subtly.",
    "Keep harmony coherent with the declared key/mode. Most pitched notes should support the scale/chord language; chromatic passing or tension notes are allowed when they resolve or serve an intentional color. Bass should reinforce or meaningfully counter the harmony rather than wander randomly.",
    "Program drums and rhythmic parts with groove rather than a perfectly identical grid when the genre permits: use accents, occasional syncopation, fills or hat variation near phrase/section boundaries. Do not overfill every subdivision.",
    "Use pan, gain, filters, delay, and reverb as arrangement tools. Create useful depth and separation, but keep effects bounded and intentional; do not put every track at identical gain/pan with identical effects.",
    "Leave SPACE. Musical quality is not event count: do not fill every beat on every track. Prefer a clear hierarchy of foreground, support, rhythm, and silence over maximum density.",
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

function buildUserPrompt(context, retryFeedback = null) {
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
    retryFeedback: retryFeedback ? String(retryFeedback).slice(0, 320) : null,
  });
}

function retryGuidanceFor(error) {
  const code = String(error?.message ?? "composer_failed");
  if (code === "insufficient_temporal_coverage") {
    return "Previous candidate rejected: insufficient_temporal_coverage. Reduce the declared bars to 4 or 8 unless the events truly span longer, and ensure audible activity reaches the middle and final bars. A sustained pad/drone spanning those beats is valid.";
  }
  if (code === "no_final_section_activity") {
    return "Previous candidate rejected: no_final_section_activity. Ensure at least one audible note, sustained pad/drone, or drum event reaches the final bars of the declared timeline.";
  }
  return `Previous candidate rejected: ${code}. Return a fresh schema-valid score and follow every duration, section, and temporal-coverage constraint exactly.`;
}

function extractResponseText(aiResult) {
  if (typeof aiResult === "string") return aiResult;
  if (aiResult && typeof aiResult.response === "string") return aiResult.response;
  if (aiResult?.result && typeof aiResult.result.response === "string") return aiResult.result.response;
  const choiceContent = aiResult?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string") return choiceContent;
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
 * Models sometimes write a coherent 4-bar idea but label the container as
 * 8/16 bars. That is not a reason to invent notes, and it should not force a
 * fixture fallback either. Before canonical validation, truthfully trim only
 * trailing declared silence down to the last audible event, while retaining a
 * four-bar floor for longer declarations so a one-note placeholder cannot
 * game the musical-quality gate by collapsing itself to one bar.
 */
function trimModelDeclaredTrailingSilence(raw) {
  const declaredBars = Number(raw?.bars);
  const beatsPerBar = Number(raw?.timeSignature?.beatsPerBar);
  const beatUnit = Number(raw?.timeSignature?.beatUnit);
  if (!Number.isInteger(declaredBars) || declaredBars <= 4) return raw;
  if (!Number.isFinite(beatsPerBar) || beatsPerBar <= 0 || !Number.isFinite(beatUnit) || beatUnit <= 0) return raw;

  const quarterBeatsPerBar = beatsPerBar * (4 / beatUnit);
  if (!Number.isFinite(quarterBeatsPerBar) || quarterBeatsPerBar <= 0) return raw;

  let latestAudibleBeat = 0;
  for (const track of Array.isArray(raw?.tracks) ? raw.tracks : []) {
    for (const event of Array.isArray(track?.events) ? track.events : []) {
      const start = Number(event?.start);
      const duration = Number(event?.duration);
      if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
        latestAudibleBeat = Math.max(latestAudibleBeat, start + duration);
      }
    }
    for (const event of Array.isArray(track?.drumEvents) ? track.drumEvents : []) {
      const start = Number(event?.start);
      if (Number.isFinite(start)) latestAudibleBeat = Math.max(latestAudibleBeat, start + 0.125);
    }
  }

  if (latestAudibleBeat <= 0) return raw;
  const occupiedBars = Math.max(4, Math.ceil(latestAudibleBeat / quarterBeatsPerBar));
  if (occupiedBars >= declaredBars) return raw;

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .filter((section) => Number.isInteger(Number(section?.startBar)) && Number(section.startBar) < occupiedBars)
    .map((section) => {
      const startBar = Number(section.startBar);
      const requestedLength = Number(section.lengthBars);
      const lengthBars = Math.max(1, Math.min(
        Number.isFinite(requestedLength) ? Math.trunc(requestedLength) : occupiedBars - startBar,
        occupiedBars - startBar,
      ));
      return { ...section, startBar, lengthBars };
    });

  return {
    ...raw,
    bars: occupiedBars,
    sections: sections.length
      ? sections
      : [{ startBar: 0, lengthBars: occupiedBars, label: "main" }],
  };
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
      { role: "user", content: buildUserPrompt(context, options.retryFeedback) },
    ],
    // Richer arrangements need enough room for structured note/drum JSON; this
    // remains bounded and is still far below the score/event safety ceilings.
    max_tokens: options.maxTokens ?? 3072,
  });

  const text = extractResponseText(aiResult);
  const parsed = trimModelDeclaredTrailingSilence(parseComposerJson(text));
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
 * Fail-closed orchestration: try the real Workers AI composer up to a
 * bounded number of attempts, requiring each candidate to pass both schema
 * validation (score-schema.js, via composeWithWorkersAI) AND the musical
 * temporal-coverage quality gate (quality-gate.js). On ANY failure across
 * every attempt -- binding unavailable, network/model error, unreadable
 * response, invalid JSON, a schema/bounds violation, or an obviously
 * placeholder/sparse composition -- falls back to the deterministic fixture
 * composer instead of leaving the channel unplayable, losing listener
 * intent, or queuing a mostly-silent score. The number of attempts is a hard
 * ceiling (MAX_COMPOSER_ATTEMPTS): this can never loop unboundedly. The
 * fallback reason is always reported, never swallowed.
 */
export async function composeChannelScore(env, trusted, context, options = {}) {
  const maxAttempts = Math.max(
    1,
    Math.min(options.maxAttempts ?? MAX_COMPOSER_ATTEMPTS, MAX_COMPOSER_ATTEMPTS),
  );
  let lastError = null;
  let retryFeedback = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const score = await composeWithWorkersAI(env, trusted, context, {
        ...options,
        retryFeedback,
      });
      assertMusicalQuality(score);
      return {
        score,
        source: "workers-ai",
        fellBack: false,
        fallbackReason: null,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      retryFeedback = retryGuidanceFor(error);
    }
  }

  const fixtureScore = createFixtureScore(trusted, {
    previousCompositionId: context?.previousCompositionId ?? null,
    motifIds: context?.recurringMotifs?.length ? context.recurringMotifs : undefined,
  });
  return {
    score: fixtureScore,
    source: "fixture",
    fellBack: true,
    fallbackReason: String(lastError?.message ?? "composer_failed"),
    attempts: maxAttempts,
  };
}

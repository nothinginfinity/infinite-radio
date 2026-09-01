// Musical temporal-coverage quality gate for infinite-radio-score-v1 scores.
//
// score-schema.js guarantees a score is STRUCTURALLY valid: correct types,
// in-bounds numbers, at least one event. It does not guarantee the
// composition is musically "there" -- a schema-valid score can declare many
// bars while nearly all of that declared duration is silent (e.g. one note
// at the very start of an otherwise-empty 16-bar score). This module adds a
// deterministic, schema-independent gate that measures how much of the
// composition's declared timeline is actually covered by audible events, so
// obvious placeholder/sparse output can be rejected while legitimate
// sustained/minimal/ambient compositions still pass.
//
// This gate is intentionally separate from score-schema.js: schema safety
// (bounds/types/identity) and musical-quality semantics (does this sound
// like a real composition) are different concerns with different failure
// modes, and keeping them in separate modules keeps each one easy to reason
// about and test in isolation.

export const QUALITY_GATE_LIMITS = Object.freeze({
  // The composition's declared timeline is divided into this many equal
  // windows (fewer for very short compositions, one per bar minimum-ish).
  MAX_COVERAGE_WINDOWS: 16,
  // At least this fraction of windows must contain audible activity.
  MIN_ACTIVE_WINDOW_RATIO: 0.35,
  // The trailing this-many windows are checked for "the composition doesn't
  // just stop" -- placeholder scores are often front-loaded and silent by
  // the end even when early density looks fine.
  FINAL_WINDOW_SPAN: 2,
  MIN_FINAL_ACTIVE_WINDOWS: 1,
  // Drum hits are effectively instantaneous; give them a small nonzero span
  // so a single drum hit can still register as activity in its window.
  MIN_DRUM_EVENT_SPAN_BEATS: 0.05,
});

function windowCountFor(bars) {
  const rounded = Math.max(1, Math.round(bars));
  return Math.max(1, Math.min(QUALITY_GATE_LIMITS.MAX_COVERAGE_WINDOWS, rounded));
}

/**
 * Compute per-window activity coverage across the composition's declared
 * timeline. Pure and deterministic; never throws, so the raw numbers can be
 * inspected/tested independently of the pass/fail gate below.
 */
export function computeTemporalCoverage(score) {
  const beatsPerBar = score.timeSignature.beatsPerBar * (4 / score.timeSignature.beatUnit);
  const totalBeats = score.bars * beatsPerBar;
  const windowCount = windowCountFor(score.bars);
  const windowBeats = totalBeats / windowCount;
  const active = new Array(windowCount).fill(false);

  function markSpan(start, end) {
    const clampedStart = Math.max(0, Math.min(start, totalBeats));
    const clampedEnd = Math.max(clampedStart + 0.0001, Math.min(end, totalBeats));
    if (clampedEnd <= clampedStart || windowBeats <= 0) return;
    const firstWindow = Math.floor(clampedStart / windowBeats);
    const lastWindow = Math.min(windowCount - 1, Math.floor((clampedEnd - 0.0001) / windowBeats));
    for (let w = Math.max(0, firstWindow); w <= lastWindow; w += 1) {
      active[w] = true;
    }
  }

  for (const track of score.tracks) {
    for (const event of track.events ?? []) {
      markSpan(event.start, event.start + event.duration);
    }
    for (const event of track.drumEvents ?? []) {
      markSpan(event.start, event.start + QUALITY_GATE_LIMITS.MIN_DRUM_EVENT_SPAN_BEATS);
    }
  }

  const activeCount = active.filter(Boolean).length;
  const finalWindowSpan = Math.min(QUALITY_GATE_LIMITS.FINAL_WINDOW_SPAN, windowCount);
  const finalActiveCount = active.slice(windowCount - finalWindowSpan).filter(Boolean).length;

  return {
    windowCount,
    active,
    activeCount,
    activeRatio: activeCount / windowCount,
    finalWindowSpan,
    finalActiveCount,
    finalSectionActive: finalActiveCount >= QUALITY_GATE_LIMITS.MIN_FINAL_ACTIVE_WINDOWS,
  };
}

/**
 * Deterministic pass/fail musical-quality gate for model-produced scores.
 * Throws a descriptive error on obvious placeholder/sparse output. Never
 * throws for legitimate sustained/minimal/ambient compositions whose events
 * genuinely span the declared timeline, even when total event count is low
 * (e.g. one long pad note covering the whole composition).
 */
export function assertMusicalQuality(score) {
  const coverage = computeTemporalCoverage(score);
  if (coverage.activeRatio < QUALITY_GATE_LIMITS.MIN_ACTIVE_WINDOW_RATIO) {
    throw new Error("insufficient_temporal_coverage");
  }
  if (!coverage.finalSectionActive) {
    throw new Error("no_final_section_activity");
  }
  return coverage;
}

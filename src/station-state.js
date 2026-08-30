export const DEFAULT_BUFFER_TARGET_SECONDS = 90;

export function createStationState(overrides = {}) {
  return {
    stationId: overrides.stationId ?? "main",
    mode: overrides.mode ?? "dj",
    status: overrides.status ?? "booting",
    currentTrack: overrides.currentTrack ?? null,
    readyQueue: overrides.readyQueue ?? [],
    promptQueue: overrides.promptQueue ?? [],
    archive: overrides.archive ?? [],
    bufferTargetSeconds:
      overrides.bufferTargetSeconds ?? DEFAULT_BUFFER_TARGET_SECONDS,
    bible: {
      identity:
        overrides.bible?.identity ??
        "An increasingly coherent late-night radio universe steered by listeners.",
      era: overrides.bible?.era ?? "origin",
      energy: overrides.bible?.energy ?? 0.5,
      tempoRange: overrides.bible?.tempoRange ?? [110, 135],
      keyHints: overrides.bible?.keyHints ?? [],
      genreTags: overrides.bible?.genreTags ?? ["electronic", "surreal"],
      recurringMotifs: overrides.bible?.recurringMotifs ?? [],
      characters: overrides.bible?.characters ?? [],
      recentStory: overrides.bible?.recentStory ?? "",
      avoid: overrides.bible?.avoid ?? [
        "same listener twice in a row",
        "same joke repeatedly",
      ],
    },
    counters: {
      promptsAccepted: overrides.counters?.promptsAccepted ?? 0,
      tracksQueued: overrides.counters?.tracksQueued ?? 0,
      archiveFallbacks: overrides.counters?.archiveFallbacks ?? 0,
    },
  };
}

export function enqueuePrompt(state, prompt) {
  if (!prompt?.text?.trim()) {
    throw new Error("prompt_text_required");
  }

  const candidate = {
    id: prompt.id ?? crypto.randomUUID(),
    userId: prompt.userId ?? "anonymous",
    text: prompt.text.trim(),
    votes: Number.isFinite(prompt.votes) ? prompt.votes : 0,
    createdAt: prompt.createdAt ?? new Date().toISOString(),
  };

  return {
    ...state,
    promptQueue: [...state.promptQueue, candidate],
    counters: {
      ...state.counters,
      promptsAccepted: state.counters.promptsAccepted + 1,
    },
  };
}

export function selectNextPrompt(state) {
  if (state.promptQueue.length === 0) {
    return { state, selected: null };
  }

  const ranked = [...state.promptQueue].sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const selected = ranked[0];

  return {
    selected,
    state: {
      ...state,
      promptQueue: state.promptQueue.filter((p) => p.id !== selected.id),
    },
  };
}

export function queueReadyTrack(state, track) {
  if (!track?.id || !Number.isFinite(track.durationSeconds)) {
    throw new Error("valid_track_required");
  }

  return {
    ...state,
    readyQueue: [...state.readyQueue, track],
    counters: {
      ...state.counters,
      tracksQueued: state.counters.tracksQueued + 1,
    },
  };
}

export function readyBufferSeconds(state) {
  return state.readyQueue.reduce(
    (sum, track) => sum + Math.max(0, track.durationSeconds ?? 0),
    0,
  );
}

export function needsGeneration(state) {
  return readyBufferSeconds(state) < state.bufferTargetSeconds;
}

export function chooseNextPlayable(state) {
  if (state.readyQueue.length > 0) {
    const [next, ...rest] = state.readyQueue;
    return {
      source: "ready",
      track: next,
      state: { ...state, currentTrack: next, readyQueue: rest, status: "playing" },
    };
  }

  if (state.archive.length > 0) {
    const next = state.archive[0];
    return {
      source: "archive",
      track: next,
      state: {
        ...state,
        currentTrack: next,
        status: "fallback",
        counters: {
          ...state.counters,
          archiveFallbacks: state.counters.archiveFallbacks + 1,
        },
      },
    };
  }

  return {
    source: "none",
    track: null,
    state: { ...state, currentTrack: null, status: "starved" },
  };
}

export function compileStationBrief(state, selectedPrompt) {
  return {
    stationId: state.stationId,
    mode: state.mode,
    listenerPrompt: selectedPrompt?.text ?? null,
    listenerId: selectedPrompt?.userId ?? null,
    continuity: structuredClone(state.bible),
    instruction:
      "Create one short radio segment that satisfies the listener idea while remaining recognizably part of the current station universe. Do not imitate a living artist by name.",
  };
}

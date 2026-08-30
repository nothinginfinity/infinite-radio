export const DEFAULT_BUFFER_TARGET_SECONDS = 90;
export const DEFAULT_GENERATION_CAP_PER_HOUR = 120;
export const DEFAULT_GENERATION_CAP_PER_DAY = 500;
export const DEFAULT_FIXTURE_TRACK_SECONDS = 30;

export const MUSIC_PROVIDERS = Object.freeze({
  FIXTURE: "fixture",
  FAL_CASSETTEAI: "fal-cassetteai",
});

function requiredId(value, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.includes("..") || normalized.includes("/")) {
    throw new Error(code);
  }
  return normalized;
}

function clone(value) {
  return structuredClone(value);
}

function defaultProviderModel(provider) {
  return provider === MUSIC_PROVIDERS.FAL_CASSETTEAI
    ? "cassetteai/music-generator"
    : "fixture";
}

function assertNoRawCredentialFields(policy) {
  const forbidden = ["apiKey", "api_key", "token", "accessToken", "secret", "credential"];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(policy ?? {}, key))) {
    throw new Error("raw_provider_secret_forbidden");
  }
}

function normalizePolicy(current, update = {}) {
  assertNoRawCredentialFields(update);
  const provider = update.provider ?? current.provider ?? MUSIC_PROVIDERS.FIXTURE;
  if (!Object.values(MUSIC_PROVIDERS).includes(provider)) {
    throw new Error("music_provider_unsupported");
  }
  const providerChanged = provider !== (current.provider ?? MUSIC_PROVIDERS.FIXTURE);
  const hasCredentialRef = Object.prototype.hasOwnProperty.call(update, "credentialRef");
  const credentialRef = hasCredentialRef
    ? update.credentialRef
    : providerChanged
      ? null
      : current.credentialRef ?? null;
  if (provider !== MUSIC_PROVIDERS.FIXTURE && !credentialRef) {
    throw new Error("credential_ref_required");
  }
  const bufferTargetSeconds = update.bufferTargetSeconds ?? current.bufferTargetSeconds ?? DEFAULT_BUFFER_TARGET_SECONDS;
  const generationCapPerHour = update.generationCapPerHour ?? current.generationCapPerHour ?? DEFAULT_GENERATION_CAP_PER_HOUR;
  const generationCapPerDay = update.generationCapPerDay ?? current.generationCapPerDay ?? DEFAULT_GENERATION_CAP_PER_DAY;
  if (!Number.isFinite(bufferTargetSeconds) || bufferTargetSeconds <= 0) throw new Error("invalid_buffer_target");
  if (!Number.isInteger(generationCapPerHour) || generationCapPerHour <= 0) throw new Error("invalid_generation_cap");
  if (!Number.isInteger(generationCapPerDay) || generationCapPerDay <= 0) throw new Error("invalid_generation_cap");
  if (generationCapPerDay < generationCapPerHour) throw new Error("daily_cap_below_hourly_cap");
  return {
    bufferTargetSeconds,
    generationCapPerHour,
    generationCapPerDay,
    provider,
    model: update.model ?? (providerChanged ? defaultProviderModel(provider) : current.model) ?? defaultProviderModel(provider),
    credentialRef,
  };
}

export function createChannelState(overrides = {}) {
  const channelId = requiredId(overrides.channelId ?? "main", "channel_id_required");
  const creatorId = requiredId(overrides.creatorId ?? "local-dev", "creator_id_required");
  const policy = normalizePolicy({}, overrides.policy ?? {});

  return {
    schemaVersion: 2,
    channelId,
    creatorId,
    mode: overrides.mode ?? "dj",
    status: overrides.status ?? "idle",
    currentTrack: overrides.currentTrack ?? null,
    readyQueue: clone(overrides.readyQueue ?? []),
    promptQueue: clone(overrides.promptQueue ?? []),
    promptLedger: clone(overrides.promptLedger ?? overrides.promptQueue ?? []),
    generationJobs: clone(overrides.generationJobs ?? []),
    archive: clone(overrides.archive ?? []),
    policy: normalizePolicy(policy, {
      bufferTargetSeconds: overrides.bufferTargetSeconds ?? policy.bufferTargetSeconds,
    }),
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
    generationWindow: {
      startedAt: overrides.generationWindow?.startedAt ?? null,
      count: overrides.generationWindow?.count ?? 0,
    },
    generationDayWindow: {
      startedAt: overrides.generationDayWindow?.startedAt ?? null,
      count: overrides.generationDayWindow?.count ?? 0,
    },
    providerHealth: clone(overrides.providerHealth ?? {
      status: "healthy",
      consecutiveFailures: 0,
      lastError: null,
      checkedAt: null,
    }),
    counters: {
      promptsAccepted: overrides.counters?.promptsAccepted ?? 0,
      promptReplays: overrides.counters?.promptReplays ?? 0,
      generationJobsCreated: overrides.counters?.generationJobsCreated ?? 0,
      generationReplays: overrides.counters?.generationReplays ?? 0,
      tracksQueued: overrides.counters?.tracksQueued ?? 0,
      archiveFallbacks: overrides.counters?.archiveFallbacks ?? 0,
      fixtureTracks: overrides.counters?.fixtureTracks ?? 0,
      autopilotPrompts: overrides.counters?.autopilotPrompts ?? 0,
    },
  };
}

export function createStationState(overrides = {}) {
  return createChannelState({
    channelId: overrides.channelId ?? overrides.stationId ?? "main",
    creatorId: overrides.creatorId ?? "local-dev",
    ...overrides,
  });
}

export function updateChannelPolicy(state, update = {}) {
  return {
    ...state,
    policy: normalizePolicy(state.policy, update),
  };
}

export function assertChannelOwner(state, creatorId) {
  if (!creatorId || creatorId !== state.creatorId) {
    throw new Error("channel_owner_required");
  }
  return true;
}

export function channelAssetKey(channelId, suffix) {
  const safeChannelId = requiredId(channelId, "channel_id_required");
  const safeSuffix = String(suffix ?? "").replace(/^\/+/, "");
  if (!safeSuffix || safeSuffix.includes("..")) {
    throw new Error("asset_suffix_required");
  }
  return `channels/${safeChannelId}/${safeSuffix}`;
}

export function submitPrompt(state, prompt) {
  if (!prompt?.text?.trim()) {
    throw new Error("prompt_text_required");
  }

  const idempotencyKey = String(
    prompt.idempotencyKey ?? prompt.id ?? crypto.randomUUID(),
  ).trim();
  if (!idempotencyKey) throw new Error("idempotency_key_required");

  const existing = state.promptLedger.find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  );
  if (existing) {
    if (
      existing.text !== prompt.text.trim() ||
      existing.userId !== (prompt.userId ?? "anonymous")
    ) {
      throw new Error("idempotency_conflict");
    }
    return {
      state: {
        ...state,
        counters: {
          ...state.counters,
          promptReplays: state.counters.promptReplays + 1,
        },
      },
      prompt: existing,
      deduped: true,
    };
  }

  const candidate = {
    id: prompt.id ?? `prompt:${idempotencyKey}`,
    channelId: state.channelId,
    idempotencyKey,
    userId: prompt.userId ?? "anonymous",
    text: prompt.text.trim(),
    votes: Number.isFinite(prompt.votes) ? prompt.votes : 0,
    createdAt: prompt.createdAt ?? new Date().toISOString(),
  };

  return {
    state: {
      ...state,
      promptQueue: [...state.promptQueue, candidate],
      promptLedger: [...state.promptLedger, candidate],
      counters: {
        ...state.counters,
        promptsAccepted: state.counters.promptsAccepted + 1,
      },
    },
    prompt: candidate,
    deduped: false,
  };
}

export function enqueuePrompt(state, prompt) {
  return submitPrompt(state, prompt).state;
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
  if (track.channelId && track.channelId !== state.channelId) {
    throw new Error("channel_scope_violation");
  }

  const scopedTrack = { ...track, channelId: state.channelId };
  if (state.readyQueue.some((candidate) => candidate.id === scopedTrack.id)) {
    return state;
  }

  return {
    ...state,
    readyQueue: [...state.readyQueue, scopedTrack],
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
  return readyBufferSeconds(state) < state.policy.bufferTargetSeconds;
}

function generationWindowFor(state, now) {
  const timestamp = new Date(now ?? Date.now()).getTime();
  const start = state.generationWindow.startedAt
    ? new Date(state.generationWindow.startedAt).getTime()
    : null;
  if (!start || timestamp - start >= 60 * 60 * 1000) {
    return { startedAt: new Date(timestamp).toISOString(), count: 0 };
  }
  return state.generationWindow;
}

function generationDayWindowFor(state, now) {
  const timestamp = new Date(now ?? Date.now()).getTime();
  const start = state.generationDayWindow?.startedAt
    ? new Date(state.generationDayWindow.startedAt).getTime()
    : null;
  if (!start || timestamp - start >= 24 * 60 * 60 * 1000) {
    return { startedAt: new Date(timestamp).toISOString(), count: 0 };
  }
  return state.generationDayWindow;
}

export function createGenerationJob(state, selectedPrompt, options = {}) {
  if (!selectedPrompt?.id) throw new Error("selected_prompt_required");
  if (selectedPrompt.channelId && selectedPrompt.channelId !== state.channelId) {
    throw new Error("channel_scope_violation");
  }
  if (
    options.credentialRef !== undefined &&
    options.credentialRef !== state.policy.credentialRef
  ) {
    throw new Error("credential_scope_violation");
  }

  const idempotencyKey = options.idempotencyKey ?? `generation:${selectedPrompt.id}`;
  const existing = state.generationJobs.find(
    (job) => job.idempotencyKey === idempotencyKey,
  );
  if (existing) {
    return {
      state: {
        ...state,
        counters: {
          ...state.counters,
          generationReplays: state.counters.generationReplays + 1,
        },
      },
      job: existing,
      deduped: true,
    };
  }

  const window = generationWindowFor(state, options.now);
  const dayWindow = generationDayWindowFor(state, options.now);
  if (window.count >= state.policy.generationCapPerHour) {
    throw new Error("generation_cap_reached");
  }
  if (dayWindow.count >= state.policy.generationCapPerDay) {
    throw new Error("daily_generation_cap_reached");
  }

  const job = {
    id: options.id ?? `job:${selectedPrompt.id}`,
    channelId: state.channelId,
    idempotencyKey,
    promptId: selectedPrompt.id,
    provider: state.policy.provider,
    model: state.policy.model,
    credentialRef: state.policy.credentialRef,
    status: "queued",
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };

  return {
    state: {
      ...state,
      generationJobs: [...state.generationJobs, job],
      generationWindow: { ...window, count: window.count + 1 },
      generationDayWindow: { ...dayWindow, count: dayWindow.count + 1 },
      counters: {
        ...state.counters,
        generationJobsCreated: state.counters.generationJobsCreated + 1,
      },
    },
    job,
    deduped: false,
  };
}

export function markGenerationRunning(state, jobId, now = Date.now()) {
  const job = state.generationJobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("generation_job_not_found");
  if (job.channelId !== state.channelId) throw new Error("channel_scope_violation");
  const updatedAt = new Date(now).toISOString();
  return {
    ...state,
    generationJobs: state.generationJobs.map((candidate) =>
      candidate.id === jobId ? { ...candidate, status: "running", updatedAt } : candidate,
    ),
  };
}

export function failGeneration(state, jobId, errorCode, now = Date.now()) {
  const job = state.generationJobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("generation_job_not_found");
  const updatedAt = new Date(now).toISOString();
  return {
    ...state,
    generationJobs: state.generationJobs.map((candidate) =>
      candidate.id === jobId
        ? { ...candidate, status: "failed", errorCode: String(errorCode ?? "provider_generation_failed"), updatedAt }
        : candidate,
    ),
    providerHealth: {
      status: "degraded",
      consecutiveFailures: (state.providerHealth?.consecutiveFailures ?? 0) + 1,
      lastError: String(errorCode ?? "provider_generation_failed"),
      checkedAt: updatedAt,
    },
  };
}

export function completeMusicGeneration(state, jobId, options = {}) {
  const job = state.generationJobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("generation_job_not_found");
  if (job.channelId !== state.channelId) throw new Error("channel_scope_violation");
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Error("invalid_generated_audio");
  }
  const prefix = `channels/${state.channelId}/`;
  if (!options.assetKey?.startsWith(prefix) || options.assetKey.includes("..")) {
    throw new Error("channel_scope_violation");
  }
  const createdAt = new Date(options.now ?? Date.now()).toISOString();
  const track = {
    id: options.trackId ?? `track:${jobId}`,
    channelId: state.channelId,
    generationJobId: jobId,
    provider: job.provider,
    model: job.model,
    durationSeconds: options.durationSeconds,
    assetKey: options.assetKey,
    contentType: options.contentType ?? "audio/wav",
    createdAt,
  };
  const readyState = queueReadyTrack(state, track);
  return {
    state: {
      ...readyState,
      generationJobs: readyState.generationJobs.map((candidate) =>
        candidate.id === jobId
          ? {
              ...candidate,
              status: "ready",
              updatedAt: createdAt,
              trackId: track.id,
              assetKey: track.assetKey,
              durationSeconds: track.durationSeconds,
              receiptId: options.receiptId ?? null,
            }
          : candidate,
      ),
      providerHealth: {
        status: "healthy",
        consecutiveFailures: 0,
        lastError: null,
        checkedAt: createdAt,
      },
    },
    track,
  };
}

export function completeFixtureGeneration(state, jobId, options = {}) {
  const job = state.generationJobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("generation_job_not_found");
  if (job.channelId !== state.channelId) throw new Error("channel_scope_violation");

  const existingTrack = [state.currentTrack, ...state.readyQueue, ...state.archive].find(
    (track) => track?.generationJobId === jobId,
  );
  if (existingTrack) {
    return { state, track: existingTrack, deduped: true };
  }
  if (job.status === "ready" && job.trackId && job.assetKey) {
    return {
      state,
      track: {
        id: job.trackId,
        channelId: state.channelId,
        generationJobId: job.id,
        provider: job.provider,
        durationSeconds: job.durationSeconds,
        assetKey: job.assetKey,
        createdAt: job.updatedAt,
      },
      deduped: true,
    };
  }

  const durationSeconds = options.durationSeconds ?? DEFAULT_FIXTURE_TRACK_SECONDS;
  const track = {
    id: options.trackId ?? `track:${jobId}`,
    channelId: state.channelId,
    generationJobId: jobId,
    provider: "fixture",
    durationSeconds,
    assetKey: channelAssetKey(state.channelId, `fixture/${jobId}.wav`),
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  const readyState = queueReadyTrack(state, track);

  return {
    state: {
      ...readyState,
      generationJobs: readyState.generationJobs.map((candidate) =>
        candidate.id === jobId
          ? {
              ...candidate,
              status: "ready",
              updatedAt: track.createdAt,
              trackId: track.id,
              assetKey: track.assetKey,
              durationSeconds: track.durationSeconds,
            }
          : candidate,
      ),
      counters: {
        ...readyState.counters,
        fixtureTracks: readyState.counters.fixtureTracks + 1,
      },
    },
    track,
    deduped: false,
  };
}

function makeAutopilotPrompt(state, sequence, now) {
  return {
    id: `autopilot:${state.channelId}:${sequence}`,
    channelId: state.channelId,
    idempotencyKey: `autopilot:${sequence}`,
    userId: "system:autopilot",
    text: `Continue ${state.bible.identity} in era ${state.bible.era}.`,
    votes: 0,
    createdAt: new Date(now ?? Date.now()).toISOString(),
  };
}

export function ensureFixtureBuffer(state, options = {}) {
  const maxTracks = options.maxTracks ?? 20;
  const created = [];
  let next = state;

  for (let i = 0; i < maxTracks && needsGeneration(next); i += 1) {
    let selectedResult = selectNextPrompt(next);
    next = selectedResult.state;
    let prompt = selectedResult.selected;
    if (!prompt) {
      const sequence = next.counters.autopilotPrompts + 1;
      prompt = makeAutopilotPrompt(next, sequence, options.now);
      next = {
        ...next,
        counters: {
          ...next.counters,
          autopilotPrompts: sequence,
        },
      };
    }

    const scheduled = createGenerationJob(next, prompt, {
      now: options.now,
      credentialRef: next.policy.credentialRef,
    });
    next = scheduled.state;
    const completed = completeFixtureGeneration(next, scheduled.job.id, {
      now: options.now,
      durationSeconds: options.durationSeconds,
    });
    next = completed.state;
    created.push({ prompt, job: scheduled.job, track: completed.track });
  }

  return { state: next, created };
}

export function chooseNextPlayable(state) {
  if (state.readyQueue.length > 0) {
    const [next, ...rest] = state.readyQueue;
    return {
      source: "ready",
      track: next,
      state: {
        ...state,
        currentTrack: next,
        readyQueue: rest,
        status: "playing",
      },
    };
  }

  if (state.archive.length > 0) {
    const next = state.archive[0];
    if (next.channelId && next.channelId !== state.channelId) {
      throw new Error("channel_scope_violation");
    }
    return {
      source: "archive",
      track: { ...next, channelId: state.channelId },
      state: {
        ...state,
        currentTrack: { ...next, channelId: state.channelId },
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
  if (selectedPrompt?.channelId && selectedPrompt.channelId !== state.channelId) {
    throw new Error("channel_scope_violation");
  }
  return {
    channelId: state.channelId,
    stationId: state.channelId,
    creatorId: state.creatorId,
    mode: state.mode,
    listenerPrompt: selectedPrompt?.text ?? null,
    listenerId: selectedPrompt?.userId ?? null,
    continuity: clone(state.bible),
    providerPolicy: {
      provider: state.policy.provider,
      model: state.policy.model,
      credentialRef: state.policy.credentialRef,
      generationCapPerHour: state.policy.generationCapPerHour,
      generationCapPerDay: state.policy.generationCapPerDay,
    },
    instruction:
      "Create one short radio segment that satisfies the listener idea while remaining recognizably part of the current channel universe. Do not imitate a living artist by name.",
  };
}

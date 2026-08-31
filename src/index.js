import { createFalClient } from "@fal-ai/client";

import {
  MUSIC_PROVIDERS,
  assertChannelOwner,
  assertProviderReady,
  channelAssetKey,
  chooseNextPlayable,
  compileStationBrief,
  completeMusicGeneration,
  compositionBufferCount,
  currentCompositionPlayback,
  createChannelState,
  createGenerationJob,
  ensureFixtureBuffer,
  failGeneration,
  markGenerationRunning,
  queueComposition,
  readyBufferSeconds,
  selectNextComposition,
  selectNextPrompt,
  submitPrompt,
  updateChannelPolicy,
} from "./station-state.js";
import { buildComposerContext, composeChannelScore } from "./composer.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(error) {
  const clientErrors = new Set([
    "channel_id_required",
    "creator_id_required",
    "channel_owner_required",
    "prompt_text_required",
    "idempotency_key_required",
    "idempotency_conflict",
    "channel_scope_violation",
    "credential_scope_violation",
    "generation_cap_reached",
    "daily_generation_cap_reached",
    "raw_provider_secret_forbidden",
    "music_provider_unsupported",
    "credential_ref_required",
    "provider_key_required",
    "provider_backoff_active",
    "real_provider_required",
    "fixture_provider_required",
    "prompt_queue_empty",
    "invalid_generated_audio",
    "valid_composition_required",
    "composition_queue_empty",
  ]);
  return json(
    { ok: false, error: error?.message ?? "internal_error" },
    { status: clientErrors.has(error?.message) ? 400 : 500 },
  );
}

function channelRoute(pathname) {
  const match = pathname.match(/^\/api\/channels\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    channelId: decodeURIComponent(match[1]),
    tail: match[2] || "/state",
  };
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function credentialRefFor(provider, rawKey) {
  const normalizedProvider = String(provider ?? "").trim();
  const normalizedKey = String(rawKey ?? "").trim();
  if (!normalizedProvider || !normalizedKey) throw new Error("provider_key_required");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedKey));
  return `${normalizedProvider}:sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function validateWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) return false;
  const text = new TextDecoder().decode(bytes.slice(0, 12));
  return text.startsWith("RIFF") && text.slice(8, 12) === "WAVE";
}

export function safeProviderErrorCode(error) {
  const known = new Set([
    "provider_audio_missing",
    "provider_audio_fetch_failed",
    "provider_audio_invalid",
    "provider_offline",
  ]);
  if (known.has(error?.message)) return error.message;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_generation_failed";
}

export async function runFalCassetteAI({ apiKey, prompt, durationSeconds, clientFactory = createFalClient, fetcher = fetch }) {
  const startedAt = Date.now();
  const client = clientFactory({ credentials: apiKey });
  const result = await client.subscribe("CassetteAI/music-generator", {
    input: {
      prompt,
      duration: Math.max(5, Math.min(180, Math.round(durationSeconds))),
    },
  });
  const sourceUrl = result?.data?.audio_file?.url;
  if (!sourceUrl) throw new Error("provider_audio_missing");
  const audioResponse = await fetcher(sourceUrl);
  if (!audioResponse.ok) throw new Error("provider_audio_fetch_failed");
  const bytes = new Uint8Array(await audioResponse.arrayBuffer());
  if (!validateWav(bytes)) throw new Error("provider_audio_invalid");
  const duration = Math.max(5, Math.min(180, Math.round(durationSeconds)));
  return {
    bytes,
    contentType: audioResponse.headers.get("content-type") || "audio/wav",
    providerRequestId: result.requestId ?? null,
    durationSeconds: duration,
    latencyMs: Date.now() - startedAt,
    costMicrousd: Math.ceil((duration / 60) * 20000),
    provenance: {
      provider: MUSIC_PROVIDERS.FAL_CASSETTEAI,
      model: "CassetteAI/music-generator",
      pricing_basis: "fal published $0.02 per output minute",
      terms_uri: "https://fal.ai/legal/terms-of-service",
      api_terms_uri: "https://fal.ai/legal/api-services",
      source_host: new URL(sourceUrl).hostname,
    },
  };
}

export async function runFalStableAudio({ apiKey, prompt, durationSeconds, clientFactory = createFalClient, fetcher = fetch }) {
  const startedAt = Date.now();
  const client = clientFactory({ credentials: apiKey });
  const duration = Math.max(1, Math.min(30, Math.round(durationSeconds)));
  const result = await client.subscribe("fal-ai/stable-audio", {
    input: {
      prompt,
      seconds_total: duration,
    },
  });
  const sourceUrl = result?.data?.audio_file?.url;
  if (!sourceUrl) throw new Error("provider_audio_missing");
  const audioResponse = await fetcher(sourceUrl);
  if (!audioResponse.ok) throw new Error("provider_audio_fetch_failed");
  const bytes = new Uint8Array(await audioResponse.arrayBuffer());
  const responseType = audioResponse.headers.get("content-type") || result?.data?.audio_file?.content_type || "application/octet-stream";
  if (bytes.byteLength <= 44 || (!validateWav(bytes) && !responseType.startsWith("audio/"))) {
    throw new Error("provider_audio_invalid");
  }
  return {
    bytes,
    contentType: validateWav(bytes) ? "audio/wav" : responseType,
    providerRequestId: result.requestId ?? null,
    durationSeconds: duration,
    latencyMs: Date.now() - startedAt,
    costMicrousd: 0,
    provenance: {
      provider: MUSIC_PROVIDERS.FAL_STABLE_AUDIO,
      model: "fal-ai/stable-audio",
      pricing_basis: "fal published $0 per compute second",
      terms_uri: "https://fal.ai/legal/terms-of-service",
      api_terms_uri: "https://fal.ai/legal/api-services",
      source_host: new URL(sourceUrl).hostname,
    },
  };
}

function createSilenceWav(durationSeconds, sampleRate = 8000) {
  const seconds = Math.max(1, Math.floor(durationSeconds));
  const dataSize = seconds * sampleRate;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  bytes.fill(128, 44);
  return bytes;
}

async function compileControlBrief(ai, state, prompt) {
  const deterministic = compileStationBrief(state, prompt);
  if (!ai?.run) return { source: "deterministic", brief: deterministic };
  try {
    const result = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "You are the low-cost control layer for an AI radio channel. Return concise JSON only with keys creative_direction, moderation, and programming_note. Do not imitate living artists by name." },
        { role: "user", content: JSON.stringify(deterministic) },
      ],
      max_tokens: 300,
      temperature: 0.4,
    });
    const text = result?.response ?? result?.result?.response ?? null;
    return { source: "workers-ai", brief: deterministic, control: typeof text === "string" ? text : JSON.stringify(text ?? result) };
  } catch (error) {
    return { source: "deterministic-fallback", brief: deterministic, workers_ai_error: error?.message ?? "workers_ai_failed" };
  }
}

async function bestEffort(statementPromise) {
  try {
    return await statementPromise;
  } catch (error) {
    console.warn("d1_metadata_write_failed", error?.message ?? String(error));
    return null;
  }
}

export class ChannelConductor {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.compositionMutationTail = Promise.resolve();
  }

  async runCompositionMutation(work) {
    const previous = this.compositionMutationTail;
    let release;
    this.compositionMutationTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async load(channelId, creatorId = null) {
    const persisted = await this.ctx.storage.get("channel-state");
    if (persisted) {
      if (persisted.channelId !== channelId) {
        throw new Error("channel_scope_violation");
      }
      return persisted;
    }
    if (!creatorId) throw new Error("creator_id_required");
    const state = createChannelState({ channelId, creatorId });
    await this.ctx.storage.put("channel-state", state);
    return state;
  }

  async persist(state) {
    await this.ctx.storage.put("channel-state", state);
    this.broadcast({ type: "channel_state", state: publicState(state) });
  }

  broadcast(message) {
    const sockets = this.ctx.getWebSockets?.() ?? [];
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
      }
    }
  }

  async generateWithProvider(state, prompt, rawKey, durationSeconds) {
    if (![MUSIC_PROVIDERS.FAL_CASSETTEAI, MUSIC_PROVIDERS.FAL_STABLE_AUDIO].includes(state.policy.provider)) {
      throw new Error("music_provider_unsupported");
    }
    const expectedRef = await credentialRefFor(state.policy.provider, rawKey);
    if (expectedRef !== state.policy.credentialRef) throw new Error("credential_scope_violation");
    const brief = compileStationBrief(state, prompt);
    const providerPrompt = [
      brief.listenerPrompt,
      `Channel identity: ${brief.continuity.identity}`,
      `Era: ${brief.continuity.era}`,
      `Genres: ${(brief.continuity.genreTags ?? []).join(", ")}`,
      `Tempo: ${(brief.continuity.tempoRange ?? []).join("-")} BPM`,
      "Create an original track. Do not imitate a living artist by name.",
    ].filter(Boolean).join("\n");
    if (this.env.MUSIC_PROVIDER?.generate) {
      return this.env.MUSIC_PROVIDER.generate({
        provider: state.policy.provider,
        model: state.policy.model,
        apiKey: rawKey,
        prompt: providerPrompt,
        durationSeconds,
      });
    }
    if (state.policy.provider === MUSIC_PROVIDERS.FAL_STABLE_AUDIO) {
      return runFalStableAudio({ apiKey: rawKey, prompt: providerPrompt, durationSeconds });
    }
    return runFalCassetteAI({ apiKey: rawKey, prompt: providerPrompt, durationSeconds });
  }

  async writeChannelMetadata(state) {
    if (!this.env.DB) return;
    const now = new Date().toISOString();
    await bestEffort(
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO creators (creator_id, created_at) VALUES (?, ?)",
      )
        .bind(state.creatorId, now)
        .run(),
    );
    await bestEffort(
      this.env.DB.prepare(
        `INSERT INTO channels (channel_id, owner_creator_id, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
        .bind(state.channelId, state.creatorId, now, now)
        .run(),
    );
    await bestEffort(
      this.env.DB.prepare(
        `INSERT INTO channel_policies
          (channel_id, buffer_target_seconds, generation_cap_per_hour, generation_cap_per_day, provider, model, credential_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           buffer_target_seconds = excluded.buffer_target_seconds,
           generation_cap_per_hour = excluded.generation_cap_per_hour,
           generation_cap_per_day = excluded.generation_cap_per_day,
           provider = excluded.provider,
           model = excluded.model,
           credential_ref = excluded.credential_ref,
           updated_at = excluded.updated_at`,
      )
        .bind(
          state.channelId,
          state.policy.bufferTargetSeconds,
          state.policy.generationCapPerHour,
          state.policy.generationCapPerDay,
          state.policy.provider,
          state.policy.model,
          state.policy.credentialRef,
          now,
        )
        .run(),
    );
  }

  async writePrompt(prompt) {
    if (!this.env.DB) return;
    await bestEffort(
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO prompts
          (prompt_id, channel_id, idempotency_key, user_id, text, votes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          prompt.id,
          prompt.channelId,
          prompt.idempotencyKey,
          prompt.userId,
          prompt.text,
          prompt.votes,
          prompt.createdAt,
        )
        .run(),
    );
  }

  async writeProviderArtifact({ job, track, receipt }) {
    if (this.env.DB) {
      await bestEffort(
        this.env.DB.prepare(
          `INSERT INTO generations
            (generation_id, channel_id, prompt_id, idempotency_key, provider, model, credential_ref, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
           ON CONFLICT(generation_id) DO UPDATE SET
             status = 'ready', model = excluded.model, updated_at = excluded.updated_at`,
        )
          .bind(job.id, job.channelId, job.promptId, job.idempotencyKey, job.provider, job.model, job.credentialRef, job.createdAt, track.createdAt)
          .run(),
      );
      await bestEffort(
        this.env.DB.prepare(
          `INSERT INTO tracks
            (track_id, channel_id, generation_id, asset_key, duration_seconds, provider, model, content_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(track_id) DO UPDATE SET asset_key = excluded.asset_key`,
        )
          .bind(track.id, track.channelId, track.generationJobId, track.assetKey, track.durationSeconds, track.provider, track.model, track.contentType, track.createdAt)
          .run(),
      );
      await bestEffort(
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO provider_receipts
            (receipt_id, channel_id, generation_id, provider, model, provider_request_id, duration_seconds, latency_ms, cost_microusd, terms_uri, provenance_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(receipt.receiptId, track.channelId, job.id, job.provider, job.model, receipt.providerRequestId, track.durationSeconds, receipt.latencyMs, receipt.costMicrousd, receipt.provenance?.terms_uri ?? null, JSON.stringify(receipt.provenance), track.createdAt)
          .run(),
      );
    }
  }

  async writeGenerationFailure(job, errorCode) {
    if (!this.env.DB) return;
    await bestEffort(
      this.env.DB.prepare(
        `INSERT INTO generations
          (generation_id, channel_id, prompt_id, idempotency_key, provider, model, credential_ref, status, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT(generation_id) DO UPDATE SET status = 'failed', error_code = excluded.error_code, updated_at = excluded.updated_at`,
      )
        .bind(job.id, job.channelId, job.promptId, job.idempotencyKey, job.provider, job.model, job.credentialRef, errorCode, job.createdAt, new Date().toISOString())
        .run(),
    );
  }

  async writeFixtureArtifacts(created) {
    for (const item of created) {
      if (this.env.DB) {
        await bestEffort(
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO generations
              (generation_id, channel_id, prompt_id, idempotency_key, provider, model, credential_ref, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          )
            .bind(
              item.job.id,
              item.job.channelId,
              item.job.promptId,
              item.job.idempotencyKey,
              item.job.provider,
              item.job.model,
              item.job.credentialRef,
              item.job.createdAt,
              item.track.createdAt,
            )
            .run(),
        );
        await bestEffort(
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO tracks
              (track_id, channel_id, generation_id, asset_key, duration_seconds, provider, model, content_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              item.track.id,
              item.track.channelId,
              item.track.generationJobId,
              item.track.assetKey,
              item.track.durationSeconds,
              item.track.provider,
              item.job.model,
              "audio/wav",
              item.track.createdAt,
            )
            .run(),
        );
      }
      if (this.env.ASSETS) {
        await this.env.ASSETS.put(
          item.track.assetKey,
          createSilenceWav(item.track.durationSeconds),
          {
            httpMetadata: { contentType: "audio/wav" },
            customMetadata: {
              schema: "infinite-radio-fixture-v1",
              channel_id: item.track.channelId,
              generation_id: item.job.id,
              prompt_id: item.job.promptId,
              duration_seconds: String(item.track.durationSeconds),
            },
          },
        );
      }
    }
  }

  /**
   * Persist an accepted infinite-radio-score-v1 composition as the durable,
   * immutable canonical library artifact. Keyed on composition_id with
   * ON CONFLICT DO NOTHING, so replaying/re-queuing the same composition can
   * never rewrite or duplicate history. This is a first-class write, not
   * best-effort metadata: failures are logged distinctly (console.error, not
   * the bestEffort console.warn used for secondary metadata) and reported
   * back to the caller as `persisted:false` rather than silently swallowed,
   * while still never blocking playback/queueing if D1 is unavailable.
   */
  async writeCompositionRecord(score, status = "buffered", now = Date.now()) {
    if (!this.env.DB) return { persisted: false, reason: "d1_unbound" };
    const createdAt = new Date(now).toISOString();
    try {
      await this.env.DB.prepare(
        `INSERT INTO compositions
          (composition_id, channel_id, creator_id, schema_version, score_json, composer, model, bpm, key_root, key_mode, bars, duration_seconds, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(composition_id) DO NOTHING`,
      )
        .bind(
          score.compositionId,
          score.channelId,
          score.creatorId ?? null,
          score.schemaVersion,
          JSON.stringify(score),
          score.provenance?.composer ?? "unknown",
          score.provenance?.model ?? null,
          score.bpm,
          score.key?.root ?? null,
          score.key?.mode ?? null,
          score.bars,
          score.durationSeconds,
          status,
          createdAt,
        )
        .run();
      return { persisted: true };
    } catch (error) {
      console.error("composition_library_write_failed", score.compositionId, error?.message ?? String(error));
      return { persisted: false, reason: error?.message ?? "write_failed" };
    }
  }

  /**
   * Mark a previously-persisted composition as selected/current. This is a
   * lifecycle-status transition on an already-durable record (the score_json
   * itself is never touched), so it uses the same best-effort pattern as
   * other secondary metadata writes elsewhere in this class.
   */
  async markCompositionSelected(compositionId, now = Date.now()) {
    if (!this.env.DB) return;
    await bestEffort(
      this.env.DB.prepare(
        `UPDATE compositions SET status = 'selected', selected_at = ? WHERE composition_id = ? AND status = 'buffered'`,
      )
        .bind(new Date(now).toISOString(), compositionId)
        .run(),
    );
  }

  /**
   * Bounded, channel-scoped, newest-first read of the composition library.
   * `limit` is always clamped server-side -- this never returns an
   * unbounded history regardless of what the caller requests.
   */
  async readCompositionLibrary(channelId, { limit = 20, before = null } = {}) {
    if (!this.env.DB) return [];
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
    try {
      const statement = before
        ? this.env.DB.prepare(
            `SELECT composition_id, creator_id, composer, model, bpm, key_root, key_mode, bars, duration_seconds, status, created_at, selected_at
             FROM compositions WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
          ).bind(channelId, before, boundedLimit)
        : this.env.DB.prepare(
            `SELECT composition_id, creator_id, composer, model, bpm, key_root, key_mode, bars, duration_seconds, status, created_at, selected_at
             FROM compositions WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
          ).bind(channelId, boundedLimit);
      const result = await statement.all();
      return (result?.results ?? []).map((row) => ({
        compositionId: row.composition_id,
        creatorId: row.creator_id,
        composer: row.composer,
        model: row.model,
        bpm: row.bpm,
        key: { root: row.key_root, mode: row.key_mode },
        bars: row.bars,
        durationSeconds: row.duration_seconds,
        status: row.status,
        createdAt: row.created_at,
        selectedAt: row.selected_at,
      }));
    } catch (error) {
      console.error("composition_library_read_failed", channelId, error?.message ?? String(error));
      return [];
    }
  }

  /**
   * Read one full canonical score for replay. Returns null if unknown; the
   * caller is responsible for enforcing channel scope against the returned
   * `channelId` before handing the score back to a client.
   */
  async readCompositionScore(compositionId) {
    if (!this.env.DB) return null;
    try {
      const row = await this.env.DB.prepare(
        `SELECT channel_id, score_json, status, created_at, selected_at FROM compositions WHERE composition_id = ?`,
      )
        .bind(compositionId)
        .first();
      if (!row) return null;
      return {
        channelId: row.channel_id,
        score: JSON.parse(row.score_json),
        status: row.status,
        createdAt: row.created_at,
        selectedAt: row.selected_at,
      };
    } catch (error) {
      console.error("composition_library_read_failed", compositionId, error?.message ?? String(error));
      return null;
    }
  }

  async ensureCompositionClock(state, now = Date.now()) {
    if (!state.currentComposition || state.currentCompositionStartedAt) return state;
    const record = await this.readCompositionScore(state.currentComposition.compositionId);
    const selectedAt = record?.selectedAt;
    const startedAt = selectedAt && Number.isFinite(new Date(selectedAt).getTime())
      ? selectedAt
      : new Date(now).toISOString();
    return { ...state, currentCompositionStartedAt: startedAt };
  }

  async rejoinCompositionPlayback(state, now = Date.now()) {
    let next = await this.ensureCompositionClock(state, now);
    let changed = next !== state;
    let playback = currentCompositionPlayback(next, now);
    let advanced = false;
    let selected = null;
    if (playback.ended && compositionBufferCount(next) > 0) {
      const selection = selectNextComposition(next, { now });
      selected = selection.selected;
      next = selection.state;
      playback = currentCompositionPlayback(next, now);
      advanced = true;
      changed = true;
    }
    if (changed) await this.persist(next);
    if (selected) await this.markCompositionSelected(selected.compositionId, now);
    return { state: next, playback, advanced };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const channelId = request.headers.get("x-channel-id");
    const creatorId = request.headers.get("x-creator-id");

    try {
      if (!channelId) throw new Error("channel_id_required");

      if (request.method === "GET" && url.pathname === "/ws") {
        const state = await this.load(channelId, creatorId);
        assertChannelOwner(state, creatorId);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.send(JSON.stringify({ type: "channel_state", state: publicState(state) }));
        return new Response(null, { status: 101, webSocket: client });
      }

      if (request.method === "POST" && url.pathname === "/init") {
        const body = (await readJson(request)) ?? {};
        const requestedCreatorId = body.creatorId ?? creatorId;
        let state = await this.load(channelId, requestedCreatorId);
        assertChannelOwner(state, requestedCreatorId);
        if (body.policy) {
          state = updateChannelPolicy(state, { ...body.policy, provider: MUSIC_PROVIDERS.FIXTURE, credentialRef: null });
          await this.persist(state);
        }
        await this.writeChannelMetadata(state);
        return json({ ok: true, state: publicState(state) }, { status: 201 });
      }

      const state = await this.load(channelId, creatorId);
      assertChannelOwner(state, creatorId);

      if (request.method === "GET" && url.pathname === "/state") {
        return json({ ok: true, state: publicState(state) });
      }

      if (request.method === "POST" && url.pathname === "/playback/rejoin") {
        const rejoined = await this.runCompositionMutation(async () => {
          const freshState = await this.load(channelId, creatorId);
          assertChannelOwner(freshState, creatorId);
          return this.rejoinCompositionPlayback(freshState);
        });
        return json({
          ok: true,
          advanced: rejoined.advanced,
          playback: publicPlayback(rejoined.playback),
          state: publicState(rejoined.state),
        });
      }

      if (request.method === "POST" && url.pathname === "/provider") {
        const body = (await readJson(request)) ?? {};
        const provider = body.provider ?? MUSIC_PROVIDERS.FIXTURE;
        let credentialRef = null;
        if (provider !== MUSIC_PROVIDERS.FIXTURE) {
          const rawKey = request.headers.get("x-provider-key");
          if (!rawKey) throw new Error("provider_key_required");
          credentialRef = await credentialRefFor(provider, rawKey);
        }
        const next = updateChannelPolicy(state, {
          provider,
          model: body.model,
          credentialRef,
          generationCapPerHour: body.generationCapPerHour,
          generationCapPerDay: body.generationCapPerDay,
          bufferTargetSeconds: body.bufferTargetSeconds,
        });
        await this.persist(next);
        await this.writeChannelMetadata(next);
        return json({ ok: true, policy: next.policy });
      }

      if (request.method === "POST" && url.pathname === "/prompts") {
        const body = (await readJson(request)) ?? {};
        const result = submitPrompt(state, body);
        await this.persist(result.state);
        await this.writePrompt(result.prompt);
        return json(
          { ok: true, deduped: result.deduped, prompt: result.prompt },
          { status: result.deduped ? 200 : 202 },
        );
      }

      if (request.method === "POST" && url.pathname === "/generation/next") {
        if (state.policy.provider === MUSIC_PROVIDERS.FIXTURE) throw new Error("real_provider_required");
        const rawKey = request.headers.get("x-provider-key");
        if (!rawKey) throw new Error("provider_key_required");
        const expectedRef = await credentialRefFor(state.policy.provider, rawKey);
        if (expectedRef !== state.policy.credentialRef) throw new Error("credential_scope_violation");
        assertProviderReady(state);
        const selectedResult = selectNextPrompt(state);
        if (!selectedResult.selected) throw new Error("prompt_queue_empty");
        const body = (await readJson(request)) ?? {};
        const scheduled = createGenerationJob(selectedResult.state, selectedResult.selected, {
          credentialRef: state.policy.credentialRef,
        });
        const runningState = markGenerationRunning(scheduled.state, scheduled.job.id);
        await this.persist(runningState);
        try {
          const generated = await this.generateWithProvider(
            runningState,
            selectedResult.selected,
            rawKey,
            body.durationSeconds ?? 30,
          );
          const extension = generated.contentType === "audio/wav" ? "wav" : "audio";
          const assetKey = channelAssetKey(state.channelId, `generated/${scheduled.job.id}.${extension}`);
          await this.env.ASSETS.put(assetKey, generated.bytes, {
            httpMetadata: { contentType: generated.contentType || "audio/wav" },
            customMetadata: {
              schema: "infinite-radio-generated-v1",
              channel_id: state.channelId,
              generation_id: scheduled.job.id,
              prompt_id: scheduled.job.promptId,
              provider: scheduled.job.provider,
              model: scheduled.job.model,
            },
          });
          const receiptId = `receipt:${scheduled.job.id}`;
          const completed = completeMusicGeneration(runningState, scheduled.job.id, {
            assetKey,
            durationSeconds: generated.durationSeconds,
            contentType: generated.contentType || "audio/wav",
            receiptId,
          });
          await this.persist(completed.state);
          await this.writeProviderArtifact({
            job: scheduled.job,
            track: completed.track,
            receipt: {
              receiptId,
              providerRequestId: generated.providerRequestId,
              latencyMs: generated.latencyMs,
              costMicrousd: generated.costMicrousd,
              provenance: generated.provenance,
            },
          });
          return json({
            ok: true,
            generation_id: scheduled.job.id,
            track: completed.track,
            receipt: {
              receipt_id: receiptId,
              provider_request_id: generated.providerRequestId,
              latency_ms: generated.latencyMs,
              cost_microusd: generated.costMicrousd,
              provenance: generated.provenance,
            },
            state: publicState(completed.state),
          }, { status: 201 });
        } catch (error) {
          const errorCode = safeProviderErrorCode(error);
          const failed = failGeneration(runningState, scheduled.job.id, errorCode);
          const retryable = {
            ...failed,
            promptQueue: [selectedResult.selected, ...failed.promptQueue],
          };
          await this.persist(retryable);
          await this.writeGenerationFailure(scheduled.job, errorCode);
          throw new Error(errorCode);
        }
      }

      if (request.method === "POST" && url.pathname === "/conductor/tick") {
        if (state.policy.provider !== MUSIC_PROVIDERS.FIXTURE) throw new Error("fixture_provider_required");
        const body = (await readJson(request)) ?? {};
        const result = ensureFixtureBuffer(state, {
          durationSeconds: body.durationSeconds,
          maxTracks: body.maxTracks,
        });
        await this.persist(result.state);
        await this.writeFixtureArtifacts(result.created);
        return json({
          ok: true,
          created: result.created.map(({ prompt, job, track }) => ({
            prompt_id: prompt.id,
            generation_id: job.id,
            track_id: track.id,
            asset_key: track.assetKey,
          })),
          state: publicState(result.state),
        });
      }

      if (request.method === "POST" && url.pathname === "/playback/next") {
        const result = chooseNextPlayable(state);
        await this.persist(result.state);
        return json({
          ok: true,
          source: result.source,
          track: result.track,
          state: publicState(result.state),
        });
      }

      if (request.method === "POST" && url.pathname === "/score/prebuffer") {
        const body = (await readJson(request)) ?? {};
        const prebuffered = await this.runCompositionMutation(async () => {
          let freshState = await this.load(channelId, creatorId);
          assertChannelOwner(freshState, creatorId);
          const previousBufferedCompositionId = freshState.compositionQueue[0]?.compositionId ?? null;
          const replaceFuture = body.replace === true && compositionBufferCount(freshState) >= 1;
          if (compositionBufferCount(freshState) >= 1 && !replaceFuture) {
            return { created: false, replaced: false, previousBufferedCompositionId, result: null, state: freshState };
          }
          if (replaceFuture) {
            freshState = { ...freshState, compositionQueue: [] };
          }
          const context = buildComposerContext(freshState, body.listenerIntent ?? {});
          const result = await composeChannelScore(this.env, { channelId: freshState.channelId, creatorId: freshState.creatorId }, context, {
            model: body.model,
          });
          freshState = queueComposition(freshState, result.score);
          await this.persist(freshState);
          const libraryWrite = await this.writeCompositionRecord(result.score, "buffered");
          return { created: true, replaced: replaceFuture, previousBufferedCompositionId, result, state: freshState, libraryWrite };
        });
        return json(
          {
            ok: true,
            created: prebuffered.created,
            replaced: prebuffered.replaced,
            previous_buffered_composition_id: prebuffered.previousBufferedCompositionId,
            source: prebuffered.result?.source ?? null,
            fell_back: prebuffered.result?.fellBack ?? false,
            fallback_reason: prebuffered.result?.fallbackReason ?? null,
            buffered_composition_id: prebuffered.state.compositionQueue[0]?.compositionId ?? null,
            composition_buffer_count: compositionBufferCount(prebuffered.state),
            library_persisted: prebuffered.libraryWrite?.persisted ?? false,
            state: publicState(prebuffered.state),
          },
          { status: prebuffered.created ? 201 : 200 },
        );
      }

      if (request.method === "POST" && url.pathname === "/score/next") {
        const body = (await readJson(request)) ?? {};
        const generated = await this.runCompositionMutation(async () => {
          let freshState = await this.load(channelId, creatorId);
          assertChannelOwner(freshState, creatorId);
          const context = buildComposerContext(freshState, body.listenerIntent ?? {});
          const result = await composeChannelScore(this.env, { channelId: freshState.channelId, creatorId: freshState.creatorId }, context, {
            model: body.model,
          });
          freshState = queueComposition(freshState, result.score);
          await this.persist(freshState);
          const libraryWrite = await this.writeCompositionRecord(result.score, "buffered");
          return { result, state: freshState, libraryWrite };
        });
        return json(
          {
            ok: true,
            source: generated.result.source,
            fell_back: generated.result.fellBack,
            fallback_reason: generated.result.fallbackReason,
            score: generated.result.score,
            composition_buffer_count: compositionBufferCount(generated.state),
            library_persisted: generated.libraryWrite?.persisted ?? false,
            state: publicState(generated.state),
          },
          { status: 201 },
        );
      }

      if (request.method === "POST" && url.pathname === "/score/select") {
        const selection = await this.runCompositionMutation(async () => {
          const freshState = await this.load(channelId, creatorId);
          assertChannelOwner(freshState, creatorId);
          const now = Date.now();
          const next = selectNextComposition(freshState, { now });
          if (!next.selected) throw new Error("composition_queue_empty");
          await this.persist(next.state);
          await this.markCompositionSelected(next.selected.compositionId, now);
          return next;
        });
        return json({
          ok: true,
          score: selection.selected,
          playback: publicPlayback(currentCompositionPlayback(selection.state)),
          composition_buffer_count: compositionBufferCount(selection.state),
          state: publicState(selection.state),
        });
      }

      if (request.method === "GET" && url.pathname === "/score/library") {
        const limitParam = url.searchParams.get("limit");
        const before = url.searchParams.get("before");
        const entries = await this.readCompositionLibrary(state.channelId, {
          limit: limitParam === null ? undefined : Number(limitParam),
          before,
        });
        return json({
          ok: true,
          channel_id: state.channelId,
          entries,
          count: entries.length,
        });
      }

      const libraryEntryMatch = url.pathname.match(/^\/score\/library\/([^/]+)$/);
      if (request.method === "GET" && libraryEntryMatch) {
        const compositionId = decodeURIComponent(libraryEntryMatch[1]);
        const record = await this.readCompositionScore(compositionId);
        if (!record) return json({ ok: false, error: "composition_not_found" }, { status: 404 });
        if (record.channelId !== state.channelId) throw new Error("channel_scope_violation");
        return json({
          ok: true,
          score: record.score,
          status: record.status,
          created_at: record.createdAt,
          selected_at: record.selectedAt,
        });
      }

      if (request.method === "POST" && url.pathname === "/brief") {
        const body = (await readJson(request)) ?? {};
        const compiled = await compileControlBrief(this.env.AI, state, body.prompt ?? null);
        return json({
          ok: true,
          ...compiled,
          workers_ai_available: Boolean(this.env.AI),
        });
      }

      return json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }
}

function publicPlayback(playback) {
  return {
    composition_id: playback.compositionId,
    started_at: playback.startedAt,
    position_seconds: playback.positionSeconds,
    duration_seconds: playback.durationSeconds,
    ended: playback.ended,
  };
}

function publicState(state) {
  const playback = currentCompositionPlayback(state);
  return {
    schemaVersion: state.schemaVersion,
    channelId: state.channelId,
    creatorId: state.creatorId,
    mode: state.mode,
    status: state.status,
    currentTrack: state.currentTrack,
    readyQueue: state.readyQueue,
    compositionQueue: state.compositionQueue,
    currentComposition: state.currentComposition ?? null,
    currentCompositionStartedAt: playback.startedAt,
    currentCompositionPositionSeconds: playback.positionSeconds,
    currentCompositionEnded: playback.ended,
    lastCompositionId: state.lastCompositionId,
    lastTransitionHint: state.lastTransitionHint,
    promptQueue: state.promptQueue,
    generationJobs: state.generationJobs,
    generationWindow: state.generationWindow,
    generationDayWindow: state.generationDayWindow,
    providerHealth: state.providerHealth,
    archive: state.archive,
    policy: state.policy,
    bible: state.bible,
    counters: state.counters,
    readyBufferSeconds: readyBufferSeconds(state),
  };
}

async function proxyChannelRequest(request, env, route) {
  if (!env.CHANNEL_CONDUCTOR) {
    return json({ ok: false, error: "channel_conductor_unbound" }, { status: 503 });
  }
  const id = env.CHANNEL_CONDUCTOR.idFromName(route.channelId);
  const stub = env.CHANNEL_CONDUCTOR.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-channel-id", route.channelId);
  const forwarded = new Request(`https://channel.internal${route.tail}${new URL(request.url).search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  return stub.fetch(forwarded);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "infinite-radio",
        version: "0.3.1",
        runtime: "structured-composition-browser-synth",
        bindings: {
          channelConductor: Boolean(env.CHANNEL_CONDUCTOR),
          d1: Boolean(env.DB),
          r2: Boolean(env.ASSETS),
          workersAI: Boolean(env.AI),
        },
        musicProviders: [MUSIC_PROVIDERS.FIXTURE, MUSIC_PROVIDERS.FAL_CASSETTEAI, MUSIC_PROVIDERS.FAL_STABLE_AUDIO],
      });
    }

    const route = channelRoute(url.pathname);
    if (route) return proxyChannelRequest(request, env, route);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        `<!doctype html>
<html lang="en" data-step="v0.4-step-2">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#08080d">
  <title>Infinite Radio · Visual Station</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f7f7fb;background:#08080d;color-scheme:dark}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0%,#202038 0,#0d0d16 34%,#08080d 68%);color:#f7f7fb}
    button,input{font:inherit} button{border:0;cursor:pointer} button:disabled{cursor:not-allowed;opacity:.42}
    .shell{min-height:100dvh;display:grid;grid-template-rows:auto auto 1fr auto;max-width:1180px;margin:0 auto;padding:env(safe-area-inset-top) 14px env(safe-area-inset-bottom)}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 2px 10px}
    .brand{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.live-dot{width:9px;height:9px;border-radius:50%;background:#74f0a7;box-shadow:0 0 18px #74f0a7}
    .version{font-size:11px;color:#9d9daf;border:1px solid #2c2c3b;border-radius:999px;padding:6px 9px;background:#11111a}
    .setup{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;padding:10px;border:1px solid #242433;background:#101019cc;border-radius:18px;backdrop-filter:blur(18px)}
    .setup input{min-width:0;border:1px solid #2c2c3b;background:#090911;color:#fff;padding:11px 12px;border-radius:12px;outline:none}.setup input:focus{border-color:#7777a8}
    .primary{background:#f4f4ff;color:#0b0b11;border-radius:12px;padding:11px 15px;font-weight:800}.secondary{background:#1a1a27;color:#f7f7fb;border:1px solid #303044;border-radius:12px;padding:10px 14px;font-weight:750}
    main{min-height:0;display:grid;grid-template-rows:auto auto minmax(320px,1fr) auto;gap:12px;padding:12px 0}
    .now{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}.eyebrow{font-size:11px;color:#9b9bab;text-transform:uppercase;letter-spacing:.12em}.title{font-size:clamp(23px,7vw,44px);line-height:1.05;margin:4px 0 7px;font-weight:850;letter-spacing:-.04em}.meta{font-size:13px;color:#a8a8b9;display:flex;flex-wrap:wrap;gap:8px 14px}
    .chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.chip{font-size:10px;border:1px solid #2c2c3b;background:#11111b;color:#b8b8c8;border-radius:999px;padding:6px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip.good{color:#8df2b4;border-color:#29563b}.chip.warn{color:#ffd28b;border-color:#5d4728}
    .canvas-wrap{position:relative;min-height:280px;border:1px solid #242433;border-radius:24px;overflow:hidden;background:linear-gradient(180deg,#10101a,#090911);box-shadow:0 28px 70px #0007}.canvas-wrap:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 70% 20%,#6c63ff16,transparent 38%);pointer-events:none} canvas{width:100%;height:100%;display:block;min-height:280px}.empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:32px;color:#88889c}.empty strong{display:block;color:#e7e7ef;font-size:18px;margin-bottom:6px}
    .transport{position:sticky;bottom:0;z-index:5;margin:0 -14px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(180deg,#08080d00,#08080df5 20%,#08080d);backdrop-filter:blur(16px)}
    .transport-card{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;border:1px solid #292938;background:#11111bd9;border-radius:18px;padding:10px}.controls{display:flex;gap:7px}.round{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#f2f2fb;color:#0b0b11;font-weight:900}.round.alt{background:#20202d;color:#f2f2fb;border:1px solid #333345}.timeline{min-width:0}.progress{height:5px;background:#2a2a38;border-radius:999px;overflow:hidden}.progress>span{display:block;width:0;height:100%;background:#f1f1fb}.time{margin-top:6px;font-size:11px;color:#9090a3;display:flex;justify-content:space-between;gap:8px}.actions{display:flex;gap:7px;align-items:center}.status{font-size:11px;color:#9999ac;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .modebar{display:flex;align-items:center;justify-content:space-between;gap:9px}.modebar-actions{display:flex;gap:6px}.tabs{display:flex;gap:5px;padding:4px;border:1px solid #292938;background:#101019;border-radius:14px}.tab{padding:8px 12px;border-radius:10px;background:transparent;color:#8f8fa3;font-weight:800;font-size:12px}.tab.active{background:#272738;color:#fff}.steer{background:#202034;color:#dcdcff;border:1px solid #3b3b58;border-radius:12px;padding:9px 12px;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}.metric{border:1px solid #242433;background:#0e0e17;border-radius:11px;padding:8px 9px;min-width:0}.metric b{display:block;font-size:11px}.metric span{display:block;margin-top:2px;font-size:10px;color:#8e8ea2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sheet-backdrop{position:fixed;inset:0;background:#0008;z-index:20;opacity:0;pointer-events:none;transition:opacity .18s}.sheet-backdrop.open{opacity:1;pointer-events:auto}.sheet{position:fixed;z-index:21;left:50%;bottom:0;width:min(680px,100%);max-height:86dvh;overflow:auto;transform:translate(-50%,105%);transition:transform .22s ease;border:1px solid #303046;border-bottom:0;background:#12121ded;border-radius:24px 24px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));backdrop-filter:blur(24px);box-shadow:0 -28px 80px #0009}.sheet.open{transform:translate(-50%,0)}.sheet-head{display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:12px}.sheet h2{font-size:20px;margin:0}.sheet p{font-size:12px;color:#9999aa;margin:5px 0 0}.steer-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.steer-row{border:1px solid #29293a;background:#0d0d16;border-radius:14px;padding:11px}.steer-row label{display:flex;justify-content:space-between;gap:10px;font-size:12px;font-weight:750}.steer-row input{width:100%;margin-top:10px}.sheet-actions{display:flex;gap:8px;margin-top:14px}.sheet-actions button{flex:1}.ghost{background:#20202c;color:#ddd;border:1px solid #363646;border-radius:12px;padding:11px 14px;font-weight:800}
    .library-list{display:flex;flex-direction:column;gap:8px;max-height:52dvh;overflow:auto}.library-empty{padding:20px 4px;color:#8e8ea2;font-size:13px;text-align:center}.library-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #29293a;background:#0d0d16;border-radius:14px;padding:11px 12px}.library-row-info{min-width:0}.library-row-title{font-weight:800;font-size:13px;color:#f0f0fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52vw}.library-row-meta{margin-top:3px;font-size:11px;color:#9595a8;display:flex;flex-wrap:wrap;gap:6px 10px}.library-row-meta .status-selected{color:#8df2b4}.library-row button{flex-shrink:0}
    @media(max-width:700px){.shell{padding-left:10px;padding-right:10px}.setup{grid-template-columns:1fr 1fr}.setup button{grid-column:1/-1}.now{grid-template-columns:1fr}.chips{justify-content:flex-start}.transport{margin-left:-10px;margin-right:-10px;padding-left:10px;padding-right:10px}.transport-card{grid-template-columns:auto 1fr}.actions{grid-column:1/-1;justify-content:space-between}.status{max-width:58vw}.title{font-size:30px}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.steer-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar"><div class="brand"><span class="live-dot"></span>Infinite Radio</div><div class="version">V0.4 · VISUAL STATION</div></header>
    <section class="setup" aria-label="Channel connection"><input id="channel" autocomplete="off" aria-label="Channel ID" placeholder="channel id"><input id="creator" autocomplete="off" aria-label="Creator ID" placeholder="creator id"><button id="connect" class="primary">Open channel</button></section>
    <main>
      <section class="now"><div><div class="eyebrow">Now playing</div><div id="score-title" class="title">No score loaded</div><div id="score-meta" class="meta"><span>Validated infinite-radio-score-v1</span></div></div><div class="chips"><span id="schema-chip" class="chip">schema · waiting</span><span id="source-chip" class="chip">source · waiting</span><span id="provenance-chip" class="chip">composer · waiting</span><span id="audio-chip" class="chip warn">audio · tap play</span><span id="buffer-chip" class="chip">buffer · empty</span><button id="return-live" class="secondary" hidden>Back to live</button></div></section>
      <div class="modebar"><div class="tabs" role="tablist" aria-label="Station projection"><button class="tab active" data-view="visual">Visual</button><button class="tab" data-view="score">Score</button></div><div class="modebar-actions"><button id="library-open" class="steer" disabled>Library</button><button id="steer-open" class="steer" disabled>Steer next</button></div></div>
      <section class="canvas-wrap" aria-label="Read-only station projection"><canvas id="score-canvas"></canvas><div id="empty" class="empty"><div><strong>Open a channel to begin</strong>Visual and Score are read-only views of one canonical score. Editing starts in V0.5.</div></div></section>
      <div id="metrics" class="metrics" aria-label="Current score presentation metrics"><div class="metric"><b>Energy</b><span id="metric-energy">—</span></div><div class="metric"><b>Density</b><span id="metric-density">—</span></div><div class="metric"><b>Brightness</b><span id="metric-brightness">—</span></div><div class="metric"><b>Space</b><span id="metric-space">—</span></div><div class="metric"><b>Harmony</b><span id="metric-harmony">—</span></div></div>
    </main>
    <div id="sheet-backdrop" class="sheet-backdrop"></div><aside id="library-sheet" class="sheet" aria-label="Composition library"><div class="sheet-head"><div><h2>Library · Recent</h2><p>Prior compositions for this channel, newest first. Replaying one is read-only and never changes what the live station plays next.</p></div><button id="library-close" class="ghost" aria-label="Close library">×</button></div><div id="library-list" class="library-list"><div class="library-empty">Open a channel to see its library.</div></div><div class="sheet-actions"><button id="library-cancel" class="ghost">Close</button></div></aside><aside id="steer-sheet" class="sheet" aria-label="Steer next composition"><div class="sheet-head"><div><h2>Steer the next composition</h2><p>These controls replace only the buffered future score. The score playing now is never edited.</p></div><button id="steer-close" class="ghost" aria-label="Close steering">×</button></div><div class="steer-grid"><div class="steer-row"><label>Energy <span id="steer-energy-value">60</span></label><input data-steer="energy" type="range" min="0" max="100" value="60"></div><div class="steer-row"><label>Tempo <span id="steer-tempo-value">55</span></label><input data-steer="tempo" type="range" min="0" max="100" value="55"></div><div class="steer-row"><label>Brightness <span id="steer-brightness-value">55</span></label><input data-steer="brightness" type="range" min="0" max="100" value="55"></div><div class="steer-row"><label>Density <span id="steer-density-value">50</span></label><input data-steer="density" type="range" min="0" max="100" value="50"></div><div class="steer-row"><label>Space <span id="steer-space-value">55</span></label><input data-steer="space" type="range" min="0" max="100" value="55"></div><div class="steer-row"><label>Harmonic tension <span id="steer-tension-value">40</span></label><input data-steer="tension" type="range" min="0" max="100" value="40"></div></div><div class="sheet-actions"><button id="steer-cancel" class="ghost">Cancel</button><button id="steer-apply" class="primary">Shape the next score</button></div></aside>
    <footer class="transport"><div class="transport-card"><div class="controls"><button id="play" class="round" disabled aria-label="Play">▶</button><button id="pause" class="round alt" disabled aria-label="Pause">Ⅱ</button><button id="stop" class="round alt" disabled aria-label="Stop">■</button></div><div class="timeline"><div class="progress"><span id="progress"></span></div><div class="time"><span id="position">0:00</span><span id="duration">0:00</span></div></div><div class="actions"><span id="status" class="status">Ready</span><button id="next" class="secondary" disabled>Buffer next</button></div></div></footer>
  </div>
  <script>
    "use strict";
    const SCORE_SCHEMA="infinite-radio-score-v1";
    const SYNTH=new Set(["sine_lead","triangle_lead","square_lead","saw_lead","sine_pad","triangle_pad","saw_pad","sub_bass","saw_bass","pluck"]);
    const DRUMS=new Set(["kick","snare","hat_closed","hat_open","noise_perc"]);
    const EFFECTS=new Set(["filter_lowpass","filter_highpass","delay","reverb_short","pan"]);
    const FIFTHS=["C","G","D","A","E","B","F#","C#","G#","D#","A#","F"];
    const PITCH_CLASS={C:0,"C#":1,D:2,"D#":3,E:4,F:5,"F#":6,G:7,"G#":8,A:9,"A#":10,B:11};
    const SCALE_INTERVALS={major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],dorian:[0,2,3,5,7,9,10],mixolydian:[0,2,4,5,7,9,10],lydian:[0,2,4,6,7,9,11],phrygian:[0,1,3,5,7,8,10]};
    const $=id=>document.getElementById(id);
    function clamp(value,min,max){return Math.max(min,Math.min(max,value));}
    function fmt(seconds){const value=Math.max(0,Number(seconds)||0);return Math.floor(value/60)+":"+String(Math.floor(value%60)).padStart(2,"0");}
    function deepFreeze(value){if(!value||typeof value!=="object"||Object.isFrozen(value))return value;Object.freeze(value);Object.values(value).forEach(deepFreeze);return value;}
    function assertPlayableScore(score){
      if(!score||score.schemaVersion!==SCORE_SCHEMA)throw new Error("unsupported_score_schema");
      if(!Number.isFinite(score.bpm)||score.bpm<40||score.bpm>220)throw new Error("invalid_score_bpm");
      if(!Number.isFinite(score.durationSeconds)||score.durationSeconds<=0||score.durationSeconds>480)throw new Error("invalid_score_duration");
      if(!Array.isArray(score.tracks)||score.tracks.length<1||score.tracks.length>12)throw new Error("invalid_score_tracks");
      score.tracks.forEach(track=>{if(track.isDrumTrack){if(track.patch!=="drum_kit")throw new Error("invalid_drum_track");(track.drumEvents||[]).forEach(event=>{if(!DRUMS.has(event.patch))throw new Error("invalid_drum_patch");});}else if(!SYNTH.has(track.patch))throw new Error("invalid_synth_patch");(track.effects||[]).forEach(effect=>{if(!EFFECTS.has(effect.type))throw new Error("invalid_effect_type");});});
      return score;
    }
    function configurePlaybackAudioSession(){try{if(navigator.audioSession&&"type" in navigator.audioSession){navigator.audioSession.type="playback";return navigator.audioSession.type||"playback";}}catch{}return "default";}
    class ScoreRenderer{
      constructor(){this.Context=globalThis.AudioContext||globalThis.webkitAudioContext;this.ctx=null;this.master=null;this.score=null;this.voices=new Set();this.state="idle";this.pausedAt=0;this.startedAt=0;this.endTimer=null;this.audioSessionType="default";}
      ensureMaster(){if(!this.ctx)throw new Error("audio_context_missing");if(!this.master||this.master.context!==this.ctx){try{this.master&&this.master.disconnect();}catch{}this.master=this.ctx.createGain();this.master.gain.value=.5;this.master.connect(this.ctx.destination);}return this.master;}
      createContext(){if(!this.Context)throw new Error("webaudio_unavailable");this.audioSessionType=configurePlaybackAudioSession();this.ctx=new this.Context();this.ensureMaster();this.ctx.onstatechange=()=>window.dispatchEvent(new CustomEvent("infinite-radio-audio-state",{detail:{state:this.ctx.state,sessionType:this.audioSessionType}}));return this.ctx;}
      adoptContext(sharedContext){if(!sharedContext||sharedContext.state==="closed")throw new Error("shared_audio_context_unavailable");this.ctx=sharedContext;this.audioSessionType=configurePlaybackAudioSession();this.ensureMaster();return this.ctx;}
      async ensureContext(){if(!this.Context)throw new Error("webaudio_unavailable");this.audioSessionType=configurePlaybackAudioSession();if(!this.ctx||this.ctx.state==="closed")this.createContext();this.ensureMaster();if(this.ctx.state!=="running"){try{await this.ctx.resume();}catch{}}if(this.ctx.state!=="running")throw new Error("audio_context_"+String(this.ctx.state||"unknown"));return this.ctx;}
      rampMasterTo(value,seconds=0){this.ensureMaster();const now=this.ctx.currentTime,target=clamp(Number(value)||0,0,1.5),duration=Math.max(0,Number(seconds)||0),gain=this.master.gain;gain.cancelScheduledValues(now);gain.setValueAtTime(gain.value,now);if(duration>0)gain.linearRampToValueAtTime(target,now+duration);else gain.setValueAtTime(target,now);}
      dispose(){this.stop();try{this.master&&this.master.disconnect();}catch{}this.master=null;this.score=null;}
      async unlockFromGesture(){await this.ensureContext();const buffer=this.ctx.createBuffer(1,1,this.ctx.sampleRate),source=this.ctx.createBufferSource();source.buffer=buffer;source.connect(this.master);source.start(0);return this.ctx.state;}
      load(score){this.stop();this.score=assertPlayableScore(score);this.state="ready";return this.score;}
      get duration(){return this.score?this.score.durationSeconds:0;}
      get position(){if(!this.score)return 0;if(this.state==="playing"&&this.ctx)return clamp(this.pausedAt+(this.ctx.currentTime-this.startedAt),0,this.duration);return clamp(this.pausedAt,0,this.duration);}
      seek(seconds){if(!this.score)throw new Error("score_not_loaded");if(this.state==="playing")this.pause();this.pausedAt=clamp(Number(seconds)||0,0,this.duration);if(this.state==="ended"&&this.pausedAt<this.duration-.02)this.state="paused";return this.pausedAt;}
      async play(){if(!this.score)throw new Error("score_not_loaded");await this.ensureContext();if(this.state==="playing")return;if(this.pausedAt>=this.duration-.02)this.pausedAt=0;this.stopVoices();const offset=this.pausedAt;this.startedAt=this.ctx.currentTime;this.scheduleScore(offset);this.state="playing";clearTimeout(this.endTimer);this.endTimer=setTimeout(()=>{this.stopVoices();this.pausedAt=this.duration;this.state="ended";},Math.max(0,(this.duration-offset)*1000+80));}
      pause(){if(this.state!=="playing")return;const position=this.position;this.stopVoices();clearTimeout(this.endTimer);this.pausedAt=position;this.state="paused";}
      stop(){this.stopVoices();clearTimeout(this.endTimer);this.pausedAt=0;if(this.score)this.state="ready";else this.state="idle";}
      stopVoices(){this.voices.forEach(source=>{try{source.stop();}catch{}});this.voices.clear();}
      trackSource(source){this.voices.add(source);source.onended=()=>this.voices.delete(source);}
      midi(pitch){return 440*Math.pow(2,(pitch-69)/12);}
      noiseBuffer(seconds,seed){const length=Math.max(1,Math.floor(this.ctx.sampleRate*seconds));const buffer=this.ctx.createBuffer(1,length,this.ctx.sampleRate);const data=buffer.getChannelData(0);let s=(seed>>>0)||1;for(let i=0;i<length;i+=1){s=(1664525*s+1013904223)>>>0;data[i]=(s/4294967296)*2-1;}return buffer;}
      createTrackChain(track){let current=this.ctx.createGain();const input=current;input.gain.value=clamp(Number(track.gain)||.8,0,1.5);if(this.ctx.createStereoPanner){const pan=this.ctx.createStereoPanner();pan.pan.value=clamp(Number(track.pan)||0,-1,1);current.connect(pan);current=pan;}(track.effects||[]).forEach(effect=>{const amount=clamp(Number(effect.amount)||0,0,1);if(effect.type==="filter_lowpass"||effect.type==="filter_highpass"){const filter=this.ctx.createBiquadFilter();filter.type=effect.type==="filter_lowpass"?"lowpass":"highpass";filter.frequency.value=effect.type==="filter_lowpass"?16000-amount*14500:30+amount*3000;current.connect(filter);current=filter;}else if(effect.type==="delay"){const mix=this.ctx.createGain(),delay=this.ctx.createDelay(.8),feedback=this.ctx.createGain();delay.delayTime.value=.08+amount*.32;feedback.gain.value=amount*.28;current.connect(mix);current.connect(delay);delay.connect(feedback);feedback.connect(delay);delay.connect(mix);current=mix;}else if(effect.type==="reverb_short"){const mix=this.ctx.createGain(),verb=this.ctx.createConvolver();verb.buffer=this.noiseBuffer(.12+amount*.38,Math.floor(amount*10000)+17);current.connect(mix);current.connect(verb);verb.connect(mix);current=mix;}else if(effect.type==="pan"&&this.ctx.createStereoPanner){const pan=this.ctx.createStereoPanner();pan.pan.value=amount*2-1;current.connect(pan);current=pan;}});current.connect(this.master);return input;}
      scheduleScore(offset){const beatSeconds=60/this.score.bpm;this.score.tracks.forEach((track,trackIndex)=>{const output=this.createTrackChain(track);if(track.isDrumTrack)(track.drumEvents||[]).forEach((event,eventIndex)=>this.scheduleDrum(event,output,offset,beatSeconds,trackIndex*997+eventIndex));else (track.events||[]).forEach(event=>this.scheduleNote(event,track.patch,output,offset,beatSeconds));});}
      scheduleNote(event,patch,output,offset,beatSeconds){const eventStart=event.start*beatSeconds,eventEnd=(event.start+event.duration)*beatSeconds;if(eventEnd<=offset)return;const when=this.ctx.currentTime+Math.max(0,eventStart-offset);const remaining=Math.max(.02,eventEnd-Math.max(offset,eventStart));const osc=this.ctx.createOscillator(),amp=this.ctx.createGain();const types={sine_lead:"sine",triangle_lead:"triangle",square_lead:"square",saw_lead:"sawtooth",sine_pad:"sine",triangle_pad:"triangle",saw_pad:"sawtooth",sub_bass:"sine",saw_bass:"sawtooth",pluck:"triangle"};osc.type=types[patch]||"sine";osc.frequency.value=this.midi(event.pitch);amp.gain.setValueAtTime(.0001,when);amp.gain.linearRampToValueAtTime(clamp(event.velocity||.8,.01,1),when+Math.min(.03,remaining*.2));amp.gain.exponentialRampToValueAtTime(.0001,when+remaining);osc.connect(amp);amp.connect(output);this.trackSource(osc);osc.start(when);osc.stop(when+remaining+.03);}
      scheduleDrum(event,output,offset,beatSeconds,seed){const eventStart=event.start*beatSeconds;if(eventStart<offset-.02)return;const when=this.ctx.currentTime+Math.max(0,eventStart-offset),velocity=clamp(event.velocity||.8,.01,1);if(event.patch==="kick"){const osc=this.ctx.createOscillator(),amp=this.ctx.createGain();osc.type="sine";osc.frequency.setValueAtTime(145,when);osc.frequency.exponentialRampToValueAtTime(45,when+.14);amp.gain.setValueAtTime(velocity,when);amp.gain.exponentialRampToValueAtTime(.0001,when+.22);osc.connect(amp);amp.connect(output);this.trackSource(osc);osc.start(when);osc.stop(when+.24);return;}const duration=event.patch==="hat_closed"?.045:event.patch==="hat_open"?.17:.16;const noise=this.ctx.createBufferSource(),filter=this.ctx.createBiquadFilter(),amp=this.ctx.createGain();noise.buffer=this.noiseBuffer(duration,seed+Math.floor(event.start*1000));filter.type=event.patch.startsWith("hat")?"highpass":event.patch==="noise_perc"?"bandpass":"highpass";filter.frequency.value=event.patch.startsWith("hat")?6500:event.patch==="noise_perc"?1800:1100;amp.gain.setValueAtTime(velocity*(event.patch.startsWith("hat")?.42:.72),when);amp.gain.exponentialRampToValueAtTime(.0001,when+duration);noise.connect(filter);filter.connect(amp);amp.connect(output);this.trackSource(noise);noise.start(when);noise.stop(when+duration+.01);}
    }
    const CROSSFADE_SECONDS=4;
    const CROSSFADE_LEAD_SECONDS=4.5;
    let renderer=new ScoreRenderer();
    const canonicalState={score:null,source:null,fellBack:false,fallbackReason:null};
    const viewState={channelId:null,creatorId:null,connected:false,activeView:"visual",sheetOpen:false,libraryOpen:false,replaying:false,steering:{energy:60,tempo:55,brightness:55,density:50,space:55,tension:40}};
    const stationState={session:0,queuedCount:0,bufferedCompositionId:null,prebufferPromise:null,advanceInFlight:false,crossfadeInFlight:false,crossfadeOutgoing:null,crossfadeEpoch:0,crossfadeAttemptedCompositionId:null,autoAdvance:false,endedHandled:false};
    const params=new URLSearchParams(location.search);$("channel").value=params.get("channel")||"demo-radio";$("creator").value=params.get("creator")||"demo-creator";
    function setStatus(text){$("status").textContent=text;}
    function setAudioStatus(){const state=renderer.ctx&&renderer.ctx.state||"locked",session=renderer.audioSessionType||"default";$("audio-chip").textContent="audio · "+state+(session==="playback"?" · playback":"");$("audio-chip").className=state==="running"?"chip good":"chip warn";}
    function setControls(enabled){$("play").disabled=!enabled;$("pause").disabled=!enabled;$("stop").disabled=!enabled;}
    function setStationBuffer(count,compositionId=null){stationState.queuedCount=Math.max(0,Number(count)||0);stationState.bufferedCompositionId=stationState.queuedCount?compositionId:null;$("buffer-chip").textContent="buffer · "+(stationState.queuedCount?"next ready":"empty");$("buffer-chip").className=stationState.queuedCount?"chip good":"chip warn";}
    function settleCrossfade(){stationState.crossfadeEpoch+=1;const outgoing=stationState.crossfadeOutgoing;if(outgoing&&outgoing!==renderer)outgoing.dispose();stationState.crossfadeOutgoing=null;stationState.crossfadeInFlight=false;if(renderer.ctx&&renderer.ctx.state!=="closed")renderer.rampMasterTo(.5);}
    function stopAllDecks(){settleCrossfade();renderer.stop();}
    function steeringPrompt(){const s=viewState.steering;const word=(v,low,mid,high)=>v<34?low:v>66?high:mid;return ["Listener steering for the NEXT composition only.","Energy: "+word(s.energy,"calm","balanced","intense")+" ("+s.energy+"/100).","Tempo feel: "+word(s.tempo,"slower","mid-tempo","faster")+".","Brightness: "+word(s.brightness,"dark","balanced","bright")+".","Density: "+word(s.density,"sparse","balanced","dense")+".","Space: "+word(s.space,"dry","balanced","spacious")+".","Harmonic tension: "+word(s.tension,"stable","colorful","strange")+".","Preserve channel identity and make an original coherent transition."].join(" ");}
    function scoreMetrics(score){if(!score)return null;const notes=score.tracks.flatMap(track=>track.events||[]),events=score.tracks.reduce((sum,track)=>sum+(track.events||[]).length+(track.drumEvents||[]).length,0),sections=score.sections||[];const energy=clamp(sections.length?sections.reduce((sum,section)=>sum+(Number(section.energy)||Number(score.continuity&&score.continuity.energy)||.5),0)/sections.length:Number(score.continuity&&score.continuity.energy)||.5,0,1);const density=clamp(events/Math.max(1,score.bars*8),0,1);const brightness=notes.length?clamp(notes.reduce((sum,event)=>sum+clamp((event.pitch-36)/60,0,1),0)/notes.length,0,1):.5;const spatial=(score.tracks.flatMap(track=>track.effects||[]).filter(effect=>effect.type==="delay"||effect.type==="reverb_short"));const space=spatial.length?clamp(spatial.reduce((sum,effect)=>sum+(Number(effect.amount)||0),0)/spatial.length,0,1):0;const root=PITCH_CLASS[score.key.root]??0,scale=SCALE_INTERVALS[score.key.mode]||SCALE_INTERVALS.major;const tension=notes.length?clamp(notes.filter(event=>!scale.includes(((event.pitch%12)-root+12)%12)).length/notes.length,0,1):0;return {energy,density,brightness,space,tension,key:score.key.root+" "+score.key.mode};}
    function updateMetrics(){const m=scoreMetrics(canonicalState.score);[["metric-energy",m&&m.energy],["metric-density",m&&m.density],["metric-brightness",m&&m.brightness],["metric-space",m&&m.space]].forEach(([id,value])=>$(id).textContent=value==null?"—":Math.round(value*100)+"%");$("metric-harmony").textContent=m?m.key+" · "+Math.round(m.tension*100)+"% tension":"—";}
    function setProjection(name){viewState.activeView=name==="score"?"score":"visual";document.querySelectorAll("[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===viewState.activeView));draw();}
    function updateSheetBackdrop(){$("sheet-backdrop").classList.toggle("open",viewState.sheetOpen||viewState.libraryOpen);}
    function setSheet(open){viewState.sheetOpen=Boolean(open);$("steer-sheet").classList.toggle("open",viewState.sheetOpen);updateSheetBackdrop();}
    function fmtWhen(iso){try{const date=new Date(iso);return date.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" "+date.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});}catch{return iso||"";}}
    function setLibraryOpen(open){viewState.libraryOpen=Boolean(open);$("library-sheet").classList.toggle("open",viewState.libraryOpen);updateSheetBackdrop();if(viewState.libraryOpen)void loadLibraryList();}
    async function loadLibraryList(){const list=$("library-list");if(!viewState.connected){list.innerHTML="<div class=\"library-empty\">Open a channel to see its library.</div>";return;}list.innerHTML="<div class=\"library-empty\">Loading…</div>";try{const payload=await api("/score/library","GET");const entries=payload.entries||[];if(!entries.length){list.innerHTML="<div class=\"library-empty\">No compositions yet for this channel.</div>";return;}list.innerHTML="";entries.forEach(entry=>{const row=document.createElement("div");row.className="library-row";const info=document.createElement("div");info.className="library-row-info";const title=document.createElement("div");title.className="library-row-title";title.textContent=entry.compositionId;const meta=document.createElement("div");meta.className="library-row-meta";const statusSpan=document.createElement("span");statusSpan.textContent=entry.status;if(entry.status==="selected")statusSpan.className="status-selected";const keyLabel=(entry.key&&entry.key.root||"")+" "+(entry.key&&entry.key.mode||"");meta.append(statusSpan,document.createTextNode(" · "+(entry.composer||entry.model||"unknown")),document.createTextNode(" · "+entry.bpm+" BPM"),document.createTextNode(" · "+keyLabel),document.createTextNode(" · "+fmt(entry.durationSeconds)),document.createTextNode(" · "+fmtWhen(entry.createdAt)));info.append(title,meta);const button=document.createElement("button");button.className="secondary";button.textContent="Replay";button.addEventListener("click",()=>replayComposition(entry.compositionId));row.append(info,button);list.appendChild(row);});}catch(error){list.innerHTML="<div class=\"library-empty\">"+error.message+"</div>";}}
    async function replayComposition(compositionId){try{setStatus("Loading library composition…");const payload=await api("/score/library/"+encodeURIComponent(compositionId),"GET");viewState.replaying=true;stationState.autoAdvance=false;stationState.endedHandled=false;stopAllDecks();loadScore(payload.score,{source:"library replay"});$("return-live").hidden=false;setLibraryOpen(false);setStatus("Replaying "+compositionId+" · this does not change the live station.");}catch(error){setStatus(error.message);}}
    async function returnToLive(){viewState.replaying=false;$("return-live").hidden=true;if(!viewState.connected)return;try{const payload=await rejoinLiveState(stationState.session);if(payload&&payload.state&&payload.state.currentComposition){if(payload.playback.ended){if(stationState.queuedCount<1)await ensureNextBuffered(stationState.session);if(stationState.queuedCount>0)await selectBufferedScore(stationState.session);}setStatus("Back to live at "+fmt(renderer.position));}else{renderer.stop();canonicalState.score=null;$("score-title").textContent="No score loaded";setControls(false);setStatus("Back to the live station · no current composition yet");}}catch(error){setStatus(error.message);}}
    function updateSteeringLabels(){for(const [key,value] of Object.entries(viewState.steering)){const node=$("steer-"+key+"-value");if(node)node.textContent=value;}}
    async function applySteering(){if(!viewState.connected||!canonicalState.score)return;const currentId=canonicalState.score.compositionId;$("steer-apply").disabled=true;setStatus("Recomposing the buffered future score…");try{const payload=await api("/score/prebuffer","POST",{replace:true,listenerIntent:{surface:"v04_visual_steering",text:steeringPrompt()}});if(canonicalState.score.compositionId!==currentId)throw new Error("current_score_changed_during_steering");setStationBuffer(payload.composition_buffer_count,payload.buffered_composition_id);setStatus(payload.replaced?"Next composition reshaped · current score unchanged":"Next composition prepared");setSheet(false);}catch(error){setStatus(error.message);}finally{$("steer-apply").disabled=false;}}
    function loadScore(score,meta,targetRenderer=renderer){const clean=deepFreeze(structuredClone(assertPlayableScore(score)));canonicalState.score=clean;canonicalState.source=meta&&meta.source||clean.provenance&&clean.provenance.composer||"persisted";canonicalState.fellBack=Boolean(meta&&meta.fellBack);canonicalState.fallbackReason=meta&&meta.fallbackReason||null;stationState.endedHandled=false;targetRenderer.load(clean);$("empty").hidden=true;$("score-title").textContent=clean.compositionId;$("score-meta").innerHTML="";[clean.bpm+" BPM",clean.key.root+" "+clean.key.mode,clean.bars+" bars",clean.tracks.length+" tracks"].forEach(text=>{const span=document.createElement("span");span.textContent=text;$("score-meta").appendChild(span);});$("schema-chip").textContent="schema · "+clean.schemaVersion;$("schema-chip").className="chip good";$("source-chip").textContent="source · "+canonicalState.source+(canonicalState.fellBack?" fallback":"");$("source-chip").className=canonicalState.fellBack?"chip warn":"chip good";$("provenance-chip").textContent="composer · "+(clean.provenance&&clean.provenance.composer||"unknown");$("duration").textContent=fmt(clean.durationSeconds);setControls(true);updateMetrics();setStatus(canonicalState.fellBack?"Fallback: "+(canonicalState.fallbackReason||"fixture"):"Score ready");draw();}
    async function api(tail,method,body){const url="/api/channels/"+encodeURIComponent(viewState.channelId)+tail;const headers={"x-creator-id":viewState.creatorId};if(body!==undefined)headers["content-type"]="application/json";const response=await fetch(url,{method:method||"GET",headers,body:body===undefined?undefined:JSON.stringify(body)});const payload=await response.json();if(!response.ok||payload.ok===false)throw new Error(payload.error||"request_failed");return payload;}
    function applyPlaybackSnapshot(playback,targetRenderer=renderer){if(!playback||!targetRenderer.score||playback.composition_id!==targetRenderer.score.compositionId)return false;targetRenderer.seek(playback.position_seconds);return true;}
    async function rejoinLiveState(session=stationState.session){const payload=await api("/playback/rejoin","POST",{});if(session!==stationState.session)return null;const queue=payload.state&&payload.state.compositionQueue||[];setStationBuffer(queue.length,queue[0]&&queue[0].compositionId);const score=payload.state&&payload.state.currentComposition;if(score){const currentId=canonicalState.score&&canonicalState.score.compositionId;if(currentId!==score.compositionId)loadScore(score,{source:score.provenance&&score.provenance.composer||"persisted current"});applyPlaybackSnapshot(payload.playback);}return payload;}
    async function ensureNextBuffered(session=stationState.session){if(!viewState.connected||session!==stationState.session)return false;if(stationState.queuedCount>0)return true;const active=stationState.prebufferPromise;if(active&&active.session===session)return active.promise;const pending=(async()=>{setStatus("Preparing next composition…");try{const payload=await api("/score/prebuffer","POST",{listenerIntent:{surface:"v04_prebuffer",text:steeringPrompt()}});if(session!==stationState.session)return false;setStationBuffer(payload.composition_buffer_count,payload.buffered_composition_id);setStatus(payload.created?(payload.fell_back?"Next score buffered via fixture fallback":"Next score buffered"):"Next score already buffered");return stationState.queuedCount>0;}catch(error){if(session===stationState.session)setStatus("Prebuffer retry available: "+error.message);return false;}})();stationState.prebufferPromise={session,promise:pending};try{return await pending;}finally{if(stationState.prebufferPromise&&stationState.prebufferPromise.promise===pending)stationState.prebufferPromise=null;}}
    async function selectBufferedScore(session,{autoplay=false}={}){const payload=await api("/score/select","POST");if(session!==stationState.session)return false;const queue=payload.state&&payload.state.compositionQueue||[];setStationBuffer(payload.composition_buffer_count,queue[0]&&queue[0].compositionId);loadScore(payload.score,{source:payload.score&&payload.score.provenance&&payload.score.provenance.composer||"persisted"});applyPlaybackSnapshot(payload.playback);void ensureNextBuffered(session);if(autoplay){await renderer.play();stationState.autoAdvance=true;setStatus("Playing · next score buffering");}return true;}
    async function connect(){const session=++stationState.session;stopAllDecks();stationState.crossfadeAttemptedCompositionId=null;stationState.autoAdvance=false;stationState.endedHandled=false;viewState.connected=false;viewState.replaying=false;$("return-live").hidden=true;setStationBuffer(0);viewState.channelId=$("channel").value.trim();viewState.creatorId=$("creator").value.trim();if(!viewState.channelId||!viewState.creatorId){setStatus("Channel and creator are required");return;}setStatus("Opening channel…");try{await api("/init","POST",{creatorId:viewState.creatorId});if(session!==stationState.session)return;viewState.connected=true;$("next").disabled=false;$("steer-open").disabled=false;$("library-open").disabled=false;let payload=await rejoinLiveState(session);if(session!==stationState.session||!payload)return;const nextUrl=new URL(location.href);nextUrl.searchParams.set("channel",viewState.channelId);nextUrl.searchParams.set("creator",viewState.creatorId);history.replaceState(null,"",nextUrl);if(payload.state&&payload.state.currentComposition&&!payload.playback.ended){void ensureNextBuffered(session);setStatus("Rejoined live at "+fmt(payload.playback.position_seconds)+" · tap Play");return;}if(stationState.queuedCount<1)await ensureNextBuffered(session);if(session!==stationState.session)return;if(stationState.queuedCount<1)throw new Error("composition_prebuffer_unavailable");await selectBufferedScore(session);setStatus(payload.state&&payload.state.currentComposition?"Recovered expired station state · next composition ready":"Station ready · next score buffering");}catch(error){if(session===stationState.session)setStatus(error.message);}}
    async function bufferNext(){if(!viewState.connected)return;$("next").disabled=true;try{if(stationState.queuedCount>0){setStatus("Next composition already buffered");return;}await ensureNextBuffered(stationState.session);}finally{$("next").disabled=false;}}
    async function advanceAfterEnd(session){if(stationState.advanceInFlight||stationState.crossfadeInFlight||viewState.replaying||session!==stationState.session)return;stationState.advanceInFlight=true;setStatus("Advancing to buffered composition…");try{if(stationState.queuedCount<1)await ensureNextBuffered(session);if(session!==stationState.session)return;if(stationState.queuedCount<1)throw new Error("composition_prebuffer_unavailable");await selectBufferedScore(session,{autoplay:true});}catch(error){stationState.autoAdvance=false;if(session===stationState.session)setStatus("Station paused: "+error.message);}finally{stationState.advanceInFlight=false;}}
    async function startDualDeckCrossfade(session){const outgoingCompositionId=canonicalState.score&&canonicalState.score.compositionId;if(stationState.crossfadeInFlight||stationState.advanceInFlight||session!==stationState.session||viewState.replaying||stationState.queuedCount<1||!outgoingCompositionId||stationState.crossfadeAttemptedCompositionId===outgoingCompositionId)return false;const epoch=++stationState.crossfadeEpoch;stationState.crossfadeAttemptedCompositionId=outgoingCompositionId;stationState.crossfadeInFlight=true;const outgoing=renderer;stationState.crossfadeOutgoing=outgoing;let incoming=null,selectionCommitted=false;try{const payload=await api("/score/select","POST");selectionCommitted=true;if(epoch!==stationState.crossfadeEpoch||session!==stationState.session)return false;const queue=payload.state&&payload.state.compositionQueue||[];setStationBuffer(payload.composition_buffer_count,queue[0]&&queue[0].compositionId);incoming=new ScoreRenderer();incoming.adoptContext(outgoing.ctx);incoming.rampMasterTo(0);loadScore(payload.score,{source:payload.score&&payload.score.provenance&&payload.score.provenance.composer||"persisted"},incoming);applyPlaybackSnapshot(payload.playback,incoming);await incoming.play();if(epoch!==stationState.crossfadeEpoch||session!==stationState.session){incoming.dispose();return false;}outgoing.rampMasterTo(0,CROSSFADE_SECONDS);incoming.rampMasterTo(.5,CROSSFADE_SECONDS);renderer=incoming;stationState.autoAdvance=true;setStatus("Crossfading · next score buffering");void ensureNextBuffered(session);await new Promise(resolve=>setTimeout(resolve,CROSSFADE_SECONDS*1000));if(epoch!==stationState.crossfadeEpoch||session!==stationState.session)return false;outgoing.dispose();if(stationState.crossfadeOutgoing===outgoing)stationState.crossfadeOutgoing=null;setStatus("Playing · transition complete · next score buffering");return true;}catch(error){if(epoch!==stationState.crossfadeEpoch||session!==stationState.session)return false;if(incoming&&incoming!==renderer)incoming.dispose();if(selectionCommitted){stationState.autoAdvance=false;setStatus("Station paused after transition selection: "+error.message);}else{setStatus("Crossfade unavailable · end transition fallback remains active: "+error.message);}return false;}finally{if(epoch===stationState.crossfadeEpoch){stationState.crossfadeInFlight=false;if(stationState.crossfadeOutgoing===outgoing)stationState.crossfadeOutgoing=null;}}}
    function prepareCanvas(){const canvas=$("score-canvas"),ctx=canvas.getContext("2d"),rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.floor(rect.width*dpr)),height=Math.max(1,Math.floor(rect.height*dpr));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);return {ctx,rect};}
    function drawScoreProjection(ctx,rect,score){const pad=18,laneH=(rect.height-pad*2)/score.tracks.length,qpb=(score.timeSignature.beatsPerBar*(4/score.timeSignature.beatUnit)),totalBeats=score.bars*qpb;ctx.strokeStyle="#232334";ctx.lineWidth=1;for(let bar=0;bar<=score.bars;bar+=1){const x=pad+(rect.width-pad*2)*(bar/score.bars);ctx.beginPath();ctx.moveTo(x,pad);ctx.lineTo(x,rect.height-pad);ctx.stroke();}score.tracks.forEach((track,index)=>{const y=pad+laneH*index;ctx.fillStyle="hsl("+((index*67+235)%360)+" 72% 65%)";ctx.globalAlpha=.82;(track.events||[]).forEach(event=>{const x=pad+(rect.width-pad*2)*(event.start/totalBeats),w=Math.max(3,(rect.width-pad*2)*(event.duration/totalBeats));ctx.fillRect(x,y+laneH*.34,w,Math.max(3,laneH*.3));});(track.drumEvents||[]).forEach(event=>{const x=pad+(rect.width-pad*2)*(event.start/totalBeats);ctx.beginPath();ctx.arc(x,y+laneH*.5,Math.max(2,laneH*.11),0,Math.PI*2);ctx.fill();});ctx.globalAlpha=1;ctx.fillStyle="#858598";ctx.font="11px system-ui";ctx.fillText(track.id,pad+4,y+13);});const playhead=renderer.duration?renderer.position/renderer.duration:0,px=pad+(rect.width-pad*2)*playhead;ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(px,pad);ctx.lineTo(px,rect.height-pad);ctx.stroke();}
    function drawVisualProjection(ctx,rect,score){const m=scoreMetrics(score),cx=rect.width/2,cy=rect.height/2,r=Math.max(70,Math.min(rect.width,rect.height)*.31),fifthIndex=Math.max(0,FIFTHS.indexOf(score.key.root)),hue=(225+fifthIndex*23)%360,playhead=renderer.duration?renderer.position/renderer.duration:0;const bg=ctx.createRadialGradient(cx,cy,8,cx,cy,Math.max(rect.width,rect.height)*.7);bg.addColorStop(0,"hsla("+hue+",70%,36%,.35)");bg.addColorStop(1,"rgba(7,7,13,0)");ctx.fillStyle=bg;ctx.fillRect(0,0,rect.width,rect.height);ctx.globalAlpha=.28;for(let ring=1;ring<=3;ring+=1){ctx.strokeStyle="hsl("+hue+" 55% "+(48+ring*8)+"%)";ctx.lineWidth=1;ctx.beginPath();ctx.arc(cx,cy,r*(.48+ring*.18),0,Math.PI*2);ctx.stroke();}ctx.globalAlpha=1;FIFTHS.forEach((key,index)=>{const angle=-Math.PI/2+index/12*Math.PI*2,x=cx+Math.cos(angle)*r,y=cy+Math.sin(angle)*r,active=key===score.key.root;ctx.fillStyle=active?"#fff":"#77778d";ctx.font=(active?"800 12px":"11px")+" system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(key,x,y);if(active){ctx.strokeStyle="#fff";ctx.globalAlpha=.35;ctx.beginPath();ctx.arc(x,y,15,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}});score.tracks.forEach((track,index)=>{const orbit=r*(.28+index/Math.max(1,score.tracks.length)*.4),angle=-Math.PI/2+(playhead+index/score.tracks.length)*Math.PI*2,x=cx+Math.cos(angle)*orbit,y=cy+Math.sin(angle)*orbit,size=4+10*m.energy;ctx.fillStyle="hsl("+((hue+index*41)%360)+" 78% 68%)";ctx.globalAlpha=.45+.45*m.brightness;ctx.beginPath();ctx.arc(x,y,size,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;});ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#f5f5ff";ctx.font="800 "+Math.max(20,Math.min(38,rect.width*.08))+"px system-ui";ctx.fillText(score.key.root,cx,cy-7);ctx.fillStyle="#a2a2b7";ctx.font="12px system-ui";ctx.fillText(score.key.mode+" · "+score.bpm+" BPM",cx,cy+23);ctx.strokeStyle="hsla("+hue+",85%,75%,.75)";ctx.lineWidth=2+5*m.energy;ctx.beginPath();ctx.arc(cx,cy,r*.78,-Math.PI/2,-Math.PI/2+playhead*Math.PI*2);ctx.stroke();ctx.textAlign="start";ctx.textBaseline="alphabetic";}
    function draw(){const {ctx,rect}=prepareCanvas(),score=canonicalState.score;if(!score)return;if(viewState.activeView==="score")drawScoreProjection(ctx,rect,score);else drawVisualProjection(ctx,rect,score);} 
    async function play(){try{await renderer.unlockFromGesture();setAudioStatus();const livePlayback=!viewState.replaying;if(livePlayback){let payload=await rejoinLiveState(stationState.session);if(payload&&payload.playback&&payload.playback.ended){if(stationState.queuedCount<1)await ensureNextBuffered(stationState.session);if(stationState.queuedCount<1)throw new Error("composition_prebuffer_unavailable");await selectBufferedScore(stationState.session);}else if(payload&&!payload.state.currentComposition){if(stationState.queuedCount<1)await ensureNextBuffered(stationState.session);if(stationState.queuedCount<1)throw new Error("composition_prebuffer_unavailable");await selectBufferedScore(stationState.session);}}await renderer.play();stationState.autoAdvance=livePlayback;stationState.endedHandled=false;setStatus(livePlayback?"Playing live · audio "+renderer.ctx.state+" · position synced":"Playing library replay · live continuity unchanged");if(livePlayback)void ensureNextBuffered(stationState.session);}catch(error){setAudioStatus();setStatus(error.message);}}
    function tick(){const duration=renderer.duration||0,position=renderer.position,remaining=Math.max(0,duration-position);$("position").textContent=fmt(position);$("progress").style.width=(duration?clamp(position/duration*100,0,100):0)+"%";if(renderer.state==="playing"&&duration&&remaining<=Math.min(12,Math.max(4,duration*.25))&&stationState.queuedCount<1&&!viewState.replaying)void ensureNextBuffered(stationState.session);if(renderer.state==="playing"&&stationState.autoAdvance&&!viewState.replaying&&!stationState.crossfadeInFlight&&!stationState.advanceInFlight&&stationState.queuedCount>0&&remaining>0.15&&remaining<=CROSSFADE_LEAD_SECONDS)void startDualDeckCrossfade(stationState.session);if(renderer.state==="ended"&&stationState.autoAdvance&&!viewState.replaying&&!stationState.endedHandled&&!stationState.crossfadeInFlight){stationState.endedHandled=true;void advanceAfterEnd(stationState.session);}draw();requestAnimationFrame(tick);}requestAnimationFrame(tick);
    document.querySelectorAll("[data-view]").forEach(button=>button.addEventListener("click",()=>setProjection(button.dataset.view)));document.querySelectorAll("[data-steer]").forEach(input=>input.addEventListener("input",()=>{viewState.steering[input.dataset.steer]=Number(input.value);updateSteeringLabels();}));updateSteeringLabels();$("steer-open").addEventListener("click",()=>setSheet(true));$("steer-close").addEventListener("click",()=>setSheet(false));$("steer-cancel").addEventListener("click",()=>setSheet(false));$("sheet-backdrop").addEventListener("click",()=>{setSheet(false);setLibraryOpen(false);});$("steer-apply").addEventListener("click",applySteering);$("library-open").addEventListener("click",()=>setLibraryOpen(true));$("library-close").addEventListener("click",()=>setLibraryOpen(false));$("library-cancel").addEventListener("click",()=>setLibraryOpen(false));$("return-live").addEventListener("click",returnToLive);$("connect").addEventListener("click",connect);$("next").addEventListener("click",bufferNext);$("play").addEventListener("click",play);$("pause").addEventListener("click",()=>{settleCrossfade();renderer.pause();setAudioStatus();setStatus("Paused");});$("stop").addEventListener("click",()=>{stopAllDecks();stationState.autoAdvance=false;stationState.endedHandled=false;setAudioStatus();setStatus("Stopped");});window.addEventListener("infinite-radio-audio-state",setAudioStatus);document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible"||!renderer.ctx)return;setAudioStatus();if(renderer.state==="playing"&&renderer.ctx.state!=="running")setStatus("Tap Play to restore audio");});window.addEventListener("resize",draw);if(params.has("channel")&&params.has("creator"))void connect();
  </script>
</body>
</html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return json({ ok: false, error: "not_found" }, { status: 404 });
  },
};

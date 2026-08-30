import { createFalClient } from "@fal-ai/client";

import {
  MUSIC_PROVIDERS,
  assertChannelOwner,
  assertProviderReady,
  channelAssetKey,
  chooseNextPlayable,
  compileStationBrief,
  completeMusicGeneration,
  createChannelState,
  createGenerationJob,
  ensureFixtureBuffer,
  failGeneration,
  markGenerationRunning,
  readyBufferSeconds,
  selectNextPrompt,
  submitPrompt,
  updateChannelPolicy,
} from "./station-state.js";

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
    if (state.policy.provider !== MUSIC_PROVIDERS.FAL_CASSETTEAI) {
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
          const assetKey = channelAssetKey(state.channelId, `generated/${scheduled.job.id}.wav`);
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

function publicState(state) {
  return {
    schemaVersion: state.schemaVersion,
    channelId: state.channelId,
    creatorId: state.creatorId,
    mode: state.mode,
    status: state.status,
    currentTrack: state.currentTrack,
    readyQueue: state.readyQueue,
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
  const forwarded = new Request(`https://channel.internal${route.tail}`, {
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
        version: "0.3.0",
        runtime: "channel-first-byok",
        bindings: {
          channelConductor: Boolean(env.CHANNEL_CONDUCTOR),
          d1: Boolean(env.DB),
          r2: Boolean(env.ASSETS),
          workersAI: Boolean(env.AI),
        },
        musicProviders: [MUSIC_PROVIDERS.FIXTURE, MUSIC_PROVIDERS.FAL_CASSETTEAI],
      });
    }

    const route = channelRoute(url.pathname);
    if (route) return proxyChannelRequest(request, env, route);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infinite Radio</title></head>
<body style="font-family:system-ui;background:#09090b;color:#fafafa;max-width:820px;margin:60px auto;padding:24px">
  <p>◉ LIVE SYSTEM / V0.3 BYOK MUSIC PROVIDER</p>
  <h1>Infinite Radio</h1>
  <p>A creator-owned network of isolated AI radio channels. V0.3 adds provider-neutral BYOK music generation while retaining fixture fallback.</p>
  <pre>POST /api/channels/:channel_id/init
GET  /api/channels/:channel_id/state
POST /api/channels/:channel_id/prompts
POST /api/channels/:channel_id/provider
POST /api/channels/:channel_id/generation/next
POST /api/channels/:channel_id/conductor/tick
POST /api/channels/:channel_id/playback/next
GET  /api/channels/:channel_id/ws</pre>
  <p>Mutation and state endpoints require an <code>x-creator-id</code> header matching the channel owner.</p>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return json({ ok: false, error: "not_found" }, { status: 404 });
  },
};

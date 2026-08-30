import {
  assertChannelOwner,
  chooseNextPlayable,
  compileStationBrief,
  createChannelState,
  ensureFixtureBuffer,
  readyBufferSeconds,
  submitPrompt,
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
          (channel_id, buffer_target_seconds, generation_cap_per_hour, provider, credential_ref, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           buffer_target_seconds = excluded.buffer_target_seconds,
           generation_cap_per_hour = excluded.generation_cap_per_hour,
           provider = excluded.provider,
           credential_ref = excluded.credential_ref,
           updated_at = excluded.updated_at`,
      )
        .bind(
          state.channelId,
          state.policy.bufferTargetSeconds,
          state.policy.generationCapPerHour,
          state.policy.provider,
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

  async writeFixtureArtifacts(created) {
    for (const item of created) {
      if (this.env.DB) {
        await bestEffort(
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO generations
              (generation_id, channel_id, prompt_id, idempotency_key, provider, credential_ref, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          )
            .bind(
              item.job.id,
              item.job.channelId,
              item.job.promptId,
              item.job.idempotencyKey,
              item.job.provider,
              item.job.credentialRef,
              item.job.createdAt,
              item.track.createdAt,
            )
            .run(),
        );
        await bestEffort(
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO tracks
              (track_id, channel_id, generation_id, asset_key, duration_seconds, provider, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              item.track.id,
              item.track.channelId,
              item.track.generationJobId,
              item.track.assetKey,
              item.track.durationSeconds,
              item.track.provider,
              item.track.createdAt,
            )
            .run(),
        );
      }
      if (this.env.ASSETS) {
        await this.env.ASSETS.put(
          item.track.assetKey,
          JSON.stringify({
            schema: "infinite-radio-fixture-v1",
            channel_id: item.track.channelId,
            generation_id: item.job.id,
            prompt_id: item.job.promptId,
            duration_seconds: item.track.durationSeconds,
          }),
          { httpMetadata: { contentType: "application/json" } },
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
          state = {
            ...state,
            policy: {
              ...state.policy,
              ...body.policy,
              provider: "fixture",
            },
          };
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

      if (request.method === "POST" && url.pathname === "/conductor/tick") {
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
        return json({
          ok: true,
          brief: compileStationBrief(state, body.prompt ?? null),
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
        version: "0.2.0",
        runtime: "channel-first",
        bindings: {
          channelConductor: Boolean(env.CHANNEL_CONDUCTOR),
          d1: Boolean(env.DB),
          r2: Boolean(env.ASSETS),
          workersAI: Boolean(env.AI),
        },
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
  <p>◉ LIVE SYSTEM / V0.2 CHANNEL RUNTIME</p>
  <h1>Infinite Radio</h1>
  <p>A creator-owned network of isolated AI radio channels. V0.2 runs fixture generation at zero music-generation cost.</p>
  <pre>POST /api/channels/:channel_id/init
GET  /api/channels/:channel_id/state
POST /api/channels/:channel_id/prompts
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

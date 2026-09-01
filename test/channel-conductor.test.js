import test from "node:test";
import assert from "node:assert/strict";

import {
  ChannelConductor,
  credentialRefFor,
  runFalCassetteAI,
  runFalStableAudio,
  safeProviderErrorCode,
} from "../src/index.js";

class MemoryStorage {
  constructor(seed = new Map()) {
    this.seed = seed;
  }

  async get(key) {
    const value = this.seed.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.seed.set(key, structuredClone(value));
  }
}

function makeCtx(storage) {
  return {
    storage,
    getWebSockets() {
      return [];
    },
    acceptWebSocket() {},
  };
}

function channelRequest(path, { method = "GET", body, channelId = "alpha", creatorId = "creator-a", providerKey } = {}) {
  const headers = new Headers({
    "x-channel-id": channelId,
    "x-creator-id": creatorId,
  });
  if (providerKey) headers.set("x-provider-key", providerKey);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://channel.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Durable Object state survives conductor reconstruction and prompt retries", async () => {
  const storage = new MemoryStorage();
  const assets = new Map();
  const env = {
    ASSETS: {
      async put(key, value, options) {
        assets.set(key, { value, options });
      },
    },
  };

  const first = new ChannelConductor(makeCtx(storage), env);
  let response = await first.fetch(
    channelRequest("/init", {
      method: "POST",
      body: {
        creatorId: "creator-a",
        policy: { bufferTargetSeconds: 90, generationCapPerHour: 20 },
      },
    }),
  );
  assert.equal(response.status, 201);

  response = await first.fetch(
    channelRequest("/prompts", {
      method: "POST",
      body: {
        idempotencyKey: "retry-safe-1",
        userId: "listener-1",
        text: "robot gospel surf",
      },
    }),
  );
  assert.equal(response.status, 202);

  response = await first.fetch(
    channelRequest("/prompts", {
      method: "POST",
      body: {
        idempotencyKey: "retry-safe-1",
        userId: "listener-1",
        text: "robot gospel surf",
      },
    }),
  );
  const replay = await response.json();
  assert.equal(response.status, 200);
  assert.equal(replay.deduped, true);

  response = await first.fetch(
    channelRequest("/conductor/tick", { method: "POST", body: {} }),
  );
  const tick = await response.json();
  assert.equal(response.status, 200);
  assert.equal(tick.state.readyBufferSeconds, 90);
  assert.equal(assets.size, 3);
  assert.ok([...assets.keys()].every((key) => key.startsWith("channels/alpha/")));
  for (const { value, options } of assets.values()) {
    assert.equal(options.httpMetadata.contentType, "audio/wav");
    assert.equal(new TextDecoder().decode(value.slice(0, 4)), "RIFF");
    assert.equal(new TextDecoder().decode(value.slice(8, 12)), "WAVE");
  }

  const restarted = new ChannelConductor(makeCtx(storage), env);
  response = await restarted.fetch(channelRequest("/state"));
  const afterRestart = await response.json();
  assert.equal(response.status, 200);
  assert.equal(afterRestart.state.channelId, "alpha");
  assert.equal(afterRestart.state.creatorId, "creator-a");
  assert.equal(afterRestart.state.readyBufferSeconds, 90);
  assert.equal(afterRestart.state.counters.promptsAccepted, 1);
  assert.equal(afterRestart.state.counters.promptReplays, 1);
});

test("Durable Object owner boundary rejects a different creator", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(
    channelRequest("/init", {
      method: "POST",
      body: { creatorId: "creator-a" },
    }),
  );

  const response = await conductor.fetch(
    channelRequest("/state", { creatorId: "creator-b" }),
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "channel_owner_required");
});

test("read-only playback rejoin bypasses an in-flight composition mutation when no successor is queued", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), {});
  await conductor.fetch(
    channelRequest("/init", {
      method: "POST",
      body: { creatorId: "creator-a" },
    }),
  );

  const state = await storage.get("channel-state");
  state.currentComposition = {
    compositionId: "ended-score",
    durationSeconds: 1,
  };
  state.currentCompositionStartedAt = new Date(Date.now() - 5000).toISOString();
  state.compositionQueue = [];
  await storage.put("channel-state", state);

  let releaseMutation;
  conductor.compositionMutationTail = new Promise((resolve) => {
    releaseMutation = resolve;
  });

  try {
    const response = await Promise.race([
      conductor.fetch(channelRequest("/playback/rejoin", { method: "POST", body: {} })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("read_only_rejoin_blocked")), 250)),
    ]);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.advanced, false);
    assert.equal(body.playback.ended, true);
    assert.equal(body.state.compositionQueue.length, 0);
  } finally {
    releaseMutation();
  }
});

test("provider errors are normalized before state or D1 persistence", () => {
  assert.equal(
    safeProviderErrorCode(new Error("upstream failed with secret-key-123")),
    "provider_generation_failed",
  );
  assert.equal(safeProviderErrorCode({ status: 401, message: "credential abc" }), "provider_auth_failed");
  assert.equal(safeProviderErrorCode({ status: 429 }), "provider_rate_limited");
  assert.equal(safeProviderErrorCode({ status: 503 }), "provider_unavailable");
});

test("credential refs are deterministic fingerprints, never raw provider keys", async () => {
  const ref = await credentialRefFor("fal-cassetteai", "secret-key-123");
  assert.match(ref, /^fal-cassetteai:sha256:[a-f0-9]{64}$/);
  assert.equal(ref.includes("secret-key-123"), false);
  assert.equal(ref, await credentialRefFor("fal-cassetteai", "secret-key-123"));
  assert.notEqual(ref, await credentialRefFor("fal-cassetteai", "different-key"));
});

test("fal adapter uses a request-scoped client and validates WAV output", async () => {
  const calls = [];
  const wav = new Uint8Array(44);
  wav.set(new TextEncoder().encode("RIFF"), 0);
  wav.set(new TextEncoder().encode("WAVE"), 8);
  const result = await runFalCassetteAI({
    apiKey: "secret-key-123",
    prompt: "original neon jazz",
    durationSeconds: 30,
    clientFactory(config) {
      assert.equal(config.credentials, "secret-key-123");
      return {
        async subscribe(endpoint, options) {
          calls.push({ endpoint, options });
          return {
            requestId: "fal-request-1",
            data: { audio_file: { url: "https://example.test/generated.wav" } },
          };
        },
      };
    },
    async fetcher(url) {
      assert.equal(url, "https://example.test/generated.wav");
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });
  assert.equal(calls[0].endpoint, "CassetteAI/music-generator");
  assert.equal(calls[0].options.input.duration, 30);
  assert.equal(result.providerRequestId, "fal-request-1");
  assert.equal(result.durationSeconds, 30);
  assert.equal(result.costMicrousd, 10000);
  assert.equal(result.provenance.terms_uri, "https://fal.ai/legal/terms-of-service");
  assert.equal(result.provenance.api_terms_uri, "https://fal.ai/legal/api-services");
  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 4)), "RIFF");
});

test("Stable Audio Open adapter uses BYOK credentials and normalizes free audio output", async () => {
  const calls = [];
  const wav = new Uint8Array(64);
  wav.set(new TextEncoder().encode("RIFF"), 0);
  wav.set(new TextEncoder().encode("WAVE"), 8);
  const result = await runFalStableAudio({
    apiKey: "stable-secret",
    prompt: "128 BPM original midnight synth loop",
    durationSeconds: 10,
    clientFactory(config) {
      assert.equal(config.credentials, "stable-secret");
      return {
        async subscribe(endpoint, options) {
          calls.push({ endpoint, options });
          return {
            requestId: "stable-request-1",
            data: { audio_file: { url: "https://example.test/stable.wav", content_type: "audio/wav" } },
          };
        },
      };
    },
    async fetcher(url) {
      assert.equal(url, "https://example.test/stable.wav");
      return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
    },
  });
  assert.equal(calls[0].endpoint, "fal-ai/stable-audio");
  assert.equal(calls[0].options.input.seconds_total, 10);
  assert.equal(result.providerRequestId, "stable-request-1");
  assert.equal(result.durationSeconds, 10);
  assert.equal(result.costMicrousd, 0);
  assert.equal(result.contentType, "audio/wav");
  assert.equal(result.provenance.provider, "fal-stable-audio");
  assert.equal(result.provenance.model, "fal-ai/stable-audio");
});

test("BYOK generation stores only a credential fingerprint and channel-scoped asset", async () => {
  const storage = new MemoryStorage();
  const assets = new Map();
  const providerCalls = [];
  const conductor = new ChannelConductor(makeCtx(storage), {
    ASSETS: {
      async put(key, value, options) {
        assets.set(key, { value, options });
      },
    },
    MUSIC_PROVIDER: {
      async generate(input) {
        providerCalls.push(input);
        return {
          bytes: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]),
          contentType: "audio/wav",
          providerRequestId: "provider-request-1",
          durationSeconds: 30,
          latencyMs: 123,
          costMicrousd: 10000,
          provenance: { provider: "fal-cassetteai", model: "CassetteAI/music-generator" },
        };
      },
    },
  });

  await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" } }));
  let response = await conductor.fetch(channelRequest("/provider", {
    method: "POST",
    providerKey: "alpha-secret",
    body: {
      provider: "fal-cassetteai",
      generationCapPerHour: 5,
      generationCapPerDay: 10,
    },
  }));
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.policy.credentialRef, /^fal-cassetteai:sha256:/);
  assert.equal(JSON.stringify(body).includes("alpha-secret"), false);

  response = await conductor.fetch(channelRequest("/prompts", {
    method: "POST",
    body: { id: "p1", idempotencyKey: "p1", userId: "u1", text: "neon jazz rain" },
  }));
  assert.equal(response.status, 202);

  response = await conductor.fetch(channelRequest("/generation/next", {
    method: "POST",
    providerKey: "wrong-secret",
    body: { durationSeconds: 30 },
  }));
  body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "credential_scope_violation");
  assert.equal(providerCalls.length, 0);

  response = await conductor.fetch(channelRequest("/generation/next", {
    method: "POST",
    providerKey: "alpha-secret",
    body: { durationSeconds: 30 },
  }));
  body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].apiKey, "alpha-secret");
  assert.equal(JSON.stringify(body).includes("alpha-secret"), false);
  assert.match(body.track.assetKey, /^channels\/alpha\/generated\//);
  assert.equal(assets.size, 1);
  assert.ok([...assets.keys()][0].startsWith("channels/alpha/generated/"));

  const persisted = await storage.get("channel-state");
  assert.equal(JSON.stringify(persisted).includes("alpha-secret"), false);
  assert.match(persisted.policy.credentialRef, /^fal-cassetteai:sha256:/);
  assert.equal(persisted.generationJobs[0].status, "ready");
});

test("provider outage requeues listener intent and marks channel health degraded", async () => {
  const storage = new MemoryStorage();
  const conductor = new ChannelConductor(makeCtx(storage), {
    ASSETS: { async put() {} },
    MUSIC_PROVIDER: {
      async generate() {
        throw new Error("provider_offline");
      },
    },
  });
  await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" } }));
  await conductor.fetch(channelRequest("/provider", {
    method: "POST",
    providerKey: "alpha-secret",
    body: { provider: "fal-cassetteai", generationCapPerHour: 5, generationCapPerDay: 10 },
  }));
  await conductor.fetch(channelRequest("/prompts", {
    method: "POST",
    body: { id: "retry-me", idempotencyKey: "retry-me", userId: "u1", text: "keep this prompt" },
  }));

  const response = await conductor.fetch(channelRequest("/generation/next", {
    method: "POST",
    providerKey: "alpha-secret",
    body: { durationSeconds: 30 },
  }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, "provider_offline");
  const persisted = await storage.get("channel-state");
  assert.equal(persisted.promptQueue.length, 1);
  assert.equal(persisted.promptQueue[0].id, "retry-me");
  assert.equal(persisted.generationJobs[0].status, "failed");
  assert.equal(persisted.providerHealth.status, "degraded");
});

test("Workers AI control layer is optional and falls back deterministically", async () => {
  const storage = new MemoryStorage();
  const calls = [];
  const conductor = new ChannelConductor(makeCtx(storage), {
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { response: '{"creative_direction":"night-drive","moderation":"ok","programming_note":"steady"}' };
      },
    },
  });
  await conductor.fetch(channelRequest("/init", { method: "POST", body: { creatorId: "creator-a" } }));
  let response = await conductor.fetch(channelRequest("/brief", {
    method: "POST",
    body: { prompt: { channelId: "alpha", userId: "u1", text: "neon desert" } },
  }));
  let body = await response.json();
  assert.equal(body.source, "workers-ai");
  assert.equal(calls.length, 1);
  assert.match(body.control, /night-drive/);

  const fallback = new ChannelConductor(makeCtx(storage), { AI: { async run() { throw new Error("offline"); } } });
  response = await fallback.fetch(channelRequest("/brief", { method: "POST", body: { prompt: null } }));
  body = await response.json();
  assert.equal(body.source, "deterministic-fallback");
  assert.equal(body.brief.channelId, "alpha");
});

import test from "node:test";
import assert from "node:assert/strict";

import { ChannelConductor } from "../src/index.js";

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

function channelRequest(path, { method = "GET", body, channelId = "alpha", creatorId = "creator-a" } = {}) {
  const headers = new Headers({
    "x-channel-id": channelId,
    "x-creator-id": creatorId,
  });
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
      async put(key, value) {
        assets.set(key, value);
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

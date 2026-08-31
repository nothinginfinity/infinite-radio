import test from "node:test";
import assert from "node:assert/strict";

import { ChannelConductor } from "../src/index.js";
import { SCORE_SCHEMA_VERSION } from "../src/score-schema.js";

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

/**
 * Minimal purpose-built D1 fake covering exactly the statements
 * ChannelConductor issues against the `compositions` table: idempotent
 * insert, lifecycle-status update, bounded/paginated select, and
 * single-row lookup by composition_id.
 */
class FakeCompositionsD1 {
  constructor({ failWrites = false } = {}) {
    this.rows = new Map();
    this.failWrites = failWrites;
  }

  prepare(sql) {
    const text = sql.trim();
    return {
      bind: (...args) => ({
        run: async () => this._run(text, args),
        all: async () => this._all(text, args),
        first: async () => this._first(text, args),
      }),
    };
  }

  async _run(sql, args) {
    if (/^INSERT INTO compositions/i.test(sql)) {
      if (this.failWrites) throw new Error("simulated_d1_write_failure");
      const [
        compositionId, channelId, creatorId, schemaVersion, scoreJson,
        composer, model, bpm, keyRoot, keyMode, bars, durationSeconds, status, createdAt,
      ] = args;
      if (this.rows.has(compositionId)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.rows.set(compositionId, {
        composition_id: compositionId,
        channel_id: channelId,
        creator_id: creatorId,
        schema_version: schemaVersion,
        score_json: scoreJson,
        composer,
        model,
        bpm,
        key_root: keyRoot,
        key_mode: keyMode,
        bars,
        duration_seconds: durationSeconds,
        status,
        created_at: createdAt,
        selected_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE compositions/i.test(sql)) {
      const [selectedAt, compositionId] = args;
      const row = this.rows.get(compositionId);
      if (row && row.status === "buffered") {
        row.status = "selected";
        row.selected_at = selectedAt;
      }
      return { success: true };
    }
    throw new Error(`FakeCompositionsD1: unsupported run statement: ${sql}`);
  }

  async _all(sql, args) {
    if (/^SELECT [\s\S]*FROM compositions/i.test(sql)) {
      const hasBefore = /created_at < \?/i.test(sql);
      const [channelId, cursorOrLimit, maybeLimit] = args;
      const before = hasBefore ? cursorOrLimit : null;
      const limit = hasBefore ? maybeLimit : cursorOrLimit;
      let rows = [...this.rows.values()].filter((row) => row.channel_id === channelId);
      if (before) rows = rows.filter((row) => row.created_at < before);
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      return { results: rows.slice(0, limit) };
    }
    throw new Error(`FakeCompositionsD1: unsupported all() query: ${sql}`);
  }

  async _first(sql, args) {
    if (/^SELECT [\s\S]*FROM compositions WHERE composition_id/i.test(sql)) {
      const [compositionId] = args;
      return this.rows.get(compositionId) ?? null;
    }
    throw new Error(`FakeCompositionsD1: unsupported first() query: ${sql}`);
  }
}

function fakeAiEnv(db, overrides = {}) {
  return {
    DB: db,
    AI: {
      async run() {
        return {
          response: JSON.stringify({
            schemaVersion: SCORE_SCHEMA_VERSION,
            compositionId: overrides.compositionId ?? "ai-comp-1",
            bpm: 120,
            timeSignature: { beatsPerBar: 4, beatUnit: 4 },
            key: { root: "E", mode: "minor" },
            bars: 4,
            sections: [{ startBar: 0, lengthBars: 4, label: "loop" }],
            tracks: [
              { id: "lead", patch: "sine_lead", events: [{ pitch: 64, start: 0, duration: 16, velocity: 0.7 }] },
            ],
            continuity: { motifIds: ["riser"], energy: 0.6 },
          }),
        };
      },
    },
  };
}

async function initChannel(conductor, { channelId = "alpha", creatorId = "creator-a" } = {}) {
  const response = await conductor.fetch(
    channelRequest("/init", { method: "POST", body: { creatorId }, channelId, creatorId }),
  );
  assert.equal(response.status, 201);
}

test("/score/next persists an immutable canonical library record as buffered", async () => {
  const db = new FakeCompositionsD1();
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.library_persisted, true);

  const libraryResponse = await conductor.fetch(channelRequest("/score/library"));
  const library = await libraryResponse.json();
  assert.equal(library.ok, true);
  assert.equal(library.count, 1);
  assert.equal(library.entries[0].compositionId, "ai-comp-1");
  assert.equal(library.entries[0].status, "buffered");
  assert.equal(library.entries[0].selectedAt, null);
});

test("/score/select marks the composition selected without rewriting score_json", async () => {
  const db = new FakeCompositionsD1();
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  const original = await conductor.fetch(channelRequest("/score/library/ai-comp-1"));
  const originalPayload = await original.json();
  assert.equal(originalPayload.status, "buffered");

  await conductor.fetch(channelRequest("/score/select", { method: "POST" }));

  const afterSelect = await conductor.fetch(channelRequest("/score/library/ai-comp-1"));
  const afterPayload = await afterSelect.json();
  assert.equal(afterPayload.status, "selected");
  assert.ok(afterPayload.selected_at);
  assert.deepEqual(afterPayload.score, originalPayload.score);

  const listResponse = await conductor.fetch(channelRequest("/score/library"));
  const list = await listResponse.json();
  assert.equal(list.entries[0].status, "selected");
});

test("GET /score/library/:id enforces channel scope", async () => {
  const db = new FakeCompositionsD1();
  const conductorAlpha = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  const conductorBeta = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db, { compositionId: "ai-comp-beta" }));
  await initChannel(conductorAlpha, { channelId: "alpha", creatorId: "creator-a" });
  await initChannel(conductorBeta, { channelId: "beta", creatorId: "creator-b" });

  await conductorAlpha.fetch(channelRequest("/score/next", { method: "POST", body: {}, channelId: "alpha", creatorId: "creator-a" }));

  const crossChannelRead = await conductorBeta.fetch(
    channelRequest("/score/library/ai-comp-1", { channelId: "beta", creatorId: "creator-b" }),
  );
  assert.equal(crossChannelRead.status, 400);
  const crossChannelPayload = await crossChannelRead.json();
  assert.equal(crossChannelPayload.error, "channel_scope_violation");

  const correctChannelRead = await conductorAlpha.fetch(
    channelRequest("/score/library/ai-comp-1", { channelId: "alpha", creatorId: "creator-a" }),
  );
  assert.equal(correctChannelRead.status, 200);
});

test("GET /score/library returns 404 for an unknown composition id", async () => {
  const db = new FakeCompositionsD1();
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/library/does-not-exist"));
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error, "composition_not_found");
});

test("channel isolation: one channel's library never surfaces another channel's compositions", async () => {
  const db = new FakeCompositionsD1();
  const conductorAlpha = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db, { compositionId: "ai-comp-alpha" }));
  const conductorBeta = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db, { compositionId: "ai-comp-beta" }));
  await initChannel(conductorAlpha, { channelId: "alpha", creatorId: "creator-a" });
  await initChannel(conductorBeta, { channelId: "beta", creatorId: "creator-b" });

  await conductorAlpha.fetch(channelRequest("/score/next", { method: "POST", body: {}, channelId: "alpha", creatorId: "creator-a" }));
  await conductorBeta.fetch(channelRequest("/score/next", { method: "POST", body: {}, channelId: "beta", creatorId: "creator-b" }));

  const alphaLibrary = await (await conductorAlpha.fetch(channelRequest("/score/library", { channelId: "alpha", creatorId: "creator-a" }))).json();
  const betaLibrary = await (await conductorBeta.fetch(channelRequest("/score/library", { channelId: "beta", creatorId: "creator-b" }))).json();

  assert.equal(alphaLibrary.entries.length, 1);
  assert.equal(alphaLibrary.entries[0].compositionId, "ai-comp-alpha");
  assert.equal(betaLibrary.entries.length, 1);
  assert.equal(betaLibrary.entries[0].compositionId, "ai-comp-beta");
});

test("replaying/re-queuing the same composition id does not duplicate the library record", async () => {
  const db = new FakeCompositionsD1();
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));

  const library = await (await conductor.fetch(channelRequest("/score/library"))).json();
  assert.equal(library.entries.filter((entry) => entry.compositionId === "ai-comp-1").length, 1);
});

test("GET /score/library clamps the limit and never returns an unbounded history", async () => {
  const db = new FakeCompositionsD1();
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  const now = Date.now();
  for (let i = 0; i < 60; i += 1) {
    db.rows.set(`bulk-${i}`, {
      composition_id: `bulk-${i}`,
      channel_id: "alpha",
      creator_id: "creator-a",
      schema_version: SCORE_SCHEMA_VERSION,
      score_json: "{}",
      composer: "fixture",
      model: null,
      bpm: 120,
      key_root: "A",
      key_mode: "minor",
      bars: 8,
      duration_seconds: 30,
      status: "buffered",
      created_at: new Date(now + i).toISOString(),
      selected_at: null,
    });
  }

  const bigLimitResponse = await conductor.fetch(channelRequest("/score/library?limit=5000"));
  const bigLimitPayload = await bigLimitResponse.json();
  assert.ok(bigLimitPayload.entries.length <= 50);

  const firstPage = await (await conductor.fetch(channelRequest("/score/library?limit=10"))).json();
  assert.equal(firstPage.entries.length, 10);
  const cursor = firstPage.entries[firstPage.entries.length - 1].createdAt;
  const secondPage = await (await conductor.fetch(channelRequest(`/score/library?limit=10&before=${encodeURIComponent(cursor)}`))).json();
  assert.equal(secondPage.entries.length, 10);
  assert.notEqual(secondPage.entries[0].compositionId, firstPage.entries[0].compositionId);
});

test("a library write failure is surfaced but never blocks composing/queuing", async () => {
  const db = new FakeCompositionsD1({ failWrites: true });
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), fakeAiEnv(db));
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.score.compositionId, "ai-comp-1");
  assert.equal(payload.library_persisted, false);

  const selectResponse = await conductor.fetch(channelRequest("/score/select", { method: "POST" }));
  assert.equal(selectResponse.status, 200);

  const library = await (await conductor.fetch(channelRequest("/score/library"))).json();
  assert.equal(library.entries.length, 0);
});

test("the library gracefully no-ops when D1 is unbound", async () => {
  const conductor = new ChannelConductor(makeCtx(new MemoryStorage()), { AI: fakeAiEnv(null).AI });
  await initChannel(conductor);

  const response = await conductor.fetch(channelRequest("/score/next", { method: "POST", body: {} }));
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.library_persisted, false);

  const library = await (await conductor.fetch(channelRequest("/score/library"))).json();
  assert.equal(library.ok, true);
  assert.deepEqual(library.entries, []);
});

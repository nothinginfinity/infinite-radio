import fs from "node:fs";

const token = process.env.TOKEN;
const channelId = process.env.CHANNEL;
const creatorId = process.env.CREATOR;

if (!token || !channelId || !creatorId) {
  throw new Error("TOKEN_CHANNEL_CREATOR_required");
}

const path = "src/index.js";
let source = fs.readFileSync(path, "utf8");

let helper = String.raw`
async function runV03FalAcceptance(env) {
  if (!env.FAL_API_KEY) {
    return json({ ok: false, error: "operator_provider_key_unavailable" }, { status: 503 });
  }

  const channelId = __CHANNEL_JSON__;
  const creatorId = __CREATOR_JSON__;

  async function channelCall(tail, { method = "GET", body, providerKey, overrideCreatorId } = {}) {
    const headers = new Headers({ "x-creator-id": overrideCreatorId || creatorId });
    if (providerKey) headers.set("x-provider-key", providerKey);
    if (body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(
      "https://acceptance.internal/api/channels/" + channelId + tail,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const response = await proxyChannelRequest(request, env, { channelId, tail });
    const data = await response.json();
    return { response, data };
  }

  const init = await channelCall("/init", {
    method: "POST",
    body: {
      creatorId,
      policy: {
        bufferTargetSeconds: 30,
        generationCapPerHour: 1,
      },
    },
  });
  if (!init.response.ok) {
    return json({ ok: false, step: "init", detail: init.data }, { status: init.response.status });
  }

  const provider = await channelCall("/provider", {
    method: "POST",
    providerKey: env.FAL_API_KEY,
    body: {
      provider: "fal-cassetteai",
      generationCapPerHour: 1,
      generationCapPerDay: 1,
      bufferTargetSeconds: 30,
    },
  });
  if (!provider.response.ok) {
    return json({ ok: false, step: "provider", detail: provider.data }, { status: provider.response.status });
  }

  const prompt = await channelCall("/prompts", {
    method: "POST",
    body: {
      id: "v03-real-fal-" + channelId,
      idempotencyKey: "v03-real-fal-" + channelId,
      userId: "operator:v03-acceptance",
      text: "Original instrumental midnight synthwave radio track with warm analog bass, glassy arpeggios, atmospheric pads, and a dramatic futuristic transition. No imitation of any existing artist.",
      votes: 0,
    },
  });
  if (!prompt.response.ok) {
    return json({ ok: false, step: "prompt", detail: prompt.data }, { status: prompt.response.status });
  }

  const generation = await channelCall("/generation/next", {
    method: "POST",
    providerKey: env.FAL_API_KEY,
    body: { durationSeconds: 30 },
  });
  if (!generation.response.ok) {
    return json({ ok: false, step: "generation", detail: generation.data }, { status: generation.response.status });
  }

  const track = generation.data.track;
  const receipt = generation.data.receipt;
  const expectedPrefix = "channels/" + channelId + "/generated/";
  if (!track?.assetKey?.startsWith(expectedPrefix) || track.channelId !== channelId) {
    return json({ ok: false, step: "channel_scope_verify", error: "channel_scope_violation" }, { status: 500 });
  }

  const asset = await env.ASSETS.get(track.assetKey);
  if (!asset) {
    return json({ ok: false, step: "r2_verify", error: "generated_asset_missing" }, { status: 500 });
  }
  const wavBytes = new Uint8Array(await asset.arrayBuffer());
  if (!validateWav(wavBytes)) {
    return json({ ok: false, step: "r2_verify", error: "generated_asset_not_wav" }, { status: 500 });
  }

  const dbResult = await env.DB.prepare(
    "SELECT receipt_id, channel_id, generation_id, provider, model, provider_request_id, duration_seconds, latency_ms, cost_microusd, terms_uri, provenance_json, created_at FROM provider_receipts WHERE receipt_id = ? AND channel_id = ? LIMIT 1",
  ).bind(receipt.receipt_id, channelId).all();
  const persistedReceipt = dbResult?.results?.[0] ?? null;
  if (!persistedReceipt) {
    return json({ ok: false, step: "d1_verify", error: "provider_receipt_missing" }, { status: 500 });
  }

  const foreign = await channelCall("/state", {
    overrideCreatorId: "creator-not-owner",
  });
  if (foreign.response.status !== 400 || foreign.data?.error !== "channel_owner_required") {
    return json({ ok: false, step: "isolation_verify", error: "foreign_creator_not_rejected" }, { status: 500 });
  }

  const ownerState = await channelCall("/state");
  if (!ownerState.response.ok) {
    return json({ ok: false, step: "state_verify", detail: ownerState.data }, { status: ownerState.response.status });
  }
  const job = ownerState.data?.state?.generationJobs?.find(
    (candidate) => candidate.id === generation.data.generation_id,
  );
  if (!job || job.status !== "ready" || job.receiptId !== receipt.receipt_id) {
    return json({ ok: false, step: "state_verify", error: "generation_not_ready" }, { status: 500 });
  }

  return json({
    ok: true,
    channel_id: channelId,
    creator_id: creatorId,
    credential_ref: provider.data?.policy?.credentialRef ?? null,
    generation_id: generation.data.generation_id,
    track,
    receipt,
    proof: {
      state_ready: true,
      r2: {
        asset_key: track.assetKey,
        wav_bytes: wavBytes.byteLength,
        riff: new TextDecoder().decode(wavBytes.slice(0, 4)) === "RIFF",
        wave: new TextDecoder().decode(wavBytes.slice(8, 12)) === "WAVE",
      },
      d1_receipt: persistedReceipt,
      isolation: {
        foreign_creator_rejected: true,
      },
    },
  }, { status: 201 });
}
`;

helper = helper
  .replace("__CHANNEL_JSON__", JSON.stringify(channelId))
  .replace("__CREATOR_JSON__", JSON.stringify(creatorId));

const exportMarker = "\nexport default {\n";
if (!source.includes(exportMarker)) {
  throw new Error("export_default_marker_missing");
}
source = source.replace(exportMarker, "\n" + helper + exportMarker);

const routeMarker =
  '    const url = new URL(request.url);\n\n' +
  '    if (request.method === "GET" && url.pathname === "/health") {';
const routeReplacement =
  '    const url = new URL(request.url);\n\n' +
  '    if (request.method === "GET" && url.pathname === "/__v03_fal_acceptance_' + token + '") {\n' +
  '      return runV03FalAcceptance(env);\n' +
  '    }\n\n' +
  '    if (request.method === "GET" && url.pathname === "/health") {';

if (!source.includes(routeMarker)) {
  throw new Error("fetch_route_marker_missing");
}
source = source.replace(routeMarker, routeReplacement);

fs.writeFileSync(path, source);

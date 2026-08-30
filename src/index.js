import {
  compileStationBrief,
  createStationState,
  enqueuePrompt,
  needsGeneration,
  readyBufferSeconds,
  selectNextPrompt,
} from "./station-state.js";

let state = createStationState({ status: "idle" });

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

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "infinite-radio",
        version: "0.1.0",
        state: {
          status: state.status,
          promptQueue: state.promptQueue.length,
          readyQueue: state.readyQueue.length,
          readyBufferSeconds: readyBufferSeconds(state),
          needsGeneration: needsGeneration(state),
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/station") {
      return json(state);
    }

    if (request.method === "POST" && url.pathname === "/api/prompts") {
      const body = await readJson(request);
      try {
        state = enqueuePrompt(state, body ?? {});
        return json({ ok: true, promptQueue: state.promptQueue }, { status: 202 });
      } catch (error) {
        return json({ ok: false, error: error.message }, { status: 400 });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/conductor/select") {
      const result = selectNextPrompt(state);
      state = result.state;
      return json({
        ok: true,
        selected: result.selected,
        generationBrief: result.selected
          ? compileStationBrief(state, result.selected)
          : null,
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infinite Radio</title></head>
<body style="font-family:system-ui;background:#09090b;color:#fafafa;max-width:760px;margin:60px auto;padding:24px">
  <p>◉ LIVE SYSTEM / V0.1 FOUNDATION</p>
  <h1>Infinite Radio</h1>
  <p>Audience-steered AI radio whose generation loop stays ahead of playback.</p>
  <p>The V0.1 repository currently exposes the deterministic station control API. Audio generation and persistence land in later roadmap slices.</p>
  <pre>GET /health
GET /api/station
POST /api/prompts
POST /api/conductor/select</pre>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return json({ ok: false, error: "not_found" }, { status: 404 });
  },
};

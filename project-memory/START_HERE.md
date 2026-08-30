# START HERE — Infinite Radio

## Current milestone

V0.1 — Foundation / deterministic station core — ACCEPTED.

The accepted V0.1 architecture proves the control loop before paid music generation:
- deterministic prompt queue and vote-first selection
- station-bible continuity state
- ready-audio buffer pressure
- ready -> archive -> starved playback fallback
- Cloudflare Worker API skeleton
- unit-tested station-state transitions

## Architecture boundary

The live/high-frequency data plane belongs in Cloudflare infrastructure. CairnStone is the durable intelligence plane for accepted station identity, era summaries, motifs, creative decisions, policies, and cross-agent handoffs. High-frequency chat, votes, playback events, and telemetry stay out of CairnStone.

## Product discovery update

The accepted single-station state machine remains valid, but the product primitive is now a creator-owned `channel`, not one global station. Each channel will have isolated runtime state, genre/station bible, archive, audience, provider policy, generation budget, provenance, and distribution settings. Cloudflare remains the shared control plane; real music generation is BYOK so creators choose providers/models and bear their own generation cost.

x402 is planned later as an optional channel-owned commerce/distribution rail for explicitly defined resources. Provenance and creator control do not by themselves guarantee copyright ownership; provider/model terms and applicable law remain authoritative for rights questions.

## Next

V0.2 — Channel-first Cloudflare runtime.

Turn the current deterministic station primitive into one isolated channel: one logical Durable Object conductor per `channel_id`, channel-scoped D1/R2 state, fixture/archive audio, Workers AI for inexpensive control intelligence, WebSocket state, and explicit two-channel isolation tests. No paid music-generation API is required for V0.2.

See:
- `docs/ROADMAP.md`
- `docs/ARCHITECTURE.md`

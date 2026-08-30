# START HERE — Infinite Radio

## Current milestone

V0.2 — Channel-first Cloudflare runtime — ACCEPTED / LIVE.

V0.2 has moved the accepted V0.1 control model to a creator-owned channel runtime:
- one logical `ChannelConductor` Durable Object per `channel_id`
- Durable Object persisted channel authority and restart-safe state
- channel-scoped D1 schema and R2 `channels/{channel_id}/...` assets
- creator ownership and credential-reference isolation
- durable prompt idempotency plus generation/asset replay receipts
- WebSocket state fanout
- zero-cost real RIFF/WAV fixture audio
- optional Workers AI control brief with deterministic fallback
- concurrent two-channel and 30-minute no-stall simulation coverage

Accepted deployment checkpoint: `54edb80c81f5aa563de1409d23c664f33a8a0e4e`.
CI: `33339178937` — success.
Deploy + live acceptance: `33339178936` — success.
Live Worker: `https://infinite-radio.jaredtechfit.workers.dev`.
Cloudflare Worker version: `6e060a21-d448-4df2-80c5-c7d4f8d84924`.
Cloudflare resources: D1 `infinite-radio-db` (`1293ae6e-8caf-4e95-90d8-136945370d33`) and R2 `infinite-radio-assets`; D1 schema verified remotely.

## Architecture boundary

The live/high-frequency data plane belongs in Cloudflare infrastructure. CairnStone is the durable intelligence plane for accepted station identity, era summaries, motifs, creative decisions, policies, and cross-agent handoffs. High-frequency chat, votes, playback events, and telemetry stay out of CairnStone.

## Product discovery update

The accepted single-station state machine remains valid, but the product primitive is now a creator-owned `channel`, not one global station. Each channel will have isolated runtime state, genre/station bible, archive, audience, provider policy, generation budget, provenance, and distribution settings. Cloudflare remains the shared control plane; real music generation is BYOK so creators choose providers/models and bear their own generation cost.

x402 is planned later as an optional channel-owned commerce/distribution rail for explicitly defined resources. Provenance and creator control do not by themselves guarantee copyright ownership; provider/model terms and applicable law remain authoritative for rights questions.

## Next

V0.3 — BYOK music provider layer.

Preserve V0.2's accepted channel isolation, Durable Object authority, channel-scoped D1/R2 provenance, idempotency, and zero platform-funded music generation while adding the first real creator-supplied music provider adapter.

See:
- `docs/ROADMAP.md`
- `docs/ARCHITECTURE.md`

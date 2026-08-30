# START HERE — Infinite Radio

## Current milestone

V0.2 — Channel-first Cloudflare runtime — ACTIVE / SOURCE + INFRA VERIFIED, LIVE DEPLOY PENDING.

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

Exact source checkpoint: `9642f4ca70f422cf97ec84ce3adaa0023eb74d90`.
CI: `33337926486` — success.
Cloudflare resources: D1 `infinite-radio-db` (`1293ae6e-8caf-4e95-90d8-136945370d33`) and R2 `infinite-radio-assets`; D1 schema verified remotely.

## Architecture boundary

The live/high-frequency data plane belongs in Cloudflare infrastructure. CairnStone is the durable intelligence plane for accepted station identity, era summaries, motifs, creative decisions, policies, and cross-agent handoffs. High-frequency chat, votes, playback events, and telemetry stay out of CairnStone.

## Product discovery update

The accepted single-station state machine remains valid, but the product primitive is now a creator-owned `channel`, not one global station. Each channel will have isolated runtime state, genre/station bible, archive, audience, provider policy, generation budget, provenance, and distribution settings. Cloudflare remains the shared control plane; real music generation is BYOK so creators choose providers/models and bear their own generation cost.

x402 is planned later as an optional channel-owned commerce/distribution rail for explicitly defined resources. Provenance and creator control do not by themselves guarantee copyright ownership; provider/model terms and applicable law remain authoritative for rights questions.

## Next

Close V0.2 live acceptance without weakening its isolation model:
1. deploy the Worker with the `ChannelConductor` Durable Object migration plus D1/R2/AI bindings
2. smoke `/health`, channel init/state, idempotent prompt retry, conductor fixture generation, playback, and a second isolated channel against the live Worker
3. verify D1/R2 channel-scoped receipts/assets after the live run
4. only then mark V0.2 `ACCEPTED` and advance the roadmap to V0.3 BYOK music providers

No paid music-generation API is required for the V0.2 acceptance run.

See:
- `docs/ROADMAP.md`
- `docs/ARCHITECTURE.md`

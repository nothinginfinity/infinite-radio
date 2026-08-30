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

## Next

V0.2 — Durable single-station conductor.

Move in-memory station state into a Durable Object, add$D1[DEBUG] schemas for prompts/generations/tracks/votes/provider receipts, define the R2 audio asset contract, add idempotent job lifecycles and WebSocket state, then prove a 30-minute fixture-audio simulation without station stalls.

See:
- `docs/ROADMAP.md`
- `docs/ARCHITECTURE.md`

# START HERE — Infinite Radio

## Current milestone

V0.3 — BYOK music provider layer — ACTIVE / LIVE BOUNDARY ACCEPTED; REAL PROVIDER GENERATION PENDING CREATOR BYOK KEY.

V0.2 remains accepted and live. V0.3 now adds the first real creator-funded music-generation path without weakening the channel-first runtime:
- provider-neutral channel policy with `fixture` and first external adapter `fal-cassetteai`
- request-scoped BYOK handling; only a SHA-256 credential reference persists
- wrong-key rejection before provider invocation and normalized safe provider error codes before persistence
- invocation-log and trace hardening so request credentials are not intentionally captured by Worker observability
- D1 V0.3 schema for provider/model/error data, daily caps, track content metadata, and normalized provider receipts
- generated WAV validation before READY and R2 storage under `channels/{channel_id}/generated/...`
- successful real-generation tracks retained in the channel archive for provider-outage fallback
- hourly + rolling-24-hour generation ceilings and exponential provider retry backoff
- normalized duration, latency, cost, request-ID, pricing, and provider-terms provenance
- source tests for raw-secret rejection, cross-channel asset rejection, BYOK mismatch, request-scoped adapter use, safe error normalization, daily/hourly caps, provider health/backoff, and archive fallback

Source checkpoint: `88a94f20b6d88a8e3a42feacc7a46473709f63bc`.
CI: `33342391862` — success.
Deploy + V0.3 live-boundary acceptance: `33342391857` — success.
Live Worker: `https://infinite-radio.jaredtechfit.workers.dev`.
Cloudflare resources remain D1 `infinite-radio-db` (`1293ae6e-8caf-4e95-90d8-136945370d33`) and R2 `infinite-radio-assets`.

The remaining V0.3 acceptance step is intentionally not fabricated: a creator must supply a real fal BYOK key for one external generation call so playable provider audio, actual provider request ID, observed latency, and cost attribution are verified end-to-end. Until then V0.3 remains `ACTIVE`, not `ACCEPTED`.

## Architecture boundary

The live/high-frequency data plane belongs in Cloudflare infrastructure. CairnStone is the durable intelligence plane for accepted station identity, era summaries, motifs, creative decisions, policies, and cross-agent handoffs. High-frequency chat, votes, playback events, and telemetry stay out of CairnStone.

## Product discovery update

The accepted single-station state machine remains valid, but the product primitive is now a creator-owned `channel`, not one global station. Each channel will have isolated runtime state, genre/station bible, archive, audience, provider policy, generation budget, provenance, and distribution settings. Cloudflare remains the shared control plane; real music generation is BYOK so creators choose providers/models and bear their own generation cost.

x402 is planned later as an optional channel-owned commerce/distribution rail for explicitly defined resources. Provenance and creator control do not by themselves guarantee copyright ownership; provider/model terms and applicable law remain authoritative for rights questions.

## Next

Finish V0.3 real-provider acceptance with one creator-supplied fal BYOK key. Do not persist or stone the raw key; use it only for the live request, verify the returned WAV/R2 asset and normalized receipt, then close V0.3 canonically.

After V0.3 is accepted, proceed to V0.4 — listener player / seamless station.

See:
- `docs/ROADMAP.md`
- `docs/ARCHITECTURE.md`

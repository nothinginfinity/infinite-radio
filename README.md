# Infinite Radio

Infinite Radio is a creator-owned network for continuously playing AI music channels.

Each creator can launch a channel with its own genre, station bible, audience, provider policy, generation budget, archive, and distribution rules. Audience prompts become candidates inside that channel; a conductor selects them, a prompt compiler maps them into the channel's musical identity, generators render audio ahead of playback, and the player crossfades through a ready buffer. CairnStone preserves durable creative state per channel without forcing the live runtime to carry an ever-growing model context.

## Product principle

**Do not build one infinitely continued song or one giant shared station. Build a network of creator-controlled channels whose identities persist.**

Generation and playback are separate loops:

```text
CHAT -> CURATION -> PROMPT COMPILER -> GENERATION -> READY QUEUE
                                      |
CURRENT TRACK -> TRANSITION -> NEXT TRACK -> TRANSITION -> ...
```

The broadcast loop must never block on generation. If the generation queue is late or unhealthy, the station falls back to safe archive material.

## V0.1 scope

The first milestone proves the control loop before adding paid music generation. That accepted single-station model is the deterministic primitive that later becomes one isolated creator channel:

- deterministic station state
- prompt queue and selection
- station-bible continuity fields
- playback buffer target
- archive fallback decision
- Cloudflare Worker API skeleton
- tests for the core state machine

See [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local development

Requires Node.js 22+.

```bash
npm test
npm run check
npm run dev
```

`npm run dev` uses Wrangler once dependencies are installed.

## Planned platform

- Cloudflare Worker for the shared HTTP/API control plane
- one Durable Object conductor per creator channel
- D1 for channel-scoped prompts, generations, votes, receipts, policies, metrics, and metadata
- R2 namespaced by channel for generated audio, DJ assets, and distributable artifacts
- Workers AI for low-cost control intelligence such as prompt compilation, moderation, programming, and DJ copy/TTS where appropriate
- provider-neutral BYOK music generation so creators can choose providers/models and pay their own generation costs
- Web Audio API for low-latency browser playback/crossfades
- CairnStone v7 for accepted per-channel memory, era summaries, creative decisions, and cross-agent handoffs
- x402 as a later optional distribution/payment rail for creator-defined access, streams, releases, or licenses

## Non-goals for V0.1

- 24/7 production broadcast
- public creator accounts
- multi-channel tenancy
- BYOK credential management
- x402 payments/distribution
- long-form songs
- server-side audio mastering
- automatic copyright-style imitation
- storing high-frequency playback telemetry in CairnStone

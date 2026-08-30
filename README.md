# Infinite Radio

Infinite Radio is a crowd-steered, continuously playing AI music station.

Audience prompts become candidates. A conductor selects them, a prompt compiler maps them into the station's current musical identity, generators render short audio segments ahead of playback, and the player crossfades through a ready buffer. CairnStone preserves durable creative state across sessions without forcing the live runtime to carry an ever-growing model context.

## Product principle

**Do not build one infinitely continued song. Build an infinite radio station whose identity persists.**

Generation and playback are separate loops:

```text
CHAT -> CURATION -> PROMPT COMPILER -> GENERATION -> READY QUEUE
                                      |
CURRENT TRACK -> TRANSITION -> NEXT TRACK -> TRANSITION -> ...
```

The broadcast loop must never block on generation. If the generation queue is late or unhealthy, the station falls back to safe archive material.

## V0.1 scope

The first milestone proves the control loop before adding paid music generation:

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

- Cloudflare Worker for HTTP/API control plane
- Durable Object for single-station real-time coordination
- D1 for prompts, generations, votes, metrics, and metadata
- R2 for generated audio and DJ assets
- Web Audio API for low-latency browser playback/crossfades
- fal providers for short music generation
- CairnStone v7 for accepted station memory, era summaries, creative decisions, and cross-agent handoffs

## Non-goals for V0.1

- 24/7 production broadcast
- public user accounts
- payments
- long-form songs
- server-side audio mastering
- automatic copyright-style imitation
- storing high-frequency playback telemetry in CairnStone

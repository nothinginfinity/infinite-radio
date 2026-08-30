# Infinite Radio Roadmap

Status legend: `PLANNED` · `ACTIVE` · `ACCEPTED`

## V0.1 — Foundation / deterministic station core — ACTIVE

Goal: prove the station control model before spending money on generation.

### Deliverables
- [x] repository bootstrap
- [x] architecture contract
- [x] deterministic station state
- [x] prompt queue and vote-first selector
- [x] station-bible continuity object
- [x] ready-buffer accounting
- [x] archive fallback decision
- [x] prompt-to-generation brief compiler
- [x] Cloudflare Worker API skeleton
- [x] unit tests for core state transitions
- [ ] CI run green on canonical commit
- [ ] CairnStone repo + roadmap acceptance

### Acceptance
- core tests pass
- no paid API required
- broadcast selection can proceed independently of generation
- a starved ready queue degrades to archive, then explicit `starved`
- roadmap and architecture are canonically stoned

---

## V0.2 — Durable single-station conductor — PLANNED

Goal: move mutable station state out of Worker process memory.

### Deliverables
- Durable Object `StationConductor`
- D1 schema for prompts, generations, tracks, votes, provider receipts
- R2 bucket contract for audio assets
- idempotent prompt submission
- generation-job lifecycle: `candidate -> selected -> generating -> validating -> ready | failed`
- WebSocket station-state updates
- configurable buffer target and generation cap

### Acceptance
- Worker restart does not lose authoritative station state
- duplicate submissions/retries do not duplicate generation jobs
- conductor can simulate a 30-minute station using fixture audio with no stalls

---

## V0.3 — First real music generation — PLANNED

Goal: make a live short-form audio segment from a listener prompt.

### Deliverables
- provider-neutral `MusicGenerator` interface
- first fal adapter
- secret/config isolation
- duration/latency/cost receipt normalization
- R2 asset ingestion
- retry/backoff policy
- hard per-minute and daily cost ceiling
- provider health telemetry

### Acceptance
- real prompt generates a playable asset
- asset reaches READY only after validation
- provider outage exercises archive fallback
- cost and latency are measurable per generation

---

## V0.4 — Listener player / seamless station — PLANNED

Goal: make the station feel live.

### Deliverables
- mobile-first listener page
- dual-source Web Audio playback
- preload + 2–4 second crossfade
- “now playing” prompt/user attribution
- queue preview
- live waveform/visualizer
- reconnect behavior
- archive fallback UX

### Acceptance
- 30-minute browser soak test without an audible gap caused by application logic
- listener reload rejoins current station state
- next segment is preloaded before transition

---

## V0.5 — Crowd steering — PLANNED

Goal: turn the station into a game.

### Deliverables
- public prompt submission
- voting
- anti-spam/rate limits
- user fairness
- novelty/repetition penalties
- modes: DJ, Jukebox, Chaos
- moderation pipeline
- prompt status feedback

### Acceptance
- one busy queue does not generate once per message
- conductor remains within generation/cost caps
- repeat users/prompts cannot monopolize the station

---

## V0.6 — DJ transitions + station personality — PLANNED

Goal: hide discontinuities by making them entertainment.

### Deliverables
- DJ copy agent
- optional TTS drops
- transition/sting library
- configurable DJ persona
- metadata-aware transitions
- no-DJ mode

### Acceptance
- unrelated prompts can transition coherently without audio-to-audio continuation
- TTS failure does not block next music track

---

## V0.7 — CairnStone station memory — PLANNED

Goal: make the station become more coherent over time without an ever-growing context window.

### Deliverables
- dedicated CairnStone station-memory chain
- accepted station-bible path
- era-summary schema
- motif/character history
- creative-decision stones
- bounded context package for prompt compiler / DJ / continuity agents
- periodic D1 -> compressed-era promotion policy
- explicit rule: high-frequency telemetry stays out of CairnStone

### Acceptance
- a fresh agent/client can reconstruct current creative identity from accepted state
- 10,000 historical prompts do not need to enter the active model context
- station history remains queryable by era/motif/character

---

## V0.8 — Multi-provider quality routing — PLANNED

Goal: route cheap filler and premium feature tracks differently.

### Deliverables
- provider capability registry
- fast filler route
- feature-track route
- provider failover
- instrumental/vocal policies
- quality/latency/cost scoring
- A/B testing hooks

---

## V0.9 — Program intelligence — PLANNED

Goal: let audience response shape programming.

### Deliverables
- skip/retention/upvote metrics
- Program Director agent
- motif fatigue detection
- controlled exploration vs exploitation
- era transition suggestions
- human operator override

---

## V1.0 — 24/7 public station — PLANNED

Goal: production launch.

### Deliverables
- production observability
- moderation/admin console
- abuse handling
- asset retention policy
- cost alarms
- multi-region/recovery strategy where needed
- polished listener UX
- optional synchronized HLS/Icecast/RTMP output
- documented provider/legal/attribution policies

### Launch invariant

The station keeps playing even when:
- chat is empty
- a generation fails
- a provider is down
- the LLM control layer is unavailable
- CairnStone is temporarily unreachable

The intelligence layer improves the broadcast; it is never allowed to become the only thing keeping audio alive.

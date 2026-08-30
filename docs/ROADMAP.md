# Infinite Radio Roadmap

Status legend: `PLANNED` · `ACTIVE` · `ACCEPTED`

## V0.1 — Foundation / deterministic station core — ACCEPTED

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
- [x] CI run green on canonical commit
- [x] CairnStone repo + roadmap acceptance

### Acceptance
- core tests pass
- no paid API required
- broadcast selection can proceed independently of generation
- a starved ready queue degrades to archive, then explicit `starved`
- roadmap and architecture are canonically stoned

---

## V0.2 — Channel-first Cloudflare runtime — PLANNED

Goal: turn the accepted single-station control loop into one isolated creator channel while keeping development Cloudflare-native and generation-cost-free.

### Deliverables
- first-class `channel_id` and creator/channel ownership model
- Durable Object `ChannelConductor`, one logical conductor per channel
- D1 schema for creators, channels, memberships, prompts, generations, tracks, votes, policies, and provider receipts with channel scoping
- R2 namespace contract: `channels/{channel_id}/...`
- idempotent prompt submission and generation-job lifecycle
- WebSocket channel-state updates
- configurable per-channel buffer target and generation cap
- fixture/archive audio provider for zero-cost simulation
- Workers AI control layer for prompt compilation/moderation/programming and optional DJ copy/TTS where appropriate
- explicit tenant-isolation tests

### Acceptance
- Worker restart does not lose authoritative channel state
- duplicate submissions/retries do not duplicate generation jobs
- two simulated channels can run concurrently without queue/state/asset crossover
- one channel cannot consume another channel's budget or credential reference
- one channel can simulate 30 minutes of fixture audio with no stalls
- no paid music-generation API is required

---

## V0.3 — BYOK music provider layer — PLANNED

Goal: let a channel creator opt into real music generation without making Infinite Radio subsidize GPU usage or hard-wire one vendor.

### Deliverables
- provider-neutral `MusicGenerator` interface
- channel-scoped provider/model policy
- opaque credential-reference contract; raw BYOK secrets never enter D1/R2/CairnStone/logs
- first external BYOK music adapter selected for lowest practical complexity/cost
- duration/latency/cost/provenance receipt normalization
- R2 asset ingestion under the authorized channel namespace
- retry/backoff and provider-health policy
- hard per-channel hourly/daily generation ceilings
- explicit provider-terms/provenance capture

### Acceptance
- a creator-authorized real prompt generates a playable asset for the correct channel
- asset reaches READY only after validation
- provider outage exercises that channel's archive fallback
- cost and latency are measurable per generation and attributable to the correct channel
- a channel cannot invoke another channel's credential reference

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

## V0.5 — Creator accounts + multi-channel management — PLANNED

Goal: let one creator own and operate one or many distinct channels without weakening tenant isolation.

### Deliverables
- creator account/session model
- create/edit/archive channel lifecycle
- channel slug/identity/visibility settings
- creator dashboard with multiple channels
- channel-specific genre/station bible controls
- channel-specific provider/budget policy
- owner/member authorization boundaries
- import/export of channel configuration without raw secrets

### Acceptance
- one creator can operate multiple channels independently
- two different creators cannot read or mutate each other's private channel state
- deleting/archiving one channel cannot damage another

---

## V0.6 — Crowd steering — PLANNED

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

## V0.7 — DJ transitions + channel personality — PLANNED

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

## V0.8 — CairnStone channel memory — PLANNED

Goal: let each creator channel become more coherent over time without an ever-growing context window or cross-channel leakage.

### Deliverables
- channel-scoped CairnStone memory chain/policy
- accepted channel-bible path
- era-summary schema
- motif/character history
- creative-decision stones
- bounded context package for prompt compiler / DJ / continuity agents
- periodic D1 -> compressed-era promotion policy
- explicit rule: high-frequency telemetry stays out of CairnStone

### Acceptance
- a fresh agent/client can reconstruct current creative identity from accepted state
- 10,000 historical prompts do not need to enter the active model context
- channel history remains queryable by era/motif/character
- one channel's context package contains no private memory from another channel

---

## V0.9 — Multi-provider quality routing — PLANNED

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

## V0.10 — Program intelligence — PLANNED

Goal: let audience response shape programming.

### Deliverables
- skip/retention/upvote metrics
- Program Director agent
- motif fatigue detection
- controlled exploration vs exploitation
- era transition suggestions
- human operator override

---

## V0.11 — Creator distribution + x402 commerce — PLANNED

Goal: let creators selectively distribute or sell access to artifacts and channel resources they funded, without coupling playback uptime to payment infrastructure.

### Deliverables
- creator-defined public/private/premium distribution policy
- immutable release manifest tying asset -> channel -> generation provenance -> provider receipt
- x402 resource contract for explicitly priced resources
- candidate resources: premium stream access, track/release download, remix/use offer, agent-accessible catalog/API
- settlement/access receipts separated from creative provenance
- revocation/expiry policy where the resource type permits it
- no claim that platform provenance alone creates copyright ownership

### Acceptance
- creator can publish a clearly defined paid test resource from their own channel
- successful payment grants only the advertised resource/access
- payment failure never stops a free/public channel from broadcasting
- another creator cannot monetize an asset outside their authorization boundary

---

## V1.0 — Multi-channel creator network — PLANNED

Goal: production launch as a network capable of hosting many independent creator channels.

### Deliverables
- production observability
- creator/channel administration and moderation console
- abuse handling
- channel-scoped asset retention policy
- channel/provider cost alarms
- multi-region/recovery strategy where needed
- discovery/listener UX for many channels
- optional synchronized HLS/Icecast/RTMP output per channel
- documented provider/legal/attribution/provenance policies
- scale tests proving tenant isolation under many active channels

### Launch invariant

Each channel keeps playing even when:
- its chat is empty
- a generation fails
- its configured provider is down
- the LLM control layer is unavailable
- CairnStone is temporarily unreachable
- x402/payment infrastructure is unavailable

Failure or overload in one channel must not stop unrelated channels. The intelligence and commerce layers improve the network; neither is allowed to become the only thing keeping audio alive.

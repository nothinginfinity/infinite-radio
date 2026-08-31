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

## V0.2 — Channel-first Cloudflare runtime — ACCEPTED

Goal: turn the accepted single-station control loop into one isolated creator channel while keeping development Cloudflare-native and generation-cost-free.

### Implementation checkpoint — 2026-08-30
- channel-first runtime, Durable Object conductor, channel-scoped D1/R2 contracts, WebSocket state, idempotent prompt/generation lifecycle, zero-cost WAV fixtures, and optional Workers AI control logic are implemented on `main`
- D1 `infinite-radio-db` and R2 `infinite-radio-assets` exist; the V0.2 D1 schema is applied and verified remotely
- source acceptance tests include Durable Object reconstruction, late retry idempotency, ownership/credential isolation, two-channel isolation, actual RIFF/WAV fixture output, Workers AI deterministic fallback, and a 30-minute concurrent fixture simulation
- exact code checkpoint `9642f4ca70f422cf97ec84ce3adaa0023eb74d90` passed CI run `33337926486`
- live Worker deployed and externally accepted at `https://infinite-radio.jaredtechfit.workers.dev`
- production acceptance run `33339178936` succeeded after exact deploy, D1 migration check, and 12/12 source tests
- Cloudflare Worker version `6e060a21-d448-4df2-80c5-c7d4f8d84924` exposed `CHANNEL_CONDUCTOR`, D1, R2, and Workers AI bindings
- live acceptance proved two isolated creator channels, owner rejection, prompt replay idempotency before and after consumption, channel-scoped fixture assets, persisted Durable Object state, and Workers AI control output
- V0.2 is `ACCEPTED`; V0.3 BYOK music provider layer is next

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

## V0.3 — Provider-neutral BYOK rendering boundary — ACCEPTED BOUNDARY / SUPERSEDED AS CORE PATH

Goal: preserve creator-scoped external music rendering without making a funded GPU/audio provider a prerequisite for Infinite Radio's core music loop.

### Accepted boundary
- provider-neutral generation contract and creator-scoped BYOK credential boundary are implemented
- request-only secrets are fingerprinted but never persisted raw
- external provider receipts, cost/latency provenance, retry/backoff, health policy, and channel isolation are implemented
- fal/CassetteAI and Stable Audio adapters remain available as optional rendering paths
- real external fal inference was blocked by provider/account HTTP 403 despite successful authentication

### Architecture decision

The prior V0.3 acceptance requirement for a real provider-rendered WAV/MP3 is superseded by V0.3.1. External audio renderers are optional premium interpretations of the canonical score; they no longer gate the product's core completion path.

---

## V0.3.1 — Structured Composition Engine + Browser Synth — ACTIVE

Goal: make a versioned structured musical composition the canonical creative asset and prove original model-generated music can be composed, validated, persisted, and performed without requiring a paid external audio renderer.

### Canonical pipeline

```text
channel musical DNA + listener intent
  -> Workers AI composer
  -> infinite-radio-score-v1
  -> deterministic validator/normalizer
  -> channel-scoped score persistence
  -> browser Web Audio renderer
  -> audible music
```

### Architectural rules
- `infinite-radio-score-v1` is canonical; WAV/MP3 is a rendering, not the source asset
- LLM output is untrusted constrained data and is never evaluated as code or arbitrary DSP
- trusted runtime channel/creator identity overrides model-supplied identity
- Channel Conductor owns continuity: key/mode, BPM range, motifs, palette, energy, arrangement history, listener influence, prior-score identity, and transition hints
- browser Web Audio performs validated scores locally
- deterministic fixture composition remains first-class for CI and failure fallback
- existing fal/Stable Audio adapters remain optional BYOK premium renderers

### Implementation checkpoint — 2026-08-30
- `src/score-schema.js` defines the score schema constants, validator/normalizer choke point, hard safety bounds, trusted identity override, and deterministic fixture composer
- `test/score-schema.test.js` covers valid output and rejection boundaries
- checkpoint `1e4229e7f5fb29eeee587fd1600078ea87cfbec2` passed CI `33354280978` and Cloudflare deploy `33354280998`
- remaining active work: Workers AI composer adapter, conductor composition queue/continuity, score persistence/retrieval, browser renderer, prebuffer/scheduling, and live end-to-end acceptance

### Acceptance
- a real Workers AI call creates an original score from channel state + listener intent
- deterministic validation succeeds before persistence or playback
- score ownership and persistence remain channel-isolated
- browser can audibly perform the score using only validated data and allowlisted patches
- invalid/unavailable model output degrades to deterministic composition without losing station operation
- score B can be prepared before score A ends
- all existing BYOK credential/isolation tests remain green
- CI, deploy, production acceptance, CairnStone reconciliation/lint, and AC1 handoff pass

---

## V0.4 — Infinite Station / seamless listener experience — PLANNED

Goal: make structured compositions feel like a continuous living station rather than isolated generated clips.

### Deliverables
- mobile-first listener/player surface
- composition prebuffering and gap-resistant scheduling
- transitions/crossfades between score performances
- reconnect and current-position behavior
- now-playing composition/prompt/creator attribution
- queue preview and listener steering hooks
- waveform/visualizer or score-aware visualization
- archive/fixture fallback UX
- longer-running station soak behavior

### Acceptance
- 30-minute browser soak without an application-caused audible gap
- listener reload can rejoin authoritative channel state
- next composition is prepared before the current composition ends
- Workers AI/provider failure does not silence a public station

---

## V0.5 — Web Music Workstation — PLANNED

Goal: turn the structured-score player into an editable browser-native music workstation.

### Deliverables
- score inspector and arrangement/timeline view
- piano-roll or equivalent note editor
- track mixer controls
- allowlisted synth/patch selection
- tempo/key/section controls
- direct note/chord/drum editing
- bounded automation/effect editing
- undo/redo and non-destructive revision preview
- import/export of the canonical score without raw credentials

### Acceptance
- creator can modify a persisted score without running another model inference
- one-note, one-chord, one-track, and tempo edits are audible immediately in local playback
- workstation cannot create a score that bypasses canonical validation

---

## V0.6 — AI Co-Producer / targeted score patches — PLANNED

Goal: make the LLM a bounded collaborator that can change selected musical regions instead of regenerating whole songs.

### Deliverables
- versioned `score-patch` contract
- selection model for bars/sections/tracks/events
- prompts such as “rewrite bars 17-20, keep drums, change bass, modulate to C minor”
- preserve/lock constraints for untouched score regions
- patch validation against the same score safety rules
- preview / apply / reject flow
- deterministic patch diff
- model/provider adapter boundary shared with structured composition

### Acceptance
- a selected section can be changed while locked sections remain content-identical
- rejected patch leaves canonical score unchanged
- accepted patch produces a new valid revision rather than mutating history in place

---

## V0.7 — Immutable Score + Station DNA provenance — PLANNED

Goal: make musical lineage a first-class graph so every meaningful edit, AI transformation, and fork can be traced without relying on mutable metadata.

### Deliverables
- content identity/hash for canonical scores
- immutable score revisions
- `parent_score_id` and `root_score_id`
- Station DNA identity and immutable revisions
- score -> Station DNA provenance
- composer/model/seed provenance
- bounded human-edit provenance
- fork lineage and attribution metadata
- license/remix-policy references separated from creative content
- lineage graph queries

### Acceptance
- Score B derived from Score A never overwrites A
- a fork can resolve its parent, root, creator, Station DNA, and generation/edit provenance
- identical canonical content has deterministic content identity
- provenance graph does not imply legal copyright ownership by itself

---

## V0.8 — Creator publishing + multi-channel management — PLANNED

Goal: let creators operate many musical universes and publish compositions or Station DNA under explicit visibility/remix policies.

### Deliverables
- creator account/session model
- create/edit/archive channel lifecycle
- creator dashboard across channels
- channel slug/identity/visibility settings
- publish/unpublish score revisions
- publish Station DNA revisions
- public/private/unlisted visibility
- remix/fork permission policy
- owner/member authorization boundaries
- discovery metadata and creator profiles
- import/export without raw secrets

### Acceptance
- one creator can operate multiple isolated channels
- another creator cannot read/mutate private scores, DNA, policies, or credentials
- a published artifact resolves to an immutable canonical revision and provenance root
- archiving one channel cannot damage another

---

## V0.9 — x402 music resources — PLANNED

Goal: expose creator-defined music resources through HTTP-native payment/access without making the free/public broadcast loop depend on commerce infrastructure.

### Candidate resources
- canonical score retrieval/download
- MIDI / MusicXML export
- authorized score fork
- authorized Station DNA fork
- premium renderer request
- commercial-use or other creator-defined license offer
- agent-accessible catalog/API resources

### Deliverables
- explicit x402 resource contract and price/policy metadata
- simple creator-defined payment recipient (`payTo`) as the first settlement model
- payment/access receipts separated from creative provenance
- entitlement/resource delivery boundaries
- idempotency/replay protection
- revocation/expiry where the resource type supports it
- machine-readable discovery metadata
- no assumption that base x402 automatically performs arbitrary multi-party royalty splits

### Acceptance
- creator can publish a paid test resource from their own canonical artifact
- successful payment unlocks only the advertised resource
- payment failure or facilitator outage never stops a free/public channel
- another creator cannot monetize an artifact outside their authorization boundary

---

## V0.10 — Program intelligence + multi-provider routing — PLANNED

Goal: improve musical programming and rendering quality without changing the canonical score contract.

### Deliverables
- composer/provider capability registry
- cost/latency/quality scoring
- inexpensive default composer route and premium feature route
- model/provider failover
- audience skip/retention/upvote metrics
- Program Director agent
- motif fatigue detection
- controlled exploration vs exploitation
- era transitions and human override
- optional CairnStone channel-memory summaries for bounded long-term creative context

### Acceptance
- model/provider can change without changing score consumers
- expensive renderers/composers are opt-in by creator policy
- one channel's programming state or memory cannot leak into another

---

## V0.11 — Open machine music economy — PLANNED

Goal: make scores, Station DNA, licenses, composers, and renderers usable by humans and autonomous agents as discoverable programmatic resources.

### Deliverables
- agent-friendly resource/catalog discovery
- MCP/x402 integration where useful
- machine-readable score/DNA/license metadata
- autonomous license/fork/payment workflows
- third-party composer adapters that emit the canonical score contract
- third-party renderer adapters that consume the canonical score contract
- optional provenance-aware royalty router for derivative economics
- recursive royalty policy only when explicitly configured and technically/legal-policy reviewed
- external consumers such as games, streams, podcasts, virtual worlds, and creative agents

### Acceptance
- an authorized agent can discover an offered resource, satisfy its payment/access policy, and consume it without a bespoke bilateral integration
- external composer/renderer plugins cannot bypass canonical validation or ownership boundaries
- any royalty routing is derived from explicit policy + provenance, not inferred ownership

---

## V1.0 — Infinite Radio protocol + creator network — PLANNED

Goal: production launch as an open creator network built around portable structured music rather than one proprietary AI-audio renderer.

### Deliverables
- production observability and creator/channel administration
- abuse/moderation handling
- public discovery/listener UX across many channels
- stable documented score, patch, Station DNA, provenance, renderer, and commerce contracts
- channel-scoped retention/cost controls
- recovery/scale strategy
- optional HLS/Icecast/RTMP or rendered distribution outputs
- documented provider/legal/attribution/provenance policies
- scale tests proving tenant isolation under many active channels
- reference browser player + Web DAW
- documented third-party integration path for composers/renderers/agents

### Launch invariant

Each channel keeps playing even when:
- its chat is empty
- a composition/generation attempt fails
- its configured external renderer/provider is down
- the LLM control layer is unavailable
- CairnStone is temporarily unreachable
- x402/payment infrastructure is unavailable

Failure or overload in one channel must not stop unrelated channels. The score protocol remains useful when any single AI provider, renderer, wallet system, or platform integration disappears.

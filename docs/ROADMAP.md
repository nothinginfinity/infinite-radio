# Infinite Radio Roadmap

Status legend: `PLANNED` · `ACTIVE` · `FEATURE COMPLETE` · `ACCEPTED`

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

## V0.3.1 — Structured Composition Engine + Browser Synth — ACCEPTED

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
- Workers AI composition is live through the provider-neutral composer adapter; untrusted model text is JSON-parsed only, then validated/normalized, with deterministic fallback on any failure
- Channel Conductor now owns a persisted composition queue plus continuity state and exposes `POST /score/next`, `POST /score/select`, and retrievable public score state
- checkpoint `a144ca5bf0b7a3b06141fad38a99768e29f228f2` live-proved real Workers AI composition -> validated persisted score, while invalid generations fail closed to fixture without silencing the channel
- Step 5 shipped the mobile-first browser workspace shell and isolated native Web Audio `ScoreRenderer`; only validated allowlisted score data reaches playback and no arbitrary generated JavaScript, DSP, AudioWorklet, or unrestricted graph is accepted
- Step 6 shipped a serialized composition-mutation boundary plus `POST /score/prebuffer`; concurrent prebuffer requests create at most one future score, and the browser automatically advances A -> B while beginning to prepare C
- runtime checkpoint `60899cddb812d8a13279e466101ef0c320b6d5ac` passed CI `33359253121` and clean deploy/live acceptance `33359253094`
- final real-model acceptance checkpoint `276f0bf34fc929c68eda7b9b0618e80152e35d8c` passed CI `33359597499` and deploy/live acceptance `33359597442`; production acceptance requires a genuine Workers AI score, verifies `provenance.composer = workers-ai`, proves the exact score is persisted/retrievable/selectable, and proves it does not appear in another channel
- mobile live evidence `vb_9c84100c` returned HTTP 200 at 393x852 with scroll width equal to viewport width (393), proving the Step 6 player remains phone-width clean
- V0.3.1 is accepted; direct score editing remains intentionally deferred to V0.5 and the next product slice is V0.4 listener/Visual experience

### Acceptance — PASSED
- [x] a real Workers AI call creates an original score from channel state + listener intent
- [x] deterministic validation succeeds before persistence or playback
- [x] score ownership and persistence remain channel-isolated
- [x] browser performs the score through native Web Audio using only validated data and allowlisted patches
- [x] invalid/unavailable model output degrades to deterministic composition without losing station operation
- [x] score B can be prepared before score A ends
- [x] all existing BYOK credential/isolation tests remain green
- [x] CI, deploy, production acceptance, CairnStone reconciliation/lint, and AC1 coordination evidence pass

---

## V0.4 — Infinite Station / seamless listener experience — FEATURE COMPLETE / LONG-SOAK HARDENING DEFERRED

Goal: make structured compositions feel like a continuous living station while establishing the reusable interaction shell that later becomes the Chat DAW.

### Step 1 checkpoint — 2026-08-30 — ACCEPTED
- **Visual** is now the default listener projection and **Score** remains an alternate read-only projection; both consume the same frozen canonical score object and neither introduces the V0.5 edit-command path
- the Visual projection derives deterministic presentation metrics from validated score data: energy, density, pitch brightness, delay/reverb space, key/mode, and harmonic tension; its key ring follows circle-of-fifths relationships while color remains presentation-only
- a mobile steering sheet exposes semantic energy, tempo feel, brightness, density, space, and harmonic-tension intent for the **next** composition only
- `POST /score/prebuffer` now supports bounded future-score replacement; steering may replace buffered B while current A remains content-identical and authoritative
- continuity semantics were tightened: merely queueing/prebuffering a future score no longer advances station motifs/energy/`lastCompositionId`; continuity advances only when a score is selected as `currentComposition`
- implementation checkpoint `83f1b8c0f72526a7afdb214836e2de58992dc7af` passed CI `33360497802` and Cloudflare deploy + strict live acceptance `33360497805`
- production acceptance proves current score identity survives future steering, the future queue stays bounded to one, the strict genuine-Workers-AI composition proof remains green, and cross-channel isolation still holds
- mobile visual evidence `vb_14f8fc82` returned HTTP 200 at 393x852 with scroll width equal to viewport width (393) and title `Infinite Radio · Visual Station`
- transition/crossfade, authoritative current-position/reconnect, attribution/queue-preview/fallback UX, and the four real layout/CI issues found during soak-driven testing are implemented and live-accepted

### Product priority decision — 2026-08-31
- V0.4's product-facing station feature set is **feature complete**; it is intentionally not being relabeled `ACCEPTED` because the previously planned uninterrupted 30-minute browser soak was not completed
- the 30-minute soak and similar long-duration reliability runs are moved to a later stabilization/hardening phase and **do not gate V0.5 creative-workstation work**
- the single previously observed ~60-second stall correlated with one HTTP 400 from `/score/select` remains a tracked hardening thread; it was seen once, has not reproduced since, and should be root-caused if it reappears rather than patched speculatively
- product priority now shifts to the highest-value creative loop: **play → edit → hear → compare/undo**, plus materially broader musical quality and versatility
- V0.5 is therefore unblocked and active by explicit product-priority decision

### UX contract
- **one score, many projections:** the browser consumes one validated canonical score; Player, Visual, Arrange, Piano, Mix, Flow, and Chat are views over that musical state rather than independent music engines
- V0.4 remains listener-first: playback and station steering ship before full score editing
- playback runtime state, view/UI state, and any future local draft score remain separate so UI gestures cannot silently mutate canonical server state
- mobile is first-class; the default phone experience is a full-height active canvas with persistent transport and lightweight mode navigation, while chat opens as a sheet rather than permanently consuming half the screen

### Deliverables
- forward-compatible browser workspace shell established by the V0.3.1 Step 5 player
- mobile-first listener/player surface and desktop responsive layout
- native Web Audio score renderer isolated from view components
- composition prebuffering and gap-resistant scheduling
- transitions/crossfades between score performances
- reconnect and current-position behavior
- now-playing composition/prompt/creator/provenance attribution
- queue preview and listener steering hooks
- first **Visual** projection for non-musicians: mood/energy surface, tempo/energy controls, and score-aware visualization using deterministic mappings
- harmonic visualization based on real musical relationships (for example circle-of-fifths/key proximity); color palettes are presentation themes, not a claim that one note has one objectively correct color
- archive/fixture fallback UX and visible source/fallback state where useful
- longer-running station soak behavior

### Deferred hardening acceptance
- long-duration browser soak without an application-caused audible gap — deferred to later stabilization; not a V0.5 gate
- listener reload can rejoin authoritative channel state — implemented/live-accepted
- next composition is prepared before the current composition ends — implemented/live-accepted
- Workers AI/provider failure does not silence a public station — implemented/live-accepted
- renderer can consume a validated score independently of whichever visual projection is active — implemented/live-accepted
- switching views/presentation state cannot alter the canonical score — implemented/live-accepted

---

## V0.5 — Chat DAW / Web Music Workstation — ACTIVE

Goal: turn the structured-score player into an editable browser-native workstation whose interface scales from non-musician semantic controls to precise producer editing without changing the underlying musical object.

### Priority order — 2026-08-31
1. **Immediate creative feedback loop:** a creator can take the score they are hearing, make a local edit, hear it immediately, A/B against the original, and undo/redo without another model call or server mutation.
2. **Editing experience before breadth:** ship a small number of delightful, musically legible controls first — tempo, track gain/pan/patch, octave/register changes, section energy, and semantic timbre/energy/space macros — then deepen Arrange/Piano/Mix precision.
3. **Music quality + versatility pulled forward:** broaden the safe musical vocabulary in parallel with editing: richer allowlisted instruments/patches, drum voices, articulation/envelopes, groove/dynamics, harmonic and arrangement variety, and better composition-quality checks. This work no longer waits for V0.10.
4. **One score, many skill levels:** every edit must remain visible/audible across Visual, Arrange, Piano, and Mix so beginners and producers manipulate the same draft at different abstraction levels.
5. **No persistence pressure yet:** early edits stay local and reversible. Immutable Save Version/provenance remains a deliberate later boundary rather than persisting every slider movement.

### Step 1 — local draft + instant A/B editing loop — ACCEPTED
- local draft cloned from the current validated score, never silently replacing canonical server state
- deterministic `EditCommand`/reducer boundary with bounded undo/redo
- Original/Draft A-B preview using the existing Web Audio renderer
- first controls: tempo, per-track gain/pan/patch, transpose/register, and semantic brightness/energy/space macros
- every candidate draft is checked before audible preview; leaving the editor can rejoin authoritative live station state
- mobile editing opens as a focused sheet/fullscreen surface rather than shrinking the active canvas into an unusable desktop DAW
- implemented and live-accepted across a sequence of bounded 2026-09-01 slices: the editing-quality foundation, the focused mobile browser editor, and the Arrange projection (section energy, section lift/drop reordering, and section structure editing)

### Step 1a — minimal Piano note editing — ACCEPTED
- selected-section Piano roll scoped to the currently selected Arrange section and melodic track
- melodic-track selection and existing-note selection
- pitch adjustment (±1 semitone / ±1 octave), duration adjustment (±0.25 beat), and velocity adjustment on the selected note
- every edit flows through the same Draft history, canonical validation, immediate Web Audio audition, Original/Draft A-B, undo/redo/reset, and safe live-rejoin architecture as Step 1 — Piano editing is not a separate mini-DAW
- deliberately deferred: note creation/deletion, free dragging, quantization, and separate persistence
- final repo HEAD `43c361c83efb5e39fd1749dcf46fe059b3eac955`; PR #1 staging CI `33515875983`, main CI `33515958434`, and deploy + strict live + real Chromium/WebAudio acceptance `33515958612` all succeeded; mobile browser acceptance passed at 393x852

### Step 1b — note add/delete — NEXT
- add and delete notes constrained to the selected melodic track and Arrange section, using the same validated Draft history/audition architecture proven in Step 1a
- clean foundation for pointer drag and snap/quantization once add/delete invariants are proven

### Step 2 — musical vocabulary + sound-quality expansion
- extend the allowlisted synth/drum/effect vocabulary without permitting arbitrary executable DSP or arbitrary AudioNode graphs
- add more expressive patch behavior (envelope/articulation/filter/timbre parameters) through bounded versioned fields
- improve groove, velocity/dynamics, voicing, motif development, section contrast, transitions, and arrangement diversity
- strengthen composition quality gates beyond mere temporal coverage so technically valid scores are also less repetitive and more musically useful to edit

### Interaction architecture

```text
canonical revision
      -> local draft
      -> UI EditCommand(s)
      -> ScoreReducer / deterministic transformation
      -> validate + normalize
      -> local Web Audio preview
      -> Save Version (later immutable revision boundary)
```

Manual UI edits and later AI-produced score patches must converge on the same controlled mutation path. No view writes arbitrary raw JSON directly, and incomplete streamed model output is never applied incrementally to a live score.

### Workspace projections
- **Visual** — mood/energy surface, semantic timbre macros, harmonic/key visualization, non-musician controls
- **Arrange** — song sections, track lanes, patterns, structure, section energy
- **Piano** — notes, timing, duration, velocity, drums, precise musical selection
- **Mix** — track gain/pan, allowlisted synth patches, bounded effects and effect amounts
- **Flow** — constrained visualization/editing of allowlisted patch/effect signal flow; no arbitrary WebAudio graph, generated JavaScript, unrestricted AudioNode wiring, or arbitrary DSP
- **Chat** — co-producer surface attached to selection/current draft; V0.5 may expose context and commands, while actual model-authored targeted score patches belong to V0.6

### Deliverables
- shared score/view store with renderer state isolated from editor/view state
- score inspector and arrangement/timeline view
- piano-roll or equivalent note editor
- track mixer controls
- allowlisted synth/patch selection
- tempo/key/section controls
- direct note/chord/drum editing
- semantic macro controls that deterministically map concepts such as brighter/darker, calmer/more energetic, sparse/dense, or dry/spacious onto validated score fields
- bounded automation/effect editing
- local draft, undo/redo, selection, and non-destructive A/B preview
- EditCommand + deterministic score transformation boundary
- every candidate draft must re-enter canonical validation before preview/save
- import/export of the canonical score without raw credentials
- mobile interaction model that prioritizes Visual/Arrange/Chat and allows precision editors to expand fullscreen/landscape

### Acceptance
- creator can modify a persisted score locally without running another model inference
- the same score remains semantically synchronized across Visual, Arrange, Piano, and Mix projections
- one-note, one-chord, one-track, tempo, and semantic-macro edits are audible immediately in local playback
- undo/redo remains local and does not create one persistent revision per pointer movement
- workstation cannot create or save a score that bypasses canonical validation
- Flow cannot express a signal graph outside the allowlisted score/synth contract

---

## V0.6 — AI Co-Producer via tool-operated editor (EditCommand as LLM/MCP surface) — PLANNED

Goal: make the LLM a bounded collaborator that operates the same deterministic editor a human uses, by calling the existing `EditCommand` vocabulary as tools, instead of regenerating whole songs or authoring a parallel patch-diff format.

### Architecture decision — 2026-09-01
- Supersedes the earlier standalone `score-patch` diff contract as the primary mechanism. The already-live `src/editor-state.js` deterministic command vocabulary (`SetTempo`, `SetTrackGain`, `SetTrackPan`, `SetTrackPatch`, `SetEffectAmount`, `Transpose`, `ChangeVelocity`, `EditNote`, `SetSectionEnergy`, `TransformSection`, `DuplicateSection`, `MoveSection`, `ResizeSection`, `SemanticMacro`) plus its `createEditorSession` / `dispatchEdit` / `undoEdit` / `redoEdit` / `resetDraft` / `previewScore` reducer already is the shape an LLM tool layer should wrap, rather than a second bespoke mutation format.
- Internal Infinite Radio co-producer LLM calls: model function tools mapped one-to-one onto the existing `EDIT_COMMANDS`, plus `music.get_score` / `music.get_section` / `music.undo` / `music.redo` / `music.preview`. No MCP hop is required for this in-process case.
- External agents (ChatGPT, Claude, CairnStone-connected agents) reach the identical surface remotely through an MCP server exposing the same schema — the same validated commands, never a looser or parallel mutation path.
- The LLM never gets arbitrary JSON-mutation access. Every tool call becomes exactly one `EditCommand`, goes through the existing `applyEditCommand` -> `validateAndNormalizeScore` pipeline, and is rejected outright on validation failure the same way a rejected human edit is.
- Repo decision: build this inside the existing `nothinginfinity/infinite-radio` repo, not a new repo. The reducer/validator/quality-gate pipeline is the one authoritative music engine and must not be forked or reimplemented elsewhere; a second repo would either duplicate that logic (drift risk) or require a network hop per tool call. Precedent: CairnStone V6 exposes MCP directly on its own Worker rather than through a companion repo, and Infinite Radio should follow the same pattern by adding its own MCP/tool-call route to the existing Worker.
- New requirement this surfaces: `createEditorSession`/`dispatchEdit` today exist only as an in-memory JS object driven by the browser tab. An LLM or external MCP agent calls tools from the server, not from that tab, so an authoritative server-side draft session is required so the human's browser and any tool-calling agent converge on one draft/undo-redo state instead of silently diverging.

### Step 1 — server-side authoritative draft session — ACCEPTED
- implemented as new routes on the existing `ChannelConductor` Durable Object (`/draft/start`, `/draft`, `/draft/edit`, `/draft/undo`, `/draft/redo`, `/draft/reset`, `/draft/preview`) rather than a new Durable Object class or a new repo, since one channel already owns one authoritative storage-backed object
- wraps the exact same `editor-state.js` reducer already covered by `test/editor-state.test.js` (`createEditorSession`/`dispatchEdit`/`undoEdit`/`redoEdit`/`resetDraft`/`previewScore`); no second mutation engine was introduced
- every `/draft/edit` call is exactly one `EditCommand` through the existing `applyEditCommand` -> `validateAndNormalizeScore` pipeline; invalid commands are rejected as 400s (`editor_*` prefix) and leave the draft unchanged
- reuses the existing per-channel creator/channel ownership check (`assertChannelOwner`) already gating every other channel route — no separate authorization path was added
- draft session storage (`ctx.storage` key `draft-session`) is kept separate from `channel-state`, so draft edits can never touch the canonical composition record
- commit `4785092661ed68b966d6aa7b9efbcd0c9215032c` (routes) plus `06fd4325e160e1f0f6e7056694880e3b50815a41` (tests); CI run `33538791734` and deploy + full live/browser acceptance run `33538791670` both succeeded; the full lifecycle (start/edit/reject-invalid/undo/redo/preview/reset/persistence-across-DO-reconstruction/wrong-creator-rejected) was independently curled against the live production Worker
- deliberately deferred to later steps: the tool/function-call schema itself (`music.edit_note`, etc.), the MCP surface for external agents, and the in-process model function-tool wiring for Infinite Radio's own co-producer LLM

### Step 2 — tool/function-call schema over EDIT_COMMANDS — NEXT
- define the one-to-one tool schema (`music.get_score`, `music.get_section`, `music.set_tempo`, `music.edit_note`, `music.transpose`, `music.duplicate_section`, `music.undo`, `music.redo`, `music.preview`, etc.) that calls the Step 1 draft-session routes
- wire it first as in-process model function tools for Infinite Radio's own co-producer LLM, then as an MCP surface on the same Worker for external agents

### Deliverables
- server-side authoritative draft-session store (Durable Object or equivalent) wrapping the existing `editor-state.js` reducer, reachable from both the browser editor and tool calls
- one-to-one tool/function schema over the existing `EDIT_COMMANDS` vocabulary, plus `music.get_score`, `music.get_section`, `music.undo`, `music.redo`, `music.preview`
- in-process model function-tool wiring for Infinite Radio's own co-producer LLM
- an MCP server surface exposing the identical schema for external agents, added to the existing Worker rather than a new repo
- selection/addressing model reused from the editor (section index/label, track id, event index) so tool calls and human taps address the same score coordinates
- audit trail distinguishing tool-issued `EditCommand`s from human-issued ones, feeding later provenance work (V0.7)
- authorization boundary reusing existing creator/channel ownership checks: which callers (internal co-producer vs. which external agents) may dispatch mutating commands on which channel's draft

### Acceptance
- an LLM (internal or MCP-connected external agent) can execute a request such as "duplicate section 2, transpose the lead in section 3 by +12, set the chorus energy to 0.82" as a sequence of individually validated `EditCommand`s
- a tool-issued command that fails validation leaves the draft unchanged, exactly like a rejected human edit
- the browser editor and a tool-calling agent operating the same channel's draft converge on one authoritative draft state, never two independent ones
- no tool call can express raw/arbitrary score JSON mutation outside the `EditCommand` vocabulary
- external MCP access to a channel's draft respects the same creator/channel authorization boundary as the human editor

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

Goal: improve system-level musical programming, provider routing, and adaptive quality without changing the canonical score contract. Foundational score/synth versatility and creator-facing sound-quality work has been pulled forward into active V0.5.

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

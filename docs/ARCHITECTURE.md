# Infinite Radio Architecture

## 1. Architectural thesis

Infinite Radio is not a serial audio-continuation experiment or one monolithic public station. It is a multi-tenant creator network. Each channel is an isolated, creator-controlled live programming system with two decoupled loops:

```text
CREATIVE LOOP
chat -> moderation/curation -> prompt compiler -> generator -> validation -> ready queue

BROADCAST LOOP
current track -> transition -> next ready track -> transition -> ...
                                      |
                               archive fallback
```

Generation is allowed to fail, retry, change providers, or temporarily stop without stopping the channel. The platform coordinates many channels; no channel's queue, creative state, provider budget, or credentials may become authority for another.

## 2. Runtime planes

### Real-time data plane

High-frequency mutable state belongs in Cloudflare infrastructure, not CairnStone.

**Durable Object — Channel Conductor**
- one logical conductor instance per `channel_id`
- owns that channel's ordered control state
- prompt candidate queue
- selected generation jobs
- ready-track queue
- playback cursor/heartbeat
- WebSocket fan-out
- generation concurrency, budget, and buffer-pressure decisions
- never reads another channel's mutable creative/runtime state as implicit fallback

**D1**
- creators, channels, memberships, and channel policy metadata
- prompts and moderation decisions scoped by `channel_id`
- generations and provider receipts scoped by `channel_id`
- votes and audience relationships scoped by `channel_id`
- track metadata, provenance, model latency/cost metrics, and archive index
- opaque provider-credential references only; never raw creator API secrets

**R2**
- channel-namespaced generated audio (`channels/{channel_id}/...`)
- DJ drops and transition assets
- optional waveform/analysis artifacts
- release/distribution artifacts and manifests when a creator chooses to publish

### Durable intelligence plane

CairnStone stores accepted, compressed state that must survive model/client/context boundaries. Durable creative memory is channel-scoped:

- channel bible, identity, and personality
- current era summaries
- recurring motifs/characters/lore
- prompt-compiler contract
- model-routing and budget policy
- safety/copyright/distribution policy
- major creative decisions
- creator/operator handoffs
- periodic compressed summaries of successful/failed experiments

A channel may eventually use a dedicated CairnStone chain such as `infinite-radio/channel/<channel_id>`. Platform/project roadmap state remains on the `infinite-radio` project chain.

CairnStone explicitly does **not** store every playback event, vote, or chat line.

## 3. Channel state and tenancy

`channel_id` is the first-class tenant and creative namespace. The minimum persistent creative state for one channel is:

```json
{
  "identity": "late-night surreal listener-steered radio",
  "era": "origin",
  "energy": 0.5,
  "tempoRange": [110, 135],
  "keyHints": [],
  "genreTags": ["electronic", "surreal"],
  "recurringMotifs": [],
  "characters": [],
  "recentStory": "",
  "avoid": ["same listener twice", "same joke repeatedly"]
}
```

A prompt compiler combines the selected audience prompt with that channel's accepted state. Continuity is semantic and musical, not dependent on conditioning every generation on the tail of the previous audio file.

Every high-frequency table/event/asset carries `channel_id`, and authorization resolves creator/member -> channel before state access. Channel isolation is an invariant, not a UI convention.

## 4. Buffer strategy

Initial target: **90 seconds of ready audio**.

The conductor continuously asks whether:

```text
ready_buffer_seconds < target_buffer_seconds
```

If true, it schedules more generation work subject to:
- provider concurrency
- per-minute generation cap
- cost ceiling
- prompt availability
- moderation
- retry/backoff state

Playback consumes only READY tracks. It never waits synchronously for a generation request.

## 5. Transition strategy

V0.x uses forgiving radio transitions instead of requiring beat-perfect mixes:

1. short crossfade
2. optional DJ sting/voice
3. next segment

Later versions can analyze actual BPM/key/loudness and prefer compatible transitions.

## 6. Provider abstraction and BYOK

Music generation is a provider interface, not hard-wired into channel logic. The default product model is BYOK: the creator selects a supported music provider/model and bears the provider's generation cost for that channel.

```text
generate({
  stationBrief,
  durationTargetSeconds,
  instrumental,
  providerPolicy
}) -> GenerationResult
```

`GenerationResult` must normalize:
- provider/model
- request id
- audio URL/blob reference
- duration
- latency
- cost
- safety status
- retryability
- raw provider receipt pointer

V0.2 uses fixture/archive audio while Cloudflare-native Workers AI handles inexpensive control intelligence such as prompt compilation, moderation, programming decisions, and DJ copy/TTS where appropriate. Real music generation begins behind the provider-neutral adapter in V0.3, with BYOK adapters added incrementally. If Cloudflare later exposes a suitable native music model, it becomes another adapter rather than a platform rewrite.

Creator provider secrets must not be written to D1, R2 metadata, logs, CairnStone, or client-visible channel state. Runtime state stores only opaque credential references. Provider request receipts are normalized per channel for cost, provenance, and troubleshooting.

## 7. Creator control, provenance, and distribution

A channel creator controls the channel configuration, genre/identity, provider choices, generation budgets, archive policy, visibility, and distribution settings. Infinite Radio records generation provenance and receipts so a creator can show how an artifact was produced.

This technical control/provenance layer does not itself guarantee copyright ownership. Rights in generated output depend on provider/model terms and applicable law; the product must preserve those terms/receipts rather than invent stronger ownership claims.

x402 is a later optional commerce/distribution rail, not an early playback dependency. A creator may eventually publish channel-defined paid resources such as premium streams, track downloads, releases, remix/use rights, agent-accessible catalogs, or other explicitly defined offers. Payment settlement and access receipts must remain separate from the underlying creative provenance record.

## 8. Browser workspace, playback, and UI projections

The browser is both the first performance runtime and the long-term creator workspace. The architecture therefore treats the V0.3.1 player as the first shell of the later Chat DAW rather than as a disposable single-purpose page.

### One score, many projections

Every browser view reads the same validated `infinite-radio-score-v1` musical object. Views are projections, not independent sources of musical truth:

```text
                         validated score
                               |
          +--------------------+--------------------+
          |                    |                    |
          v                    v                    v
       Visual               Arrange               Piano
          |                    |                    |
          +-------------+------+---------+----------+
                        |                |
                        v                v
                       Mix              Flow
                        \                /
                         +------ Chat ---+
```

The same note moved in Piano must be reflected by any corresponding representation in Arrange/Visual/Mix. Switching views alone never modifies musical state.

### State separation

Browser state is deliberately separated into four concerns:

1. **canonical score/revision** — validated server-backed creative state
2. **playback runtime** — AudioContext, scheduler, playhead, active voices, prebuffer/crossfade state
3. **view state** — selected view, zoom, scroll, open inspector, visual palette, current selection
4. **local draft** (V0.5+) — uncommitted human/AI-assisted edits with undo/redo

The renderer consumes validated score data and does not depend on a particular editor/view implementation. View components must not mutate the authoritative score in place.

### V0.3.1 Step 5 shell

Step 5 remains intentionally minimal: a mobile-first browser player plus native Web Audio renderer for validated scores. However, its component/state boundaries should be reusable by later UI work:

- channel/station header and now-playing identity
- central active-canvas region
- persistent transport/playback controls
- score/provenance/source status where useful, including deterministic-fallback visibility during development
- responsive mobile-first layout
- renderer isolated behind a score-to-performance interface
- no direct score editing, AI patches, provenance revisioning, publishing, or x402 in this slice

The V0.3.1 renderer synthesizes only the allowlisted score contract: approved oscillator/synth patch IDs, drum patches, gain/pan, and bounded effects. It never interprets generated JavaScript or arbitrary DSP graphs.

### V0.4 listener interaction / Visual projection

V0.4 can make the shell expressive for non-musicians before it becomes a full workstation. A `Visual` projection may expose semantic controls such as energy, tempo, brightness/darkness, density, spaciousness, or harmonic tension. These are deterministic macros over allowed score/channel fields, not free-form model calls.

Harmonic visualizations should represent actual relationships such as key proximity/circle-of-fifths movement. Color is a configurable presentation layer; no single synesthetic color-to-note mapping becomes protocol truth.

Mobile should prioritize the active visual/player canvas and transport. Chat/controls can open as sheets or fullscreen modes instead of permanently shrinking the musical surface.

### V0.5 Chat DAW mutation path

The editor must introduce a controlled transformation layer rather than letting components write raw JSON:

```text
UI gesture
   -> EditCommand
   -> deterministic ScoreReducer / transform
   -> candidate local draft
   -> validate + normalize
   -> Web Audio preview
   -> Save Version
```

Examples include `MoveNote`, `ResizeNote`, `SetTrackGain`, `SetTempo`, `Transpose`, `SetEffectAmount`, or higher-level semantic macro commands. Pointer movement may update local draft state continuously, but persistent version history is created only at deliberate save/version boundaries.

The initial projections are:

- **Visual** — mood/energy/harmonic/timbre macro controls for non-musicians
- **Arrange** — sections, track lanes, patterns, structure, and energy arcs
- **Piano** — precise pitch/timing/duration/velocity/drum editing
- **Mix** — gain, pan, allowlisted patch selection, bounded effects
- **Flow** — constrained view of the allowlisted patch/effect chain
- **Chat** — contextual co-producer surface attached to the current selection/draft

`Flow` is not initially Max/MSP. The current score contract deliberately forbids arbitrary WebAudio graphs. A true modular synthesizer requires a separate future versioned safe patch contract; until then Flow can only express/reorder/configure what the allowlist supports.

### V0.6 AI editing

AI does not get a privileged mutation path. A complete model-produced `score-patch` is parsed and validated first, then converted into the same controlled draft/change system used by human actions. Conversational text may stream, but incomplete JSON/model output must never mutate the live draft token-by-token.

Selection and locks are first-class: the user can select bars/tracks/events, lock untouched material, request a transformation, preview the diff/A-B result, then apply or reject it.

### Revision and publishing UX

V0.7+ makes revision lineage visible in the interface: history, compare, restore, fork, and save-version actions map to immutable score/Station-DNA provenance. V0.8/V0.9 publishing should use plain product language such as **Publish**, **Publish & Price**, **Offer License**, or **Make Forkable**. x402 payment does not imply NFT/token minting, so the default interface should not say `Mint & Sell` unless a future explicit minting feature actually exists.

### Future synchronized broadcast

Client-side score performance remains the default low-cost path. A later broadcast output can render server-side HLS/Icecast/RTMP if a universal synchronized stream becomes necessary.

## 9. Agent roles (later)

CairnStone v7 can compile bounded contexts for specialized agents:

- Producer — musical direction
- Continuity — lore and recurring motifs
- Prompt Compiler — transforms audience prompts
- DJ — short intros/transitions
- Program Director — uses retention/vote evidence
- Cost Router — selects provider tier
- Safety — moderation and policy

They share only the accepted memory for the authorized channel without sharing a giant mutable prompt or leaking another channel's state.

## 10. Failure and isolation invariants

1. Playback never synchronously depends on generation.
2. Provider failure cannot kill a channel.
3. Archive fallback always remains possible once a channel archive exists.
4. Paid generation is rate/cost bounded per channel.
5. One channel can never spend another channel's provider budget or use its credential reference.
6. One channel can never read another channel's private queue, archive, audience, or creative memory without explicit authorization.
7. Raw BYOK secrets never enter D1, R2 metadata, CairnStone, logs, or public client state.
8. Real-time telemetry does not inflate CairnStone.
9. CairnStone accepted state changes deliberately, not per event.
10. Provider-specific response shapes never leak into conductor core logic.
11. A generated track is not READY until its asset and metadata are valid.
12. x402/payment infrastructure can fail without stopping free/public channel playback.

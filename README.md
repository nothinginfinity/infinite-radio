# Infinite Radio

Infinite Radio is an open, creator-owned protocol and application stack for programmable music: generative radio, structured musical composition, a browser-native workstation, immutable remix lineage, and HTTP-native creator commerce.

The central primitive is **not an MP3 or WAV**. It is a versioned, validated musical object: `infinite-radio-score-v1`. An LLM can arrange that score, a human can edit it directly, the browser can perform it locally with Web Audio, other renderers can interpret it later, and every meaningful derivative can retain provenance back to its parent score and Station DNA.

A useful shorthand for the long-term product is:

> **Git + a browser DAW + generative radio + HTTP-native commerce for music.**

## Product principle

**Do not build one opaque AI song generator or one giant shared station. Build a network of creator-controlled musical universes whose compositions remain editable, portable, attributable, and independently monetizable.**

The canonical pipeline is:

```text
STATION DNA + LISTENER INTENT
            |
            v
        COMPOSER
  (Workers AI / BYOK / fixture)
            |
            v
 infinite-radio-score-v1
            |
      VALIDATE + NORMALIZE
            |
            v
  CHANNEL-SCOPED SCORE STORE
            |
      +-----+-------------------+
      |                         |
      v                         v
 WEB AUDIO PLAYER           WEB DAW
 local performance      inspect / edit / fork
      |                         |
      +-----------+-------------+
                  v
          SCORE REVISION GRAPH
                  |
                  v
        LICENSE / x402 RESOURCES
```

Composition and performance are deliberately separate. The score is the canonical creative asset; browser synthesis, MIDI export, premium neural rendering, game-engine playback, and future hardware/software renderers are interpretations of the same structured object.

## Why structured scores matter

Traditional text-to-music systems usually collapse generation and rendering into one opaque audio blob. Infinite Radio keeps the musical information editable:

- change one chord, instrument, tempo, motif, or section without regenerating the whole work
- select four bars and ask an AI co-producer to rewrite only that bounded region
- preserve drums while replacing a bassline or modulating to a new key
- preview a patch before applying it
- fork a score or an entire Station DNA while retaining parent/root lineage
- render the same composition through Web Audio, MIDI, MusicXML, or optional premium audio providers
- expose machine-readable licensing and paid resources without putting the free broadcast loop behind a payment dependency

The architecture is intentionally human-in-the-loop. Models arrange constrained musical data; they do not own the runtime, execute generated code, or replace direct editing.

## Canonical objects

The long-term protocol centers on a small set of versioned objects:

- **Station DNA** — a creator's musical identity: genre mixture, harmonic vocabulary, BPM range, instrument palette, rhythm/arrangement tendencies, motifs, energy behavior, transition rules, and bounded composer instructions
- **Score** — a validated `infinite-radio-score-v1` composition sufficient to reconstruct a performance
- **Score Patch** — a bounded, reviewable transformation against a score or selected section
- **Revision / Fork** — an immutable derivative with content identity, parent/root lineage, creator/provenance, and policy references
- **Performance** — one rendering of a score, such as browser Web Audio or an optional premium audio render
- **License Resource** — a creator-defined access/use offer that can later be exposed through x402 without conflating payment receipts with creative provenance

## Current build

V0.1 and V0.2 established the deterministic station and isolated creator-channel runtime. V0.3 added the provider-neutral BYOK boundary. The current canonical build is **V0.3.1 — Structured Composition Engine + Browser Synth**.

V0.3.1 makes `infinite-radio-score-v1` the core creative asset and proves the zero/low-cost loop end to end:

```text
channel musical state
  -> Workers AI composer
  -> validated structured score
  -> channel-scoped persistence
  -> browser Web Audio performance
```

A deterministic fixture composer remains first-class so CI, fallback playback, and basic station operation never depend on a paid model or external audio provider. Existing fal/Stable Audio adapters remain optional BYOK renderers rather than product blockers.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Planned product layers

1. **Infinite Station** — seamless continuous playback, buffering, transitions, listener steering, discovery, and longer-running channel behavior
2. **Web Music Workstation** — timeline/piano-roll editing, mixer controls, patch selection, direct score manipulation, and undo/redo
3. **AI Co-Producer** — targeted score patches such as “rewrite bars 17-20 but keep the drums” with preview/apply/reject
4. **Score + Station DNA Provenance** — immutable revisions, content hashes, parent/root lineage, attribution, and fork policy
5. **Creator Publishing** — public/private compositions, published Station DNA, remix permissions, creator profiles, and multi-channel management
6. **x402 Music Resources** — paid canonical-score retrieval, MIDI/export resources, forks, premium rendering, commercial-use offers, and agent-callable endpoints
7. **Open Music Economy** — machine discovery/licensing, provenance-aware royalty routing, third-party composers/renderers, and autonomous agent consumption

## Planned platform

- Cloudflare Worker for the shared HTTP/API and policy control plane
- one Durable Object conductor per creator channel for authoritative continuity, queueing, and transition state
- D1 for channel-scoped metadata, score/revision indexes, prompts, policies, receipts, metrics, and ownership boundaries
- R2 for optional rendered audio, exports, large artifacts, and channel-scoped distributable assets
- Workers AI as the initial structured composer, behind a provider-neutral adapter so BYOK and future models can share the score contract
- Web Audio API for deterministic client-side synthesis, scheduling, prebuffering, transitions, and workstation preview
- CairnStone for accepted project memory, creative decisions, bounded historical context, and cross-agent handoffs rather than high-frequency playback telemetry
- x402 as an optional HTTP-native payment/access layer for creator-defined resources; free/public playback must remain operational when payment infrastructure is unavailable

This design moves most playback computation to the listener device and keeps model output compact and structured. That can make marginal infrastructure cost extremely low, but the project does not assume AI inference, storage, settlement, or networking are literally free.

## Provenance and ownership boundary

Infinite Radio should make **provenance mathematically precise** without pretending protocol metadata alone settles copyright law. Score history can record who created, generated, edited, forked, licensed, or rendered an artifact; legal rights and copyright treatment remain jurisdiction- and authorship-dependent.

Likewise, the first x402 implementation should favor a simple creator-defined payment recipient per resource. Recursive or multi-party royalty splitting can be layered on later using the provenance graph rather than assumed to be automatic protocol behavior.

## Local development

Requires Node.js 22+.

```bash
npm test
npm run check
npm run dev
```

`npm run dev` uses Wrangler once dependencies are installed.

## System invariants

- a channel's free/public broadcast loop never depends on x402 availability
- one channel cannot read or spend another channel's credentials, budget, scores, or private memory
- LLM output is untrusted structured data and is never evaluated as executable JavaScript or arbitrary DSP
- trusted runtime identity overrides any model-supplied creator/channel identity
- invalid model output fails closed or falls back deterministically
- the canonical score remains portable even when a renderer/provider disappears
- creative provenance and payment/settlement receipts remain distinct
- high-frequency playback telemetry does not become unbounded model or CairnStone context

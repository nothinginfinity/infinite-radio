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

## 8. Browser playback

The earliest listener client uses two HTMLAudio/Web Audio sources:
- A = currently audible
- B = preloaded next segment

Gain envelopes crossfade A -> B. This avoids introducing a server-side mixing stack before product behavior is validated.

A later broadcast output can render server-side HLS/Icecast/RTMP if a universal synchronized stream becomes necessary.

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

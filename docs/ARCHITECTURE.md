# Infinite Radio Architecture

## 1. Architectural thesis

Infinite Radio is not a serial audio-continuation experiment. It is a fault-tolerant live programming system with two decoupled loops:

```text
CREATIVE LOOP
chat -> moderation/curation -> prompt compiler -> generator -> validation -> ready queue

BROADCAST LOOP
current track -> transition -> next ready track -> transition -> ...
                                      |
                               archive fallback
```

Generation is allowed to fail, retry, change providers, or temporarily stop without stopping the station.

## 2. Runtime planes

### Real-time data plane

High-frequency mutable state belongs in Cloudflare infrastructure, not CairnStone.

**Durable Object — Station Conductor**
- owns one station's ordered control state
- prompt candidate queue
- selected generation jobs
- ready-track queue
- playback cursor/heartbeat
- WebSocket fan-out
- generation concurrency and buffer-pressure decisions

**D1**
- prompts and moderation decisions
- users/session metadata when accounts arrive
- generations and provider receipts
- votes
- track metadata
- model latency/cost metrics
- archive index

**R2**
- generated audio
- DJ drops
- transition assets
- optional waveform/analysis artifacts

### Durable intelligence plane

CairnStone stores accepted, compressed state that must survive model/client/context boundaries:

- station bible and personality
- current era summaries
- recurring motifs/characters/lore
- prompt-compiler contract
- model-routing policy
- safety/copyright policy
- major creative decisions
- operator handoffs
- periodic compressed summaries of successful/failed experiments

CairnStone explicitly does **not** store every playback event, vote, or chat line.

## 3. Station state

The minimum persistent creative state is:

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

A prompt compiler combines the selected audience prompt with this accepted state. Continuity is semantic and musical, not dependent on conditioning every generation on the tail of the previous audio file.

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

## 6. Provider abstraction

Music generation is a provider interface, not hard-wired into station logic.

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

The initial live generator will favor a fast/cheap short-form fal model. Higher-quality providers become feature-track routes once the control loop is proven.

## 7. Browser playback

The earliest listener client uses two HTMLAudio/Web Audio sources:
- A = currently audible
- B = preloaded next segment

Gain envelopes crossfade A -> B. This avoids introducing a server-side mixing stack before product behavior is validated.

A later broadcast output can render server-side HLS/Icecast/RTMP if a universal synchronized stream becomes necessary.

## 8. Agent roles (later)

CairnStone v7 can compile bounded contexts for specialized agents:

- Producer — musical direction
- Continuity — lore and recurring motifs
- Prompt Compiler — transforms audience prompts
- DJ — short intros/transitions
- Program Director — uses retention/vote evidence
- Cost Router — selects provider tier
- Safety — moderation and policy

They share accepted station memory without sharing a giant mutable prompt.

## 9. Failure invariants

1. Playback never synchronously depends on generation.
2. Provider failure cannot kill the station.
3. Archive fallback always remains possible once an archive exists.
4. Paid generation is rate/cost bounded.
5. Real-time telemetry does not inflate CairnStone.
6. CairnStone accepted state changes deliberately, not per event.
7. Provider-specific response shapes never leak into the conductor core.
8. A generated track is not READY until its asset and metadata are valid.

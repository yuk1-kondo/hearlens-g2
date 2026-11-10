# HearLens — live captions + sound direction for Even G2

## The problem
For deaf and hard-of-hearing people, smart glasses are the most natural
captioning device ever built — the text floats where you're already
looking. But captions alone miss half the picture: hearing people
constantly use *where* sound comes from and *who* is speaking. Today's
captioning tools flatten all of that into anonymous text.

## The project
HearLens streams PCM from the glasses (or phone) microphones via
`audioControl` and turns it into a hearing-assist display:

- **Live captions** — pluggable STT: on-device via a local
  Whisper-compatible server, the WebView's SpeechRecognition, or any
  hosted transcription endpoint. Falls back gracefully to meter-only.
- **Direction arrows** (`◀ ● ▶`) driven by `audioEvent.direction` —
  the wearer sees whether a voice came from the left, front, or right.
- **Speaker role** chip (`YOU` / `OTHER`) from `audioEvent.speakerRole`.
- **Sound-awareness layer** — always-on level meter and a flash alert on
  sudden loud sounds (doorbell, horn, someone calling your name). Works
  even with no STT backend, fully offline.

Tap freezes captions mid-read; long-press switches glasses ↔ phone mic;
double-tap exits through the system dialog.

## Why it matters for Even Hub
Accessibility is a flagship use case for heads-up displays, and the
audio pipeline (`audioControl` + direction tags + speaker role) is
exactly the hardware Even built for it — yet the catalogue has almost
nothing exercising it. HearLens demonstrates all three audio signals in
one glanceable UI, fits Quiet Tech (no account, no app-hopping — the
captions are just there), and its pluggable STT design doubles as a
reference implementation for any developer wanting speech input.

## Current status
Working prototype on the official SDK (0.0.16): page layout, serialized
image pipeline (same proven pattern as my Neck Stretch app), VAD-driven
utterance segmentation → WAV → Whisper-compatible endpoint, Web Speech
fallback, settings webview, and EN/JA bilingual UI with CJK rasterized
through the image pipeline. Verified end-to-end on the simulator,
including a synthetic-audio demo mode (`?demo=1`) that exercises every
visual state without a mic.

Also filed-worthy: simulator 0.7.x rejects `textColor` in
create/rebuild payloads — page creation fails hard. Worked around by
omitting the field; happy to write it up for the tracker.

## What needs hardware (and only hardware)
- PCM format/rate of `audioEvent.audioPcm` (assumed s16le @16 kHz —
  `?debug=1` shows live level stats to confirm)
- `direction` tag value semantics — remappable at runtime via `?dirmap=`
- `speakerRole` classification behaviour in real conversations
- Whether the Even Hub WebView grants `SpeechRecognition`/mic access
  (if not, the local-STT path covers it)

## 120-day plan
- Weeks 1–2: on-device audio validation, direction mapping, PCM tuning
- Weeks 3–6: caption readability on the real display (font scale,
  contrast, refresh pacing), JA proofreading
- Weeks 7–10: field testing with hard-of-hearing volunteers
- Weeks 11–16: store submission via Even Hub review

## Applicant
Independent developer based in Japan. Second Even Hub app after Neck
Stretch (IMU head-tracking stretch coach, also simulator-complete and
waiting on the same hardware gap). Both apps are built to be reference
implementations I intend to document and share back with the community.

# HearLens

Live captions + sound direction on Even G2 — a hearing-assist app.
The glasses mic (or phone mic) streams PCM via `audioControl`; speech is
transcribed and shown as large captions, while a level meter, direction
arrows (`◀ ● ▶`) and a speaker-role chip (`YOU`/`OTHER`) stay live in the
corner. Sudden loud sounds flash a border alert.

If no speech-to-text backend is reachable the app still runs as a pure
sound-awareness display — level, direction, role, loud-sound alerts.

## Layout (576×288)

```
┌──────────────────────────────────────────────┐
│ HearLens ● webspeech · glasses mic           │  header (text)
│                                              │
│  captions — last 2 lines + ▸ interim         │  capText (text, Latin)
│  ─ or ─                                      │  ─ or ─
│  日本語字幕（画像化）                          │  capL + capR (images, CJK)
│                                              │
├───────────────────┬──────────────────────────┤
│  ◀  ●  ▶   ▂▃▅▇▂ │  mic: glasses            │  meter (img) + side (text)
│      OTHER       │  speaker: other          │
├───────────────────┴──────────────────────────┤
│ tap hold · long mic↔ · 2tap exit             │  footer (text)
└──────────────────────────────────────────────┘
```

Japanese/CJK captions are rasterized through the image pipeline because
the firmware font has no CJK glyphs — `?rec=ja` (or zh/ko) switches the
caption area to two side-by-side image containers.

## Speech-to-text backends

| Backend | How | Needs |
|---|---|---|
| `webspeech` | WebView `SpeechRecognition` (own mic) | works in the simulator; unverified inside the real Even Hub webview — falls back automatically |
| `whisper` | bridge PCM → VAD segmentation → WAV → POST | any Whisper-compatible `/v1/audio/transcriptions` endpoint (OpenAI, Groq, whisper.cpp, speaches…) |
| `none` | — | meter/direction only |

Selection is automatic (`?stt=auto`): whisper if an endpoint is
configured, else webspeech if available, else meter-only. Override with
`?stt=` or the settings panel in the companion webview (settings persist
in localStorage).

For a release `.ehpk`, list your STT endpoint's origin in the
`network` permission `whitelist` inside `app.json`.

## Run

```bash
npm install
npm run dev            # http://localhost:5174
```

Then either:
- **Simulator:** `evenhub-simulator "http://localhost:5174?sim=1&demo=1"`
  - `?sim=1` — uses this Mac's mic via getUserMedia for the level meter;
    Web Speech supplies captions. With a whisper endpoint configured, the
    sim PCM feeds the real segmentation → WAV → endpoint pipeline.
  - `?demo=1` — cycles a fake direction + speaker role on each loud
    sound, so the glasses UI can be previewed without hardware.
- **Real glasses:** `npx evenhub qr --url http://<your-ip>:5174`
  and scan with the Even Hub companion app.

## Controls

| Input | Action |
|---|---|
| tap | start / hold captions (freeze to finish reading) / release |
| long press | switch mic glasses ↔ phone |
| double tap | exit (system dialog) |

## Tuning on hardware (`?debug=1`)

The debug panel (replacing the side status) shows raw values that need
real-device validation:

- `raw dir:` — undocumented `audioEvent.direction` values. If they don't
  follow the assumed negative=left / ~0=center / positive=right pattern
  (they may be enum ints), remap without a rebuild via
  `?dirmap=<left>:<center>:<right>` value lists, e.g. `?dirmap=1:0:2`.
- PCM format — assumed s16le mono at `?rate=` Hz (default 16000). If the
  meter looks dead or slammed, check `lvl:` against actual loudness.
- `speakerRole` — host-side classification; may stay `unknown`.

## Pack for distribution

```bash
npm run pack   # build + hearlens.ehpk
npm test       # node checks for the audio pipeline (no framework)
```

## Files

| File | Purpose |
|---|---|
| `src/main.ts` | Page containers, state machine, event routing, settings webview |
| `src/audio.ts` | PCM decode, RMS level meter, onset detection, VAD segmenter, WAV encode |
| `src/stt.ts` | STT backends: webspeech / whisper-compatible endpoint / none |
| `src/render.ts` | Meter+direction canvas, CJK caption rasterization → PNG |
| `app.json` | Manifest (`com.yukik.hearlens`, g2/phone-microphone + network permissions) |

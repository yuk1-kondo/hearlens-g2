// Audio analysis for the PCM stream delivered via `audioEvent.audioPcm`.
//
// Format assumptions (the SDK docs don't pin them down — verify on hardware):
//   - signed 16-bit little-endian PCM, mono
//   - sample rate: 16 kHz by default; override with ?rate=
// The analyzer degrades gracefully: if bytes aren't s16le the meter will
// just look wrong, and `?debug=1` shows raw stats to retune with.

export type Direction = 'left' | 'center' | 'right' | 'unknown'

// Raw `direction` tag values are undocumented. Default mapping: negative =
// left, ~0 = center/front, positive = right. Override with ?dirmap=l:c:r
// after watching the debug line on hardware.
export function directionFromTag(raw: number | null | undefined, map?: { left: number[]; center: number[]; right: number[] }): Direction {
  if (raw == null) return 'unknown'
  if (map) {
    if (map.left.includes(raw)) return 'left'
    if (map.center.includes(raw)) return 'center'
    if (map.right.includes(raw)) return 'right'
    return 'unknown'
  }
  if (raw < -0.2) return 'left'
  if (raw > 0.2) return 'right'
  return 'center'
}

/** Decode s16le PCM bytes into Int16Array. Ignores a trailing odd byte. */
export function decodeS16le(bytes: Uint8Array): Int16Array {
  const n = bytes.length - (bytes.length % 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n)
  const out = new Int16Array(n / 2)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** RMS of an int16 frame, normalized 0..1. */
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.min(1, Math.sqrt(sum / samples.length) / 32768)
}

// ── Level meter state ────────────────────────────────────────────────
const HISTORY_LEN = 48 // bars kept (~event rate dependent; ~3-5s of audio)

export class LevelMeter {
  /** Most recent RMS values, oldest first. */
  history: number[] = []
  /** Smoothed current level 0..1. */
  level = 0
  /** Total PCM frames seen. */
  frames = 0
  /** Onset pulse: timestamp of last sudden loud sound. */
  lastOnsetAt = 0
  private baseline = 0.002

  feed(samples: Int16Array): number {
    const r = rms(samples)
    this.frames++
    this.level += (r - this.level) * 0.45
    this.history.push(this.level)
    if (this.history.length > HISTORY_LEN) this.history.shift()

    // slow noise-floor tracker for onset detection
    this.baseline += (r - this.baseline) * 0.05
    if (r > Math.max(0.06, this.baseline * 4)) this.lastOnsetAt = Date.now()
    return r
  }

  get onsetActive(): boolean {
    return Date.now() - this.lastOnsetAt < 700
  }
}

// ── Utterance segmenter for STT ──────────────────────────────────────
// Collects PCM until a pause: at least `minSpeechMs` voiced, then
// `silenceMs` below threshold — or a hard cap at `maxMs`.
export class SpeechSegmenter {
  private chunks: Int16Array[] = []
  private voicedMs = 0
  private trailingSilenceMs = 0

  constructor(
    public readonly sampleRate: number,
    public readonly silenceThreshold = 0.02,
    public readonly minSpeechMs = 600,
    public readonly silenceMs = 700,
    public readonly maxMs = 8000,
  ) {}

  /** Returns a completed utterance (concatenated samples) or null. */
  feed(samples: Int16Array): Int16Array | null {
    const ms = (samples.length / this.sampleRate) * 1000
    const r = rms(samples)
    const voiced = r >= this.silenceThreshold

    this.chunks.push(samples)
    if (voiced) {
      this.voicedMs += ms
      this.trailingSilenceMs = 0
    } else {
      this.trailingSilenceMs += ms
    }

    const totalMs = this.totalMs()
    const done =
      (this.voicedMs >= this.minSpeechMs && this.trailingSilenceMs >= this.silenceMs) ||
      totalMs >= this.maxMs ||
      // long silence with nothing worth sending
      (this.voicedMs < this.minSpeechMs && this.trailingSilenceMs >= this.silenceMs * 2)

    if (!done) return null
    const out = this.voicedMs >= this.minSpeechMs ? this.drain() : null
    this.reset()
    return out
  }

  reset() {
    this.chunks = []
    this.voicedMs = 0
    this.trailingSilenceMs = 0
  }

  private totalMs(): number {
    let n = 0
    for (const c of this.chunks) n += c.length
    return (n / this.sampleRate) * 1000
  }

  private drain(): Int16Array {
    let n = 0
    for (const c of this.chunks) n += c.length
    const out = new Int16Array(n)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}

// ── WAV encoding (for Whisper-compatible endpoints) ──────────────────
export function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  wstr(36, 'data')
  v.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true)
  return new Blob([buf], { type: 'audio/wav' })
}

// Speech-to-text backends. The SDK only delivers raw PCM — transcription
// needs one of:
//
//   'webspeech' — the WebView's SpeechRecognition (Chrome-family). Uses the
//      webview's own mic, not the bridge PCM. Works great in the simulator;
//      on the real Even Hub webview mic access is unverified — we fall back
//      automatically if it errors.
//   'whisper'   — segmented bridge PCM → POST to a Whisper-compatible
//      `/v1/audio/transcriptions` endpoint (OpenAI, Groq, whisper.cpp
//      server, speaches, …). Endpoint/key come from the settings panel or
//      ?endpoint= / ?key= query params.
//   'none'      — no captions; the level meter + direction still run.

import { encodeWav, SpeechSegmenter } from './audio'

export interface SttResult {
  text: string
  /** false for interim/partial results. */
  final: boolean
}

export interface SttBackend {
  readonly name: string
  /** Called once after the user gesture that starts listening. */
  start(): void
  stop(): void
  /** Bridge PCM input; only the whisper backend uses it. */
  feedPcm?(samples: Int16Array): void
  onResult?: (r: SttResult) => void
  /** Reported when the backend can no longer produce results. */
  onFatal?: (reason: string) => void
}

export class NullStt implements SttBackend {
  readonly name = 'none'
  start() {}
  stop() {}
}

// ── Web Speech API ───────────────────────────────────────────────────
type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export class WebSpeechStt implements SttBackend {
  readonly name = 'webspeech'
  onResult?: (r: SttResult) => void
  onFatal?: (reason: string) => void
  private rec: SpeechRecognitionLike | null = null
  private running = false
  private failures = 0

  constructor(public lang: string) {}

  start() {
    const Ctor = speechRecognitionCtor()
    if (!Ctor) {
      this.onFatal?.('SpeechRecognition not available')
      return
    }
    this.running = true
    this.rec = new Ctor()
    this.rec.lang = this.lang
    this.rec.continuous = true
    this.rec.interimResults = true

    this.rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const text = res[0]?.transcript?.trim()
        if (text) this.onResult?.({ text, final: !!res.isFinal })
      }
    }
    this.rec.onerror = e => {
      // 'not-allowed' / 'service-not-allowed' mean the webview won't give
      // us a mic — no point retrying.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false
        this.onFatal?.(`mic denied (${e.error})`)
        return
      }
      this.failures++
      if (this.failures > 5) {
        this.running = false
        this.onFatal?.(`repeated errors (${e.error})`)
      }
    }
    this.rec.onend = () => {
      // continuous mode still ends on long silence; restart while running
      if (this.running) {
        try {
          this.rec?.start()
        } catch {
          /* already started */
        }
      }
    }
    try {
      this.rec.start()
    } catch (err) {
      this.running = false
      this.onFatal?.(`start failed: ${err}`)
    }
  }

  stop() {
    this.running = false
    this.rec?.stop()
    this.rec = null
  }
}

// ── Whisper-compatible HTTP endpoint ─────────────────────────────────
export interface WhisperConfig {
  endpoint: string
  apiKey?: string
  model?: string
  /** ISO code ('en', 'ja') or '' to auto-detect. */
  language?: string
  sampleRate: number
}

export class WhisperStt implements SttBackend {
  readonly name = 'whisper'
  onResult?: (r: SttResult) => void
  onFatal?: (reason: string) => void
  private segmenter: SpeechSegmenter
  private running = false
  private sending: Promise<void> = Promise.resolve()
  private failures = 0

  constructor(public cfg: WhisperConfig) {
    this.segmenter = new SpeechSegmenter(cfg.sampleRate)
  }

  start() {
    this.running = true
  }

  stop() {
    this.running = false
    this.segmenter.reset()
  }

  feedPcm(samples: Int16Array) {
    if (!this.running) return
    const utterance = this.segmenter.feed(samples)
    if (utterance) this.queueSend(utterance)
  }

  private queueSend(samples: Int16Array) {
    // serialize requests; don't pile them up faster than they complete
    this.sending = this.sending.then(() => this.send(samples)).catch(() => {})
  }

  private async send(samples: Int16Array) {
    if (!this.running) return
    try {
      const form = new FormData()
      form.append('file', encodeWav(samples, this.cfg.sampleRate), 'audio.wav')
      form.append('model', this.cfg.model || 'whisper-1')
      if (this.cfg.language) form.append('language', this.cfg.language)
      form.append('response_format', 'json')

      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
        body: form,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { text?: string }
      const text = json.text?.trim()
      if (text) this.onResult?.({ text, final: true })
      this.failures = 0
    } catch (err) {
      this.failures++
      console.warn('[stt] whisper send failed:', err)
      if (this.failures >= 4) {
        this.running = false
        this.onFatal?.(`endpoint unreachable (${err})`)
      }
    }
  }
}

// ── Selection ────────────────────────────────────────────────────────
export function pickBackend(opts: {
  forced?: string | null
  whisper?: WhisperConfig | null
  recLang: string
}): SttBackend {
  const { forced, whisper, recLang } = opts
  if (forced === 'none') return new NullStt()
  if (forced === 'whisper') return whisper ? new WhisperStt(whisper) : new NullStt()
  if (forced === 'webspeech') return new WebSpeechStt(recLang)
  if (whisper?.endpoint) return new WhisperStt(whisper)
  if (speechRecognitionCtor()) return new WebSpeechStt(recLang)
  return new NullStt()
}

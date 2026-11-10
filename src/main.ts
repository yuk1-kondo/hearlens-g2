import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import {
  decodeS16le,
  directionFromTag,
  LevelMeter,
  type Direction,
} from './audio'
import { pickBackend, type SttBackend, type WhisperConfig } from './stt'
import { renderMeter, renderCaptionsJa, CAP_H, METER_H, METER_W } from './render'

// ── Config ───────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)
const SIM = params.has('sim')
const DEBUG = params.has('debug')
const DEMO = params.has('demo') // sim: fake direction/role so the UI can be previewed

// Raw direction tags are undocumented — ?dirmap=1,2:0:3 maps
// left:center:right value lists after checking ?debug=1 on hardware.
const DIRMAP = (() => {
  const raw = params.get('dirmap')
  if (!raw) return undefined
  const [l = '', c = '', r = ''] = raw.split(':')
  const nums = (s: string) => s.split(',').filter(Boolean).map(Number)
  return { left: nums(l), center: nums(c), right: nums(r) }
})()
const store = {
  get: (k: string) => localStorage.getItem(`hearlens.${k}`),
  set: (k: string, v: string) => localStorage.setItem(`hearlens.${k}`, v),
}
const cfg = {
  /** PCM sample rate assumption for the bridge stream (tune on hardware). */
  rate: Number(params.get('rate') ?? store.get('rate') ?? 16000),
  /** recognition language, e.g. en-US / ja-JP */
  rec: params.get('rec') ?? store.get('rec') ?? 'en-US',
  stt: params.get('stt') ?? store.get('stt') ?? 'auto', // auto|none|webspeech|whisper
  src: (params.get('src') ?? store.get('src') ?? 'glasses') as 'glasses' | 'phone',
  endpoint: params.get('endpoint') ?? store.get('endpoint') ?? '',
  key: params.get('key') ?? store.get('key') ?? '',
  model: params.get('model') ?? store.get('model') ?? 'whisper-1',
}
// CJK needs the image pipeline (firmware font has no glyphs for it).
const CAPTIONS_IMG = /^(ja|zh|ko)/i.test(cfg.rec)
const UI_JA = (params.get('lang') ?? navigator.language).startsWith('ja')

const bridge = await waitForEvenAppBridge()

// ── Page layout ──────────────────────────────────────────────────────
const eventLayer = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 288,
  borderWidth: 0, borderColor: 0, paddingLength: 0,
  containerID: 1, containerName: 'eventLayer', content: ' ', isEventCapture: 1,
})
const header = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 28,
  borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 2, containerName: 'header', content: '', isEventCapture: 0,
})
// Latin-script captions (firmware text). CJK uses capL/capR images instead.
const capText = new TextContainerProperty({
  xPosition: 0, yPosition: 30, width: 576, height: 148,
  borderWidth: 0, borderColor: 5, paddingLength: 6,
  containerID: 3, containerName: 'capText', content: '', isEventCapture: 0,
})
const capL = new ImageContainerProperty({
  xPosition: 0, yPosition: 30, width: 288, height: CAP_H,
  containerID: 4, containerName: 'capL',
})
const capR = new ImageContainerProperty({
  xPosition: 288, yPosition: 30, width: 288, height: CAP_H,
  containerID: 5, containerName: 'capR',
})
const meter = new ImageContainerProperty({
  xPosition: 0, yPosition: 186, width: METER_W, height: METER_H,
  containerID: 6, containerName: 'meter',
})
// textColor is intentionally unset: simulator 0.7.x rejects the field in
// create/rebuild payloads (device-side default brightness 4 applies).
const side = new TextContainerProperty({
  xPosition: 296, yPosition: 186, width: 272, height: METER_H,
  borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 7, containerName: 'side', content: '', isEventCapture: 0,
})
const footer = new TextContainerProperty({
  xPosition: 0, yPosition: 264, width: 576, height: 24,
  borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 8, containerName: 'footer', content: '', isEventCapture: 0,
})

const textObjects = [eventLayer, header, ...(CAPTIONS_IMG ? [] : [capText]), side, footer]
const imageObjects = [...(CAPTIONS_IMG ? [capL, capR] : []), meter]

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: textObjects.length + imageObjects.length,
    textObject: textObjects,
    imageObject: imageObjects,
  }),
)
if (created !== 0) {
  const rebuilt = await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: textObjects.length + imageObjects.length,
      textObject: textObjects,
      imageObject: imageObjects,
    }),
  )
  if (!rebuilt) {
    document.querySelector('#app')!.textContent = `page create failed: ${created}`
    throw new Error(`createStartUpPageContainer: ${created}`)
  }
  console.log('page recovered via rebuildPageContainer')
}

// ── Display helpers ──────────────────────────────────────────────────
const textCache = new Map<string, string>()
async function setText(id: number, name: string, content: string) {
  if (textCache.get(name) === content) return
  textCache.set(name, content)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content }))
}

let rendering: Promise<unknown> = Promise.resolve()
function pushImage(id: number, name: string, make: () => Promise<Uint8Array>) {
  rendering = rendering.then(async () => {
    const res = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: await make() }))
    if (res !== 'success') console.error('updateImageRawData:', name, res)
  })
}

// ── PCM sources (sim only; real device uses the bridge audioEvent) ────
interface PcmTap {
  start(onSamples: (s: Int16Array) => void): Promise<number>
  stop(): void
}

class WebAudioPcmTap implements PcmTap {
  private ctx?: AudioContext
  private stream?: MediaStream
  async start(onSamples: (s: Int16Array) => void): Promise<number> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no mediaDevices')
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.ctx = new AudioContext()
    const src = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but still the simplest pull model;
    // fine for a simulator-only dev path.
    const proc = this.ctx.createScriptProcessor(2048, 1, 1)
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    proc.onaudioprocess = e => {
      const f = e.inputBuffer.getChannelData(0)
      const s = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) s[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)))
      onSamples(s)
    }
    src.connect(proc)
    proc.connect(mute)
    mute.connect(this.ctx.destination)
    return this.ctx.sampleRate
  }
  stop() {
    this.stream?.getTracks().forEach(t => t.stop())
    this.ctx?.close()
  }
}

// The simulator webview has no mic — synthesize a quiet noise floor with
// periodic speech-like bursts so meter/onset/direction demos still run.
class FakePcmTap implements PcmTap {
  private timer?: ReturnType<typeof setInterval>
  constructor(private rate = 16000) {}
  async start(onSamples: (s: Int16Array) => void): Promise<number> {
    let t = 0 // ms
    const chunkLen = this.rate / 10 // 100 ms per push
    this.timer = setInterval(() => {
      const s = new Int16Array(chunkLen)
      const voiced = t % 4000 < 1500 // 1.5 s "speech" every 4 s
      for (let i = 0; i < s.length; i++) {
        const sec = (t * 10 + i) / this.rate
        const env = voiced ? 0.5 + 0.5 * Math.sin(sec * 6) : 0.02
        const v = env * (11000 * Math.sin(2 * Math.PI * 180 * sec) + 5000 * (Math.random() - 0.5))
        s[i] = Math.max(-32768, Math.min(32767, Math.round(v)))
      }
      t += 100
      onSamples(s)
    }, 100)
    return this.rate
  }
  stop() {
    clearInterval(this.timer)
  }
}

// ── State ────────────────────────────────────────────────────────────
type State = 'intro' | 'listening' | 'held'
let state: State = 'intro'
const levelMeter = new LevelMeter()
let stt: SttBackend | null = null
let tap: PcmTap | null = null
let direction: Direction = 'unknown'
let lastDirRaw: number | null = null
let speakerRole = 'unknown'
let micSource: 'glasses' | 'phone' = cfg.src
let sttFatal: string | null = null

const finals: string[] = [] // committed caption lines (keep last 2 on lens)
let interim = ''

function wrapLatin(text: string, width = 32): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > width && cur) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

function captionText(): string {
  const shown = finals.slice(-2).flatMap(t => wrapLatin(t))
  if (interim) shown.push(...wrapLatin(`▸ ${interim}`))
  return shown.join('\n') || ' '
}

let lastCapImg = ''
async function pushCaptions() {
  if (CAPTIONS_IMG) {
    const lines = [
      ...finals.slice(-2).map(text => ({ text })),
      ...(interim ? [{ text: `▸ ${interim}`, dim: true }] : []),
    ]
    const key = JSON.stringify(lines)
    if (key === lastCapImg) return
    lastCapImg = key
    const halves = renderCaptionsJa(lines)
    pushImage(4, 'capL', async () => (await halves)[0])
    pushImage(5, 'capR', async () => (await halves)[1])
  } else {
    setText(3, 'capText', captionText())
  }
}

function refreshHeader() {
  const dot = state === 'listening' ? '●' : '○'
  const mode = stt?.name === 'none' || sttFatal ? 'meter' : (stt?.name ?? '…')
  const hold = state === 'held' ? '  [HELD]' : ''
  setText(2, 'header', `HearLens ${dot} ${mode} · ${micSource} mic${hold}`)
}

function refreshSide() {
  if (DEBUG) {
    setText(7, 'side',
      `raw dir:${lastDirRaw ?? '-'} role:${speakerRole}\n` +
      `lvl:${levelMeter.level.toFixed(3)} frames:${levelMeter.frames}\n` +
      `stt:${stt?.name ?? '-'}${sttFatal ? ` !${sttFatal}` : ''}`)
    return
  }
  const loud = levelMeter.onsetActive ? '\nLOUD ▲' : ''
  const err = sttFatal ? `\n!${sttFatal}` : ''
  setText(7, 'side', `mic: ${micSource}\nspeaker: ${speakerRole}${loud}${err}`)
}

function refreshFooter() {
  setText(8, 'footer', state === 'intro'
    ? 'tap start · 2tap exit'
    : 'tap hold · long mic↔ · 2tap exit')
}

// ── Listening pipeline ───────────────────────────────────────────────
function onPcm(samples: Int16Array) {
  levelMeter.feed(samples)
  stt?.feedPcm?.(samples)
}

async function startListening() {
  sttFatal = null

  // Open the PCM source first so the STT segmenter sees the real rate.
  if (SIM) {
    tap = new WebAudioPcmTap()
    try {
      cfg.rate = await tap.start(onPcm)
    } catch (err) {
      log(`mic unavailable (${err}) — synthetic audio`)
      tap = new FakePcmTap(cfg.rate)
      cfg.rate = await tap.start(onPcm)
    }
  } else {
    const src = micSource === 'glasses' ? AudioInputSource.Glasses : AudioInputSource.Phone
    const ok = await bridge.audioControl(true, src)
    log(`audioControl(${micSource}): ${ok}`)
    if (!ok) sttFatal = 'mic open failed'
  }

  const whisper: WhisperConfig | null = cfg.endpoint
    ? { endpoint: cfg.endpoint, apiKey: cfg.key || undefined, model: cfg.model, language: cfg.rec.split('-')[0], sampleRate: cfg.rate }
    : null
  stt = pickBackend({ forced: cfg.stt === 'auto' ? null : cfg.stt, whisper, recLang: cfg.rec })
  stt.onResult = r => {
    if (r.final) {
      finals.push(r.text)
      if (finals.length > 8) finals.splice(0, finals.length - 8)
      interim = ''
      logTranscript(r.text)
    } else {
      interim = r.text
    }
    if (state !== 'held') pushCaptions()
  }
  stt.onFatal = reason => {
    sttFatal = reason
    refreshHeader()
    refreshSide()
    log(`stt unavailable: ${reason} — meter mode`)
  }
  stt.start()

  state = 'listening'
  refreshAll()
}

async function stopListening() {
  stt?.stop()
  stt = null
  tap?.stop()
  tap = null
  if (!SIM) await bridge.audioControl(false)
}

async function toggleMicSource() {
  micSource = micSource === 'glasses' ? 'phone' : 'glasses'
  store.set('src', micSource)
  if (state !== 'intro') {
    await stopListening()
    await startListening()
  } else refreshAll()
}

function onTap() {
  if (state === 'intro') startListening()
  else if (state === 'listening') {
    state = 'held'
    refreshHeader()
    refreshFooter()
  } else if (state === 'held') {
    state = 'listening'
    pushCaptions()
    refreshHeader()
    refreshFooter()
  }
}

// ── Events ───────────────────────────────────────────────────────────
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
  stopListening()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sys = event.sysEvent
  const sysType = eventTypeOf(sys)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
    return
  }
  if (sysType === OsEventTypeList.LONG_PRESS_EVENT) {
    toggleMicSource()
    return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    onTap()
    return
  }
  const audio = event.audioEvent
  if (audio?.audioPcm?.length) {
    lastDirRaw = audio.direction ?? null
    direction = directionFromTag(audio.direction, DIRMAP)
    speakerRole = audio.speakerRole ?? 'unknown'
    onPcm(decodeS16le(audio.audioPcm))
  }
})
window.addEventListener('beforeunload', cleanup)

// ── Render loop (meter + side) ───────────────────────────────────────
let lastMeterKey = ''
let lastMeterPush = 0
let demoPrevOnset = false
let demoIdx = 0
setInterval(() => {
  const listening = state === 'listening' || state === 'held'
  // sim preview: cycle a fake direction + role on each loud-sound onset
  if (DEMO && listening) {
    const onsetNow = levelMeter.onsetActive
    if (onsetNow && !demoPrevOnset) {
      direction = (['left', 'center', 'right'] as const)[demoIdx % 3]
      speakerRole = demoIdx % 2 ? 'self' : 'other'
      demoIdx++
    }
    demoPrevOnset = onsetNow
  }
  // meter: push on change, throttled heartbeat while quiet
  const key = [
    Math.round(levelMeter.level * 12), direction, speakerRole,
    levelMeter.onsetActive ? 1 : 0, listening ? 1 : 0,
  ].join('|')
  const now = Date.now()
  if (key !== lastMeterKey || (levelMeter.level > 0.01 && now - lastMeterPush > 900)) {
    lastMeterKey = key
    lastMeterPush = now
    pushImage(6, 'meter', () =>
      renderMeter({
        history: levelMeter.history,
        level: levelMeter.level,
        direction,
        speakerRole,
        onset: levelMeter.onsetActive,
        listening,
      }))
  }
  refreshSide()
}, 150)

function refreshAll() {
  refreshHeader()
  refreshSide()
  refreshFooter()
  pushCaptions()
}

// ── Companion webview ────────────────────────────────────────────────
const appEl = document.querySelector<HTMLDivElement>('#app')!
const tr = (en: string, ja: string) => (UI_JA ? ja : en)

appEl.innerHTML = `
  <h1>HearLens</h1>
  <p class="sub">${tr('Live captions + sound direction on your glasses.', 'メガネにリアルタイム字幕と音の方向を表示します。')}
    ${SIM ? tr(' <b>SIM:</b> uses this device\'s mic.', ' <b>SIM:</b> この端末のマイクを使います。') : ''}</p>

  <fieldset>
    <legend>${tr('Speech-to-text', '音声認識')}</legend>
    <label>${tr('Backend', 'バックエンド')}</label>
    <select id="f-stt">
      <option value="auto">auto</option>
      <option value="webspeech">webspeech</option>
      <option value="whisper">whisper endpoint</option>
      <option value="none">none (meter only)</option>
    </select>
    <label>Endpoint (whisper-compatible /v1/audio/transcriptions)</label>
    <input id="f-endpoint" placeholder="https://api.openai.com/v1/audio/transcriptions" />
    <label>API key</label>
    <input id="f-key" type="password" placeholder="sk-…" autocomplete="off" />
    <div class="row">
      <div style="flex:1"><label>Model</label><input id="f-model" /></div>
      <div style="flex:1"><label>${tr('Language', '認識言語')}</label><input id="f-rec" placeholder="en-US / ja-JP" /></div>
    </div>
    <label>${tr('Mic source', 'マイク')}</label>
    <select id="f-src"><option value="glasses">glasses</option><option value="phone">phone</option></select>
    <div class="row" style="margin-top:10px">
      <button id="save" class="primary">${tr('Save & apply', '保存して適用')}</button>
      <button id="toggle">${tr('Start / stop', '開始 / 停止')}</button>
    </div>
    <p class="hint">${tr('Glasses: tap = hold/release captions · long press = switch mic · double tap = exit.', 'メガネ操作: タップ=字幕ホールド · 長押し=マイク切替 · 2連タップ=終了。')}</p>
  </fieldset>

  <div id="log"></div>
`

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => appEl.querySelector<T>(`#${id}`)!
$<HTMLSelectElement>('f-stt').value = cfg.stt
$('f-endpoint').value = cfg.endpoint
$('f-key').value = cfg.key
$('f-model').value = cfg.model
$('f-rec').value = cfg.rec
$<HTMLSelectElement>('f-src').value = micSource

const logEl = appEl.querySelector<HTMLDivElement>('#log')!
function log(msg: string) {
  const line = document.createElement('div')
  line.textContent = msg
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
}
function logTranscript(text: string) {
  const line = document.createElement('div')
  line.className = 'cap'
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`
  logEl.append(line)
  logEl.scrollTop = logEl.scrollHeight
}

$('save').addEventListener('click', async () => {
  cfg.stt = $<HTMLSelectElement>('f-stt').value
  cfg.endpoint = $('f-endpoint').value.trim()
  cfg.key = $('f-key').value.trim()
  cfg.model = $('f-model').value.trim() || 'whisper-1'
  cfg.rec = $('f-rec').value.trim() || 'en-US'
  cfg.src = $<HTMLSelectElement>('f-src').value as 'glasses' | 'phone'
  for (const k of ['stt', 'endpoint', 'key', 'model', 'rec', 'src'] as const) store.set(k, String(cfg[k]))
  micSource = cfg.src
  if (state !== 'intro') {
    await stopListening()
    await startListening()
  } else refreshAll()
  log('settings applied')
})
$('toggle').addEventListener('click', () => {
  if (state === 'intro') startListening()
  else {
    stopListening()
    state = 'intro'
    refreshAll()
  }
})

refreshAll()
log(`[hearlens] ready — stt:${cfg.stt} rec:${cfg.rec} src:${micSource}${SIM ? ' (sim)' : ''}`)

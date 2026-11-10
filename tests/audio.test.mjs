// Plain-node checks for src/audio.ts (bundled by esbuild via `npm test`).
// No framework — assert + exit code.
import assert from 'node:assert/strict'
import {
  decodeS16le, rms, directionFromTag, encodeWav, LevelMeter, SpeechSegmenter,
} from '../node_modules/.tmp-audio.mjs'

let n = 0
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`) }

// ── decodeS16le ──────────────────────────────────────────────────────
ok('decodeS16le little-endian', () => {
  const s = decodeS16le(new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]))
  assert.deepEqual([...s], [1, 32767, -32768])
})
ok('decodeS16le drops odd byte', () => {
  assert.equal(decodeS16le(new Uint8Array([1, 0, 2])).length, 1)
})

// ── rms ──────────────────────────────────────────────────────────────
ok('rms silence=0, full-scale≈1', () => {
  assert.equal(rms(new Int16Array(100)), 0)
  const full = new Int16Array(100).fill(32767)
  assert.ok(rms(full) > 0.99)
})
ok('rms quarter-scale sine-ish', () => {
  const s = new Int16Array(512).map((_, i) => Math.round(8192 * Math.sin(i / 8)))
  assert.ok(rms(s) > 0.1 && rms(s) < 0.3)
})

// ── directionFromTag ─────────────────────────────────────────────────
ok('direction default thresholds', () => {
  assert.equal(directionFromTag(null), 'unknown')
  assert.equal(directionFromTag(undefined), 'unknown')
  assert.equal(directionFromTag(-1), 'left')
  assert.equal(directionFromTag(0), 'center')
  assert.equal(directionFromTag(0.1), 'center')
  assert.equal(directionFromTag(1), 'right')
})
ok('direction custom map (enum-style tags)', () => {
  const map = { left: [1], center: [0], right: [2] }
  assert.equal(directionFromTag(1, map), 'left')
  assert.equal(directionFromTag(2, map), 'right')
  assert.equal(directionFromTag(0, map), 'center')
  assert.equal(directionFromTag(9, map), 'unknown')
})

// ── LevelMeter ───────────────────────────────────────────────────────
ok('LevelMeter tracks level + history cap', () => {
  const m = new LevelMeter()
  for (let i = 0; i < 60; i++) m.feed(new Int16Array(64).fill(16000))
  assert.ok(m.level > 0.2)
  assert.ok(m.history.length <= 48)
  assert.equal(m.frames, 60)
})
ok('LevelMeter onset fires on sudden loud', () => {
  const m = new LevelMeter()
  for (let i = 0; i < 20; i++) m.feed(new Int16Array(64)) // quiet floor
  m.feed(new Int16Array(64).fill(30000))
  assert.ok(m.onsetActive)
})

// ── SpeechSegmenter ──────────────────────────────────────────────────
ok('segmenter emits on speech→silence', () => {
  const seg = new SpeechSegmenter(16000)
  const speech = () => new Int16Array(1600).fill(9000) // 100ms voiced
  const silence = () => new Int16Array(1600)           // 100ms quiet
  let out = null
  for (let i = 0; i < 8; i++) out = seg.feed(speech()) ?? out   // 800ms voiced
  for (let i = 0; i < 8 && !out; i++) out = seg.feed(silence()) // pause → emit
  assert.ok(out, 'should emit an utterance')
  assert.ok(out.length >= 8 * 1600)
})
ok('segmenter drops pure silence', () => {
  const seg = new SpeechSegmenter(16000)
  let out = null
  for (let i = 0; i < 30; i++) out = seg.feed(new Int16Array(1600)) ?? out
  assert.equal(out, null)
})
ok('segmenter hard-caps long speech', () => {
  const seg = new SpeechSegmenter(16000)
  const speech = () => new Int16Array(1600).fill(9000)
  let out = null
  for (let i = 0; i < 200 && !out; i++) out = seg.feed(speech())
  assert.ok(out, 'should cap at maxMs')
  assert.ok(out.length <= 16000 * ((seg.maxMs + 200) / 1000))
})

// ── encodeWav ────────────────────────────────────────────────────────
ok('encodeWav produces valid RIFF header', async () => {
  const blob = encodeWav(new Int16Array([0, 100, -100]), 16000)
  const buf = new Uint8Array(await blob.arrayBuffer())
  const str = (o, l) => String.fromCharCode(...buf.slice(o, o + l))
  assert.equal(str(0, 4), 'RIFF')
  assert.equal(str(8, 4), 'WAVE')
  assert.equal(buf.byteLength, 44 + 6)
  const view = new DataView(buf.buffer)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getInt16(46, true), 100)
})

console.log(`\n${n} checks passed`)

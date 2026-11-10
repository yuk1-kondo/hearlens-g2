// Renderers: draw to offscreen canvases and encode PNG bytes for
// `bridge.updateImageRawData`. Same pipeline as neck-stretch — the host
// converts PNG to the display's greyscale.
//
// Image containers are limited to 288×144, so the Japanese caption area
// (576×144 logical) is split into left/right halves at push time.

import type { Direction } from './audio'

async function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  return new Uint8Array(await blob.arrayBuffer())
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// ── Sound meter + direction panel ────────────────────────────────────
export const METER_W = 288
export const METER_H = 76

const meterCanvas = makeCanvas(METER_W, METER_H)
const mctx = meterCanvas.getContext('2d')!

export async function renderMeter(opts: {
  history: number[]
  level: number
  direction: Direction
  /** 'self' | 'other' | 'unknown' — who the glasses think is speaking. */
  speakerRole: string
  /** sudden loud sound pulse. */
  onset: boolean
  listening: boolean
}): Promise<Uint8Array> {
  const { history, level, direction, speakerRole, onset, listening } = opts
  const c = mctx
  c.clearRect(0, 0, METER_W, METER_H)

  // onset flash border
  if (onset) {
    c.strokeStyle = '#ffffff'
    c.lineWidth = 3
    c.strokeRect(1.5, 1.5, METER_W - 3, METER_H - 3)
  } else {
    c.strokeStyle = '#333333'
    c.lineWidth = 1
    c.strokeRect(0.5, 0.5, METER_W - 1, METER_H - 1)
  }

  // direction cluster: ◀ ● ▶ — active direction is bright, rest dim
  const cy = 26
  const slots: { d: Direction; x: number; glyph: string }[] = [
    { d: 'left', x: METER_W / 2 - 56, glyph: '◀' },
    { d: 'center', x: METER_W / 2, glyph: '●' },
    { d: 'right', x: METER_W / 2 + 56, glyph: '▶' },
  ]
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.font = '28px system-ui, sans-serif'
  for (const s of slots) {
    const active = listening && direction === s.d
    c.fillStyle = active ? '#ffffff' : '#2e2e2e'
    c.fillText(s.glyph, s.x, cy)
  }

  // speaker-role chip under the direction cluster
  const role = speakerRole === 'self' ? 'YOU' : speakerRole === 'other' ? 'OTHER' : listening ? '…' : 'MIC OFF'
  c.font = 'bold 13px system-ui, sans-serif'
  c.fillStyle = speakerRole === 'other' ? '#ffffff' : '#888888'
  c.fillText(role, METER_W / 2, 54)

  // level history strip on the right edge
  const bx = METER_W - 64
  const bw = 3
  const gap = 1
  const maxBars = Math.floor(60 / (bw + gap))
  const bars = history.slice(-maxBars)
  for (let i = 0; i < bars.length; i++) {
    const h = Math.max(1, Math.round(bars[i] * 30))
    c.fillStyle = '#cccccc'
    c.fillRect(bx + i * (bw + gap), 66 - h, bw, h)
  }
  // current level marker, left edge
  c.fillStyle = '#ffffff'
  c.fillRect(6, 66 - Math.round(level * 30), 4, Math.max(2, Math.round(level * 30)))

  return toPng(meterCanvas)
}

// ── Japanese captions (rasterized; firmware font has no CJK) ─────────
export const CAP_W = 576
export const CAP_H = 144
const capCanvas = makeCanvas(CAP_W, CAP_H)
const cctx = capCanvas.getContext('2d')!
const capLeft = makeCanvas(CAP_W / 2, CAP_H)
const capRight = makeCanvas(CAP_W / 2, CAP_H)

const JP_FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif'

export interface CapLine {
  text: string
  /** interim / partial result — drawn dimmer. */
  dim?: boolean
}

/** Wrap `text` to `maxWidth` px using the JP font at `font` spec. */
function wrap(ctx: CanvasRenderingContext2D, text: string, font: string, maxWidth: number): string[] {
  ctx.font = font
  const lines: string[] = []
  let cur = ''
  for (const ch of text) {
    const next = cur + ch
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur)
      cur = ch
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/** Returns PNG pair [left, right] for the two 288-wide image containers. */
export async function renderCaptionsJa(lines: CapLine[]): Promise<[Uint8Array, Uint8Array]> {
  const c = cctx
  c.clearRect(0, 0, CAP_W, CAP_H)
  c.textBaseline = 'top'
  c.textAlign = 'left'

  let y = 4
  for (const l of lines) {
    const font = `${l.dim ? '' : 'bold '}30px ${JP_FONT}`
    for (const w of wrap(c, l.text, font, CAP_W - 12)) {
      if (y > CAP_H - 34) break
      c.font = font
      c.fillStyle = l.dim ? '#888888' : '#ffffff'
      c.fillText(w, 6, y)
      y += 36
    }
  }

  // split into left/right halves
  capLeft.getContext('2d')!.clearRect(0, 0, CAP_W / 2, CAP_H)
  capRight.getContext('2d')!.clearRect(0, 0, CAP_W / 2, CAP_H)
  capLeft.getContext('2d')!.drawImage(capCanvas, 0, 0)
  capRight.getContext('2d')!.drawImage(capCanvas, -CAP_W / 2, 0)

  return [await toPng(capLeft), await toPng(capRight)]
}

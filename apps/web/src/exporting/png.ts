/**
 * PNG export from the on-screen canvas.
 *
 * Read the warning below before using this for anything published.
 *
 * The desktop app renders its saved figures with Matplotlib's Agg backend at a
 * configurable DPI, on a fixed white background, with Matplotlib's own tick
 * placement, font metrics and legend layout. This function reads pixels out of a
 * uPlot canvas drawn by the browser. The two agree on the data and on nothing
 * else: line joins, antialiasing, text shaping and tick selection all differ,
 * and they differ *between browsers* as well.
 *
 * That is fine for a screenshot to paste into a message, and not fine for a
 * figure in a paper. The formal, reproducible figure is the cloud poster, which
 * runs the pinned Matplotlib renderer against a validated plot spec — that is
 * the only output carrying a pixel-level guarantee. The UI says so at the point
 * of export rather than in a document nobody opens.
 */

/** Japanese caveat shown next to the PNG action and repeated in the result toast. */
export const PNG_PARITY_NOTICE =
  'ブラウザPNGはデスクトップ版（Matplotlib）と画素単位では一致しません。論文用の図はクラウドの正式ポスターを使用してください。'

export const PNG_PARITY_NOTICE_EN =
  'Browser PNG is not pixel-identical to the desktop Matplotlib output. Use the cloud formal poster for publication figures.'

export interface CanvasPngOptions {
  /**
   * Pixel scale relative to the CSS size. 2 roughly matches a retina screenshot;
   * it is *not* the desktop's `export_dpi`, which has no meaning for a canvas
   * that was never laid out in inches.
   */
  scale: number
  /** Painted behind the plot, because a canvas is transparent where nothing drew. */
  background: string
  /** Identification is painted into the PNG, including the visible series colours. */
  title: string
  legend: readonly { color: string; label: string }[]
  foreground: string
}

// Match --font-sans, --size-subheader and --size-small in styles/tokens.css.
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP", Meiryo, sans-serif'
const TITLE_FONT = `500 13px ${FONT_FAMILY}`
const LEGEND_FONT = `400 11px ${FONT_FAMILY}`
const PADDING = 12
const SWATCH = 8
const SWATCH_GAP = 6
const ITEM_GAP = 16
const LINE_HEIGHT = 16

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  // Character wrapping also handles Japanese labels and long unbroken filenames.
  for (const character of text) {
    if (character === '\n' || (line !== '' && context.measureText(line + character).width > width)) {
      lines.push(line)
      line = ''
    }
    if (character !== '\n') line += character
  }
  if (line !== '') lines.push(line)
  return lines
}

function layoutHeader(context: CanvasRenderingContext2D, width: number, options: CanvasPngOptions) {
  const available = Math.max(1, width - 2 * PADDING)
  const text: { label: string; x: number; y: number; font: string }[] = []
  const swatches: { x: number; y: number; color: string }[] = []
  let top = PADDING
  context.font = TITLE_FONT
  for (const label of wrapText(context, options.title, available)) {
    text.push({ label, x: PADDING, y: top, font: TITLE_FONT })
    top += 18
  }
  if (text.length > 0 && options.legend.length > 0) top += 4
  context.font = LEGEND_FONT
  let left = PADDING
  let rowHeight = 0
  for (const entry of options.legend) {
    const lines = wrapText(context, entry.label, Math.max(1, available - SWATCH - SWATCH_GAP))
    const itemWidth =
      SWATCH + SWATCH_GAP + Math.max(0, ...lines.map((line) => context.measureText(line).width))
    if (left > PADDING && left + itemWidth > width - PADDING) {
      top += rowHeight
      left = PADDING
      rowHeight = 0
    }
    swatches.push({ x: left, y: top + (LINE_HEIGHT - SWATCH) / 2, color: entry.color })
    lines.forEach((label, index) => {
      text.push({ label, x: left + SWATCH + SWATCH_GAP, y: top + index * LINE_HEIGHT, font: LEGEND_FONT })
    })
    rowHeight = Math.max(rowHeight, Math.max(1, lines.length) * LINE_HEIGHT)
    left += itemWidth + ITEM_GAP
  }
  return { text, swatches, height: top + rowHeight + PADDING }
}

/**
 * Copy a canvas to a PNG blob.
 *
 * The source is redrawn onto an opaque offscreen canvas first: exporting the
 * live canvas directly gives a transparent background, which turns into black
 * in most viewers and into an invisible plot in a dark-themed one.
 */
export async function canvasToPng(canvas: HTMLCanvasElement, options: CanvasPngOptions): Promise<Blob> {
  // Both CSS dimensions must be real before any canvas work: substituting
  // bitmap size for a zero-width element produced absurd targets, and a
  // detached or zero-height canvas yields a corrupt export.
  const rect = canvas.getBoundingClientRect()
  const width = rect.width
  const height = rect.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`グラフの描画領域が無効です (${width}×${height})。`)
  }

  const target = document.createElement('canvas')
  const context = target.getContext('2d')
  if (context === null) throw new Error('2Dコンテキストを取得できませんでした。')

  // uPlot's bitmap already includes devicePixelRatio. Lay out in CSS pixels,
  // then scale the header and source together, including on retina displays.
  const pixelRatio = canvas.width / width
  const scale = options.scale * pixelRatio
  const header = layoutHeader(context, width, options)
  target.width = Math.max(1, Math.round(width * scale))
  target.height = Math.max(1, Math.ceil((height + header.height) * scale))

  context.fillStyle = options.background
  context.fillRect(0, 0, target.width, target.height)
  context.scale(scale, scale)
  context.textBaseline = 'top'
  context.fillStyle = options.foreground
  for (const item of header.text) {
    context.font = item.font
    context.fillText(item.label, item.x, item.y)
  }
  for (const item of header.swatches) {
    context.fillStyle = item.color
    context.fillRect(item.x, item.y, SWATCH, SWATCH)
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, header.height, width, height)

  return new Promise<Blob>((resolve, reject) => {
    target.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('PNGの生成に失敗しました。'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

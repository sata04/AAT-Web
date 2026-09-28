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
}

/** Output geometry depends on CSS size, never the display's backing-store ratio. */
export function pngTargetDimensions(
  cssWidth: number,
  cssHeight: number,
  scale: number,
): {
  width: number
  height: number
} {
  if (![cssWidth, cssHeight, scale].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('PNGのサイズと倍率は正の有限値で指定してください。')
  }
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  }
}

/**
 * Copy a canvas to a PNG blob.
 *
 * The source is redrawn onto an opaque offscreen canvas first: exporting the
 * live canvas directly gives a transparent background, which turns into black
 * in most viewers and into an invisible plot in a dark-themed one.
 */
export async function canvasToPng(canvas: HTMLCanvasElement, options: CanvasPngOptions): Promise<Blob> {
  const { width, height } = pngTargetDimensions(canvas.clientWidth, canvas.clientHeight, options.scale)

  const target = document.createElement('canvas')
  target.width = width
  target.height = height
  const context = target.getContext('2d')
  if (context === null) throw new Error('2Dコンテキストを取得できませんでした。')

  context.fillStyle = options.background
  context.fillRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  // Capture only: no uPlot redraw is wired here. Above the source backing
  // resolution this upscales existing pixels; at/below it this copies/downscales.
  context.drawImage(canvas, 0, 0, width, height)

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

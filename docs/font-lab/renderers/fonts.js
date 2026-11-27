const fonts = JSON.parse(document.getElementById('fonts').textContent)
// A glyph's strokes as lists of [x, y] points, and its left and right edges (proportional spacing).
const glyph = (font, ch) => {
  const strokes = (font[ch] || []).map((stroke) => stroke.split(' ').map((point) => point.split(',').map(Number)))
  const xs = strokes.flat().map(([x]) => x)
  return { strokes, left: xs.length ? Math.min(...xs) : 0, right: xs.length ? Math.max(...xs) : 1 }
}
// Width of a line of text in grid units (multiply by size / height for pixels).
// The display font's broad pen widens every stroke, so its letters sit a unit further apart.
const gap = (font) => (font == fonts.display ? 3 : 2)
const textWidth = (text, font = fonts.readable) => [...text].reduce((w, ch) => w + glyph(font, ch).right - glyph(font, ch).left + gap(font), -gap(font))
// Draw a line of text with its top-left at (x, y). size is the cap height in pixels; the caller sets strokeStyle.
// The readable font is drawn thin and round. The display font is drawn with a broad pen held at 45°: the path is
// stroked thinly at nine points along the nib, so strokes running down-left to up-right come out thin and the
// rest thick, like lettering cut with a calligraphy nib.
function drawText(ctx, text, x, y, size, font = fonts.readable, weight) {
  const display = font == fonts.display
  const height = display ? 8 : 6
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / height, size / height)
  ctx.lineWidth = weight || (display ? 0.4 : 0.8)
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const ch of text) {
    const { strokes, left, right } = glyph(font, ch)
    const path = new Path2D()
    for (const points of strokes) points.forEach(([px, py], i) => (i ? path.lineTo(px - left, py) : path.moveTo(px - left, py)))
    for (let k = display ? -4 : 0; k <= (display ? 4 : 0); k++) ctx.setTransform(ctx.getTransform().translate(k * 0.14, -k * 0.14)), ctx.stroke(path), ctx.setTransform(ctx.getTransform().translate(-k * 0.14, k * 0.14))
    ctx.translate(right - left + gap(font), 0)
  }
  ctx.restore()
}

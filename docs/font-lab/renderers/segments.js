const { segments, glyphs } = JSON.parse(document.getElementById('font').textContent)
function drawText(ctx, text, x, y, size) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 8, size / 8)
  ctx.lineWidth = 1
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const ch of text.toUpperCase()) {
    ctx.beginPath()
    for (const name of glyphs[ch]?.split(' ') || []) {
      const [[x0, y0], [x1, y1]] = segments[name].split(' ').map((point) => point.split(','))
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    }
    ctx.stroke()
    ctx.translate(6, 0)
  }
  ctx.restore()
}

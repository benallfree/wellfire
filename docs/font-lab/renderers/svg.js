const font = JSON.parse(document.getElementById('font').textContent)
function drawText(ctx, text, x, y, size) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 8, size / 8)
  ctx.lineWidth = 1
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const ch of text.toUpperCase()) {
    if (font[ch]) ctx.stroke(new Path2D(font[ch]))
    ctx.translate(6, 0)
  }
  ctx.restore()
}

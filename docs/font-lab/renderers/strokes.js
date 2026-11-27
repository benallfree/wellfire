const font = JSON.parse(document.getElementById('font').textContent)
function drawText(ctx, text, x, y, size) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 8, size / 8)
  ctx.lineWidth = 1
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const ch of text.toUpperCase()) {
    ctx.beginPath()
    for (const stroke of font[ch] || []) {
      stroke.split(' ').forEach((point, i) => {
        const [px, py] = point.split(',')
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
      })
    }
    ctx.stroke()
    ctx.translate(6, 0)
  }
  ctx.restore()
}

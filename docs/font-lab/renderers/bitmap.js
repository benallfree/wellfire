const font = JSON.parse(document.getElementById('font').textContent)
function drawText(ctx, text, x, y, size) {
  const pixel = size / 8
  for (const ch of text.toUpperCase()) {
    font[ch]?.forEach((row, j) => [...row].forEach((cell, i) => cell == '#' && ctx.fillRect(x + i * pixel, y + j * pixel, pixel, pixel)))
    x += 6 * pixel
  }
}

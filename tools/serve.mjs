// A tiny static server: / is the built game (dist/index.html); /tools/viewer.html is the model viewer.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = +(process.env.PORT || 8713)
const types = { html: 'text/html', js: 'text/javascript', txt: 'text/plain' }
createServer(async (req, res) => {
  let path = req.url.split('?')[0]
  if (path == '/' || path == '/index.html') path = '/dist/index.html'
  if (!/^\/(dist|src|tools)\/[\w./-]+$/.test(path) || path.includes('..')) return res.writeHead(404).end('not found')
  try {
    const body = await readFile(new URL('..' + path, import.meta.url))
    res.writeHead(200, { 'content-type': types[path.split('.').pop()] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${port}  (model viewer: /tools/viewer.html)`))

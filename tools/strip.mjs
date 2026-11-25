// Drops JS comments for the shipped build; everything else (names, indentation, line breaks) stays as written.
// Under surprisal, comments are the expensive part of the source: stripping them took game.js from 7,388 to 4,960
// bytes at -1, while collapsing whitespace or minifying made it worse (see docs/refactor-size.md).
// A small scanner: it skips strings, template literals (with ${} nesting) and regex literals, so only real comments go.
// A line that held only a comment is removed; a trailing comment is cut along with the spaces before it.
export function strip(src) {
  let out = ''
  let i = 0
  let last = '' // the last significant character, to tell a regex from a division
  const stack = [] // open template literals: the ${ depth at which each one resumes
  let depth = 0
  const regexAfter = '(,=:[!&|?{};+-*%<>~^'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c == '/' && n == '/') {
      const e = src.indexOf('\n', i)
      i = e < 0 ? src.length : e
      out = out.replace(/[ \t]+$/, '')
      if (/(^|\n)$/.test(out)) i++ // the line held only the comment: drop it whole
      continue
    }
    if (c == '/' && n == '*') {
      const e = src.indexOf('*/', i + 2)
      i = e < 0 ? src.length : e + 2
      continue
    }
    if (c == "'" || c == '"') {
      let j = i + 1
      while (j < src.length && src[j] != c) j += src[j] == '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
      last = c
      continue
    }
    if (c == '`' || (c == '}' && stack.length && stack[stack.length - 1] == depth)) {
      if (c == '}') stack.pop(), depth--
      let j = i + 1
      while (j < src.length && src[j] != '`' && !(src[j] == '$' && src[j + 1] == '{')) j += src[j] == '\\' ? 2 : 1
      if (src[j] == '$') stack.push(++depth), (j += 2)
      else j++
      out += src.slice(i, j)
      i = j
      last = '`'
      continue
    }
    if (c == '/' && (!last || regexAfter.includes(last) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd()))) {
      let j = i + 1
      let cls = false
      while (j < src.length && (src[j] != '/' || cls)) {
        if (src[j] == '\\') j++
        else if (src[j] == '[') cls = true
        else if (src[j] == ']') cls = false
        j++
      }
      j++
      while (/[a-z]/i.test(src[j] || '')) j++ // flags
      out += src.slice(i, j)
      i = j
      last = '/'
      continue
    }
    if (c == '{') depth++
    else if (c == '}') depth--
    if (!/\s/.test(c)) last = c
    out += c
    i++
  }
  return out
}

// The music compiler and player: score JSON in, WebAudio voices out.
// See README.md "Music". The score compiles once into per-step event lists; a lookahead scheduler plays them.

const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const midi = (pc, oct) => 12 * (oct + 1) + pc
const hz = (m) => 440 * 2 ** ((m - 69) / 12)
const DRUMS = ['noise', 'kick']

// "Am", "F#", "G7", "Bbm7" -> { root pitch class, intervals }
function chord(s) {
  const m = s.match(/^([a-g])(#|b)?(m)?(7)?$/i)
  if (!m) throw Error('bad chord ' + s)
  const iv = m[3] ? [0, 3, 7] : [0, 4, 7]
  if (m[4]) iv.push(10)
  return { root: NOTE[m[1].toLowerCase()] + (m[2] == '#') - (m[2] == 'b'), iv }
}

// Chord tone i (1 = root, 2 = third, 3 = fifth, 4 = root an octave up, ...) with the root in octave oct.
const tone = (c, i, oct) => midi(c.root, oct) + c.iv[(i - 1) % c.iv.length] + 12 * Math.floor((i - 1) / c.iv.length)

// Tokens -> [[time, token, duration]] in steps. Each token lasts `unit` steps; "a,b" splits it evenly.
function slots(tokens, unit) {
  const out = []
  let t = 0
  for (const tok of tokens) {
    const parts = tok.split(',')
    for (const p of parts) out.push([t, p, unit / parts.length]), (t += unit / parts.length)
  }
  return { out, n: t }
}

// Read the score JSON: tempo, section orders, voices, parts shared by all sections, and sections.
// A section with a "base" starts as a copy of that section's parts. Patterns are strings of tokens; "|" is a bar line.
export function score(json) {
  const S = JSON.parse(json)
  for (const name in S.voices) S.voices[name].name = name
  const raw = S.sections
  const parts = (name) => ({ ...(raw[name].base && parts(raw[name].base)), ...raw[name].parts })
  S.sections = {}
  for (const name in raw) S.sections[name] = build(S, raw[name].chords, { ...S.allSections, ...parts(name) })
  return S
}

// Compile one section into events per step: { v: voice, t: start step, d: length in steps, f: [Hz...], acc }.
function build(S, chords = 'C', lines) {
  const tokens = (p) => p.replace(/\|/g, ' ').trim().split(/\s+/)
  const ch = slots(tokens(chords), S.tempo.stepsPerBeat * S.tempo.beatsPerBar)
  const voices = Object.keys(lines)
  const parsed = voices.map((k) => slots(tokens(lines[k]), 1))
  const len = Math.max(ch.n, ...parsed.map((p) => p.n))
  const chordAt = (t) => {
    t %= ch.n
    let c = ch.out[0]
    for (const s of ch.out) if (s[0] <= t) c = s
    return chord(c[1])
  }
  const steps = Array.from({ length: len }, () => [])
  voices.forEach((k, i) => {
    const v = S.voices[k]
    if (!v) throw Error('no voice ' + k)
    const { out, n } = parsed[i]
    let last = null
    for (let r = 0; r * n < len; r++)
      for (const [t0, tok, d] of out) {
        const t = t0 + r * n
        if (t >= len) break
        if (tok == '-') {
          if (last) last.d += d
          continue
        }
        last = null
        if (tok == '.') continue
        let f
        if (DRUMS.includes(v.wave)) f = [0]
        else if (tok == '*') f = chordAt(t).iv.map((_, j) => tone(chordAt(t), j + 1, v.octave))
        else if (/^\d$/.test(tok)) f = [tone(chordAt(t), +tok, v.octave)]
        else {
          const m = tok.match(/^([a-g])(#|b)?(\d)?$/)
          if (!m) throw Error(`bad note ${tok} in ${k}`)
          f = [midi(NOTE[m[1]] + (m[2] == '#') - (m[2] == 'b'), m[3] ? +m[3] : v.octave)]
        }
        steps[Math.floor(t)].push((last = { v, t, d, f: f.map(hz), acc: tok == 'o' }))
      }
  })
  return { len, steps }
}

// A sequencer for a compiled score on an AudioContext. tick(until) schedules every step that starts before `until`.
// The game drives it in real time; an OfflineAudioContext can drive it to render the song for checks.
export function sequencer(S, ac, out) {
  const step = 60 / S.tempo.bpm / S.tempo.stepsPerBeat // seconds per step; the tempo never changes
  const bar = S.tempo.stepsPerBeat * S.tempo.beatsPerBar
  const st = { day: 1, near: {}, steps: 0, section: '', order: 'day' }
  const master = ac.createBiquadFilter()
  master.connect(out)
  const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate)
  noise.getChannelData(0).forEach((_, i, d) => (d[i] = Math.random() * 2 - 1))
  const chan = {}
  for (const v of Object.values(S.voices)) {
    const f = ac.createBiquadFilter()
    f.type = v.wave == 'noise' ? 'highpass' : 'lowpass'
    f.frequency.value = v.filter || 20000
    const g = (chan[v.name] = ac.createGain())
    g.gain.value = v.monster ? 0 : v.volume
    f.connect(g).connect(master)
    chan[v.name].in = f
  }
  let idx = -1
  let pos = 0
  let sec
  let next = ac.currentTime + 0.1
  const want = () => (st.day < 0.35 ? 'night' : 'day')
  // At each section end, play the next section of the current order. When day turns to night (or back),
  // switch orders at the next bar line, staying at the same place in the bar count.
  function advance(keep) {
    idx = want() == st.order ? (idx + 1) % S.order[st.order].length : 0
    st.order = want()
    st.section = S.order[st.order][idx]
    sec = S.sections[st.section]
    pos = keep ? pos % sec.len : 0
  }
  advance()

  function note(e, t, d) {
    const v = e.v
    const g = ac.createGain()
    const vol = (e.acc ? 1.6 : 1) / Math.sqrt(e.f.length)
    const end = t + Math.max(d, v.attack)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + v.attack)
    if (DRUMS.includes(v.wave)) g.gain.setTargetAtTime(0, t + v.attack, v.release / 3)
    else g.gain.setValueAtTime(vol, end), g.gain.setTargetAtTime(0, end, v.release / 3)
    g.connect(chan[v.name].in)
    const stop = end + v.release * 2
    for (const f of e.f) {
      let s
      if (v.wave == 'noise') {
        s = ac.createBufferSource()
        s.buffer = noise
        s.loop = true
      } else {
        s = ac.createOscillator()
        if (v.wave == 'kick') {
          s.frequency.setValueAtTime(300, t)
          s.frequency.exponentialRampToValueAtTime(45, t + 0.12)
        } else {
          s.type = v.wave
          s.frequency.value = f
          s.detune.value = (Math.random() - 0.5) * 12 // a little chorus on chords
        }
      }
      s.connect(g)
      s.start(t)
      s.stop(stop)
    }
  }

  st.tick = (until) => {
    const now = ac.currentTime
    if (next < now) next = now + 0.05 // we fell behind (background tab): skip ahead rather than burst
    // mood: night closes the filter. A voice tagged with a monster kind follows how near that kind
    // is (0..1, from the game); "calm" voices duck while any monster is near.
    const any = Math.max(0, ...Object.values(st.near))
    master.frequency.setTargetAtTime(1200 + st.day * 6000, now, 0.5)
    for (const v of Object.values(S.voices))
      chan[v.name].gain.setTargetAtTime(v.volume * (v.calm ? 1 - any * 0.8 : v.monster ? st.near[v.monster] || 0 : 1), now, 0.3)
    while (next < until) {
      for (const e of sec.steps[pos]) note(e, next + (e.t - pos) * step, e.d * step)
      next += step
      st.steps++
      if (++pos >= sec.len) advance()
      else if (pos % bar == 0 && want() != st.order) advance(true)
    }
  }
  return st
}

// The game's audio: one AudioContext created on the first user gesture, a mute switch (remembered), and the music.
export function jukebox(S) {
  const J = { ac: null, out: null, muted: false, music: null }
  try {
    J.muted = localStorage.warriorMute == 1
  } catch {}
  J.start = () => {
    if (!J.ac) {
      J.ac = new AudioContext()
      J.out = J.ac.createGain()
      J.out.connect(J.ac.destination)
      J.music = sequencer(S, J.ac, J.out)
      setInterval(() => J.music.tick(J.ac.currentTime + 0.25), 50)
    }
    J.ac[J.muted ? 'suspend' : 'resume']()
  }
  J.mute = (m = !J.muted) => {
    J.muted = m
    try {
      localStorage.warriorMute = m ? 1 : 0
    } catch {}
    if (J.ac) J.start()
  }
  J.mood = (day, near) => J.music && Object.assign(J.music, { day, near })
  return J
}

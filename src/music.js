// The music compiler and player: score JSON in, WebAudio voices out.
// See README.md "Music". The score compiles once into per-step event lists; a lookahead scheduler plays them.

const NOTE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const midi = (pc, oct) => 12 * (oct + 1) + pc
const hz = (m) => 440 * 2 ** ((m - 69) / 12)
const DRUMS = ['kick', 'taiko', 'snare', 'hat']

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

// The instruments, all synthesized. Struck and plucked sounds (harp, bell, marimba, drums) are rendered into an
// AudioBuffer once per pitch and replayed; held sounds (flute, strings, brass, bass) are small live oscillator graphs.
const rnd = (a = 1) => (Math.random() * 2 - 1) * a
function instruments(ac) {
  const SR = ac.sampleRate
  const TAU = 2 * Math.PI
  let z = 0 // one-pole filter state for the renderers
  const buf = (sec, fn, chans = 1) => {
    const b = ac.createBuffer(chans, Math.ceil(sec * SR), SR)
    for (let c = 0; c < chans; c++) for (let i = 0, d = b.getChannelData(c); i < d.length; i++) d[i] = fn(i / SR, i, d)
    return b
  }
  const gain = (v = 1) => {
    const g = ac.createGain()
    g.gain.value = v
    return g
  }
  const filt = (type, f, q = 0.7) => {
    const b = ac.createBiquadFilter()
    b.type = type
    b.frequency.value = Math.min(f, SR / 2.2)
    b.Q.value = q
    return b
  }
  const osc = (type, f, t, stop, det = 0) => {
    const o = ac.createOscillator()
    typeof type == 'string' ? (o.type = type) : o.setPeriodicWave(type)
    o.frequency.value = f
    o.detune.value = det
    o.start(t)
    stop && o.stop(stop)
    return o
  }
  // 0 -> peak over att, then toward peak*sus (time constant dec); after `end`, fades out over about rel seconds
  const env = (out, t, end, peak, att, sus, dec, rel) => {
    const g = gain(0)
    const p = g.gain
    p.setValueAtTime(0, t)
    p.linearRampToValueAtTime(peak, t + att)
    p.setTargetAtTime(peak * sus, t + att, dec)
    p.setTargetAtTime(0, Math.max(end, t + att + 0.001), rel / 3)
    g.connect(out)
    return g
  }
  const noise = buf(1, () => rnd())
  const hiss = (out, f, q, t, stop) => {
    const n = ac.createBufferSource()
    n.buffer = noise
    n.loop = true
    n.start(t, Math.random())
    n.stop(stop)
    return n.connect(filt('bandpass', f, q)).connect(out)
  }
  const FLUTE = ac.createPeriodicWave(new Float32Array(5), new Float32Array([0, 1, 0.22, 0.07, 0.03]))
  const decay = (t, k) => Math.exp(-t * k)
  // Renderers: (voice, Hz) -> AudioBuffer. Drums ignore the pitch.
  const sampled = {
    // Karplus-Strong: a noise burst circulating in a delay line one period long, averaged (so it loses highs) each pass
    pluck: (v, f) => {
      const P = SR / f - 0.5
      const b = v.bright || 0.5
      return buf(v.release + 0.3, (t, i, d) => {
        if (i < P + 2) return (z += (rnd() - z) * b)
        const x = i - P
        const j = x | 0
        const fr = x - j
        return (d[j] + (d[j + 1] - d[j]) * fr + d[j - 1] + (d[j] - d[j - 1]) * fr) * 0.5 * (v.sustain || 0.996)
      })
    },
    // a struck bar or bell: inharmonic partials, the high ones dying first, plus a slow beat on the fundamental
    // (each partial is a two-pole resonator's ringing: a decaying sine for two multiplies a sample)
    bell: (v, f) => {
      const b = buf(v.release + 0.3, () => 0)
      const d = b.getChannelData(0)
      for (const [r, a, k] of [[1.002, 0.4, 1.2], [1, 1, 1.2], [2, 0.45, 2.4], [3.01, 0.22, 4], [4.17, 0.16, 6], [5.43, 0.1, 9]]) {
        const w = (TAU * f * r) / SR
        const R = Math.exp(-k / SR)
        const c = 2 * R * Math.cos(w)
        let y = 0
        let y1 = a * 0.5 * R * Math.sin(w)
        if (w < 3) for (let i = 1; i < d.length; i++) (d[i] += y1), (y = c * y1 - R * R * y), ([y, y1] = [y1, y])
      }
      for (let i = 0; i < SR / 400; i++) d[i] *= (i * 400) / SR // a soft hammer
      return b
    },
    // a soft mallet with a pitch that drops into place: the slime's boing
    marimba: (v, f) =>
      buf(v.release + 0.3, (t) => (Math.sin(TAU * f * (t + (0.5 * (1 - decay(t, 40))) / 40)) * decay(t, 6) + Math.sin(TAU * f * 4 * t) * 0.25 * decay(t, 25)) * Math.min(1, t * 300)),
    kick: () => buf(0.5, (t) => Math.sin(TAU * (48 * t + (180 * (1 - decay(t, 28))) / 28)) * decay(t, 7) + rnd(0.4) * decay(t, 250)),
    // taiko / frame drum: a low tone that bends down, under a dark skin noise
    taiko: () => buf(1.2, (t) => Math.sin(TAU * (62 * t + (50 * (1 - decay(t, 14))) / 14)) * decay(t, 3.5) + (z += (rnd() - z) * 0.08) * 1.5 * decay(t, 9)),
    snare: () => {
      let p = 0
      return buf(0.4, (t) => (Math.sin(TAU * 185 * t) + 0.5 * Math.sin(TAU * 330 * t)) * 0.5 * decay(t, 30) + (p - (p = rnd()) ) * 0.4 * decay(t, 16))
    },
    // hi-hat and spider ticks: high-passed noise, decay set by the voice's release
    hat: (v) => {
      let p = 0
      return buf(v.release * 4, (t) => (p - (p = rnd())) * 0.5 * decay(t, 3 / v.release))
    },
  }
  const cache = {}
  const sample = (v, f) => (cache[v.name + f] ||= sampled[v.wave](v, f))
  // Live instruments: (voice, Hz, start, note end, stop, output)
  const live = {
    // filtered sine with a breathy chiff on the attack and vibrato that only arrives on held notes
    flute(v, f, t, end, stop, out) {
      const o = osc(FLUTE, f, t, stop)
      const d = gain(0)
      d.gain.setValueAtTime(0, t + 0.15)
      d.gain.linearRampToValueAtTime(f * 0.006, t + 0.6)
      osc('sine', 4.6 + Math.random(), t, stop).connect(d).connect(o.frequency)
      o.connect(env(out, t, end, 1, 0.06, 0.8, 0.2, v.release))
      hiss(env(out, t, end, 1.2, 0.02, 0.25, 0.05, v.release), f * 1.5, 1.5, t, stop)
    },
    // three detuned saws per note through a low-pass that opens as the bow bites (the voice adds the chorus)
    strings(v, f, t, end, stop, out) {
      const lp = filt('lowpass', f * 1.5, 0.5)
      lp.frequency.setValueAtTime(f * 1.5, t)
      lp.frequency.linearRampToValueAtTime(Math.min(f * 5, 6000), t + v.attack)
      lp.connect(env(out, t, end, 0.4, v.attack, 0.9, 1, v.release))
      for (const c of [-9, 0, 8]) osc('sawtooth', f, t, stop, c + rnd(3)).connect(lp)
    },
    // saws scooping up into pitch, with a filter that blares open on the attack and settles
    brass(v, f, t, end, stop, out) {
      const lp = filt('lowpass', f, 1.2)
      const p = lp.frequency
      p.setValueAtTime(f, t)
      p.linearRampToValueAtTime(f * 7, t + 0.05)
      p.setTargetAtTime(f * 3, t + 0.05, 0.2)
      p.setTargetAtTime(f, end, v.release / 3)
      lp.connect(env(out, t, end, 0.6, 0.03, 0.75, 0.25, v.release))
      for (const c of [-6, 6]) {
        const o = osc('sawtooth', f, t, stop, c)
        o.frequency.setValueAtTime(f * 0.97, t)
        o.frequency.exponentialRampToValueAtTime(f, t + 0.06)
        o.connect(lp)
      }
    },
    // a saw and a sine under a filter that snaps shut: a plucked, round bass
    bass(v, f, t, end, stop, out) {
      const lp = filt('lowpass', f * 10, 2)
      lp.frequency.setValueAtTime(f * 10, t)
      lp.frequency.setTargetAtTime(f * 3, t, 0.07)
      lp.connect(env(out, t, end, 1, 0.005, 0.45, 0.35, v.release))
      osc('sawtooth', f, t, stop).connect(lp)
      osc('sine', f, t, stop).connect(gain(1.5)).connect(lp)
    },
  }
  // any oscillator type, with the voice's attack and release
  const plain = (v, f, t, end, stop, out) => osc(v.wave, f, t, stop).connect(env(out, t, end, 1, v.attack, 1, 1, v.release))

  // The room: a convolution reverb whose impulse is decaying noise that darkens as it fades
  const verb = ac.createConvolver()
  verb.buffer = buf(2.4, (t) => (z += (rnd() - z) * (0.05 + 0.9 * decay(t, 2))) * decay(t, 2.6) * (t > 0.012), 2)

  // note: one voice's event at time t (velocity a, pitch ratio r for drift) into its channel input
  function play(v, f, t, d, a, r, out) {
    const g = gain(a)
    g.connect(out)
    if (sampled[v.wave]) {
      const s = ac.createBufferSource()
      s.buffer = sample(v, f)
      s.playbackRate.value = r
      s.connect(g)
      s.start(t)
      if (!DRUMS.includes(v.wave)) g.gain.setTargetAtTime(0, t + d, v.release / 3) // the damper
    } else (live[v.wave] || plain)(v, f * r, t, t + d, t + d + v.release * 2 + 0.1, g)
  }
  return { gain, filt, osc, verb, play, sample, sampled }
}

// A sequencer for a compiled score on an AudioContext. tick(until) schedules every step that starts before `until`.
// The game drives it in real time; an OfflineAudioContext can drive it to render the song for checks.
export function sequencer(S, ac, out) {
  const step = 60 / S.tempo.bpm / S.tempo.stepsPerBeat // seconds per step; the tempo never changes
  const bar = S.tempo.stepsPerBeat * S.tempo.beatsPerBar
  const st = { day: 1, near: {}, steps: 0, section: '', order: 'day' }
  const I = instruments(ac)
  // master: night low-pass -> rumble/DC cut -> gentle compressor -> music level (kept under the game's sound effects)
  const master = I.filt('lowpass', 20000)
  const comp = ac.createDynamicsCompressor()
  for (const [k, x] of Object.entries({ threshold: -20, knee: 12, ratio: 3, attack: 0.01, release: 0.3 })) comp[k].value = x
  master.connect(I.filt('highpass', 30)).connect(comp).connect(I.gain(S.mix || 1)).connect(out)
  I.verb.connect(master)
  // ensemble chorus for voices that ask for it: two slowly wobbling delays, panned apart
  const chorus = I.gain(0.8)
  for (const [pan, rate] of [[-0.8, 0.31], [0.8, 0.43]]) {
    const dl = ac.createDelay(0.05)
    dl.delayTime.value = 0.016
    I.osc('sine', rate, ac.currentTime).connect(I.gain(0.004)).connect(dl.delayTime)
    const p = ac.createStereoPanner()
    p.pan.value = pan
    chorus.connect(dl).connect(p).connect(master)
    p.connect(I.gain(0.3)).connect(I.verb)
  }
  // a channel per voice: optional filter -> level -> pan -> master, plus a send to the reverb
  const chan = {}
  for (const v of Object.values(S.voices)) {
    const g = (chan[v.name] = I.gain(v.monster ? 0 : v.volume))
    const p = ac.createStereoPanner()
    p.pan.value = v.pan || 0
    g.connect(p).connect(master)
    p.connect(I.gain(v.reverb ?? 0.25)).connect(I.verb)
    if (v.chorus) g.connect(chorus)
    g.in = v.filter ? I.filt(v.wave == 'hat' ? 'highpass' : 'lowpass', v.filter) : g
    if (v.filter) g.in.connect(g)
  }
  // render every sampled note the score uses, one per tick, so first plays don't stall a frame
  const warm = []
  for (const sec of Object.values(S.sections)) for (const es of sec.steps) for (const e of es) if (I.sampled[e.v.wave]) for (const f of e.f) warm.push([e.v, f])
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

  // humanized: a few ms of timing slop, varied velocity with lighter off-beats, a few cents of pitch drift
  // (drums vary more, as hand drums do)
  function note(e, t, d) {
    const v = e.v
    const drum = DRUMS.includes(v.wave)
    const a = ((e.acc ? 1.5 : 1) / Math.sqrt(e.f.length)) * (1 + rnd(0.12)) * (e.t % S.tempo.stepsPerBeat ? 0.85 : 1)
    for (const f of e.f) I.play(v, f, Math.max(ac.currentTime, t + rnd(0.006)), d, a, 2 ** (rnd(drum ? 30 : 4) / 1200), chan[v.name].in)
  }

  st.tick = (until) => {
    const now = ac.currentTime
    if (next < now) next = now + 0.05 // we fell behind (background tab): skip ahead rather than burst
    if (warm.length) I.sample(...warm.pop())
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

// Groovebox — beat maker: drums, a sustained bassline, guitar & funk sounds, and an oscilloscope (Toolbox).
// Sound engine and oscilloscope screen are shared with Mosaicus (../mosaicus/app/js): one codebase.
//
//   voices ─► (velocity) ─► session gain ─┐
//   audition ─────────────────────────────┴► bus ─► compressor ─► master ─► speakers
//                                                      └──────► analyser (mix oscilloscope, not audible)
//
//   Sound lab: the selected sound is rendered ALONE with an OfflineAudioContext (exact waveform,
//   no mix, no timing jitter) and compared with the previous version (grey ghost trace).
import { audio, audioSupported } from '../mosaicus/app/js/audio.js';
import { Screen } from '../mosaicus/app/js/screen.js';
import { SCALES, noteFreq } from '../mosaicus/app/js/dsp.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STEPS = 16, ROWS = 8;
const WINS = [20, 100, 400]; // mix oscilloscope windows, ms
const store = {
  get(k, d) { try { const v = localStorage.getItem('groovebox.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('groovebox.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const WAVES = { choice: ['sine', 'sawtooth', 'square', 'triangle'], labels: ['Sine', 'Saw', 'Square', 'Triangle'] };

// ---------------------------------------------------------------- sounds and their parameters
// Single-row tracks: each step has a value 0 = off, 1 = hit, 2 = ghost (soft), 3 = roll ×2, 4 = roll ×3.
const TRACKS = [
  { id: 'kick', group: 'drums', name: 'Kick',
    hint: 'A sine wave whose frequency falls exponentially: it starts high (the click of the beater) and settles low (the boom). Drive (soft clipping) flattens the peaks: the average power rises while the peak stays the same, and it adds harmonics that a phone speaker CAN reproduce. Sub is a steady sine at the end pitch; Click is a 10 ms burst of noise.',
    params: [
      { k: 'f0', label: 'Start pitch', min: 60, max: 400, def: 160, unit: 'Hz', desc: 'Pitch at the very first instant: the click.' },
      { k: 'f1', label: 'End pitch', min: 30, max: 120, def: 48, unit: 'Hz', desc: 'Pitch it falls to: the low boom.' },
      { k: 'sweep', label: 'Pitch drop time', min: 10, max: 200, def: 45, unit: 'ms', desc: 'How fast it falls from start to end pitch.' },
      { k: 'decay', label: 'Decay', min: 80, max: 800, def: 320, unit: 'ms', desc: 'How long it rings: time for the amplitude to drop to 1/1000 (−60 dB).' },
      { k: 'drive', label: 'Drive', min: 0, max: 100, def: 35, unit: '%', desc: 'Soft clipping: more power and more harmonics (it sounds louder and punchier).' },
      { k: 'sub', label: 'Sub', min: 0, max: 100, def: 35, unit: '%', desc: 'A steady low sine added under the kick: weight (you may only feel it on good speakers).' },
      { k: 'click', label: 'Click', min: 0, max: 100, def: 25, unit: '%', desc: 'Noise burst at the start: the attack that cuts through the mix.' },
    ] },
  { id: 'snare', group: 'drums', name: 'Snare',
    hint: 'A tone from the drum skin plus noise from the snare wires: a pitched sound and a hiss added together. Ghost notes (soft hits between the main ones) give funk its feel.',
    params: [
      { k: 'tone', label: 'Tone pitch', min: 120, max: 400, def: 190, unit: 'Hz', desc: 'Pitch of the drum skin.' },
      { k: 'noise', label: 'Noise amount', min: 0, max: 100, def: 65, unit: '%', desc: 'Hiss of the snare wires against the skin tone.' },
      { k: 'decay', label: 'Decay', min: 60, max: 500, def: 170, unit: 'ms', desc: 'How long the hiss rings (−60 dB).' },
    ] },
  { id: 'hat', group: 'drums', name: 'Hi-hat',
    hint: 'White noise through a high-pass filter: a continuous spectrum with no pitch. In trap the hi-hat runs on every 16th, with rolls (two or three hits in one step).',
    params: [
      { k: 'hp', label: 'High-pass cutoff', min: 3000, max: 12000, def: 7500, unit: 'Hz', desc: 'Frequencies below this are removed: higher = thinner and brighter.' },
      { k: 'decay', label: 'Decay', min: 10, max: 300, def: 45, unit: 'ms', desc: 'Short = closed hat.' },
    ] },
  { id: 'ohat', group: 'drums', name: 'Open hat',
    hint: 'The same noise as the closed hi-hat, but left ringing: the metal discs keep vibrating for longer.',
    params: [
      { k: 'hp', label: 'High-pass cutoff', min: 3000, max: 12000, def: 6500, unit: 'Hz', desc: 'Frequencies below this are removed.' },
      { k: 'decay', label: 'Decay', min: 80, max: 800, def: 300, unit: 'ms', desc: 'How long the discs ring (−60 dB).' },
    ] },
  { id: 'clap', group: 'drums', name: 'Clap',
    hint: 'Band-passed noise in three quick bursts (hands never clap at exactly the same instant), then a tail.',
    params: [
      { k: 'fc', label: 'Filter centre', min: 600, max: 3000, def: 1300, unit: 'Hz', desc: 'Centre of the band of noise that is kept.' },
      { k: 'decay', label: 'Tail decay', min: 50, max: 600, def: 220, unit: 'ms', desc: 'How long the tail rings (−60 dB).' },
    ] },
  { id: 'cow', group: 'drums', name: 'Cowbell',
    hint: 'Two square waves a fifth apart (frequency ratio ≈ 1.48) through a band-pass filter: the classic 808 cowbell. Two inharmonic partials make a metallic, funky “tok”.',
    params: [
      { k: 'pitch', label: 'Pitch', min: 300, max: 900, def: 540, unit: 'Hz', desc: 'Lower of the two square waves; the other is 1.48× higher.' },
      { k: 'decay', label: 'Decay', min: 30, max: 500, def: 200, unit: 'ms', desc: 'How long it rings (−60 dB).' },
    ] },
  { id: 'chank', group: 'gtr', name: 'Chank',
    hint: 'The funk-guitar “scratch”: strings muted by the left hand and raked with the right. A burst of band-passed noise plus a very short string tone. It plays on the 16ths between the drums.',
    params: [
      { k: 'fc', label: 'Filter centre', min: 800, max: 5000, def: 2400, unit: 'Hz', desc: 'Centre of the noise band: the “colour” of the scratch.' },
      { k: 'decay', label: 'Decay', min: 15, max: 150, def: 55, unit: 'ms', desc: 'Very short: the strings are muted.' },
      { k: 'tone', label: 'String tone', min: 0, max: 100, def: 50, unit: '%', desc: 'Amount of muted string (pitched) against the noise.' },
    ] },
  { id: 'chord', group: 'gtr', name: 'Chord stab',
    hint: 'Three plucked strings (Karplus–Strong) forming a triad built on the bass note under the step (or the key note if the bass is silent). The strum delays each string a few ms.',
    params: [
      { k: 'octave', label: 'Octave', min: 2, max: 5, def: 3, unit: '', desc: 'Register of the chord.' },
      { k: 'bright', label: 'Brightness', min: 0, max: 100, def: 55, unit: '%', desc: 'How much high-frequency content the pluck starts with.' },
      { k: 'decay', label: 'Decay', min: 100, max: 1500, def: 450, unit: 'ms', desc: 'How long the strings ring (−60 dB).' },
      { k: 'strum', label: 'Strum', min: 0, max: 60, def: 14, unit: 'ms', desc: 'Delay between the strings: 0 = struck together.' },
    ] },
  { id: 'pluck', group: 'gtr', name: 'Pluck',
    hint: 'A single plucked string, a physical model: a burst of noise runs round a loop whose length sets the pitch, and the loop loses a little high frequency on each lap. It doubles the bass note under the step.',
    params: [
      { k: 'octave', label: 'Octave', min: 2, max: 5, def: 4, unit: '', desc: 'Register of the note.' },
      { k: 'bright', label: 'Brightness', min: 0, max: 100, def: 65, unit: '%', desc: 'Soft finger (low) to hard pick (high).' },
      { k: 'decay', label: 'Decay', min: 100, max: 1500, def: 650, unit: 'ms', desc: 'How long the string rings (−60 dB).' },
    ] },
];
TRACKS.push({ id: 'arp', group: 'gtr', name: 'Arp',
  hint: 'An arpeggiator: the notes of a chord played one after another instead of together. Each active step plays the NEXT note of the chord built on the bass note under it (a stack of scale notes, thirds apart); the Mode, Notes and Octaves chips decide the order and the range. The step pattern gives the rhythm, the arpeggiator gives the pitches. Filter and decay shape each note.',
  params: [
    { k: 'wave', label: 'Waveform', choice: true, def: 'sawtooth', desc: 'Sine is pure; saw and square have many harmonics.' },
    { k: 'octave', label: 'Octave', min: 3, max: 6, def: 4, unit: '', desc: 'Register of the lowest note.' },
    { k: 'cutoff', label: 'Filter cutoff', min: 300, max: 8000, def: 2500, unit: 'Hz', desc: 'Low-pass: it opens at the start of each note and closes (a “pluck”).' },
    { k: 'decay', label: 'Decay', min: 60, max: 800, def: 220, unit: 'ms', desc: 'How long each note rings (−60 dB).' },
  ] });
const BASS = { id: 'bass', group: 'bass', name: 'Bass',
  hint: 'A held note: attack, then decay down to a sustain level, held until the end of the note, then release. Saw and square are rich in harmonics, the low-pass filter removes the upper ones. Small speakers play bass poorly: raise the octave or use headphones.',
  params: [
    { k: 'wave', label: 'Waveform', choice: true, def: 'sine', desc: 'Sine is pure; saw and square have many harmonics.' },
    { k: 'octave', label: 'Octave', min: 1, max: 4, def: 2, unit: '', desc: 'Higher octave = easier to hear on a phone.' },
    { k: 'cutoff', label: 'Filter cutoff', min: 100, max: 6000, def: 900, unit: 'Hz', desc: 'Low-pass: harmonics above this are removed.' },
    { k: 'reso', label: 'Resonance', min: 0, max: 15, def: 0, unit: '', desc: 'Boost around the cutoff: the “wow” of an acid bass.' },
    { k: 'sustain', label: 'Sustain level', min: 0, max: 100, def: 80, unit: '%', desc: 'Level held while the note lasts (100 % = no decay at all).' },
    { k: 'decay', label: 'Decay', min: 40, max: 1500, def: 900, unit: 'ms', desc: 'Time to fall from the peak to the sustain level.' },
    { k: 'drive', label: 'Drive', min: 0, max: 100, def: 40, unit: '%', desc: 'Soft clipping: flattens the peaks and adds harmonics (distortion).' },
  ] };
const KEYS = { id: 'keys', group: 'keys', name: 'Keys',
  hint: 'A polyphonic synth you play live. Two oscillators, slightly detuned (the beating between them thickens the sound), go through a low-pass filter and an ADSR envelope: Attack (rise), Decay (fall to the sustain level), Sustain (level while the key is held), Release (fade after you let go).',
  params: [
    { k: 'wave', label: 'Waveform', choice: true, def: 'sawtooth', desc: 'Sine is pure; saw and square have many harmonics.' },
    { k: 'cutoff', label: 'Filter cutoff', min: 300, max: 8000, def: 3000, unit: 'Hz', desc: 'Low-pass: harmonics above this are removed (it closes after the attack).' },
    { k: 'reso', label: 'Resonance', min: 0, max: 15, def: 2, unit: '', desc: 'Boost around the cutoff.' },
    { k: 'attack', label: 'Attack', min: 2, max: 800, def: 5, unit: 'ms', desc: 'Time to reach full level: short = percussive, long = a swell.' },
    { k: 'decay', label: 'Decay', min: 50, max: 1500, def: 400, unit: 'ms', desc: 'Time to fall from the peak to the sustain level.' },
    { k: 'sustain', label: 'Sustain', min: 0, max: 100, def: 60, unit: '%', desc: 'Level kept while the key is held (0 = the note dies by itself).' },
    { k: 'release', label: 'Release', min: 20, max: 1500, def: 250, unit: 'ms', desc: 'Fade after you let go of the key.' },
    { k: 'detune', label: 'Detune', min: 0, max: 30, def: 8, unit: 'cents', desc: 'The two oscillators differ by this much: they beat, like a chorus.' },
  ] };
const SOUNDS = [...TRACKS, BASS, KEYS];
const KEY_SOUNDS = {
  'Lead': { wave: 'sawtooth', cutoff: 3500, reso: 3, attack: 5, decay: 300, sustain: 60, release: 200, detune: 10 },
  'Pad': { wave: 'triangle', cutoff: 1800, reso: 1, attack: 450, decay: 600, sustain: 80, release: 900, detune: 14 },
  'Pluck': { wave: 'square', cutoff: 2200, reso: 4, attack: 2, decay: 250, sustain: 0, release: 150, detune: 6 },
  'Organ': { wave: 'sine', cutoff: 6000, reso: 0, attack: 6, decay: 100, sustain: 100, release: 70, detune: 0 },
};
const byId = (id) => SOUNDS.find((s) => s.id === id);
const REL = 0.07; // bass release, s

const BASS_SOUNDS = {
  '808 sub': { wave: 'sine', octave: 2, cutoff: 900, reso: 0, sustain: 80, decay: 900, drive: 40 },
  'Saw': { wave: 'sawtooth', octave: 2, cutoff: 900, reso: 3, sustain: 60, decay: 300, drive: 0 },
  'Funk': { wave: 'square', octave: 2, cutoff: 700, reso: 6, sustain: 10, decay: 140, drive: 10 },
  'Soft': { wave: 'triangle', octave: 2, cutoff: 1800, reso: 0, sustain: 90, decay: 400, drive: 0 },
};
const NOTE_LENS = [[1, '1/16'], [2, '1/8'], [4, '1/4'], [8, '1/2'], [16, '1 bar']];

const NOTE_EN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SCALE_LIST = [['pentatonicaMin', 'Minor pentatonic'], ['pentatonica', 'Major pentatonic'], ['minore', 'Minor'], ['dorica', 'Dorian'], ['maggiore', 'Major'],
  ['frigia', 'Phrygian'], ['minoreArmonica', 'Harmonic minor'], ['blues', 'Blues'], ['giapponese', 'Japanese'], ['araba', 'Arabic']];

// ---------------------------------------------------------------- styles (rows follow TRACKS order)
// digits: 0 off · 1 hit · 2 ghost · 3 roll ×2 · 4 roll ×3 ; bass: [step, row, length in steps]
const STYLES = {
  'House': { prog: [0, 0, 0, -2], bpm: 124, swing: 0, key: 9, scale: 'pentatonicaMin', sound: 'Saw',
    rows: ['1000100010001000', '0000000000000000', '1212121212121212', '0010001000100010', '0000100000001000', '0000000000000000', '0000000000000000', '0000001000000010', '0000000000000000', '1212121212121212'],
    arp: { mode: 'updown', n: 3, oct: 2 },
    bass: [[2, 0, 2], [6, 0, 2], [10, 2, 2], [14, 3, 2]] },
  'Hip-hop': { prog: [0, 0, -4, -2], bpm: 90, swing: 18, key: 5, scale: 'pentatonicaMin', sound: '808 sub',
    rows: ['1000001001100000', '0000100000001000', '1212121212121212', '0000000000000010', '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000'],
    bass: [[0, 0, 6], [6, 3, 3], [10, 0, 5]] },
  'Trap': { prog: [0, 0, -4, -2], bpm: 140, swing: 0, key: 0, scale: 'minore', sound: '808 sub',
    rows: ['1000000001000010', '0000000000000000', '1212121312121242', '0000000000000010', '0000000010000000', '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000'],
    bass: [[0, 0, 5], [6, 0, 3], [10, 2, 4], [14, 0, 2]] },
  'Funk': { prog: [0, 0, 5, 0], bpm: 102, swing: 12, key: 4, scale: 'dorica', sound: 'Funk',
    rows: ['1001001000100010', '0200100200201002', '1212121212121212', '0000001000000010', '0000000000000000', '0000000000000000', '0101101001011010', '0000001000000010', '0000000000000000'],
    bass: [[0, 0, 2], [3, 0, 1], [6, 3, 1], [8, 0, 2], [11, 2, 1], [14, 3, 2]] },
  'Breakbeat': { prog: [0, 0, 0, 0], bpm: 130, swing: 0, key: 9, scale: 'pentatonicaMin', sound: 'Saw',
    rows: ['1000000010100000', '0000100000001001', '1010101010101010', '0000000000000000', '0000000000000100', '0000000000000000', '0000000000000000', '0000000000000000', '0000000000000000'],
    bass: [[0, 0, 3], [3, 0, 3], [6, 2, 2], [10, 0, 3], [12, 4, 3]] },
};
const rowsFrom = (a) => TRACKS.map((_, i) => Array.from(a[i] || '0'.repeat(STEPS), (c) => +c)); // rows missing from a style stay empty
function bassFrom(list) {
  const b = Array(STEPS).fill(-1), l = Array(STEPS).fill(1);
  for (const [i, r, n] of list) { b[i] = r; l[i] = n; }
  return { b, l };
}

const S = {
  bpm: store.get('bpm', 124), swing: store.get('swing', 0), vol: store.get('vol', 0.8),
  win: store.get('win', 100), view: store.get('view', 'wave'), labView: store.get('labView', 'full'),
  key: store.get('key', 9), scale: store.get('scale', 'pentatonicaMin'), brush: store.get('brush', 1), nlen: store.get('nlen', 2),
  pat: store.get('pat3', null), bass: store.get('bass3', null), bl: store.get('bl3', null), mute: store.get('mute3', {}), params: store.get('params3', {}),
  sel: 'kick', solo: null,
  kloop: store.get('kloop', null), arp: store.get('arp', null), prog: store.get('prog', null), mix: store.get('mix', {}), fx: store.get('fx', {}),
};
if (Array.isArray(S.pat) && S.pat.length < TRACKS.length && S.pat.every((r) => Array.isArray(r) && r.length === STEPS)) while (S.pat.length < TRACKS.length) S.pat.push(Array(STEPS).fill(0)); // saved beat from an older version: add the new empty rows
if (!Array.isArray(S.pat) || S.pat.length !== TRACKS.length || S.pat.some((r) => !Array.isArray(r) || r.length !== STEPS)) {
  S.pat = rowsFrom(STYLES.House.rows); const b = bassFrom(STYLES.House.bass); S.bass = b.b; S.bl = b.l;
}
if (!Array.isArray(S.bass) || S.bass.length !== STEPS || !Array.isArray(S.bl) || S.bl.length !== STEPS) { const b = bassFrom(STYLES.House.bass); S.bass = b.b; S.bl = b.l; }
if (!Array.isArray(S.prog) || S.prog.length !== 4 || S.prog.some((v) => !Number.isFinite(v))) S.prog = [...STYLES.House.prog];
if (!S.kloop || !Array.isArray(S.kloop.ev)) S.kloop = { ev: [], ses: 0 }; // recorded keyboard loop: ev = { p: start in steps 0–64, d: length in steps, m: MIDI note, s: recording pass }
S.arp = { mode: 'up', n: 3, oct: 2, ...(S.arp || {}) };
if (!['up', 'down', 'updown', 'random'].includes(S.arp.mode)) S.arp.mode = 'up';
const SEND_DEF = { snare: 15, clap: 25, chord: 20, pluck: 15, ohat: 10, arp: 20, keys: 15 };
for (const s of SOUNDS) S.mix[s.id] = { vol: 80, send: SEND_DEF[s.id] || 0, ...(S.mix[s.id] || {}) };
S.fx = { hp: 0, lp: 100, res: 10, rev: 70, rtime: 1.6, ...S.fx };
if (!WINS.includes(S.win)) S.win = 100;
if (![1, 2, 3, 4].includes(S.brush)) S.brush = 1;
if (!NOTE_LENS.some(([n]) => n === S.nlen)) S.nlen = 2;
if (!['full', 'attack', 'spec'].includes(S.labView)) S.labView = 'full';
if (!SCALES[S.scale]) S.scale = 'pentatonicaMin';
for (const s of SOUNDS) S.params[s.id] = { ...Object.fromEntries(s.params.map((p) => [p.k, p.def])), ...(S.params[s.id] || {}) };
const saveAll = () => {
  for (const k of ['bpm', 'swing', 'vol', 'win', 'view', 'labView', 'key', 'scale', 'brush', 'nlen', 'prog', 'mix', 'fx', 'arp', 'kloop']) store.set(k, S[k]);
  store.set('pat3', S.pat); store.set('bass3', S.bass); store.set('bl3', S.bl); store.set('mute3', S.mute); store.set('params3', S.params);
};

// ---------------------------------------------------------------- bass notes: row, length, and which note covers a step
/** Semitones above the tonic for grid row r (row 0 = tonic, going up through the scale). */
function semis(r) { const d = SCALES[S.scale]; return d[r % d.length] + 12 * Math.floor(r / d.length); }
function rowFreq(r, octave, sh = 0) { return noteFreq(S.key + semis(r) + sh + 12 * (octave - 4) - 9); } // sh = transposition of the bar, in semitones
const rowName = (r) => NOTE_EN[(S.key + semis(r)) % 12];
/** Length (in steps) of the note starting at step i: cut by the next note and by the end of the bar. */
function noteLen(i) {
  let n = Math.max(1, Math.min(S.bl[i] || 1, STEPS - i));
  for (let k = 1; k < n; k++) if (S.bass[i + k] >= 0) { n = k; break; }
  return n;
}
/** cov[i] = row of the bass note sounding at step i (start or sustained part), -1 if silent. */
let cov = Array(STEPS).fill(-1);
function recompute() {
  cov = Array(STEPS).fill(-1);
  for (let i = 0; i < STEPS; i++) if (S.bass[i] >= 0) { const n = noteLen(i); for (let k = 0; k < n; k++) cov[i + k] = S.bass[i]; }
}
recompute();
const rowAt = (i) => (cov[i] >= 0 ? cov[i] : 0);

// ---------------------------------------------------------------- audio engine
let A = null; // { ctx, bus, hp, lp, an, buf, conv, revOut, aud, strips, sess }
//   channel strip (one per sound):  voice ─► vol ─┬─► dry ─► bus
//                                                 └─► send ─► reverb (ConvolverNode) ─► return ─► bus
//   bus ─► high-pass ─► low-pass ─► compressor ─► master            (filters act on the whole mix, reverb included)
const volGain = (id) => Math.pow(S.mix[id].vol / 80, 1.6);          // 80 = unity gain, 100 = +4 dB
const hpFreq = () => 20 * Math.pow(100, S.fx.hp / 100);             // 20 Hz (off) … 2 kHz
const lpFreq = () => 200 * Math.pow(100, S.fx.lp / 100);            // 200 Hz … 20 kHz (off)
const qOf = () => 0.7 + (S.fx.res / 100) * 11;
/** Reverb impulse response: noise whose amplitude falls exponentially to −60 dB at `sec` (the room's decay time). */
function impulse(ctx, sec) {
  const n = Math.round(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c); let s = 9001 + 77 * c, lp = 0;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const k = 0.55 - 0.4 * (i / n); lp += k * ((s / 2147483648 - 1) - lp); // the highs die first, as in a real room
      d[i] = lp * Math.pow(10, (-3 * i) / n);
    }
  }
  return b;
}
function makeStrips(dryOut, wetIn) {
  const o = {};
  for (const s of SOUNDS) {
    const vol = A.ctx.createGain(), send = A.ctx.createGain();
    vol.gain.value = volGain(s.id); send.gain.value = S.mix[s.id].send / 100;
    vol.connect(dryOut); vol.connect(send); send.connect(wetIn); o[s.id] = { vol, send };
  }
  return o;
}
function applyMix() {
  if (!A) return;
  const t = A.ctx.currentTime;
  for (const set of [A.aud, A.strips]) if (set) for (const s of SOUNDS) { set[s.id].vol.gain.setTargetAtTime(volGain(s.id), t, 0.015); set[s.id].send.gain.setTargetAtTime(S.mix[s.id].send / 100, t, 0.015); }
}
function applyFx() {
  if (!A) return;
  const t = A.ctx.currentTime;
  A.hp.frequency.setTargetAtTime(hpFreq(), t, 0.02); A.lp.frequency.setTargetAtTime(lpFreq(), t, 0.02);
  A.hp.Q.setTargetAtTime(qOf(), t, 0.02); A.lp.Q.setTargetAtTime(qOf(), t, 0.02);
  A.revOut.gain.setTargetAtTime(S.fx.rev / 100, t, 0.02);
}
let irTimer = 0;
function applyReverbTime() { clearTimeout(irTimer); irTimer = setTimeout(() => { if (A) A.conv.buffer = impulse(A.ctx, S.fx.rtime); }, 150); }
function engine() {
  const base = audio(); // creates / resumes the shared context: must run inside a tap or click
  if (!A) {
    const { ctx, master } = base;
    const bus = ctx.createGain(); bus.gain.value = S.vol;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpFreq(); hp.Q.value = qOf();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpFreq(); lp.Q.value = qOf();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;
    const an = ctx.createAnalyser(); an.fftSize = 32768; an.smoothingTimeConstant = 0;
    bus.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(master); comp.connect(an);
    const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, S.fx.rtime);
    const revOut = ctx.createGain(); revOut.gain.value = S.fx.rev / 100; conv.connect(revOut); revOut.connect(bus);
    A = { ctx, bus, hp, lp, an, buf: new Float32Array(an.fftSize), conv, revOut, aud: null, strips: null, sess: null };
    A.aud = makeStrips(bus, conv);
    // iPhone: a silent one-sample buffer played inside the first tap "unlocks" the output
    const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0);
  }
  return A;
}

const noiseCache = new WeakMap();
function noise(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) { // seeded: the same noise every time, so waveforms can be compared
    const n = Math.round(ctx.sampleRate); b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0); let s = 12345;
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
    noiseCache.set(ctx, b);
  }
  return b;
}
/** Amplitude envelope: 2 ms attack, then exponential decay down to −66 dB after `decay` seconds. */
function env(ctx, t, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.002 + Math.max(0.01, decay));
  return g;
}
function noiseSrc(ctx, t, len) {
  const n = ctx.createBufferSource(); n.buffer = noise(ctx);
  n.start(t, ctx.length === undefined ? Math.random() * 0.4 : 0); // offline render: always from the start
  n.stop(t + len + 0.05); return n;
}

/** Karplus–Strong plucked string, computed sample by sample: a ring of N = fs/f samples filled with
 *  (filtered) noise; each lap every sample is replaced by the average of two neighbours (a low-pass:
 *  the high harmonics die first) times a loss g chosen so that the string falls by 60 dB in t60 seconds. */
const ksCache = new Map();
function ksData(sr, f, t60, bright) {
  const key = `${sr}|${f.toFixed(2)}|${Math.round(t60 * 1000)}|${Math.round(bright * 100)}`;
  let out = ksCache.get(key); if (out) return out;
  const N = Math.max(2, Math.round(sr / f - 0.5)), len = Math.ceil(sr * Math.min(1.6, t60 * 1.05 + 0.05));
  const ring = new Float32Array(N); out = new Float32Array(len);
  let s = 777, prev = 0; const a = 0.12 + 0.88 * bright; // excitation: noise through a one-pole low-pass (soft finger … hard pick)
  for (let i = 0; i < N; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; prev += a * ((s / 2147483648 - 1) - prev); ring[i] = prev; }
  const g = Math.min(0.9999, Math.pow(10, -3 / Math.max(1, f * t60))); let peak = 1e-9;
  for (let n = 0, j = 0; n < len; n++) {
    const v = ring[j]; out[n] = v; if (Math.abs(v) > peak) peak = Math.abs(v);
    const j2 = j + 1 === N ? 0 : j + 1; ring[j] = g * 0.5 * (v + ring[j2]); j = j2;
  }
  for (let n = 0; n < len; n++) out[n] /= peak * 1.0;
  if (ksCache.size > 300) ksCache.clear();
  ksCache.set(key, out); return out;
}
function string(ctx, out, t, f, t60, bright, gain) {
  const d = ksData(ctx.sampleRate, f, t60, bright), b = ctx.createBuffer(1, d.length, ctx.sampleRate);
  b.getChannelData(0).set(d);
  const src = ctx.createBufferSource(); src.buffer = b;
  const g = ctx.createGain(); g.gain.value = gain; src.connect(g).connect(out); src.start(t);
}
const curves = new Map();
function driveCurve(pct) { // tanh soft clipper, normalised so small signals keep their level
  const k = 1 + (pct / 100) * 9, key = Math.round(k * 10); let c = curves.get(key);
  if (!c) { c = new Float32Array(513); for (let i = 0; i < 513; i++) { const x = (i / 256) - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } curves.set(key, c); }
  return c;
}

/** Keys voice. dur = known length (loop playback, lab): the whole envelope is scheduled now.
 *  dur = null (a key held live): returns off(time) that starts the release when the key is lifted. */
function keyVoice(ctx, out, t, p, midi, dur) {
  const A0 = Math.max(0.002, p.attack / 1000), D = p.decay / 1000, sus = Math.max(0.001, p.sustain / 100), R = Math.max(0.02, p.release / 1000), PK = 0.5;
  const f = noteFreq(midi - 69), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = p.reso;
  lp.frequency.setValueAtTime(Math.min(p.cutoff * 2.5, 18000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(80, p.cutoff), t + 0.25);
  const g = ctx.createGain(), level = (tt) => { const x = tt - t; return x < A0 ? PK * Math.max(0.0001, x / A0) : x < A0 + D ? PK * Math.pow(sus, (x - A0) / D) : PK * sus; };
  g.gain.setValueAtTime(0.0001, t);
  const oscs = [-1, 1].map((sgn) => { const o = ctx.createOscillator(); o.type = p.wave; o.frequency.value = f; o.detune.value = (sgn * p.detune) / 2; o.connect(lp); o.start(t); return o; });
  lp.connect(g); g.connect(out);
  const stopAll = (tt) => oscs.forEach((o) => o.stop(tt));
  if (dur == null) {
    g.gain.linearRampToValueAtTime(PK, t + A0); g.gain.exponentialRampToValueAtTime(Math.max(0.0005, PK * sus), t + A0 + D);
    return (tt) => { g.gain.cancelScheduledValues(tt); g.gain.setValueAtTime(Math.max(0.0005, level(tt)), tt); g.gain.exponentialRampToValueAtTime(0.0005, tt + R); stopAll(tt + R + 0.05); };
  }
  const end = t + Math.max(0.03, dur);
  if (end <= t + A0) g.gain.linearRampToValueAtTime(level(end), end);
  else {
    g.gain.linearRampToValueAtTime(PK, t + A0);
    if (end >= t + A0 + D) { g.gain.exponentialRampToValueAtTime(Math.max(0.0005, PK * sus), t + A0 + D); g.gain.setValueAtTime(Math.max(0.0005, PK * sus), end); }
    else g.gain.exponentialRampToValueAtTime(Math.max(0.0005, level(end)), end);
  }
  g.gain.exponentialRampToValueAtTime(0.0005, end + R); stopAll(end + R + 0.05);
  return null;
}

const VOICES = {
  kick(ctx, out, t, p) {
    const d = p.decay / 1000, o = ctx.createOscillator();
    o.frequency.setValueAtTime(p.f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, p.f1), t + p.sweep / 1000);
    let node = o.connect(env(ctx, t, 0.8, d));
    if (p.drive > 0) { const sh = ctx.createWaveShaper(); sh.curve = driveCurve(p.drive); sh.oversample = '2x'; node.connect(sh); node = sh; }
    node.connect(out); o.start(t); o.stop(t + d + 0.06);
    if (p.sub > 0) { const so = ctx.createOscillator(); so.frequency.value = Math.max(20, p.f1); so.connect(env(ctx, t, 0.4 * p.sub / 100, d * 1.2)).connect(out); so.start(t); so.stop(t + d * 1.2 + 0.06); }
    if (p.click > 0) { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200; noiseSrc(ctx, t, 0.012).connect(hp).connect(env(ctx, t, 0.6 * p.click / 100, 0.01)).connect(out); }
  },
  snare(ctx, out, t, p) {
    const d = p.decay / 1000, k = p.noise / 100;
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(p.tone * 1.4, t); o.frequency.exponentialRampToValueAtTime(p.tone, t + 0.04);
    o.connect(env(ctx, t, 0.15 + 0.65 * (1 - k), Math.min(d, 0.15))).connect(out); o.start(t); o.stop(t + d + 0.06);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    noiseSrc(ctx, t, d).connect(hp).connect(env(ctx, t, 0.05 + 0.8 * k, d)).connect(out);
  },
  hat(ctx, out, t, p) {
    const d = p.decay / 1000, hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hp; hp.Q.value = 0.7;
    noiseSrc(ctx, t, d).connect(hp).connect(env(ctx, t, 0.5, d)).connect(out);
  },
  clap(ctx, out, t, p) {
    const d = p.decay / 1000, bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.fc; bp.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    for (const b of [0, 0.011, 0.022]) { g.gain.setValueAtTime(0.9, t + b); g.gain.exponentialRampToValueAtTime(0.12, t + b + 0.009); }
    g.gain.setValueAtTime(0.7, t + 0.033); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.033 + d);
    noiseSrc(ctx, t, d + 0.04).connect(bp).connect(g).connect(out);
  },
  cow(ctx, out, t, p) {
    const d = p.decay / 1000, bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.pitch * 4.9; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.55, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03 + d);
    for (const r of [1, 1.4815]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = p.pitch * r; o.connect(bp); o.start(t); o.stop(t + d + 0.09); }
    bp.connect(g).connect(out);
  },
  chank(ctx, out, t, p, row = 0, dur = 0, sh = 0) {
    const d = p.decay / 1000, bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.fc; bp.Q.value = 2.5;
    noiseSrc(ctx, t, d).connect(bp).connect(env(ctx, t, 0.75, d)).connect(out);
    if (p.tone > 0) string(ctx, out, t, rowFreq(row, 3, sh), Math.max(0.05, d * 1.6), 0.35, 0.55 * p.tone / 100);
  },
  chord(ctx, out, t, p, row = 0, dur = 0, sh = 0) {
    const t60 = p.decay / 1000;
    [0, 2, 4].forEach((k, n) => string(ctx, out, t + n * p.strum / 1000, rowFreq(row + k, p.octave, sh), t60, p.bright / 100, 0.42));
  },
  pluck(ctx, out, t, p, row = 0, dur = 0, sh = 0) { string(ctx, out, t, rowFreq(row, p.octave, sh), p.decay / 1000, p.bright / 100, 0.8); },
  keys(ctx, out, t, p, row = 0, dur = 0.4) { keyVoice(ctx, out, t, p, row >= 24 ? row : 60, dur); }, // row = MIDI note (60 when the lab plays it)
  arp(ctx, out, t, p, row = 0, dur = 0, sh = 0) {
    const d = p.decay / 1000, o = ctx.createOscillator(); o.type = p.wave; o.frequency.value = rowFreq(row, p.octave, sh);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(Math.min(p.cutoff * 3, 16000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(120, p.cutoff * 0.5), t + Math.min(d, 0.12));
    o.connect(lp).connect(env(ctx, t, 0.45, d)).connect(out); o.start(t); o.stop(t + d + 0.06);
  },
  bass(ctx, out, t, p, row = 0, dur = 0.4, sh = 0) {
    const d = p.decay / 1000, sus = Math.max(0.001, p.sustain / 100), end = t + Math.max(0.03, dur), PK = 0.85, A0 = 0.004;
    const o = ctx.createOscillator(); o.type = p.wave; o.frequency.value = rowFreq(row, p.octave, sh);
    const ws = ctx.createWaveShaper(); ws.curve = driveCurve(p.drive); ws.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = p.reso;
    lp.frequency.setValueAtTime(Math.min(p.cutoff * 4, 18000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(60, p.cutoff), t + Math.min(d, 0.25));
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(PK, t + A0);
    let level; // ADSR: attack, exponential decay to the sustain level, hold, release
    if (end >= t + A0 + d) { level = PK * sus; g.gain.exponentialRampToValueAtTime(level, t + A0 + d); g.gain.setValueAtTime(level, end); }
    else { level = PK * Math.pow(sus, (end - t - A0) / d); g.gain.exponentialRampToValueAtTime(Math.max(0.0005, level), end); }
    g.gain.exponentialRampToValueAtTime(0.0005, end + REL);
    o.connect(ws).connect(lp).connect(g).connect(out); o.start(t); o.stop(end + REL + 0.05);
  },
};
VOICES.ohat = VOICES.hat; // same noise, other parameters (longer decay)
function playSound(ctx, out, id, t, row = 0, dur = 0.4, vel = 1, sh = 0) {
  let dest = out;
  if (vel !== 1) { dest = ctx.createGain(); dest.gain.value = vel; dest.connect(out); }
  VOICES[id](ctx, dest, t, S.params[id], row, dur, sh);
}

/** How long (s) a sound lasts, for the Sound lab time axis. */
function soundLength(id, p) {
  const ms = id === 'bass' ? 450 + REL * 1000 : id === 'keys' ? 450 + p.release : id === 'clap' ? p.decay + 33 : id === 'cow' ? p.decay + 30 : id === 'chank' ? Math.max(p.decay, 90) + 40
    : id === 'chord' ? p.decay + 3 * p.strum : p.decay;
  return Math.min(1.5, Math.max(0.1, ms / 1000 + 0.06));
}

// ---------------------------------------------------------------- scheduler (look-ahead)
const LOOKAHEAD = 0.12, TICK_MS = 25;
let playing = false, step = 0, nextT = 0, timer = 0;
const queue = [];   // steps waiting to be shown by the playhead
const hits = [];    // recent hits, for the triggered mix oscilloscope: { t, id, seg: {win: Float32Array|null} }
let cur = -1;

function hit(id, t, set, row, vel = 1, dur = 0.4, sh = 0) { // set = the channel strips to play through (the loop's, or the audition ones)
  playSound(A.ctx, (set || A.aud)[id].vol, id, t, row, dur, vel, sh);
  hits.push({ t, id, seg: {} }); if (hits.length > 40) hits.shift();
}
const audible = (id) => !S.mute[id] && (S.solo == null || S.solo === id);
const ROLLS = { 1: [[0, 1]], 2: [[0, 0.3]], 3: [[0, 0.9], [0.5, 0.7]], 4: [[0, 0.9], [1 / 3, 0.6], [2 / 3, 0.75]] };
let bar = 0; // which of the 4 bars of the progression is being scheduled
let cycleT0 = 0; // AudioContext time of step 1 of bar 1 in the running cycle
let arpIdx = 0; // position in the arpeggio; restarts every bar so that the bar repeats exactly
/** Rows (scale notes) of the arpeggio: a chord stacked in thirds on row r, over `oct` octaves, in the chosen order. */
function arpPool(r) {
  const len = SCALES[S.scale].length, a = S.arp, pool = [];
  for (let o = 0; o < a.oct; o++) for (let k = 0; k < a.n; k++) pool.push(r + 2 * k + o * len);
  if (a.mode === 'down') pool.reverse();
  else if (a.mode === 'updown' && pool.length > 2) pool.push(...pool.slice(1, -1).reverse());
  return pool;
}
function arpNote(st) {
  const pool = arpPool(rowAt(st));
  return S.arp.mode === 'random' ? pool[Math.floor(Math.random() * pool.length)] : pool[arpIdx++ % pool.length];
}
function tick() {
  const sd = 60 / S.bpm / 4;
  while (nextT < A.ctx.currentTime + LOOKAHEAD) {
    if (step === 0 && bar === 0) cycleT0 = nextT; // start of the 4-bar cycle: the recorder measures positions from here
    const tt = nextT + (step % 2 ? (S.swing / 100) * sd : 0), sh = S.prog[bar];
    if (S.kloop.ev.length && audible('keys')) { // recorded keyboard notes whose start falls inside this step
      const idx = bar * STEPS + step;
      for (const e of S.kloop.ev) if (e.p >= idx && e.p < idx + 1) hit('keys', nextT + (e.p - idx) * sd, A.strips, e.m, 1, e.d * sd);
    }
    TRACKS.forEach((tr, ti) => {
      const v = S.pat[ti][step];
      if (v && audible(tr.id)) for (const [k, vel] of ROLLS[v]) hit(tr.id, tt + k * sd, A.strips, tr.id === 'arp' ? arpNote(step) : rowAt(step), vel, 0.4, sh);
    });
    if (S.bass[step] >= 0 && audible('bass')) hit('bass', tt, A.strips, S.bass[step], 1, noteLen(step) * sd, sh);
    queue.push({ i: step, t: tt, bar });
    nextT += sd; step = (step + 1) % STEPS; if (step === 0) { bar = (bar + 1) % 4; arpIdx = 0; }
  }
}
function play() {
  engine();
  const dry = A.ctx.createGain(), wet = A.ctx.createGain(); dry.connect(A.bus); wet.connect(A.conv);
  A.sess = { dry, wet }; A.strips = makeStrips(dry, wet);
  playing = true; step = 0; bar = 0; arpIdx = 0; cycleT0 = A.ctx.currentTime + 0.06; nextT = A.ctx.currentTime + 0.06; queue.length = 0;
  tick(); timer = setInterval(tick, TICK_MS);
  paintTransport();
}
function stop() {
  if (!playing) return;
  if (recording) stopRec();
  clearInterval(timer); playing = false; queue.length = 0; setCur(-1, -1);
  if (A?.sess) {
    const { dry, wet } = A.sess, t = A.ctx.currentTime;
    dry.gain.setTargetAtTime(0, t, 0.01); wet.gain.setTargetAtTime(0, t, 0.01); setTimeout(() => { dry.disconnect(); wet.disconnect(); }, 400);
    A.sess = null; A.strips = null;
  }
  paintTransport();
}
/** Sound a pad or a note as feedback, but ONLY while the loop is stopped: in a live set a tap must not sound on its own, the loop plays it when its turn comes. */
function preview(id, row, dur) { if (!playing) audition(id, row, dur); }
function audition(id, row = 0, dur = 0.5) { engine(); hit(id, A.ctx.currentTime + 0.01, null, row, 1, dur); }
/** Hear the scale: the 8 rows of the bass grid, going up. */
function playScale() {
  if (playing) return;
  engine(); const t0 = A.ctx.currentTime + 0.02;
  for (let r = 0; r < ROWS; r++) hit('bass', t0 + r * 0.2, null, r, 1, 0.17);
}

// ---------------------------------------------------------------- grids
const colCells = Array.from({ length: STEPS }, () => []); // every step button of a column, for the playhead
const cells = {};   // track id -> 16 buttons
const bcells = [];  // bass: [row][step]
const BRUSH_NAME = { 1: 'hit', 2: 'ghost', 3: 'roll ×2', 4: 'roll ×3' };

function trackRow(tr) {
  const row = document.createElement('div'); row.className = 'trk'; row.dataset.id = tr.id;
  row.innerHTML =
    `<div class="trk-head"><button class="pad" data-pad="${tr.id}" aria-label="${tr.name}: select and hear">${tr.name}</button>` +
    `<button class="solo toggle" data-solo="${tr.id}" aria-pressed="false" title="Solo" aria-label="Solo ${tr.name}">S</button>` +
    `<button class="mute toggle" data-mute="${tr.id}" aria-pressed="false" title="Mute" aria-label="Mute ${tr.name}">M</button></div>` +
    `<div class="steps" role="group" aria-label="${tr.name} steps">${Array.from({ length: STEPS }, (_, i) =>
      `<button class="st" data-id="${tr.id}" data-i="${i}" data-v="0" aria-pressed="false" aria-label="${tr.name} step ${i + 1}"></button>`).join('')}</div>`;
  cells[tr.id] = $$('.st', row); cells[tr.id].forEach((b, i) => colCells[i].push(b));
  return row;
}
function buildGrids() {
  const seq = $('#seq'), gs = $('#gseq'); seq.innerHTML = ''; gs.innerHTML = '';
  TRACKS.forEach((tr) => (tr.group === 'drums' ? seq : gs).appendChild(trackRow(tr)));

  const bg = $('#bgrid'); bg.innerHTML = '';
  for (let r = ROWS - 1; r >= 0; r--) {
    const row = document.createElement('div'); row.className = 'brow' + (r === 0 ? ' root' : '');
    row.innerHTML = `<span class="blab" data-r="${r}"></span><div class="steps">${Array.from({ length: STEPS }, (_, i) =>
      `<button class="st${i >= 8 ? ' hi' : ''}" data-id="bass" data-r="${r}" data-i="${i}" aria-pressed="false" aria-label="Bass step ${i + 1}, row ${r + 1}"></button>`).join('')}</div>`;
    bcells[r] = $$('.st', row); bcells[r].forEach((b, i) => colCells[i].push(b));
    bg.appendChild(row);
  }
  $('#key').innerHTML = NOTE_EN.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('#scale').innerHTML = SCALE_LIST.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $('#key').value = S.key; $('#scale').value = S.scale;
  $('#bassSounds').innerHTML = '<span>Bass sound</span>' + Object.keys(BASS_SOUNDS).map((n) => `<button data-bs="${n}" aria-pressed="false">${n}</button>`).join('');
  $('#noteLens').innerHTML = '<span>Note length</span>' + NOTE_LENS.map(([n, l]) => `<button data-nl="${n}" aria-pressed="false">${l}</button>`).join('');
  paintGrid(); paintBass(); paintSelection(); paintBrush();
}
function paintCell(b, v) { b.dataset.v = v; b.setAttribute('aria-pressed', String(v > 0)); }
function paintGrid() {
  TRACKS.forEach((tr, ti) => cells[tr.id].forEach((b, i) => paintCell(b, S.pat[ti][i])));
  paintFlags(); paintSummaries();
}
function paintFlags() {
  [...TRACKS, BASS, KEYS].forEach((s) => {
    const row = s.id === 'bass' ? $('#bassHead') : s.id === 'keys' ? $('#keysHead') : $(`.trk[data-id="${s.id}"]`);
    row.classList.toggle('muted', !!S.mute[s.id]);
    $('.mute', row).setAttribute('aria-pressed', String(!!S.mute[s.id]));
    $('.solo', row).setAttribute('aria-pressed', String(S.solo === s.id));
  });
  document.body.classList.toggle('has-solo', S.solo != null);
}
function paintBass() {
  recompute(); if (typeof kb !== 'undefined') paintKb(); if (typeof paintKeySounds === 'function' && $('#keySounds').firstChild) paintKeySounds();
  const labs = $$('.blab');
  for (let r = 0; r < ROWS; r++) {
    labs[ROWS - 1 - r].textContent = rowName(r);
    bcells[r].forEach((b, i) => { b.setAttribute('aria-pressed', String(S.bass[i] === r)); b.dataset.n = S.bass[i] === r ? 'start' : (cov[i] === r ? 'tail' : ''); });
  }
  const bp = $('#bassSounds'), pr = S.params.bass;
  $$('[data-bs]', bp).forEach((b) => b.setAttribute('aria-pressed', String(Object.entries(BASS_SOUNDS[b.dataset.bs]).every(([k, v]) => pr[k] === v))));
  $$('#noteLens [data-nl]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.nl === S.nlen)));
  paintSummaries();
}
function paintBrush() {
  $$('#brush [data-brush]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.brush === S.brush)));
}
function paintSelection() {
  const name = byId(S.sel).name;
  $$('.pad').forEach((p) => p.classList.toggle('sel', p.dataset.pad === S.sel));
  $$('.sel-name').forEach((e) => (e.textContent = name));
  $$('#labChips [data-sound]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sound === S.sel)));
}
function setCur(i, b = -1) {
  $$('#prog .pbar').forEach((e) => e.classList.toggle('now', +e.dataset.bar === b));
  if (i === cur) return;
  if (cur >= 0) colCells[cur].forEach((b) => b.classList.remove('cur'));
  cur = i; if (i >= 0) colCells[i].forEach((b) => b.classList.add('cur'));
  $$('#pager [data-page]').forEach((b) => b.classList.toggle('now', i >= 0 && Math.floor(i / 8) === +b.dataset.page)); // phone: which half holds the playhead
}

// ---------------------------------------------------------------- painting steps and notes
let paint = null; // { id, v } for step rows; { bass: true, mode, i, r } for the note grid
const trackIdx = (id) => TRACKS.findIndex((t) => t.id === id);
const setStep = (id, i, v) => { S.pat[trackIdx(id)][i] = v; paintCell(cells[id][i], v); };
function eraseNoteAt(i) { // the note that covers step i, wherever it starts
  for (let j = i; j >= 0; j--) if (S.bass[j] >= 0) { if (j + noteLen(j) > i) S.bass[j] = -1; break; }
}
function placeNote(i, r, len) {
  S.bass[i] = r; S.bl[i] = len; // an earlier note that covered this step is simply cut short (see noteLen)
  paintBass();
}
const gridEl = $('#sections');
gridEl.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.st'); if (!b) return;
  const i = +b.dataset.i;
  if (b.dataset.id === 'bass') {
    const r = +b.dataset.r;
    if (b.dataset.n) { paint = { bass: true, mode: 'erase' }; eraseNoteAt(i); paintBass(); }
    else { paint = { bass: true, mode: 'set', i, r }; placeNote(i, r, S.nlen); }
  } else {
    paint = { id: b.dataset.id, v: S.pat[trackIdx(b.dataset.id)][i] === S.brush ? 0 : S.brush }; setStep(paint.id, i, paint.v);
  }
  b.releasePointerCapture?.(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!paint) return;
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.st'); if (!el) return;
  const j = +el.dataset.i;
  if (paint.bass) {
    if (paint.mode === 'erase') { if (el.dataset.id === 'bass') { eraseNoteAt(j); paintBass(); } }
    else if (el.dataset.id === 'bass' && +el.dataset.r === paint.r && j >= paint.i) { const n = j - paint.i + 1; if (S.bl[paint.i] !== n) { S.bl[paint.i] = n; paintBass(); } } // drag right = longer note
  } else if (el.dataset.id === paint.id) setStep(paint.id, j, paint.v);
});
const endPaint = () => { if (paint) { paint = null; saveAll(); paintSummaries(); } };
document.addEventListener('pointerup', endPaint); document.addEventListener('pointercancel', endPaint);

// pads, mute, solo, steps by keyboard: `click` (iOS Safari only unlocks audio on a completed tap)
gridEl.addEventListener('click', (e) => {
  const st = e.target.closest('.st');
  if (st) {
    const i = +st.dataset.i;
    if (st.dataset.id === 'bass') {
      const r = +st.dataset.r;
      if (e.detail === 0) { if (st.dataset.n) eraseNoteAt(i); else placeNote(i, r, S.nlen); paintBass(); saveAll(); }
      if (S.bass[i] === r) preview('bass', r, Math.min(0.7, noteLen(i) * 60 / S.bpm / 4)); // hear the note you just placed
    } else if (e.detail === 0) { setStep(st.dataset.id, i, S.pat[trackIdx(st.dataset.id)][i] === S.brush ? 0 : S.brush); saveAll(); }
    return;
  }
  const pad = e.target.closest('.pad');
  if (pad) { select(pad.dataset.pad); preview(pad.dataset.pad); return; }
  const m = e.target.closest('.mute'); if (m) { const id = m.dataset.mute; S.mute[id] = !S.mute[id]; paintFlags(); saveAll(); return; }
  const so = e.target.closest('.solo'); if (so) { const id = so.dataset.solo; S.solo = S.solo === id ? null : id; paintFlags(); $('#soloBtn').setAttribute('aria-pressed', String(S.solo === S.sel)); }
});
$('#brush').addEventListener('click', (e) => { const b = e.target.closest('[data-brush]'); if (b) { S.brush = +b.dataset.brush; paintBrush(); saveAll(); } });
$('#noteLens').addEventListener('click', (e) => { const b = e.target.closest('[data-nl]'); if (b) { S.nlen = +b.dataset.nl; paintBass(); saveAll(); } });
$('#bassSounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bs]'); if (!b) return;
  Object.assign(S.params.bass, BASS_SOUNDS[b.dataset.bs]); saveAll(); paintBass();
  if (S.sel === 'bass') { lab.ghost = lab.buf; renderLabPanel(); renderLab(); }
  preview('bass', 0, 0.6);
});
// ---------------------------------------------------------------- drawing helpers
const LIME = '#C6F432', GHOST = 'rgba(255,255,255,0.42)';
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
/** Spectrum of the first 4096 samples of a segment (Hann window, zero-padded to 16384), on a log frequency axis. */
function spectrumOf(seg, sr) {
  const NFFT = 16384, n = Math.min(4096, seg.length), re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let i = 0; i < n; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const df = sr / NFFT, mag = new Float64Array(NFFT / 2); let mx = 1e-12;
  for (let k = 1; k < NFFT / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > mx) mx = mag[k]; }
  const M = 360, xs = [], ys = []; let best = 0, fbest = 0;
  for (let j = 0; j < M; j++) {
    const f = 20 * Math.pow(1000, j / (M - 1));
    const lo = Math.max(1, Math.floor((f * Math.pow(2, -1 / 48)) / df)), hi = Math.max(lo, Math.ceil((f * Math.pow(2, 1 / 48)) / df));
    let m = 0; for (let k = lo; k <= hi && k < NFFT / 2; k++) m = Math.max(m, mag[k]);
    if (m > best) { best = m; fbest = f; }
    xs.push(Math.log10(f)); ys.push(Math.max(-80, 20 * Math.log10(m / mx + 1e-12)));
  }
  return { xs, ys, fpeak: fbest };
}
/** Points of a waveform up to tmax ms; min/max per column when there are too many samples (no aliasing). */
function waveTrace(seg, sr, tmax) {
  const n = Math.min(seg.length, Math.ceil((sr * tmax) / 1000)), x = [], y = [];
  if (n <= 1200) { for (let i = 0; i < n; i++) { x.push((i / sr) * 1000); y.push(seg[i]); } return { x, y }; }
  const B = 700, per = n / B;
  for (let b = 0; b < B; b++) {
    let lo = Infinity, hi = -Infinity; for (let i = Math.floor(b * per); i < Math.floor((b + 1) * per); i++) { lo = Math.min(lo, seg[i]); hi = Math.max(hi, seg[i]); }
    const xx = ((b * per) / sr) * 1000; x.push(xx, xx); y.push(b % 2 ? hi : lo, b % 2 ? lo : hi);
  }
  return { x, y };
}
const niceMs = (v) => [20, 50, 100, 200, 400, 500, 800, 1000, 1200].find((x) => x >= v) || 1200;
const nice = (v) => [0.1, 0.2, 0.5, 1, 2].find((x) => x >= v * 1.05) || 2;
const fmt = (v) => (v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');
const SPEC = { x0: Math.log10(20), x1: Math.log10(20000), y0: -80, y1: 0, yLabel: '10 dB/div', centerX: false, centerY: false };
const SPEC_MARK = [{ x: Math.log10(200), label: '200 Hz', color: 'rgba(255,255,255,0.45)' }, { x: Math.log10(2000), label: '2 kHz', color: 'rgba(255,255,255,0.45)' }];

// ---------------------------------------------------------------- Sound lab scope (one sound, exact)
const labScr = new Screen($('#labScope'), { divX: 10, divY: 8 });
function drawLab() {
  if (!lab.buf) return;
  const sr = lab.sr, view = S.labView, now = lab.buf, gh = lab.ghost;
  labScr.divX = view === 'spec' ? 3 : 10; labScr.divY = 8;
  if (view === 'spec') {
    const a = spectrumOf(now, sr), g = gh ? spectrumOf(gh, sr) : null;
    labScr.draw({
      ...SPEC, xLabel: '20 Hz – 20 kHz',
      traces: [...(g ? [{ x: g.xs, y: g.ys, color: GHOST, width: 1.4 }] : []), { x: a.xs, y: a.ys, color: LIME, width: 1.8, glow: true, fill: 'rgba(198,244,50,0.12)' }],
      markers: [...SPEC_MARK, { x: Math.log10(a.fpeak), label: `peak ${Math.round(a.fpeak)} Hz`, color: LIME, dash: [2, 3], row: 1 }],
      note: gh ? 'white = before' : 'this sound',
    });
    return;
  }
  const full = view === 'full';
  const tmax = full ? niceMs((Math.max(now.length, gh?.length || 0) / sr) * 1000) : 40;
  const traces = [];
  if (gh) { const t = waveTrace(gh, sr, tmax); traces.push({ x: t.x, y: t.y, color: GHOST, width: 1.4 }); }
  const t = waveTrace(now, sr, tmax); traces.push({ x: t.x, y: t.y, color: LIME, width: 1.8, glow: true });
  labScr.draw({ x0: 0, x1: tmax, y0: -1, y1: 1, xLabel: `${tmax / 10} ms/div`, yLabel: '0.25/div', traces, note: gh ? 'white = before' : (full ? 'whole sound' : 'first 40 ms') });
}

// ---------------------------------------------------------------- Mix oscilloscope (triggered on the last hit)
const scr = new Screen($('#scope'), { divX: 10, divY: 8 });
const latest = {}; // win -> { t, seg } newest hit whose window is complete
let spec = null;   // cached spectrum of the newest 100 ms segment

/** Cut `wms` ms of the analyser buffer, starting at the onset of a hit that happened `age` s ago. */
function cut(buf, sr, age, wms) {
  const N = buf.length, L = Math.round((sr * wms) / 1000);
  const i0 = Math.round(N - age * sr), a = Math.max(0, i0 - Math.round(0.012 * sr)), b = Math.min(N, i0 + Math.round(Math.min(wms / 1000, 0.05) * sr));
  let peak = 0; for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak < 0.002) return new Float32Array(L); // silent (muted or too quiet)
  let on = a; while (on < b && Math.abs(buf[on]) < 0.12 * peak) on++;
  const start = Math.max(0, Math.min(N - L, on - Math.round(0.0005 * sr)));
  return buf.slice(start, start + L);
}
function capture() {
  if (!A) return;
  const { ctx, an, buf } = A, sr = ctx.sampleRate, now = ctx.currentTime; let read = false;
  for (const h of hits) {
    for (const w of WINS) {
      if (w in h.seg) continue;
      const age = now - h.t;
      if (age < w / 1000 + 0.05) continue;                    // window not complete yet
      if (age > an.fftSize / sr - 0.03) { h.seg[w] = null; continue; } // already left the buffer
      if (!read) { an.getFloatTimeDomainData(buf); read = true; }
      h.seg[w] = cut(buf, sr, age, w);
      if (!latest[w] || h.t >= latest[w].t) latest[w] = { t: h.t, seg: h.seg[w] };
    }
  }
}
function drawScope() {
  capture();
  if (!$('#sec-scope').open) return;
  const sr = A?.ctx.sampleRate || 48000, w = S.win;
  scr.divX = S.view === 'spec' ? 3 : 10; scr.divY = 8;
  if (S.view === 'wave') {
    const seg = latest[w]?.seg;
    if (!seg) { scr.draw({ x0: 0, x1: w, y0: -1, y1: 1, xLabel: `${w / 10} ms/div`, yLabel: '', traces: [], note: A ? '' : 'Press Play or tap a pad' }); return; }
    const peak = seg.reduce((m, v) => Math.max(m, Math.abs(v)), 0), yr = nice(Math.max(peak, 0.05)), t = waveTrace(seg, sr, w);
    scr.draw({ x0: 0, x1: w, y0: -yr, y1: yr, xLabel: `${w / 10} ms/div`, yLabel: `${fmt(yr / 4)}/div`, traces: [{ x: t.x, y: t.y, color: LIME, width: 1.8, glow: true }], note: 'last hit · triggered' });
  } else {
    const seg = latest[100]?.seg;
    if (!seg) { scr.draw({ ...SPEC, xLabel: '20 Hz – 20 kHz', traces: [], note: A ? '' : 'Press Play or tap a pad' }); return; }
    if (!spec || spec.seg !== seg) spec = { seg, ...spectrumOf(seg, sr) };
    scr.draw({
      ...SPEC, xLabel: '20 Hz – 20 kHz', note: 'last hit',
      traces: [{ x: spec.xs, y: spec.ys, color: LIME, width: 1.8, glow: true, fill: 'rgba(198,244,50,0.14)' }],
      markers: [...SPEC_MARK, { x: Math.log10(spec.fpeak), label: `peak ${Math.round(spec.fpeak)} Hz`, color: LIME, dash: [2, 3], row: 1 }],
    });
  }
}
function paintScopeButtons() {
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.view)));
  $$('[data-win]').forEach((b) => { b.setAttribute('aria-pressed', String(+b.dataset.win === S.win)); b.hidden = S.view === 'spec'; });
}
$('.scope-ctl').addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]'), w = e.target.closest('[data-win]');
  if (v) S.view = v.dataset.view; if (w) S.win = +w.dataset.win;
  paintScopeButtons(); saveAll();
});

// ---------------------------------------------------------------- transport, styles
function paintTransport() {
  $$('.play').forEach((b) => { b.textContent = playing ? '■ Stop' : '▶ Play'; b.setAttribute('aria-pressed', String(playing)); });
  $('#status').textContent = playing ? 'Playing' : 'Tap Play, or tap a pad to hear a sound';
}
function paintReadout() {
  const T = 60 / S.bpm, sd = T / 4, late = Math.round((S.swing / 100) * sd * 1000);
  $('#bpmOut').textContent = S.bpm; $('#bpmBar').textContent = S.bpm; $('#bpm').value = S.bpm; $('#swing').value = S.swing;
  $('#swingOut').textContent = `${S.swing} %`; $('#volOut').textContent = `${Math.round(S.vol * 100)} %`;
  $('#phys').textContent = `Beat period T = ${T.toFixed(2)} s · frequency f = 1/T = ${(1 / T).toFixed(2)} Hz · one step = ${Math.round(sd * 1000)} ms`;
  $('#swingNote').textContent = S.swing ? `Every second step is late by ${late} ms.` : 'Steps are perfectly evenly spaced.';
  paintSummaries();
}
const togglePlay = () => (playing ? stop() : (audioSupported() ? play() : ($('#status').textContent = 'This browser has no Web Audio.')));
$$('.play').forEach((b) => b.addEventListener('click', togglePlay));
const setBpm = (v) => { S.bpm = Math.max(60, Math.min(180, v)); paintReadout(); saveAll(); };
$('#bpm').addEventListener('input', (e) => { S.bpm = +e.target.value; paintReadout(); });
$('#bpmDown').addEventListener('click', () => setBpm(S.bpm - 1)); $('#bpmUp').addEventListener('click', () => setBpm(S.bpm + 1));
$('#swing').addEventListener('input', (e) => { S.swing = +e.target.value; paintReadout(); });
$('#vol').addEventListener('input', (e) => { S.vol = +e.target.value / 100; if (A) A.bus.gain.setTargetAtTime(S.vol, A.ctx.currentTime, 0.02); paintReadout(); });
for (const id of ['bpm', 'swing', 'vol']) $('#' + id).addEventListener('change', saveAll);

function syncAll() {
  $('#key').value = S.key; $('#scale').value = S.scale;
  paintGrid(); paintBass(); paintReadout(); paintProg(); paintArp(); saveAll(); renderLabPanel(); lab.ghost = null; renderLab();
}
function applyStyle(n) {
  const st = STYLES[n], b = bassFrom(st.bass);
  S.pat = rowsFrom(st.rows); S.bass = b.b; S.bl = b.l; S.prog = [...st.prog]; S.arp = { ...S.arp, ...(st.arp || {}) };
  S.bpm = st.bpm; S.swing = st.swing; S.key = st.key; S.scale = st.scale; Object.assign(S.params.bass, BASS_SOUNDS[st.sound]);
  syncAll();
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function surprise() {
  applyStyle(pick(Object.keys(STYLES)));
  S.pat.forEach((row, ti) => { if (ti) row.forEach((v, i) => { if (Math.random() < 0.07) row[i] = v ? 0 : pick([1, 1, 2]); }); }); // keep the kick, shake the rest
  S.bass.fill(-1); S.bl.fill(1);
  for (const i of [0, 2, 3, 6, 8, 10, 12, 14]) if (Math.random() < (i === 0 ? 0.9 : 0.45)) { S.bass[i] = pick([0, 0, 0, 2, 3, 4]); S.bl[i] = pick([1, 2, 2, 3, 4]); }
  S.key = Math.floor(Math.random() * 12); S.scale = pick(['pentatonicaMin', 'minore', 'dorica', 'blues']);
  Object.assign(S.params.bass, BASS_SOUNDS[pick(Object.keys(BASS_SOUNDS))]);
  syncAll();
}
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]'); if (!b) return;
  const n = b.dataset.preset;
  if (n === 'Clear') { S.pat = TRACKS.map(() => Array(STEPS).fill(0)); S.bass = Array(STEPS).fill(-1); S.bl = Array(STEPS).fill(1); syncAll(); }
  else if (n === 'Surprise') surprise();
  else applyStyle(n);
  $$('#presets [data-preset]').forEach((x) => x.classList.toggle('now', x === b && STYLES[n] !== undefined));
});
$('#key').addEventListener('change', (e) => { S.key = +e.target.value; paintBass(); saveAll(); renderLab(); playScale(); });
$('#scale').addEventListener('change', (e) => { S.scale = e.target.value; paintBass(); saveAll(); renderLab(); playScale(); });
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/^(INPUT|BUTTON|SELECT|TEXTAREA|SUMMARY)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); togglePlay(); }
});

// ---------------------------------------------------------------- sections (collapsible; one at a time on a phone)
const phone = matchMedia('(max-width: 680px)');
const secs = $$('.sec');
let labDirty = true;
function openSection(id, scroll = true) {
  secs.forEach((d) => { if (d.id === 'sec-' + id) d.open = true; else if (phone.matches) d.open = false; });
  if (scroll) requestAnimationFrame(() => $('#sec-' + id).scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
secs.forEach((d) => d.addEventListener('toggle', () => {
  if (d.open && phone.matches) secs.forEach((o) => { if (o !== d) o.open = false; });
  if (d.open) labDirty = true;
}));
if (phone.matches) secs.forEach((d) => (d.open = d.id === 'sec-drums'));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-open]'); if (go) openSection(go.dataset.open);
  const pg = e.target.closest('#pager [data-page]');
  if (pg) { $('#bgrid').dataset.page = pg.dataset.page; $$('#pager [data-page]').forEach((b) => b.setAttribute('aria-pressed', String(b === pg))); }
});
function paintSummaries() {
  const cnt = (a, b) => S.pat.slice(a, b).reduce((x, r) => x + r.filter((v) => v > 0).length, 0);
  const nBass = S.bass.filter((v) => v >= 0).length;
  const scaleName = SCALE_LIST.find(([k]) => k === S.scale)?.[1] || '';
  $('#sum-drums').textContent = `${cnt(0, 6)} hits`;
  $('#sum-bass').textContent = `${nBass} notes · ${NOTE_EN[S.key]} ${scaleName.toLowerCase()}`;
  $('#sum-gtr').textContent = `${cnt(6, 10)} hits`;
  $('#sum-keys').textContent = recording ? '● recording' : S.kloop.ev.length ? `${S.kloop.ev.length} notes looped` : 'play live';
  $('#sum-lab').textContent = byId(S.sel).name;
  $('#sum-prog').textContent = S.prog.map((v) => rootOf(v)).join(' → ');
  $('#sum-mix').textContent = hpFreq() < 25 && lpFreq() > 19000 ? 'filters off' : `HP ${hpFreq() < 25 ? 'off' : hz(hpFreq())} · LP ${lpFreq() > 19000 ? 'off' : hz(lpFreq())}`;
  $('#sum-groove').textContent = `${S.bpm} BPM · swing ${S.swing} %`;
}

// ---------------------------------------------------------------- selection and Sound lab
const lab = { buf: null, ghost: null, sr: 44100, busy: false, pending: false };
function select(id) { S.sel = id; lab.ghost = null; lab.buf = null; paintSelection(); renderLabPanel(); renderLab(); paintSummaries(); }
$('#labChips').innerHTML = SOUNDS.map((s) => `<button data-sound="${s.id}" aria-pressed="false">${s.name}</button>`).join('');
$('#labChips').addEventListener('click', (e) => { const b = e.target.closest('[data-sound]'); if (b) { select(b.dataset.sound); preview(b.dataset.sound); } });

function renderLabPanel() {
  const s = byId(S.sel), p = S.params[s.id];
  $('#labHint').textContent = s.hint;
  $('#labParams').innerHTML = s.params.map((q) => q.choice
    ? `<div class="pn-row choice"><span>${q.label}</span><div class="seg" role="group" aria-label="${s.name} ${q.label}">${WAVES.choice.map((w, i) =>
        `<button data-k="${q.k}" data-v="${w}" aria-pressed="${p[q.k] === w}">${WAVES.labels[i]}</button>`).join('')}</div><small>${q.desc}</small></div>`
    : `<label class="pn-row"><span>${q.label}</span><output id="o_${q.k}">${p[q.k]} ${q.unit}</output>` +
      `<input type="range" data-k="${q.k}" min="${q.min}" max="${q.max}" step="1" value="${p[q.k]}" aria-label="${s.name} ${q.label}"><small>${q.desc}</small></label>`).join('');
  $('#soloBtn').setAttribute('aria-pressed', String(S.solo === s.id));
}
$('#labParams').addEventListener('pointerdown', (e) => { if (e.target.closest('input[type="range"]')) lab.ghost = lab.buf; }); // grey = before this drag
$('#labParams').addEventListener('keydown', (e) => { if (e.target.closest('input[type="range"]') && !e.repeat) lab.ghost = lab.buf; });
$('#labParams').addEventListener('input', (e) => {
  const r = e.target.closest('input[data-k]'); if (!r) return;
  const q = byId(S.sel).params.find((x) => x.k === r.dataset.k);
  S.params[S.sel][q.k] = +r.value; $('#o_' + q.k).textContent = `${r.value} ${q.unit}`;
  renderLab();                                                     // the waveform follows the slider
});
$('#labParams').addEventListener('change', (e) => { if (e.target.closest('input[data-k]')) { saveAll(); paintBass(); preview(S.sel); } });
$('#labParams').addEventListener('click', (e) => {
  const c = e.target.closest('button[data-v]'); if (!c) return;
  lab.ghost = lab.buf; S.params[S.sel][c.dataset.k] = c.dataset.v;
  $$('button[data-k="' + c.dataset.k + '"]', $('#labParams')).forEach((b) => b.setAttribute('aria-pressed', String(b === c)));
  saveAll(); paintBass(); renderLab(); preview(S.sel);
});
$('#hearBtn').addEventListener('click', () => audition(S.sel));
$('#soloBtn').addEventListener('click', () => { S.solo = S.solo === S.sel ? null : S.sel; paintFlags(); $('#soloBtn').setAttribute('aria-pressed', String(S.solo === S.sel)); });
$('#resetBtn').addEventListener('click', () => {
  lab.ghost = lab.buf; const s = byId(S.sel); s.params.forEach((q) => (S.params[s.id][q.k] = q.def));
  renderLabPanel(); saveAll(); paintBass(); renderLab(); preview(S.sel);
});
$$('#labView [data-lv]').forEach((b) => b.addEventListener('click', () => { S.labView = b.dataset.lv; paintLabView(); saveAll(); drawLab(); }));
function paintLabView() { $$('#labView [data-lv]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lv === S.labView))); }

/** Render ONE sound alone, offline: exact waveform, independent of the sequencer. */
function renderSingle(id, sr) {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new Off(1, Math.max(1, Math.ceil(sr * soundLength(id, S.params[id]))), sr);
  const g = oc.createGain(); g.connect(oc.destination);
  playSound(oc, g, id, 0, 0, 0.45, 1);
  return oc.startRendering().then((b) => b.getChannelData(0).slice());
}
async function renderLab() {
  if (lab.busy) { lab.pending = true; return; }
  lab.busy = true;
  try {
    const sr = A?.ctx.sampleRate || 44100, id = S.sel;
    const buf = await renderSingle(id, sr);
    if (id === S.sel) { lab.buf = buf; lab.sr = sr; drawLab(); }
  } catch { /* offline rendering not available: the mix oscilloscope still works */ }
  lab.busy = false; if (lab.pending) { lab.pending = false; renderLab(); }
}

// ---------------------------------------------------------------- chord progression (transposition per bar)
const INTERVALS = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
const PROGS = { 'Stay': [0, 0, 0, 0], 'I–IV–V–IV': [0, 5, 7, 5], 'i–VI–III–VII': [0, -4, 3, -2], 'i–iv–i–v': [0, 5, 0, 7] };
const shiftLabel = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)} · ${INTERVALS[((n % 12) + 12) % 12]}`;
const rootOf = (sh) => NOTE_EN[(S.key + sh + 120) % 12];
function buildProg() {
  $('#progPresets').innerHTML = '<span>Progression</span>' + Object.keys(PROGS).map((n) => `<button data-pp="${n}" aria-pressed="false">${n}</button>`).join('');
  const opts = Array.from({ length: 25 }, (_, i) => i - 12).map((n) => `<option value="${n}">${shiftLabel(n)}</option>`).join('');
  $('#prog').innerHTML = [0, 1, 2, 3].map((b) => `<div class="pbar" data-bar="${b}"><span class="pn">Bar ${b + 1}</span>` +
    `<select data-bar="${b}" aria-label="Bar ${b + 1}: transposition in semitones">${opts}</select><span class="proot"></span></div>`).join('');
  paintProg();
}
function paintProg() {
  $$('#prog select').forEach((sel) => { sel.value = S.prog[+sel.dataset.bar]; });
  $$('#prog .pbar').forEach((e) => { e.querySelector('.proot').textContent = `root ${rootOf(S.prog[+e.dataset.bar])}`; });
  $$('#progPresets [data-pp]').forEach((b) => b.setAttribute('aria-pressed', String(PROGS[b.dataset.pp].every((v, i) => v === S.prog[i]))));
  paintSummaries();
}
$('#prog').addEventListener('change', (e) => { const sel = e.target.closest('select'); if (!sel) return; S.prog[+sel.dataset.bar] = +sel.value; paintProg(); saveAll(); });
$('#progPresets').addEventListener('click', (e) => { const b = e.target.closest('[data-pp]'); if (b) { S.prog = [...PROGS[b.dataset.pp]]; paintProg(); saveAll(); } });

// ---------------------------------------------------------------- keys: live keyboard and loop recorder
let recording = false, kOct = store.get('kOct', 4);
const pend = new Map();           // MIDI note -> { p, s }: notes held down while recording
const loopSteps = () => 4 * STEPS;
function loopPos() { const sd = 60 / S.bpm / 4, L = loopSteps(); return ((((A.ctx.currentTime - cycleT0) / sd) % L) + L) % L; } // position in the 4-bar loop, in steps
function finishNote(m) {
  const q = pend.get(m); if (!q) return; pend.delete(m);
  let d = (loopPos() - q.p + loopSteps()) % loopSteps(); d = Math.max(0.15, d);
  if (q.p + d > loopSteps()) d = loopSteps() - q.p; // a note cannot run past the end of the loop
  S.kloop.ev.push({ p: +q.p.toFixed(3), d: +d.toFixed(3), m, s: q.s });
}
function startRec() {
  if (!playing) play();
  recording = true; S.kloop.ses += 1; paintKeysUi();
}
function stopRec() { for (const m of [...pend.keys()]) finishNote(m); recording = false; saveAll(); paintKeysUi(); }
const held = new Map();           // MIDI note -> { off, n }: voices sounding now
function noteOn(m) {
  engine(); const h = held.get(m);
  if (h) { h.n += 1; return; }
  const off = keyVoice(A.ctx, A.aud.keys.vol, A.ctx.currentTime + 0.005, S.params.keys, m, null);
  held.set(m, { off, n: 1 }); hits.push({ t: A.ctx.currentTime + 0.005, id: 'keys', seg: {} }); if (hits.length > 40) hits.shift();
  if (recording && playing) pend.set(m, { p: loopPos(), s: S.kloop.ses });
  paintKeyOn(m, true);
}
function noteOff(m) {
  const h = held.get(m); if (!h) return;
  if (--h.n > 0) return;
  held.delete(m); h.off(A.ctx.currentTime); if (recording) finishNote(m); paintKeyOn(m, false);
}
const kb = $('#kb');
const PCS = [0, 2, 4, 5, 7, 9, 11], BLACK_AFTER = [0, 2, 5, 7, 9]; // white keys, and the white keys followed by a black one
function buildKb() {
  const octs = phone.matches ? 1 : 2, nW = 7 * octs + 1, base = 12 * (kOct + 1); let html = '';
  for (let i = 0; i < nW; i++) html += `<div class="wk" data-m="${base + 12 * Math.floor(i / 7) + PCS[i % 7]}"><span>${PCS[i % 7] === 0 ? 'C' + (kOct + Math.floor(i / 7)) : ''}</span></div>`;
  for (let i = 0; i < nW - 1; i++) if (BLACK_AFTER.includes(PCS[i % 7])) html += `<div class="bk" data-m="${base + 12 * Math.floor(i / 7) + PCS[i % 7] + 1}" style="left:calc(${((i + 1) / nW) * 100}% - ${30 / nW}%);width:${60 / nW}%"></div>`;
  kb.innerHTML = html; $('#kOctOut').textContent = `C${kOct}`; paintKb();
}
function paintKb() { // dots mark the notes of the current key and scale
  const pcs = new Set(SCALES[S.scale].map((d) => (S.key + d) % 12));
  $$('[data-m]', kb).forEach((k) => { const m = +k.dataset.m; k.classList.toggle('inkey', pcs.has(m % 12)); k.classList.toggle('on', held.has(m)); });
}
function paintKeyOn(m, on) { $$(`[data-m="${m}"]`, kb).forEach((k) => k.classList.toggle('on', on)); }
const kbPtr = new Map(); // pointerId -> MIDI note
kb.addEventListener('pointerdown', (e) => {
  const k = e.target.closest('[data-m]'); if (!k) return;
  e.preventDefault(); kb.setPointerCapture?.(e.pointerId); const m = +k.dataset.m; kbPtr.set(e.pointerId, m); noteOn(m);
});
kb.addEventListener('pointermove', (e) => {
  if (!kbPtr.has(e.pointerId)) return;
  const k = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-m]'); if (!k) return;
  const m = +k.dataset.m, old = kbPtr.get(e.pointerId); if (m === old) return;
  kbPtr.set(e.pointerId, m); noteOff(old); noteOn(m);                  // slide the finger: glissando
});
const kbUp = (e) => { if (kbPtr.has(e.pointerId)) { noteOff(kbPtr.get(e.pointerId)); kbPtr.delete(e.pointerId); } };
kb.addEventListener('pointerup', kbUp); kb.addEventListener('pointercancel', kbUp); kb.addEventListener('lostpointercapture', kbUp);
kb.addEventListener('click', () => engine());                          // iPhone only unlocks audio on a completed tap
kb.addEventListener('contextmenu', (e) => e.preventDefault());
// computer keyboard: A S D F G H J K L ; = white keys, W E T Y U O P = black keys, Z / X = octave
const KMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !$('#sec-keys').open || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') { kOct = Math.max(1, Math.min(6, kOct + (k === 'x' ? 1 : -1))); store.set('kOct', kOct); buildKb(); return; }
  if (k in KMAP) { e.preventDefault(); noteOn(12 * (kOct + 1) + KMAP[k]); }
});
document.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (k in KMAP) noteOff(12 * (kOct + 1) + KMAP[k]); });
$('#kOctDown').addEventListener('click', () => { kOct = Math.max(1, kOct - 1); store.set('kOct', kOct); buildKb(); });
$('#kOctUp').addEventListener('click', () => { kOct = Math.min(6, kOct + 1); store.set('kOct', kOct); buildKb(); });
phone.addEventListener?.('change', buildKb);

function paintKeysUi() {
  $('#kRec').setAttribute('aria-pressed', String(recording)); $('#kRec').textContent = recording ? '■ Stop rec' : '● Rec';
  const n = S.kloop.ev.length;
  $('#kInfo').textContent = recording ? 'Recording: play on the keyboard. Notes are kept exactly as you play them.' : n ? `Loop of 4 bars · ${n} notes. Press Rec again to overdub.` : 'Press Rec, then play: the loop of 4 bars starts from your notes.';
  $('#kUndo').disabled = !n; $('#kClear').disabled = !n; paintSummaries();
}
$('#kRec').addEventListener('click', () => (recording ? stopRec() : startRec()));
$('#kUndo').addEventListener('click', () => { const last = Math.max(...S.kloop.ev.map((e) => e.s)); S.kloop.ev = S.kloop.ev.filter((e) => e.s !== last); saveAll(); paintKeysUi(); });
$('#kClear').addEventListener('click', () => { S.kloop.ev = []; saveAll(); paintKeysUi(); });
function buildKeySounds() {
  $('#keySounds').innerHTML = '<span>Sound</span>' + Object.keys(KEY_SOUNDS).map((n) => `<button data-ks="${n}" aria-pressed="false">${n}</button>`).join('');
  paintKeySounds();
}
function paintKeySounds() { const pr = S.params.keys; $$('#keySounds [data-ks]').forEach((b) => b.setAttribute('aria-pressed', String(Object.entries(KEY_SOUNDS[b.dataset.ks]).every(([k, v]) => pr[k] === v)))); }
$('#keySounds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ks]'); if (!b) return;
  Object.assign(S.params.keys, KEY_SOUNDS[b.dataset.ks]); saveAll(); paintKeySounds();
  if (S.sel === 'keys') { lab.ghost = lab.buf; renderLabPanel(); renderLab(); }
});
/** The recorded loop as a small piano roll, with the playhead. */
const roll = $('#kroll');
function drawRoll() {
  if (!$('#sec-keys').open) return;
  const w = roll.clientWidth, h = roll.clientHeight, dpr = devicePixelRatio || 1;
  if (roll.width !== Math.round(w * dpr)) { roll.width = Math.round(w * dpr); roll.height = Math.round(h * dpr); }
  const c = roll.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  c.fillStyle = 'rgba(128,128,128,.12)'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(128,128,128,.45)'; c.lineWidth = 1;
  for (let b = 1; b < 4; b++) { c.beginPath(); c.moveTo((b * w) / 4, 0); c.lineTo((b * w) / 4, h); c.stroke(); }
  const ev = S.kloop.ev; if (ev.length) {
    const lo = Math.min(...ev.map((e) => e.m)) - 1, hi = Math.max(...ev.map((e) => e.m)) + 1, rh = Math.max(3, Math.min(10, h / (hi - lo + 1)));
    c.fillStyle = getComputedStyle(document.body).getPropertyValue('--primary') || '#2a5b8c';
    for (const e of ev) c.fillRect((e.p / loopSteps()) * w, h - ((e.m - lo + 0.5) / (hi - lo + 1)) * h - rh / 2, Math.max(2, (e.d / loopSteps()) * w), rh);
  }
  if (playing && A) { const x = (loopPos() / loopSteps()) * w; c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent') || '#e8590c'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
}

// ---------------------------------------------------------------- arpeggiator controls
const ARP_MODES = [['up', '↑ Up'], ['down', '↓ Down'], ['updown', '↕ Up-down'], ['random', '⚄ Random']];
function buildArp() {
  $('#arpCtl').innerHTML = '<span>Arp</span>' + ARP_MODES.map(([k, l]) => `<button data-am="${k}" aria-pressed="false">${l}</button>`).join('') +
    '<span>Notes</span>' + [3, 4].map((n) => `<button data-an="${n}" aria-pressed="false">${n}</button>`).join('') +
    '<span>Octaves</span>' + [1, 2, 3].map((n) => `<button data-ao="${n}" aria-pressed="false">${n}</button>`).join('');
  paintArp();
}
function paintArp() {
  $$('#arpCtl [data-am]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.am === S.arp.mode)));
  $$('#arpCtl [data-an]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.an === S.arp.n)));
  $$('#arpCtl [data-ao]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.ao === S.arp.oct)));
}
$('#arpCtl').addEventListener('click', (e) => {
  const m = e.target.closest('[data-am]'), n = e.target.closest('[data-an]'), o = e.target.closest('[data-ao]');
  if (m) S.arp.mode = m.dataset.am; if (n) S.arp.n = +n.dataset.an; if (o) S.arp.oct = +o.dataset.ao;
  if (m || n || o) { arpIdx = 0; paintArp(); saveAll(); }
});

// ---------------------------------------------------------------- mixer and master filters
function buildMixer() {
  $('#strips').innerHTML = '<div class="mixrow head"><span></span><span>Volume</span><span>Reverb send</span></div>' + SOUNDS.map((s) =>
    `<div class="mixrow" data-id="${s.id}"><span class="mixname">${s.name}</span>` +
    `<input type="range" min="0" max="100" step="1" data-mix="vol" data-id="${s.id}" value="${S.mix[s.id].vol}" aria-label="${s.name} volume" title="${S.mix[s.id].vol}">` +
    `<input type="range" min="0" max="100" step="1" data-mix="send" data-id="${s.id}" value="${S.mix[s.id].send}" aria-label="${s.name} reverb send" title="${S.mix[s.id].send}"></div>`).join('');
  $('#fxhp').value = S.fx.hp; $('#fxlp').value = S.fx.lp; $('#fxres').value = S.fx.res; $('#fxrev').value = S.fx.rev; $('#fxrt').value = Math.round(S.fx.rtime * 10);
  paintFx();
}
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
function paintFx() {
  $('#hpOut').textContent = hpFreq() < 25 ? 'off' : hz(hpFreq());
  $('#lpOut').textContent = lpFreq() > 19000 ? 'off' : hz(lpFreq());
  $('#resOut').textContent = `Q = ${qOf().toFixed(1)}`; $('#revOut').textContent = `${S.fx.rev} %`; $('#rtOut').textContent = `${S.fx.rtime.toFixed(1)} s`;
  paintSummaries();
}
$('#strips').addEventListener('input', (e) => {
  const r = e.target.closest('input[data-mix]'); if (!r) return;
  S.mix[r.dataset.id][r.dataset.mix] = +r.value; r.title = r.value; applyMix();
});
$('#strips').addEventListener('change', (e) => { if (e.target.closest('input[data-mix]')) { saveAll(); paintSummaries(); const id = e.target.dataset.id; if (!playing) audition(id, 0, 0.4); } });
for (const [id, k] of [['fxhp', 'hp'], ['fxlp', 'lp'], ['fxres', 'res'], ['fxrev', 'rev']]) {
  $('#' + id).addEventListener('input', (e) => { S.fx[k] = +e.target.value; applyFx(); paintFx(); });
  $('#' + id).addEventListener('change', saveAll);
}
$('#fxrt').addEventListener('input', (e) => { S.fx.rtime = +e.target.value / 10; applyReverbTime(); paintFx(); });
$('#fxrt').addEventListener('change', saveAll);
$('#mixReset').addEventListener('click', () => {
  for (const s of SOUNDS) S.mix[s.id] = { vol: 80, send: SEND_DEF[s.id] || 0 };
  S.fx = { hp: 0, lp: 100, res: 10, rev: 70, rtime: 1.6 };
  buildMixer(); applyMix(); applyFx(); applyReverbTime(); saveAll();
});

// ---------------------------------------------------------------- main loop
function frame() {
  requestAnimationFrame(frame);
  if (A && playing) { const now = A.ctx.currentTime; let q = null; while (queue.length && queue[0].t <= now) q = queue.shift(); if (q) setCur(q.i, q.bar); }
  drawScope(); drawRoll();
  if (labDirty && $('#sec-lab').open) { labDirty = false; renderLab(); } // a section that was closed has a 0-size canvas: draw it when it opens
}

buildGrids(); buildProg(); buildArp(); buildMixer(); buildKb(); buildKeySounds(); paintKeysUi(); renderLabPanel(); paintLabView(); paintTransport(); paintScopeButtons();
$('#vol').value = Math.round(S.vol * 100); paintReadout();
renderLab();
requestAnimationFrame(frame);

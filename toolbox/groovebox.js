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
import { SCALES, noteFreq, TIMBRES } from '../mosaicus/app/js/dsp.js';
import { prepareRecorder, Tap, encodeWav, encodeMp3, zip } from './gb-export.js';
import { initSong } from './gb-song.js';
import { buildShaper, initFx } from './gb-fx.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STEPS = 16, ROWS = 8;
const WINS = [20, 100, 400]; // mix oscilloscope windows, ms
const store = {
  get(k, d) { try { const v = localStorage.getItem('groovebox.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('groovebox.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const WAVES = { choice: ['sine', 'sawtooth', 'square', 'triangle', 'custom'], labels: ['Sine', 'Saw', 'Square', 'Triangle', 'Custom'] };

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
      { k: 'wah', label: 'Wah (0 off · 1 pedal · 2 LFO)', min: 0, max: 2, def: 0, unit: '', desc: 'Long sustained chord (sawtooth) through a swept band-pass: 1 = the filter opens on the attack like a wah pedal, 2 = it sweeps slowly by itself (LFO).' },
      { k: 'hold', label: 'Hold (wah)', min: 1, max: 8, def: 2, unit: 'beats', desc: 'How long the wah chord lasts: 2 beats = half a bar.' },
      { k: 'vib', label: 'Vibrato (wah)', min: 0, max: 60, def: 0, unit: 'cents', desc: 'Depth of the pitch wobble (5.4 Hz) that fades in after the attack.' },
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
  hint: 'An arpeggiator: the notes of a chord played one after another instead of together. Each active step plays the NEXT note of the chord built on the bass note under it (a stack of scale notes, thirds apart); the Mode, Notes and Octaves chips decide the order and the range. The step pattern gives the rhythm, the arpeggiator gives the pitches. Order can also be Chord (all the notes at once), Root, Fifths or Octaves: static, bass-like lines. Filter and decay shape each note.',
  params: [
    { k: 'wave', label: 'Waveform', choice: true, def: 'sawtooth', desc: 'Sine is pure; saw and square have many harmonics.' },
    { k: 'octave', label: 'Octave', min: 2, max: 6, def: 4, unit: '', desc: 'Register of the lowest note (2 = bass register).' },
    { k: 'cutoff', label: 'Filter cutoff', min: 300, max: 8000, def: 2500, unit: 'Hz', desc: 'Low-pass: it opens at the start of each note and closes (a “pluck”).' },
    { k: 'decay', label: 'Decay', min: 60, max: 2500, def: 220, unit: 'ms', desc: 'How long each note rings (−60 dB). Long values make organ-like pads.' },
  ] });

// two more arp-type tracks: the Keys can play chords + a low static line + an arpeggio at the same time
{
  const a = TRACKS.find((t) => t.id === 'arp'), mk = (id, name, hint, def) => ({ ...a, id, name, hint, params: a.params.map((p) => ({ ...p, def: def[p.k] ?? p.def })) });
  TRACKS.push(
    mk('kchord', 'Keys chords', 'Chords: every active step plays all the notes of the chord at once (stacked thirds taken from the scale you chose). Long decays make organ or pad chords.', { wave: 'square', octave: 3, cutoff: 1800, decay: 600 }),
    mk('klow', 'Keys low', 'A low, quiet line that fills the bottom: it plays the bass note (or its fifth, octave, or a slow walk up the chord), as a pure low tone.', { wave: 'triangle', octave: 2, cutoff: 1000, decay: 300 }));
}
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
const EXTRA = [ // sounds used by the Pads only (not rows of the step sequencer)
  { id: 'tom', group: 'pads', name: 'Tom', hint: 'Like the kick, a sine with a falling pitch, but higher and shorter: a tom is a drum skin tuned to a note.',
    params: [{ k: 'pitch', label: 'Pitch', min: 70, max: 320, def: 140, unit: 'Hz', desc: 'Final pitch of the drum skin.' }, { k: 'decay', label: 'Decay', min: 80, max: 600, def: 260, unit: 'ms', desc: 'How long it rings (−60 dB).' }] },
  { id: 'rim', group: 'pads', name: 'Rim shot', hint: 'A very short click: a burst of band-passed noise on top of a brief tone from the rim of the drum.',
    params: [{ k: 'tone', label: 'Tone pitch', min: 300, max: 900, def: 500, unit: 'Hz', desc: 'Pitch of the click.' }, { k: 'decay', label: 'Decay', min: 10, max: 120, def: 40, unit: 'ms', desc: 'Very short.' }] },
  { id: 'crash', group: 'pads', name: 'Crash', hint: 'High-passed noise left ringing for a long time: the metal cymbal keeps vibrating.',
    params: [{ k: 'hp', label: 'High-pass cutoff', min: 3000, max: 10000, def: 5500, unit: 'Hz', desc: 'Frequencies below this are removed.' }, { k: 'decay', label: 'Decay', min: 300, max: 2000, def: 1100, unit: 'ms', desc: 'How long the cymbal rings (−60 dB).' }] },
  { id: 'vox', group: 'pads', name: 'Voice', hint: 'A sung voice built from scratch (formant synthesis). The vocal cords are a buzzing sawtooth (a pitch with many harmonics); the throat and mouth act as resonators that boost a few bands, the formants. Each vowel is a different set of 4 formant frequencies: “ah” has F1 ≈ 800 Hz and F2 ≈ 1150 Hz, “ee” has F1 ≈ 350 Hz and F2 ≈ 1700 Hz. Moving smoothly from one set to another gives “oo-ah”. A slow pitch wobble (vibrato) and a little breath noise make it human. These are NOT recordings of real singers: they are imitations computed by the browser.',
    params: [{ k: 'octave', label: 'Register', min: 3, max: 5, def: 4, unit: '', desc: '3 = low (baritone), 4 = alto, 5 = soprano.' },
      { k: 'vibrato', label: 'Vibrato', min: 0, max: 100, def: 45, unit: '%', desc: 'Depth of the pitch wobble (about 5.5 times per second).' },
      { k: 'breath', label: 'Breath', min: 0, max: 60, def: 14, unit: '%', desc: 'Noise mixed into the voice: the air of the singer.' },
      { k: 'length', label: 'Length', min: 60, max: 160, def: 100, unit: '%', desc: 'Stretches or squeezes the whole phrase in time.' }] },
];
const SOUNDS = [...TRACKS, BASS, KEYS, ...EXTRA];
const MUTEK = { arp: 'karp', kchord: 'kchords', klow: 'klow' }; // each Keys layer has its own M; the Keys loop fader mutes all three
const GMK = { keys: 'karp', kchords: 'kchords', klow: 'klow' }; // slot -> mute key
const GROUP = { kchord: 'keys', klow: 'keys', kick: 'drums', snare: 'drums', hat: 'drums', ohat: 'drums', clap: 'drums', cow: 'drums', tom: 'drums', rim: 'drums', crash: 'drums', vox: 'pads', chank: 'guitar', chord: 'guitar', pluck: 'guitar', arp: 'karp', keys: 'live', bass: 'bass' }; // group 'keys' = the Keys LOOPS of the launcher; group 'live' = keyboard, its recorded loop and the keys pads
const GROUPS = [['drums', 'Drums'], ['bass', 'Bass'], ['guitar', 'Guitar'], ['keys', 'Keys loop'], ['karp', 'Arp']];
const KEY_SOUNDS = {
  'Lead': { wave: 'sawtooth', cutoff: 3500, reso: 3, attack: 5, decay: 300, sustain: 60, release: 200, detune: 10 },
  'Pad': { wave: 'triangle', cutoff: 1800, reso: 1, attack: 450, decay: 600, sustain: 80, release: 900, detune: 14 },
  'Pluck': { wave: 'square', cutoff: 2200, reso: 4, attack: 2, decay: 250, sustain: 0, release: 150, detune: 6 },
  'Organ': { wave: 'sine', cutoff: 6000, reso: 0, attack: 6, decay: 100, sustain: 100, release: 70, detune: 0 },
  'Gospel organ': { wave: 'square', cutoff: 2600, reso: 0, attack: 8, decay: 100, sustain: 90, release: 140, detune: 3 },
  'Rhodes': { wave: 'triangle', cutoff: 2800, reso: 1, attack: 3, decay: 900, sustain: 15, release: 500, detune: 5 },
  'Strings': { wave: 'sawtooth', cutoff: 1600, reso: 0.5, attack: 350, decay: 600, sustain: 85, release: 800, detune: 18 },
  'Custom': { wave: 'custom', cutoff: 3500, reso: 0.5, attack: 8, decay: 500, sustain: 70, release: 300, detune: 6 }, // your own harmonics (Step view → Custom waveform)
  'Stab': { wave: 'sawtooth', cutoff: 3800, reso: 2, attack: 2, decay: 160, sustain: 0, release: 120, detune: 12 },
};
const byId = (id) => SOUNDS.find((s) => s.id === id);
const REL = 0.07; // bass release, s

const BASS_SOUNDS = {
  '808 sub': { wave: 'sine', octave: 2, cutoff: 900, reso: 0, sustain: 80, decay: 900, drive: 40, up: 20, gain: 0.8 },
  'Saw': { wave: 'sawtooth', octave: 2, cutoff: 750, reso: 1.5, sustain: 60, decay: 300, drive: 0, up: 15, gain: 1.1 },
  'Funk': { wave: 'square', octave: 2, cutoff: 650, reso: 2, sustain: 30, decay: 200, drive: 10, up: 25, gain: 1.0 },
  'Soft': { wave: 'triangle', octave: 2, cutoff: 1800, reso: 0, sustain: 90, decay: 400, drive: 0, up: 30, gain: 1.05 },
  // from the reference tracks: strong fundamental, 2nd harmonic ~40 %, 3rd ~25 %, long legato notes, no harsh distortion
  'Sub+': { wave: 'sine', octave: 2, cutoff: 1400, reso: 0, sustain: 85, decay: 700, drive: 25, up: 40, up3: 25, gain: 0.8 },
  'Finger': { wave: 'triangle', octave: 2, cutoff: 1100, reso: 0, sustain: 80, decay: 500, drive: 15, up: 38, up3: 22, gain: 0.9 },
  'Warm': { wave: 'sine', octave: 2, cutoff: 600, reso: 0, sustain: 95, decay: 900, drive: 10, up: 12, up3: 5, gain: 0.9 }, // quiet but it fills: soft, long, almost no upper partials
  'Custom': { wave: 'custom', octave: 2, cutoff: 1500, reso: 0, sustain: 85, decay: 700, drive: 15, up: 20, up3: 10, gain: 0.8 },
  'Round': { wave: 'sine', octave: 2, cutoff: 1000, reso: 0, sustain: 75, decay: 900, drive: 45, up: 32, up3: 28, gain: 0.78 },
};
const NOTE_LENS = [[1, '1/16'], [2, '1/8'], [4, '1/4'], [8, '1/2'], [16, '1 bar']];

const NOTE_EN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SCALE_LIST = [['pentatonicaMin', 'Minor pentatonic'], ['pentatonica', 'Major pentatonic'], ['minore', 'Minor'], ['dorica', 'Dorian'], ['maggiore', 'Major'],
  ['frigia', 'Phrygian'], ['minoreArmonica', 'Harmonic minor'], ['blues', 'Blues'], ['giapponese', 'Japanese'], ['araba', 'Arabic'],
  ['minoreMelodica', 'Melodic minor'], ['lidia', 'Lydian'], ['misolidia', 'Mixolydian'], ['locria', 'Locrian'], ['napoletana', 'Neapolitan minor'], ['ungherese', 'Hungarian minor'],
  ['spagnola', 'Spanish (Phrygian dominant)'], ['bluesMag', 'Major blues'], ['esatonale', 'Whole tone'], ['diminuita', 'Diminished']];

// ---------------------------------------------------------------- styles (rows follow TRACKS order)
// digits: 0 off · 1 hit · 2 ghost · 3 roll ×2 · 4 roll ×3 ; bass: [step, row, length in steps]
const S2D = { 0: 0, 2: 1, 3: 2, 4: 2, 5: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6, '-4': 5, '-3': 5, '-2': 6, '-1': 6 }; // old semitone shifts -> scale degrees (0 = I … 6 = VII)
const toDeg = (a) => a.map((v) => S2D[v] ?? 0);
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
  ext: store.get('ext', 1), harm: (() => { const v = store.get('harm', null); return Array.isArray(v) && v.length === 8 && v.every((x) => x >= 0 && x <= 1) ? v : [...TIMBRES.clarinetto.amps]; })(), lock: store.get('lock', {}), drop: store.get('drop', 6), sel: 'kick', solo: null, rep: store.get('rep', 0),
  kloop: store.get('kloop', null), ploop: store.get('ploop', null), arp: store.get('arp', null), arps: store.get('arps', null), prog: store.get('prog3', null), mix: store.get('mix', {}), fx: store.get('fx', {}), grp: store.get('grp', null), gmute: store.get('gmute', {}),
};
if (Array.isArray(S.pat) && S.pat.length < TRACKS.length && S.pat.every((r) => Array.isArray(r) && r.length === STEPS)) while (S.pat.length < TRACKS.length) S.pat.push(Array(STEPS).fill(0)); // saved beat from an older version: add the new empty rows
if (!Array.isArray(S.pat) || S.pat.length !== TRACKS.length || S.pat.some((r) => !Array.isArray(r) || r.length !== STEPS)) {
  S.pat = rowsFrom(STYLES.House.rows); const b = bassFrom(STYLES.House.bass); S.bass = b.b; S.bl = b.l;
}
if (!Array.isArray(S.bass) || S.bass.length !== STEPS || !Array.isArray(S.bl) || S.bl.length !== STEPS) { const b = bassFrom(STYLES.House.bass); S.bass = b.b; S.bl = b.l; }
if (!Array.isArray(S.prog) || S.prog.length !== 4 || S.prog.some((v) => !(v >= 0 && v <= 6))) S.prog = [0, 0, 0, 0]; // default: Stay (one chord)
if (!S.ploop || !Array.isArray(S.ploop.ev)) S.ploop = { ev: [], ses: 0 }; // recorded pad hits: { p, m: pad number, v: velocity, s }
if (!S.kloop || !Array.isArray(S.kloop.ev)) S.kloop = { ev: [], ses: 0 }; // recorded keyboard loop: ev = { p: start in steps 0–64, d: length in steps, m: MIDI note, s: recording pass }
{ const SA = S.arps || {}; S.arps = { arp: { mode: 'up', n: 3, oct: 2, ...(S.arp || {}), ...(SA.arp || {}) }, kchord: { mode: 'chord', n: 3, oct: 1, ...(SA.kchord || {}) }, klow: { mode: 'root', n: 3, oct: 1, ...(SA.klow || {}) } }; }
S.vnote = store.get('vnote', 0); S.bank = store.get('bank', 0); S.vgest = 0; // voice pads: pitch (scale step), pad bank, last phrase
const ARP_OK = ['up', 'down', 'updown', 'random', 'chord', 'root', 'fifths', 'oct', 'scale', 'scaledown', 'scaleud'];
for (const k in S.arps) if (!ARP_OK.includes(S.arps[k].mode)) S.arps[k].mode = k === 'kchord' ? 'chord' : k === 'klow' ? 'root' : 'up';
const SEND_DEF = { snare: 15, clap: 25, chord: 20, pluck: 15, ohat: 10, arp: 20, kchord: 15, keys: 15 };
for (const s of SOUNDS) S.mix[s.id] = { vol: 80, send: SEND_DEF[s.id] || 0, ...(S.mix[s.id] || {}) };
S.fx = { hp: 0, lp: 100, res: 10, rev: 70, rtime: 1.6 }; // the filter and reverb are now played on the XY pad: always start open
S.grp = { drums: 80, bass: 80, guitar: 80, keys: 80, karp: 80, live: 80, pads: 80, ...(S.grp || {}) }; S.gmute = S.gmute || {};
for (const s of SOUNDS) { S.mix[s.id].send = 0; S.mix[s.id].vol = 80; } // reverb is now an effect of the XY pad, not a send per sound
if (!WINS.includes(S.win)) S.win = 100;
if (![1, 2, 3, 4].includes(S.brush)) S.brush = 1;
if (!NOTE_LENS.some(([n]) => n === S.nlen)) S.nlen = 2;
if (!['full', 'attack', 'spec'].includes(S.labView)) S.labView = 'full';
if (!SCALES[S.scale]) S.scale = 'pentatonicaMin';
for (const s of SOUNDS) S.params[s.id] = { ...Object.fromEntries(s.params.map((p) => [p.k, p.def])), ...(S.params[s.id] || {}) };
const saveAll = () => {
  for (const k of ['bpm', 'swing', 'vol', 'win', 'view', 'labView', 'key', 'scale', 'brush', 'nlen', 'prog', 'mix', 'fx', 'kloop', 'grp', 'gmute', 'ploop', 'rep', 'vnote', 'bank', 'arps', 'ext', 'lock', 'drop', 'harm']) store.set(k, S[k]);
  store.set('prog3', S.prog);
  store.set('slots', Object.fromEntries(SLOTS.map(([k]) => [k, SL[k].cur])));
  store.set('pat3', S.pat); store.set('bass3', S.bass); store.set('bl3', S.bl); store.set('mute3', S.mute); store.set('params3', S.params);
};

// ---------------------------------------------------------------- bass notes: row, length, and which note covers a step
/** Semitones above the tonic for grid row r (row 0 = tonic, going up through the scale). */
function semis(r) { const d = SCALES[S.scale]; return d[r % d.length] + 12 * Math.floor(r / d.length); }
/** The chord of the bar is a DEGREE of the scale (0 = I … 6 = VII), not a fixed number of semitones: every note moves along the scale, so the chord qualities come out of the scale itself. */
const dstep = (d) => { const n = SCALES[S.scale].length; return n === 7 ? d : Math.round((d * n) / 7); }; // scales with 5, 6, 8 notes: nearest step
const foldOf = (d) => (semis(dstep(d)) >= 8 ? 12 : 0); // VI and VII sit an octave lower, so the bass does not jump up
const rootSemi = (d) => semis(dstep(d)) - foldOf(d);
const shiftSemi = (r, d) => semis(r + dstep(d)) - foldOf(d);
/** The Custom waveform: a sum of 8 sine waves (fundamental + harmonics), additive synthesis like the Mosaicus synth. Cached per audio context. */
const harmCache = new WeakMap();
function setWave(ctx, o, w) {
  if (w !== 'custom') { o.type = w; return; }
  const key = S.harm.join(','); let m = harmCache.get(ctx);
  if (!m || m.key !== key) { const re = new Float32Array(9), im = new Float32Array(9); S.harm.forEach((a, i) => { im[i + 1] = a; }); if (!S.harm.some((a) => a > 0)) im[1] = 1; m = { key, pw: ctx.createPeriodicWave(re, im) }; harmCache.set(ctx, m); }
  o.setPeriodicWave(m.pw);
}
/** Real basses live low: the root of the key sits between E1 and D♯2 (41–78 Hz), whatever the key; the Octave parameter moves it (2 = as is). */
/** Long chord with wah and vibrato: sawtooth pairs (slightly detuned) → band-pass swept by a pedal envelope or an LFO; vibrato = LFO on the pitch, fading in. */
function wahChord(ctx, out, t, p, row, sh) {
  const L = Math.max(0.25, ((p.hold || 2) * 60) / S.bpm), end = t + L, ks = [0, 2, 4, 6, 8].slice(0, 3 + S.ext);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4.5;
  const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 900; const bg = ctx.createGain(); bg.gain.value = 0.35;
  const g = ctx.createGain(), PK = 0.38; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(PK, t + 0.008); g.gain.setTargetAtTime(PK * 0.72, t + 0.03, 0.3);
  g.gain.cancelScheduledValues(end); g.gain.setTargetAtTime(0.0001, end, 0.035);
  bp.connect(g); body.connect(bg).connect(g); g.connect(out);
  const stops = [];
  if (p.wah === 2) { const lf = ctx.createOscillator(), lg = ctx.createGain(); bp.frequency.value = 1000; lf.frequency.value = 2.2; lg.gain.value = 750; lf.connect(lg).connect(bp.frequency); lf.start(t); stops.push(lf); }
  else { bp.frequency.setValueAtTime(420, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 0.17); bp.frequency.exponentialRampToValueAtTime(650, t + Math.min(L, 1)); }
  let vg = null;
  if (p.vib > 0) { const vl = ctx.createOscillator(); vg = ctx.createGain(); vl.frequency.value = 5.4; vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(p.vib, t + 0.3); vl.connect(vg); vl.start(t); stops.push(vl); }
  for (const k of ks) for (const det of [-6, 6]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = rowFreq(row + k, p.octave, sh); o.detune.value = det; if (vg) vg.connect(o.detune);
    const og = ctx.createGain(); og.gain.value = 0.55 / Math.sqrt(ks.length); o.connect(og); og.connect(bp); og.connect(body); o.start(t); stops.push(o);
  }
  for (const o of stops) o.stop(end + 0.35);
}
function bassFreq(r, octave, sh = 0) { const root = 28 + ((((S.key - 4) % 12) + 12) % 12); return 440 * Math.pow(2, (root + shiftSemi(r, sh) + 12 * (octave - 2) - 69) / 12); }
function rowFreq(r, octave, sh = 0) { return noteFreq(S.key + shiftSemi(r, sh) + 12 * (octave - 4) - 9); } // sh = degree of the bar
const rowName = (r) => NOTE_EN[(S.key + semis(r)) % 12];
/** Length (in steps) of the note starting at step i: cut by the next note and by the end of the bar. */
function noteLenOf(b, l, i) {
  let n = Math.max(1, Math.min(l[i] || 1, STEPS - i));
  for (let k = 1; k < n; k++) if (b[i + k] >= 0) { n = k; break; }
  return n;
}
const noteLen = (i) => noteLenOf(S.bass, S.bl, i);
function coverOf(b, l) { const c = Array(STEPS).fill(-1); for (let i = 0; i < STEPS; i++) if (b[i] >= 0) { const n = noteLenOf(b, l, i); for (let k = 0; k < n; k++) c[i + k] = b[i]; } return c; }
/** cov[i] = row of the bass note sounding at step i (start or sustained part), -1 if silent. */
let cov = Array(STEPS).fill(-1);
function recompute() {
  cov = Array(STEPS).fill(-1);
  for (let i = 0; i < STEPS; i++) if (S.bass[i] >= 0) { const n = noteLen(i); for (let k = 0; k < n; k++) cov[i + k] = S.bass[i]; }
}
recompute();
const rowAt = (i) => (cov[i] >= 0 ? cov[i] : 0);

// ---------------------------------------------------------------- audio engine
let xrec = null; // the export in progress (see Export · record)
let A = null; // { ctx, bus, hp, lp, an, buf, conv, revOut, aud, strips, sess }
//   channel strip (one per sound):  voice ─► vol ─┬─► dry ─► bus
//                                                 └─► send ─► reverb (ConvolverNode) ─► return ─► bus
//   bus ─► high-pass ─► low-pass ─► waveshaper (dry/wet) ─► compressor ─► master            (filters act on the whole mix, reverb included)
const GTRIM = { drums: 0.75, bass: 0.5, guitar: 2.0, keys: 2.4 }; // the references have far more mid-range than bass in the mix: loops are balanced like that (live keys and pads are untouched)
let kickMul = 1; // temporary boost of the kick (drop effect)
const volGain = (id) => (S.gmute[GROUP[id]] || S.gmute[MUTEK[id]] ? 0 : Math.pow(S.mix[id].vol / 80, 1.6) * (id === 'vox' ? 1 : Math.pow(S.grp[GROUP[id]] / 80, 1.6) * (GTRIM[GROUP[id]] ?? 1) * (id === 'kick' ? kickMul : 1))); // voice pads: the Pads fader is already applied by the pad itself          // 80 = unity gain, 100 = +4 dB
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
    vol.connect(dryOut); vol.connect(send); send.connect(wetIn); if (s.id !== 'vox') vol.connect(A.gan[GROUP[s.id]]); o[s.id] = { vol, send }; // the voice reaches the Pads meter through the pad's own tap
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
  if (xrec) for (const st of xrec.stems) st.sync();
}
let irTimer = 0;
function applyReverbTime() { clearTimeout(irTimer); irTimer = setTimeout(() => { if (A) { A.conv.buffer = impulse(A.ctx, S.fx.rtime); if (xrec) for (const st of xrec.stems) st.conv.buffer = A.conv.buffer; } }, 150); }
/** Effects of the XY pad: three parallel sends taken after the filters (reverb, echo, flanger). The filter is an insert (hp + lp). */
function buildFx(ctx, lp, comp, main = false) {
  const G = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const rs = G(), cS = ctx.createConvolver(), cL = ctx.createConvolver(), oS = G(1), oL = G(0);
  cS.buffer = impulse(ctx, 0.6); cL.buffer = impulse(ctx, 2.8); lp.connect(rs); rs.connect(cS); rs.connect(cL); cS.connect(oS); cL.connect(oL); oS.connect(comp); oL.connect(comp);
  const es = G(), dl = ctx.createDelay(2), fb = G(0.4), ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 3500; dl.delayTime.value = 0.25;
  lp.connect(es); es.connect(dl); dl.connect(ef); ef.connect(fb); fb.connect(dl); ef.connect(comp);
  const fs = G(), fd = ctx.createDelay(0.05), lfo = ctx.createOscillator(), depth = G(0.002), ffb = G(0.5); fd.delayTime.value = 0.005; lfo.frequency.value = 0.5;
  lfo.connect(depth); depth.connect(fd.delayTime); lfo.start(); lp.connect(fs); fs.connect(fd); fd.connect(ffb); ffb.connect(fd); fd.connect(comp);
  const ws = buildShaper(ctx, lp, comp, main); // the waveshaper insert: lp → (dry + shaped) → comp
  return { rs, oS, oL, es, dl, fb, fs, lfo, depth, ffb, ws };
}
const ECHO_DIV = [1 / 16, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1]; // delay times in beats: the echo stays in time with the beat
/** One XY pad position (x, y in 0…1, y up) for one effect; on = false releases it. */
function fxApply(kind, x, y, on) {
  if (!A) return;
  if (kind === 'filter') { S.fx.hp = on && x > 0.5 ? (x - 0.5) * 200 : 0; S.fx.lp = on && x < 0.5 ? x * 200 : 100; S.fx.res = on ? 10 + y * 80 : 10; applyFx(); return; }
  for (const f of [A.fx, ...(xrec ? xrec.fxs : [])]) fxTo(f, kind, x, y, on); // while recording, the Drums / Bass stems get the same effects
}
function fxTo(f, kind, x, y, on) {
  const t = A.ctx.currentTime, T = 0.025;
  if (kind === 'reverb') { f.rs.gain.setTargetAtTime(on ? 0.15 + 0.85 * x : 0, t, T); f.oS.gain.setTargetAtTime(1 - y, t, T); f.oL.gain.setTargetAtTime(y, t, T); }
  else if (kind === 'echo') {
    f.es.gain.setTargetAtTime(on ? 0.8 : 0, t, T); f.dl.delayTime.setTargetAtTime((60 / S.bpm) * ECHO_DIV[Math.min(7, Math.floor(x * 8))], t, 0.05);
    f.fb.gain.setTargetAtTime(on ? 0.2 + 0.65 * y : 0.45, t, T);
  } else if (kind === 'flanger') {
    f.fs.gain.setTargetAtTime(on ? 0.7 : 0, t, T); f.lfo.frequency.setTargetAtTime(0.1 * Math.pow(60, x), t, 0.05);
    f.depth.gain.setTargetAtTime(0.0004 + 0.0026 * y, t, T); f.ffb.gain.setTargetAtTime(0.25 + 0.45 * y, t, T);
  }
}
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
    bus.connect(hp); hp.connect(lp); comp.connect(master); comp.connect(an);
    const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, S.fx.rtime);
    const revOut = ctx.createGain(); revOut.gain.value = S.fx.rev / 100; conv.connect(revOut); revOut.connect(bus);
    A = { ctx, master, bus, hp, lp, an, buf: new Float32Array(an.fftSize), conv, revOut, aud: null, strips: null, sess: null, fx: buildFx(ctx, lp, comp, true), gan: {}, gbuf: new Float32Array(1024) };
    for (const g of [...GROUPS.map(([k]) => k), 'live', 'pads']) { const a = ctx.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0; A.gan[g] = a; } // one level meter per group (after its fader)
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
  const oscs = [-1, 1].map((sgn) => { const o = ctx.createOscillator(); setWave(ctx, o, p.wave); o.frequency.value = f; o.detune.value = (sgn * p.detune) / 2; o.connect(lp); o.start(t); return o; });
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


// ---------------------------------------------------------------- voices (formant synthesis)
/** Sung vowels (alto): the 4 formant centre frequencies (Hz), their levels (dB) and bandwidths (Hz). */
const VOWELS = {
  a: { f: [800, 1150, 2800, 3500], a: [0, -4, -20, -36], b: [80, 90, 120, 130] },
  e: { f: [400, 1600, 2700, 3300], a: [0, -24, -30, -35], b: [60, 80, 120, 150] },
  i: { f: [350, 1700, 2700, 3700], a: [0, -20, -30, -36], b: [60, 90, 100, 120] },
  o: { f: [450, 800, 2830, 3500], a: [0, -9, -16, -28], b: [70, 80, 100, 130] },
  u: { f: [325, 700, 2530, 3500], a: [0, -12, -30, -40], b: [50, 60, 170, 180] },
  ae: { f: [660, 1700, 2400, 3300], a: [0, -8, -20, -32], b: [80, 90, 120, 130] },
  uh: { f: [600, 1200, 2500, 3300], a: [0, -8, -22, -34], b: [80, 90, 120, 130] },
  m: { f: [270, 1000, 2200, 3200], a: [0, -14, -30, -40], b: [60, 100, 150, 150] },
};
/** One-shot phrases. A note is [start s, length s, scale steps above the chosen note, vowels (morphed in this order), options].
 *  options: g = glide from this many semitones below, f = fall by this many semitones at the end, a = attack s, vd = vibrato delay s, c = consonant ('h' breath, 'd' plosive, 'y' glide in from “ee”). */
const VOX = [
  { n: 'Ooh', notes: [[0, 1.3, 0, ['o', 'u'], { g: -3, a: 0.09, vd: 0.35 }]] },
  { n: 'Aah', g: 1.5, notes: [[0, 1.4, 0, ['a'], { a: 0.05, vd: 0.3 }]] },
  { n: 'Hey!', notes: [[0, 0.3, 2, ['e', 'ae'], { c: 'h', f: -2, a: 0.01 }]] },
  { n: 'Yeah', notes: [[0, 0.45, 0, ['ae', 'e'], { c: 'y', f: -3, a: 0.012 }]] },
  { n: 'Oh yeah', notes: [[0, 0.4, 0, ['o', 'a'], { g: -2, a: 0.03 }], [0.44, 0.55, 2, ['ae', 'e'], { c: 'y', f: -4, a: 0.012 }]] },
  { n: 'Ah-ha', notes: [[0, 0.2, 0, ['a'], { a: 0.01 }], [0.24, 0.4, 2, ['a'], { c: 'h', f: -2, a: 0.01 }]] },
  { n: 'Whoa', notes: [[0, 0.95, 0, ['u', 'o', 'a'], { g: -5, f: -2, a: 0.04, vd: 0.25 }]] },
  { n: 'Mm', g: 0.6, notes: [[0, 1.2, 0, ['m'], { a: 0.1, vd: 0.3 }]] },
  { n: 'Uh!', g: 1.4, notes: [[0, 0.17, 0, ['uh'], { c: 'h', a: 0.006 }]] },
  { n: 'Run', g: 1.3, notes: [[0, 0.1, 4, ['a']], [0.1, 0.1, 2, ['a']], [0.2, 0.1, 3, ['a']], [0.3, 0.1, 2, ['a']], [0.4, 0.12, 1, ['a']], [0.52, 0.75, 0, ['a'], { vd: 0.15 }]] },
  { n: 'Ow', notes: [[0, 0.55, 2, ['a', 'o', 'u'], { f: -4, a: 0.012 }]] },
  { n: 'Doo', g: 0.8, notes: [[0, 0.32, 0, ['o'], { c: 'd', a: 0.006 }]] },
  { n: 'Oh-oh', g: 0.8, notes: [[0, 0.25, 2, ['o'], { a: 0.01 }], [0.3, 0.5, 0, ['o'], { f: -1, a: 0.01 }]] },
  { n: 'Fall', g: 0.8, notes: [[0, 0.95, 2, ['a', 'o'], { f: -7, vd: 0.2 }]] },
  { n: 'Rise', notes: [[0, 0.85, 0, ['o', 'a'], { g: -7, a: 0.1 }]] },
  { n: 'Choir', poly: true, notes: [[0, 1.5, 0, ['o', 'u'], { a: 0.14, vd: 0.4 }], [0, 1.5, 2, ['o', 'u'], { a: 0.14, vd: 0.5 }], [0, 1.5, 4, ['o', 'u'], { a: 0.14, vd: 0.45 }]] },
];
/** Root of the voice: the key note of the bar folded into one octave of an alto (≈ 175–350 Hz), then moved by the Register parameter. */
function voxRoot(oct, sh) { let f = noteFreq(S.key + rootSemi(sh) - 9); while (f < 175) f *= 2; while (f >= 350) f /= 2; return f * Math.pow(2, (oct || 4) - 4); }
const voxLen = (p) => Math.max(...VOX[(p.gest ?? S.vgest ?? 0) | 0].notes.map((n) => n[0] + n[1])) * ((p.length || 100) / 100) + 0.12;
function voxNote(ctx, out, t0, d, f, vs, o, p, amp) {
  const osc = ctx.createOscillator(); osc.type = 'sawtooth';
  const g0 = o.g || 0, fl = o.f || 0, ramp = Math.min(0.14, d * 0.45);
  osc.frequency.setValueAtTime(f * Math.pow(2, g0 / 12), t0);
  if (g0) osc.frequency.exponentialRampToValueAtTime(f, t0 + ramp);
  if (fl) { osc.frequency.setValueAtTime(f, t0 + d * 0.5); osc.frequency.exponentialRampToValueAtTime(f * Math.pow(2, fl / 12), t0 + d); }
  const lfo = ctx.createOscillator(); lfo.frequency.value = 5.3 + Math.random() * 0.5; const vg = ctx.createGain(); // vibrato: grows after a short delay, like a real singer
  vg.gain.setValueAtTime(0, t0); vg.gain.setValueAtTime(0, t0 + (o.vd ?? 0.2)); vg.gain.linearRampToValueAtTime((p.vibrato / 100) * 38, t0 + (o.vd ?? 0.2) + 0.35);
  lfo.connect(vg).connect(osc.detune); lfo.start(t0); lfo.stop(t0 + d + 0.25);
  const src = ctx.createGain(); src.gain.value = 1; osc.connect(src);
  if (p.breath > 0) { const ng = ctx.createGain(); ng.gain.value = (p.breath / 100) * 0.9; noiseSrc(ctx, t0, d + 0.2).connect(ng).connect(src); }
  if (o.c === 'h') { const ng = ctx.createGain(); ng.gain.setValueAtTime(1.6, t0); ng.gain.exponentialRampToValueAtTime(0.01, t0 + 0.06); noiseSrc(ctx, t0, 0.1).connect(ng).connect(src); }
  const env = ctx.createGain(), att = o.a ?? 0.04, PK = amp;
  env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(PK, t0 + att);
  env.gain.setValueAtTime(PK, t0 + Math.max(att + 0.001, d - 0.06)); env.gain.exponentialRampToValueAtTime(0.0005, t0 + d + 0.12);
  if (o.c === 'd') { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900; const cg = ctx.createGain(); cg.gain.setValueAtTime(0.9, t0); cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.02); noiseSrc(ctx, t0, 0.03).connect(hp).connect(cg).connect(out); }
  const seq = o.c === 'y' ? ['i', ...vs] : vs, tEnd = t0 + d * 0.8; // the formants glide from vowel to vowel
  for (let k = 0; k < 4; k++) {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; const ag = ctx.createGain();
    seq.forEach((v, j) => {
      const V = VOWELS[v], tj = seq.length === 1 ? t0 : t0 + (tEnd - t0) * (j / (seq.length - 1)) * (o.c === 'y' && j === 1 ? 0.25 : 1);
      const fq = V.f[k], q = fq / V.b[k], gl = Math.pow(10, V.a[k] / 20);
      if (j === 0) { bp.frequency.setValueAtTime(fq, t0); bp.Q.setValueAtTime(q, t0); ag.gain.setValueAtTime(gl, t0); }
      else { bp.frequency.linearRampToValueAtTime(fq, tj); bp.Q.linearRampToValueAtTime(q, tj); ag.gain.linearRampToValueAtTime(gl, tj); }
    });
    src.connect(bp).connect(ag).connect(env);
  }
  env.connect(out); osc.start(t0); osc.stop(t0 + d + 0.2);
}

const VOX_GAIN = 1.8; // output level of the voices (the band-pass filters remove most of the sawtooth energy: this brings them next to the other pads)
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
    if (p.wah > 0) return wahChord(ctx, out, t, p, row, sh);
    const t60 = p.decay / 1000;
    [0, 2, 4, 6, 8].slice(0, 3 + S.ext).forEach((k, n) => string(ctx, out, t + n * p.strum / 1000, rowFreq(row + k, p.octave, sh), t60, p.bright / 100, 0.42 * Math.pow(3 / (3 + S.ext), 0.5)));
  },
  pluck(ctx, out, t, p, row = 0, dur = 0, sh = 0) { string(ctx, out, t, rowFreq(row, p.octave, sh), p.decay / 1000, p.bright / 100, 0.8); },
  tom(ctx, out, t, p) {
    const d = p.decay / 1000, o = ctx.createOscillator();
    o.frequency.setValueAtTime(p.pitch * 1.7, t); o.frequency.exponentialRampToValueAtTime(p.pitch, t + 0.07);
    o.connect(env(ctx, t, 0.8, d)).connect(out); o.start(t); o.stop(t + d + 0.06);
  },
  rim(ctx, out, t, p) {
    const d = p.decay / 1000, o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = p.tone;
    o.connect(env(ctx, t, 0.5, d)).connect(out); o.start(t); o.stop(t + d + 0.05);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1.5;
    noiseSrc(ctx, t, d).connect(bp).connect(env(ctx, t, 0.6, d)).connect(out);
  },
  crash(ctx, out, t, p) {
    const d = p.decay / 1000, hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.hp;
    noiseSrc(ctx, t, d).connect(hp).connect(env(ctx, t, 0.55, d)).connect(out);
  },
  keys(ctx, out, t, p, row = 0, dur = 0.4) { keyVoice(ctx, out, t, p, row >= 24 ? row : 60, dur); }, // row = MIDI note (60 when the lab plays it)
  arp(ctx, out, t, p, row = 0, dur = 0, sh = 0) {
    const d = p.decay / 1000, o = ctx.createOscillator(); setWave(ctx, o, p.wave); o.frequency.value = rowFreq(row, p.octave, sh);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(Math.min(p.cutoff * 3, 16000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(120, p.cutoff * 0.5), t + Math.min(d, 0.12));
    o.connect(lp).connect(env(ctx, t, 0.45, d)).connect(out); o.start(t); o.stop(t + d + 0.06);
  },
  vox(ctx, out, t, p, row = 0, dur = 0, sh = 0) {
    const G = VOX[(p.gest ?? S.vgest ?? 0) | 0] || VOX[0], sc = (p.length || 100) / 100, root = voxRoot(p.octave, sh), amp = VOX_GAIN * (G.g || 1) / (G.poly ? Math.pow(G.notes.length, 0.75) : 1);
    for (const [dt, d0, dr, vs, o = {}] of G.notes) voxNote(ctx, out, t + dt * sc, d0 * sc, root * Math.pow(2, semis(row + dr) / 12), vs, o, p, amp);
  },
  bass(ctx, out, t, p, row = 0, dur = 0.4, sh = 0) {
    const d = p.decay / 1000, sus = Math.max(0.001, p.sustain / 100), end = t + Math.max(0.03, dur), PK = 0.85 * (p.gain ?? 1), A0 = 0.004;
    const o = ctx.createOscillator(); setWave(ctx, o, p.wave); o.frequency.value = bassFreq(row, p.octave, sh);
    const ws = ctx.createWaveShaper(); ws.curve = driveCurve(p.drive); ws.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = p.reso;
    lp.frequency.setValueAtTime(Math.min(p.cutoff * 4, 18000), t); lp.frequency.exponentialRampToValueAtTime(Math.max(60, p.cutoff), t + Math.min(d, 0.25));
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(PK, t + A0);
    let level; // ADSR: attack, exponential decay to the sustain level, hold, release
    if (end >= t + A0 + d) { level = PK * sus; g.gain.exponentialRampToValueAtTime(level, t + A0 + d); g.gain.setValueAtTime(level, end); }
    else { level = PK * Math.pow(sus, (end - t - A0) / d); g.gain.exponentialRampToValueAtTime(Math.max(0.0005, level), end); }
    g.gain.exponentialRampToValueAtTime(0.0005, end + REL);
    o.connect(ws).connect(lp).connect(g).connect(out); o.start(t); o.stop(end + REL + 0.05);
    for (const [h, amt] of [[2, p.up], [3, p.up3]]) if (amt > 0) { const o2 = ctx.createOscillator(), g2 = ctx.createGain(); o2.frequency.value = h * bassFreq(row, p.octave, sh); g2.gain.value = amt / 100; o2.connect(g2).connect(lp); o2.start(t); o2.stop(end + REL + 0.05); } // an octave up, sine: makes the note audible on small speakers
  },
};
VOICES.kchord = VOICES.arp; VOICES.klow = VOICES.arp;
VOICES.ohat = VOICES.hat; // same noise, other parameters (longer decay)
function playSound(ctx, out, id, t, row = 0, dur = 0.4, vel = 1, sh = 0, over = null) {
  let dest = out;
  if (vel !== 1) { dest = ctx.createGain(); dest.gain.value = vel; dest.connect(out); }
  VOICES[id](ctx, dest, t, over ? { ...S.params[id], ...over } : S.params[id], row, dur, sh);
}

/** How long (s) a sound lasts, for the Sound lab time axis. */
function soundLength(id, p) {
  const ms = id === 'bass' ? 450 + REL * 1000 : id === 'keys' ? 450 + p.release : id === 'clap' ? p.decay + 33 : id === 'cow' ? p.decay + 30 : id === 'chank' ? Math.max(p.decay, 90) + 40
    : id === 'chord' ? p.decay + 3 * p.strum : id === 'vox' ? voxLen(p) * 1000 : p.decay;
  return Math.min(1.8, Math.max(0.1, ms / 1000 + 0.06));
}

// ---------------------------------------------------------------- loops: slots and ready-made clips (like the remix decks of a DJ program)
const SLOTS = [['drums', 'Drums'], ['bass', 'Bass'], ['guitar', 'Guitar'], ['kchords', 'Chords'], ['klow', 'Low'], ['keys', 'Arp']]; // the three Keys layers play together
const SLOT_OF = TRACKS.map((tr) => ({ arp: 'keys', kchord: 'kchords', klow: 'klow' }[tr.id] || (tr.group === 'gtr' ? 'guitar' : 'drums')));
const R16 = (str) => Array.from(str, (c) => +c);
const EMPTY16 = Array(STEPS).fill(0), NOBASS = { b: Array(STEPS).fill(-1), l: Array(STEPS).fill(1) };
/** A clip of 4 bars: `rows` = patterns by track id (16 digits: 0 off, 1 hit, 2 ghost, 3 roll ×2, 4 roll ×3); the 4th bar can be a fill. */
function padClip(id, name, rows, extra = {}, fill = false) {
  const bar = (r) => TRACKS.map((tr) => (r[tr.id] ? R16(r[tr.id]) : null));
  const last = fill ? { ...rows, snare: (rows.snare || '0000000000000000').slice(0, 12) + '1313', kick: (rows.kick || '0000000000000000').slice(0, 15) + '0' } : rows;
  return { id, name, slot: SLOT_OF[TRACKS.findIndex((t) => rows[t.id])], bars: [bar(rows), bar(rows), bar(rows), bar(last)], ...extra };
}
function bassClipN(id, name, lists, sound) { // a bass loop that changes every bar (a walking line)
  return { id, name, slot: 'bass', sound, bars: Array.from({ length: 4 }, (_, i) => bassFrom(lists[i % lists.length])) }; // fewer than 4 variations: they repeat
}
function bassClip(id, name, list, sound) {
  const o = bassFrom(list); return { id, name, slot: 'bass', sound, bars: [o, o, o, o] };
}
const CLIPS = {
  drums: [
    padClip('d-house', 'House', { kick: '1000100010001000', hat: '1212121212121212', ohat: '0010001000100010', clap: '0000100000001000' }, { bpm: 124, swing: 0 }, true),
    padClip('d-hiphop', 'Hip-hop', { kick: '1000001001100000', snare: '0000100000001000', hat: '1212121212121212', ohat: '0000000000000010' }, { bpm: 90, swing: 18 }, true),
    padClip('d-trap', 'Trap', { kick: '1000000001000010', snare: '0000000010000000', hat: '1212121312121242', ohat: '0000000000000010', clap: '0000000010000000' }, { bpm: 140, swing: 0 }, true),
    padClip('d-funk', 'Funk', { kick: '1001001000100010', snare: '0200100200201002', hat: '1212121212121212', ohat: '0000001000000010' }, { bpm: 102, swing: 12 }, true),
    padClip('d-break', 'Breakbeat', { kick: '1000000010100000', snare: '0000100000001001', hat: '1010101010101010', clap: '0000000000000100' }, { bpm: 130, swing: 0 }, true),
    padClip('d-dembow', 'Reggaeton', { kick: '1000100010001000', snare: '0001001000010010', hat: '1212121212121212', cow: '0000000000001000' }, { bpm: 95, swing: 0 }, true),
    padClip('d-techno', 'Techno', { kick: '1000100010001000', clap: '0000100000001000', ohat: '0010001000100010', hat: '0101010101010101' }, { bpm: 128, swing: 0 }, true),
    padClip('d-disco', 'Disco', { kick: '1000100010001000', snare: '0000100000001000', ohat: '0010001000100010', hat: '1010101010101010' }, { bpm: 118, swing: 0 }, true),
    padClip('d-lofi', 'Lo-fi', { kick: '1000000100100000', snare: '0000100000001000', hat: '1212121212121212' }, { bpm: 78, swing: 25 }, true),
    padClip('d-dnb', 'Drum & bass', { kick: '1000000000100000', snare: '0000100200001020', hat: '1010101010101010', ohat: '0000000000000010' }, { bpm: 172, swing: 0 }, true),
    padClip('d-jungle', 'Jungle (Amen-style)', { kick: '1010000000110000', snare: '0000100201201000', hat: '1010101010101010' }, { bpm: 160, swing: 0 }, true),
    padClip('d-garage', 'UK garage', { kick: '1000000100100000', snare: '0000100200101000', hat: '1212121212121212', ohat: '0000001000000010' }, { bpm: 132, swing: 28 }, true),
    padClip('d-drill', 'UK drill', { kick: '1000000100100000', snare: '0000000010000000', hat: '1213121212131213' }, { bpm: 142, swing: 0 }, true),
    padClip('d-reggae', 'Reggae one-drop', { kick: '0000000010000000', snare: '0000000010000000', hat: '1010101010101010', ohat: '0000000000000010' }, { bpm: 76, swing: 20 }, true),
    padClip('d-dub', 'Dubstep half-time', { kick: '1000000000100000', snare: '0000000010000000', hat: '0010001000100010' }, { bpm: 140, swing: 0 }, true),
    padClip('d-trance', 'Trance', { kick: '1000100010001000', clap: '0000100000001000', ohat: '0010001000100010', hat: '1212121212121212' }, { bpm: 138, swing: 0 }, true),
    padClip('d-break92', 'Boom-bap break 92', { kick: '1010000001100000', snare: '0200100200201000', hat: '1212121212121212', ohat: '0000000000000010' }, { bpm: 92, swing: 8 }, true),
    padClip('d-lazy95', 'Lazy swing 95', { kick: '1000000100100000', snare: '0000100000001000', hat: '1010101010101010', ohat: '0000000000000010' }, { bpm: 95, swing: 22 }, true),
    padClip('d-cosmic', 'Cosmic funk 104', { kick: '1000100010010001', snare: '0200100200201000', hat: '1212121212121212', ohat: '0000000000100000', cow: '0000000010000000' }, { bpm: 104, swing: 6 }, true),
    padClip('d-deep130', 'Deep house 130', { kick: '1000100010001000', clap: '0000100000001000', hat: '0212021202120212', ohat: '0010001000100010' }, { bpm: 130, swing: 0 }, true),
    padClip('d-brush', 'Brushes soft · half-time', { kick: '2000000000100000', rim: '0000000010000000', snare: '0000200000002000', hat: '1000100210001002' }, { bpm: 116, swing: 30 }),
    padClip('d-clave', 'Salsa clave 3-2', { kick: '0000100000001000', cow: '1001001000101000', hat: '1010101010101010' }, { bpm: 100, swing: 0 }, true),
    padClip('d-rock', 'Rock', { kick: '1000001010100000', snare: '0000100000001000', hat: '1010101010101010' }, { bpm: 110, swing: 0 }, true),
    padClip('d-afro', 'Afrobeat', { kick: '1000001000100100', snare: '0000100000001000', hat: '1212121212121212', cow: '1001001000101000' }, { bpm: 105, swing: 10 }, true),
    padClip('d-soul', 'Soul backbeat', { kick: '1000000100100000', snare: '0000100000001000', hat: '1010101010101010', ohat: '0000000000000010' }, { bpm: 92, swing: 15 }, true),
    padClip('d-motown', 'Motown', { kick: '1000100010001000', snare: '0000100000001000', hat: '1111111111111111' }, { bpm: 112, swing: 0 }, true),
    padClip('d-jazz', 'Jazz swing', { kick: '2000200020002000', hat: '1000101010001010', snare: '0000000020000000' }, { bpm: 124, swing: 30 }, false),
    padClip('d-bossa', 'Bossa nova', { kick: '1000001010000010', cow: '1001001000101000', hat: '1010101010101010' }, { bpm: 128, swing: 0 }, false),
    padClip('d-afrohouse', 'Afro house', { kick: '1000100010001000', ohat: '0010001000100010', hat: '0101010101010101', cow: '0010010010010010' }, { bpm: 122, swing: 8 }, false),
    padClip('d-steppers', 'Reggae steppers', { kick: '1000100010001000', snare: '0000000010000000', hat: '0010001000100010' }, { bpm: 80, swing: 20 }, true),
  ],
  bass: [
    bassClipN('b-jazzwalk', 'Jazz walking', [[[0, 0, 4], [4, 2, 4], [8, 4, 4], [12, 3, 4]], [[0, 4, 4], [4, 3, 4], [8, 2, 4], [12, 1, 4]], [[0, 0, 4], [4, 1, 4], [8, 2, 4], [12, 4, 4]], [[0, 3, 4], [4, 2, 4], [8, 1, 4], [12, 4, 4]]], 'Soft'),
    bassClip('b-dnb', 'DnB two-step sub', [[0, 0, 9], [10, 0, 2], [12, 3, 2], [14, 2, 2]], '808 sub'),
    bassClip('b-walk', 'Walking', [[0, 0, 2], [2, 2, 2], [4, 3, 2], [6, 4, 2], [8, 3, 2], [10, 2, 2], [12, 0, 2], [14, 2, 2]], 'Soft'),
    bassClip('b-demb', 'Reggaeton', [[0, 0, 3], [6, 0, 2], [8, 0, 3], [14, 0, 2]], '808 sub'),
    bassClip('b-lofi', 'Lo-fi', [[0, 0, 4], [6, 2, 2], [10, 0, 3]], 'Soft'),
    bassClip('b-jungle', 'Jungle sub', [[0, 0, 6], [8, 0, 4], [12, 3, 4]], '808 sub'),
    bassClip('b-gospel', 'Gospel bass', [[0, 0, 4], [6, 0, 2], [8, 4, 4], [14, 3, 2]], 'Soft'),
    bassClipN('b-subslow', 'Sub slow', [[[8, 0, 4]], [[8, 0, 4]], [[8, 0, 4], [13, 2, 2]], [[6, 2, 2], [8, 0, 4], [12, 3, 3]]], 'Sub+'),
    bassClipN('b-rootb3', 'Root & third', [[[0, 0, 4], [4, 2, 2], [6, 0, 2], [8, 0, 4], [12, 3, 2], [14, 0, 2]], [[0, 0, 4], [4, 2, 2], [6, 0, 2], [8, 0, 4], [12, 4, 2], [14, 3, 2]]], 'Round'),
    bassClipN('b-funkleg', 'Funk legato', [[[0, 0, 2], [2, 2, 1], [3, 0, 2], [6, 3, 1], [7, 4, 2], [10, 2, 1], [11, 0, 2], [13, 2, 1], [14, 3, 2]], [[0, 0, 2], [2, 0, 1], [3, 2, 2], [6, 3, 1], [7, 2, 2], [10, 0, 1], [11, 4, 2], [13, 3, 1], [14, 2, 2]]], 'Finger'),
    bassClipN('b-rolling', 'Rolling', [[[0, 0, 3], [3, 0, 1], [4, 2, 2], [6, 3, 2], [8, 0, 3], [11, 4, 1], [12, 3, 2], [14, 2, 1], [15, 3, 1]], [[0, 0, 3], [3, 0, 1], [4, 2, 2], [6, 3, 2], [8, 4, 3], [11, 3, 1], [12, 2, 2], [14, 0, 1], [15, 2, 1]]], 'Finger'),
    bassClipN('b-soulline', 'Soul line', [[[0, 0, 4], [4, 2, 2], [6, 3, 2], [8, 4, 3], [11, 3, 1], [12, 2, 2], [14, 0, 2]], [[0, 0, 4], [4, 2, 2], [6, 0, 2], [8, 3, 3], [11, 2, 1], [12, 0, 4]]], 'Sub+'),
    bassClipN('b-warm', 'Warm long notes', [[[0, 0, 12], [12, 4, 3]], [[0, 0, 16]], [[0, 0, 8], [8, 4, 8]], [[0, 0, 12], [12, 2, 4]]], 'Warm'),
    bassClip('b-neosoul', 'Neo-soul', [[0, 0, 3], [3, 0, 1], [6, 2, 2], [10, 0, 2], [12, 3, 3]], 'Soft'),
  ],
  guitar: [
    padClip('g-scratch', 'Funk scratch', { chank: '0101101001011010' }),
    padClip('g-skank', 'Off-beat skank', { chord: '0010001000100010' }),
    padClip('g-stabs', 'Stabs', { chord: '1000001000100000', chank: '0000100000001000' }),
    padClip('g-riff', 'Pluck riff', { pluck: '1001001010010010' }),
    padClip('g-muted', 'Muted 16ths', { chank: '1111111111111111' }),
    padClip('g-disco', 'Disco chops', { chank: '1011101110111011' }),
    padClip('g-long', 'Chord on 1', { chord: '1000000000000000' }),
    padClip('g-demb', 'Reggaeton stabs', { chord: '1001001000100010' }),
    padClip('g-combo', 'Scratch + stab', { chank: '0101101001011010', chord: '0000001000000010' }),
    padClip('g-soul', 'Soul chops', { chord: '1000001000001000', chank: '0010000100100010' }),
    padClip('g-motown', 'Motown stabs', { chord: '1001001000100100' }),
    padClip('g-chic', 'Funk 16th chops', { chank: '1101101011011010', chord: '1000000010000000' }),
    padClip('g-gospel', 'Gospel chords', { chord: '1000001010000010' }),
    padClip('g-roots', 'Roots skank', { chord: '0010000000100000', chank: '0000100000001000' }),
    padClip('g-pulse', 'Chord pulse', { chord: '1000100010001000' }),
    padClip('g-charleston', 'Jazz Charleston', { chord: '1000001000000000' }),
    padClip('g-wahfunk', 'Wah chord · funk', { chord: '1000000010000000' }, { sound: { wah: 1, hold: 2, vib: 18, octave: 3 } }),
    padClip('g-wahlfo', 'Wah chord · slow LFO', { chord: '1000000010000000' }, { sound: { wah: 2, hold: 2, vib: 26, octave: 3 } }),
    padClip('g-half', 'Chord on 1 & 3', { chord: '1000000010000000' }),
  ],
  keys: [
    padClip('k-jazz', 'Jazz Charleston', { arp: '1000001000000000' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 3, cutoff: 2400, decay: 420 } }),
    padClip('k-lowslow', 'Low walk · slow', { arp: '1000100010001000' }, { arp: { mode: 'updown', n: 3, oct: 1 }, sound: { wave: 'triangle', octave: 2, cutoff: 1000, decay: 420 } }),
    padClip('k-lowup', 'Low walk · up', { arp: '1010101010101010' }, { arp: { mode: 'up', n: 4, oct: 1 }, sound: { wave: 'sine', octave: 2, cutoff: 900, decay: 240 } }),
    padClip('k-lowfill', 'Low fill (soft)', { arp: '1111111111111111' }, { arp: { mode: 'updown', n: 3, oct: 1 }, sound: { wave: 'sine', octave: 2, cutoff: 600, decay: 150 } }),
    padClip('k-lowjazz', 'Low jazz walk', { arp: '1000100010001000' }, { arp: { mode: 'up', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 2, cutoff: 1100, decay: 380 } }),
    padClip('k-up', 'Arp 16ths', { arp: '1111111111111111' }, { arp: { mode: 'up', n: 3, oct: 2 } }),
    padClip('k-ud', 'Up-down 8ths', { arp: '1010101010101010' }, { arp: { mode: 'updown', n: 4, oct: 1 } }),
    padClip('k-gate', 'Trance gate', { arp: '1212121212121212' }, { arp: { mode: 'updown', n: 3, oct: 2 } }),
    padClip('k-down', 'Down 16ths', { arp: '1111111111111111' }, { arp: { mode: 'down', n: 3, oct: 2 } }),
    padClip('k-wide', 'Wide 3 octaves', { arp: '1010101010101010' }, { arp: { mode: 'up', n: 3, oct: 3 } }),
    padClip('k-pulse', 'Chord pulse', { arp: '1000100010001000' }, { arp: { mode: 'up', n: 4, oct: 1 } }),
    padClip('k-off', 'Offbeat arp', { arp: '0010001000100010' }, { arp: { mode: 'up', n: 3, oct: 2 } }),
    padClip('k-rand', 'Sparkle', { arp: '1001010010100100' }, { arp: { mode: 'random', n: 4, oct: 2 } }),
    padClip('k-organ', 'Low organ chords', { arp: '1000000010000000' }, { arp: { mode: 'chord', n: 3, oct: 1 }, sound: { wave: 'square', octave: 3, cutoff: 1400, decay: 900 } }),
    padClip('k-beachpiano', 'Soft piano comping', { arp: '1000000100000000' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 4, cutoff: 3200, decay: 1500 } }),
    padClip('k-beachpad', 'Soft pad', { arp: '1000000000000000' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 4, cutoff: 1800, decay: 3300 } }),
    padClip('k-pad', 'Pad (long chords)', { arp: '1000000000000000' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 3, cutoff: 1800, decay: 2300 } }),
    padClip('k-soul', 'Soul stabs', { arp: '1001001000100000' }, { arp: { mode: 'chord', n: 3, oct: 1 }, sound: { wave: 'square', octave: 3, cutoff: 2200, decay: 160 } }),
    padClip('k-rhodes', 'Rhodes comping', { arp: '1001000100100010' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'triangle', octave: 3, cutoff: 2600, decay: 520 } }),
    padClip('k-motown', 'Motown piano 8ths', { arp: '1010101010101010' }, { arp: { mode: 'chord', n: 3, oct: 1 }, sound: { wave: 'triangle', octave: 3, cutoff: 3000, decay: 230 } }),
    padClip('k-gospel', 'Gospel organ swell', { arp: '1000000000001000' }, { arp: { mode: 'chord', n: 4, oct: 1 }, sound: { wave: 'sawtooth', octave: 3, cutoff: 1500, decay: 1400 } }),
    padClip('k-bubble', 'Reggae bubble', { arp: '0010010100100101' }, { arp: { mode: 'chord', n: 3, oct: 1 }, sound: { wave: 'square', octave: 3, cutoff: 1800, decay: 100 } }),
    padClip('k-root', 'Low root pulse', { arp: '1010101010101010' }, { arp: { mode: 'root', n: 3, oct: 1 }, sound: { wave: 'sawtooth', octave: 2, cutoff: 700, decay: 200 } }),
    padClip('k-drone', 'Sub drone', { arp: '1000000000000000' }, { arp: { mode: 'root', n: 3, oct: 1 }, sound: { wave: 'sine', octave: 2, cutoff: 600, decay: 2500 } }),
    padClip('k-fifths', 'Low fifths', { arp: '1000100010001000' }, { arp: { mode: 'fifths', n: 3, oct: 1 }, sound: { wave: 'sawtooth', octave: 2, cutoff: 900, decay: 320 } }),
    padClip('k-oct', 'Octave bounce', { arp: '1010101010101010' }, { arp: { mode: 'oct', n: 3, oct: 1 }, sound: { wave: 'square', octave: 2, cutoff: 1000, decay: 180 } }),
    padClip('k-lowwalk', 'Low walk', { arp: '1010101010101010' }, { arp: { mode: 'updown', n: 3, oct: 1 }, sound: { wave: 'triangle', octave: 2, cutoff: 1100, decay: 260 } }),
  ],
};
// the keys loops go to three slots that play together: chords, low and static lines, arpeggios
const KGRP = Object.fromEntries([['Chords', ['k-organ', 'k-pad', 'k-beachpiano', 'k-soul', 'k-rhodes', 'k-motown', 'k-gospel', 'k-bubble', 'k-jazz']],
  ['Low', ['k-lowwalk', 'k-lowslow', 'k-lowup', 'k-lowjazz', 'k-beachpad', 'k-lowfill', 'k-root', 'k-drone', 'k-fifths', 'k-oct']]].flatMap(([g, ids]) => ids.map((i) => [i, g])));
function retarget(c, trackId, slot) { // the clip was written for the 'arp' row: move it to the row of its layer
  const ia = TRACKS.findIndex((t) => t.id === 'arp'), it = TRACKS.findIndex((t) => t.id === trackId);
  c.bars = c.bars.map((bar) => bar.map((row, i) => (i === it ? bar[ia] : i === ia ? null : row))); c.slot = slot;
}
{
  const all = CLIPS.keys, ord = Object.keys(KGRP); CLIPS.keys = []; CLIPS.kchords = []; CLIPS.klow = [];
  for (const c of all) { const g = KGRP[c.id]; if (g === 'Chords') { retarget(c, 'kchord', 'kchords'); CLIPS.kchords.push(c); } else if (g === 'Low') { retarget(c, 'klow', 'klow'); CLIPS.klow.push(c); } else CLIPS.keys.push(c); }
  CLIPS.kchords.sort((a, b) => ord.indexOf(a.id) - ord.indexOf(b.id)); CLIPS.klow.sort((a, b) => ord.indexOf(a.id) - ord.indexOf(b.id));
}
const grpHead = () => '';
const CLIP_BY_ID = Object.fromEntries(Object.values(CLIPS).flat().map((c) => [c.id, c]));
/** SL[slot].cur = what plays now ('mine' = your own step pattern, null = silent); .next = queued for the next bar line (undefined = no change). */
const SL = Object.fromEntries(SLOTS.map(([k]) => [k, { cur: null, next: undefined }]));
// The two live loops (Pads, Keys) also have a lane in the Song: 'live' = the loop you are recording, an id = a block you saved, null = silent
const LIVE_LANES = ['lpads', 'lkeys'], LANES = [...SLOTS, ['lpads', 'Pads'], ['lkeys', 'Keys']];
for (const k of LIVE_LANES) SL[k] = { cur: 'live', next: undefined };
const LIB = (() => { const v = store.get('lib1', null) || {}, ok = (a) => (Array.isArray(a) ? a.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.ev)) : []); return { lpads: ok(v.lpads), lkeys: ok(v.lkeys) }; })();
CLIPS.lpads = LIB.lpads; CLIPS.lkeys = LIB.lkeys; for (const c of [...LIB.lpads, ...LIB.lkeys]) CLIP_BY_ID[c.id] = c;
const liveEv = (lane) => { const c = SL[lane].cur; if (c === 'live') return lane === 'lpads' ? S.ploop.ev : S.kloop.ev; const x = c && CLIP_BY_ID[c]; return x ? x.ev : []; };
function saveLive(lane) { // keep the loop you recorded as a block of the Song timeline
  const src = lane === 'lpads' ? S.ploop.ev : S.kloop.ev, label = lane === 'lpads' ? 'Pad loop' : 'Keys loop', arr = LIB[lane]; if (!src.length) { $('#status').textContent = 'Nothing recorded yet: press Rec first'; return; }
  const n = 1 + Math.max(0, ...arr.map((c) => +(c.name.match(/(\d+)$/) || [0, 0])[1])), c = { id: `u-${lane}-${Date.now().toString(36)}${arr.length}${Math.floor(Math.random() * 1296).toString(36)}`, name: `${label} ${n}`, lane, ev: src.map((e) => ({ ...e })) };
  arr.push(c); CLIP_BY_ID[c.id] = c; store.set('lib1', LIB); $('#status').textContent = `Saved as “${c.name}”: place it in Song › ${lane === 'lpads' ? 'Pads' : 'Keys'}`;
}
const libOp = {
  rename(id, name) { const c = CLIP_BY_ID[id]; if (c && c.ev && name) { c.name = String(name).slice(0, 24); store.set('lib1', LIB); } },
  remove(id) { const c = CLIP_BY_ID[id]; if (!c || !c.lane) return; const a = LIB[c.lane], i = a.indexOf(c); if (i >= 0) a.splice(i, 1); delete CLIP_BY_ID[id]; for (const k of LIVE_LANES) if (SL[k].cur === id) SL[k].cur = 'live'; store.set('lib1', LIB); },
};
// every visit starts with everything off: you add one instrument at a time
S.mute.keys = true; S.mute.pads = true; // the loops you recorded earlier are kept but start muted (M on Keys, the button on Pads)
let loopsDirty = true;
const useMine = (slot) => { if (SL[slot].cur !== 'mine') { SL[slot].cur = 'mine'; SL[slot].next = undefined; loopsDirty = true; } };
const ARP_DEF = { arp: { wave: 'sawtooth', octave: 4, cutoff: 2500, decay: 220 }, kchord: { wave: 'square', octave: 3, cutoff: 1800, decay: 600 }, klow: { wave: 'triangle', octave: 2, cutoff: 1000, decay: 300 } };
const SLOT_TRACK = { keys: 'arp', kchords: 'kchord', klow: 'klow' };
function clipExtras(slot, id) { // what a clip changes besides the notes
  const c = CLIP_BY_ID[id]; if (!c) return;
  if (slot === 'bass' && c.sound) Object.assign(S.params.bass, BASS_SOUNDS[c.sound]);
  if (slot === 'guitar') { // a guitar clip with a sound (wah chord) sets the chord voice; the others give the normal chord back
    const pc = S.params.chord;
    if (c.sound) Object.assign(pc, c.sound, { fromClip: true });
    else if (pc.fromClip) { Object.assign(pc, Object.fromEntries(SOUNDS.find((x) => x.id === 'chord').params.map((q) => [q.k, q.def]))); delete pc.fromClip; }
  }
  const tid = SLOT_TRACK[slot];
  if (tid && c.arp) {
    S.arps[tid] = { ...S.arps[tid], ...c.arp };
    const pa = S.params[tid]; // clips with a sound (low organ, drone…) set it; the others give the default sound back
    if (c.sound) Object.assign(pa, ARP_DEF[tid], c.sound, { fromClip: true });
    else if (pa.fromClip) { Object.assign(pa, ARP_DEF[tid]); delete pa.fromClip; }
  }
}
/** The Step grid always shows the loop that is playing: launching a loop copies it into the grid, ready to edit. */
let stepDirty = true, syncDirty = false, pendScene = null; // pendScene: key, scale and chords of a scene wait for the next bar line, like the loops
const lastClip = {};
function copyToMine(slot, id) {
  const c = CLIP_BY_ID[id]; if (!c) return;
  if (slot === 'bass') { S.bass = [...c.bars[0].b]; S.bl = [...c.bars[0].l]; }
  else TRACKS.forEach((tr, ti) => { if (SLOT_OF[ti] === slot) S.pat[ti] = c.bars[0][ti] ? [...c.bars[0][ti]] : Array(STEPS).fill(0); });
  stepDirty = true;
}
function patAt(ti, st, b) {
  const sl = SL[SLOT_OF[ti]]; if (!sl.cur) return 0;
  if (sl.cur === 'mine') return S.pat[ti][st];
  const c = CLIP_BY_ID[sl.cur], row = c.bars[b % c.bars.length][ti]; return row ? row[st] : 0;
}
function bassOf(b) { const sl = SL.bass; if (!sl.cur) return NOBASS; return sl.cur === 'mine' ? { b: S.bass, l: S.bl } : CLIP_BY_ID[sl.cur].bars[b % 4]; }

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
const arpIdx = { arp: 0, kchord: 0, klow: 0 }; // position in each arpeggio; restarts every bar so that the bar repeats exactly
const resetArp = () => { for (const k in arpIdx) arpIdx[k] = 0; };
/** Rows (scale notes) of the arpeggio: a chord stacked in thirds on row r, over `oct` octaves, in the chosen order. */
function arpPool(r, a) {
  const len = SCALES[S.scale].length, pool = [];
  if (a.mode === 'scale' || a.mode === 'scaledown' || a.mode === 'scaleud') { // runs up/down the notes of the chosen scale, one degree at a time
    for (let k = 0; k < a.n * a.oct; k++) pool.push(r + k);
    if (a.mode === 'scaledown') pool.reverse(); else if (a.mode === 'scaleud' && pool.length > 2) pool.push(...pool.slice(1, -1).reverse());
    return pool;
  }
  if (a.mode === 'root') return [r];                          // static: always the bass note
  if (a.mode === 'fifths') return [r, r + 4];                  // root and fifth (4 scale steps up), like a two-note bass line
  if (a.mode === 'oct') return [r, r + len];                   // root and its octave
  for (let o = 0; o < a.oct; o++) for (let k = 0; k < a.n; k++) pool.push(r + 2 * k + o * len);
  if (a.mode === 'down') pool.reverse();
  else if (a.mode === 'updown' && pool.length > 2) pool.push(...pool.slice(1, -1).reverse());
  return pool;
}
let curBass = NOBASS, curCov = Array(STEPS).fill(-1);
const rowAtP = (i) => (curCov[i] >= 0 ? curCov[i] : 0);
function arpNote(st, id) {
  const cfg = S.arps[id], pool = arpPool(rowAtP(st), cfg);
  return cfg.mode === 'random' ? pool[Math.floor(Math.random() * pool.length)] : pool[arpIdx[id]++ % pool.length];
}
function tick() {
  const sd = 60 / S.bpm / 4;
  while (nextT < A.ctx.currentTime + LOOKAHEAD) {
    if (step === 0) { // bar line: queued clips enter here, always on time
      if (bar === 0) cycleT0 = nextT; // start of the 4-bar cycle: the recorders measure positions from here
      if (xrec) recBar(nextT);
      if (pendScene) { Object.assign(S, pendScene); pendScene = null; syncDirty = true; }
      if (bar === 0) song.cycle(nextT);   // the Song timeline queues the loops of the next 4-bar cycle
      for (const [k] of SLOTS) { const sl = SL[k]; if (sl.next !== undefined) { sl.cur = sl.next; sl.next = undefined; loopsDirty = true; if (sl.cur && sl.cur !== 'mine') { clipExtras(k, sl.cur); copyToMine(k, sl.cur); } } }
      for (const k of LIVE_LANES) { const sl = SL[k]; if (sl.next !== undefined) { sl.cur = sl.next; sl.next = undefined; } }
      curBass = bassOf(bar); curCov = coverOf(curBass.b, curBass.l);
    }
    const tt = nextT + (step % 2 ? (S.swing / 100) * sd : 0), sh = S.prog[bar], idx = bar * STEPS + step;
    const kev = liveEv('lkeys'), pev = liveEv('lpads');
    if (kev.length && audible('keys')) for (const e of kev) if (e.p >= idx && e.p < idx + 1) hit('keys', nextT + (e.p - idx) * sd, A.strips, e.m, 1, e.d * sd);
    if (pev.length && !S.mute.pads) for (const e of pev) if (e.p >= idx && e.p < idx + 1) padHit(e.m, nextT + (e.p - idx) * sd, null, e.v);
    TRACKS.forEach((tr, ti) => {
      const v = patAt(ti, step, bar);
      if (v && audible(tr.id)) for (const [k, vel] of ROLLS[v]) {
        if (S.arps[tr.id] && S.arps[tr.id].mode === 'chord') { const ch = arpPool(rowAtP(step), tr.id === 'kchord' ? { ...S.arps[tr.id], n: 3 + S.ext } : S.arps[tr.id]); for (const r of ch) hit(tr.id, tt + k * sd, A.strips, r, (vel * 1.15) / Math.sqrt(ch.length), 0.4, sh); } // all the notes at once
        else hit(tr.id, tt + k * sd, A.strips, S.arps[tr.id] ? arpNote(step, tr.id) : rowAtP(step), vel, 0.4, sh);
      }
    });
    if (curBass.b[step] >= 0 && audible('bass')) hit('bass', tt, A.strips, curBass.b[step], 1, noteLenOf(curBass.b, curBass.l, step) * sd, sh);
    queue.push({ i: step, t: tt, bar });
    nextT += sd; step = (step + 1) % STEPS; if (step === 0) { bar = (bar + 1) % 4; resetArp(); }
  }
}
function play() {
  engine();
  const dry = A.ctx.createGain(), wet = A.ctx.createGain(); dry.gain.value = LOOP_TRIM; dry.connect(A.bus); wet.connect(A.conv);
  A.sess = { dry, wet }; A.strips = makeStrips(dry, wet);
  playing = true; step = 0; bar = 0; resetArp(); cycleT0 = A.ctx.currentTime + 0.06; nextT = A.ctx.currentTime + 0.06; queue.length = 0;
  tick(); timer = setInterval(tick, TICK_MS);
  paintTransport();
}
function stop() {
  if (!playing) return;
  if (recording) stopRec();
  if (padRec) stopPadRec();
  if (xrec) finishExport(true);
  song.stopped();
  for (const k of LIVE_LANES) { SL[k].cur = 'live'; SL[k].next = undefined; } // after a Song the loops you recorded play again
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
// ---------------------------------------------------------------- pads (MPC style): live pads, velocity from where you touch, Note Repeat
const HUE = { drums: 24, bass: 205, guitar: 285, keys: 150, karp: 135, kchords: 165, klow: 135, live: 175, pads: 330, master: 0 };
const LOOP_TRIM = 0.7; // the loops sit ~3 dB lower than the live pads, and the pads duck them a little: the pads stand out
const duck = (t) => { if (!playing || !A?.sess) return; const g = A.sess.dry.gain; g.cancelScheduledValues(t); g.setTargetAtTime(LOOP_TRIM * 0.5, t, 0.006); g.setTargetAtTime(LOOP_TRIM, t + 0.1, 0.1); };
const PADS = [
  { n: 'Kick', id: 'kick', g: 'drums' }, { n: 'Snare', id: 'snare', g: 'drums' }, { n: 'Hi-hat', id: 'hat', g: 'drums' }, { n: 'Open hat', id: 'ohat', g: 'drums' },
  { n: 'Clap', id: 'clap', g: 'drums' }, { n: 'Rim', id: 'rim', g: 'drums' }, { n: 'Tom hi', id: 'tom', g: 'drums', over: { pitch: 220 } }, { n: 'Tom lo', id: 'tom', g: 'drums', over: { pitch: 110 } },
  { n: 'Cowbell', id: 'cow', g: 'drums' }, { n: 'Crash', id: 'crash', g: 'drums' }, { n: 'Chank', id: 'chank', g: 'guitar' }, { n: 'Chord', id: 'chord', g: 'guitar' },
  { n: 'Pluck', id: 'pluck', g: 'guitar' }, { n: '808', id: 'bass', g: 'bass', over: BASS_SOUNDS['808 sub'], dur: 0.7 }, { n: '808 5th', id: 'bass', g: 'bass', over: BASS_SOUNDS['808 sub'], dur: 0.7, fifth: true }, { n: 'Keys', id: 'keys', g: 'keys', chord: true },
  // bank B: sung phrases (formant synthesis); the pitch follows the key, the chord of the bar and the “Voice note” chips
  { n: 'Ooh', id: 'vox', g: 'pads', vox: 0 }, { n: 'Aah', id: 'vox', g: 'pads', vox: 1 }, { n: 'Hey!', id: 'vox', g: 'pads', vox: 2 }, { n: 'Yeah', id: 'vox', g: 'pads', vox: 3 }, { n: 'Oh yeah', id: 'vox', g: 'pads', vox: 4 }, { n: 'Ah-ha', id: 'vox', g: 'pads', vox: 5 }, { n: 'Whoa', id: 'vox', g: 'pads', vox: 6 }, { n: 'Mm', id: 'vox', g: 'pads', vox: 7 }, { n: 'Uh!', id: 'vox', g: 'pads', vox: 8 }, { n: 'Run', id: 'vox', g: 'pads', vox: 9 }, { n: 'Ow', id: 'vox', g: 'pads', vox: 10 }, { n: 'Doo', id: 'vox', g: 'pads', vox: 11 }, { n: 'Oh-oh', id: 'vox', g: 'pads', vox: 12 }, { n: 'Fall', id: 'vox', g: 'pads', vox: 13 }, { n: 'Rise', id: 'vox', g: 'pads', vox: 14 }, { n: 'Choir', id: 'vox', g: 'pads', vox: 15 },
  // 32+: shades of the Keys chord pad (V) and a soft bass
  { n: 'Organ', id: 'keys', g: 'keys', h: 35, chord: { ks: [0, 2, 4], base: 48, dur: 0.9, vel: 0.25, over: KEY_SOUNDS['Gospel organ'] } },
  { n: 'Organ 7th', id: 'keys', g: 'keys', h: 35, chord: { ks: [0, 2, 4, 6], base: 48, dur: 0.9, vel: 0.22, over: KEY_SOUNDS['Gospel organ'] } },
  { n: 'Rhodes', id: 'keys', g: 'keys', h: 195, chord: { ks: [0, 2, 4], base: 55, dur: 0.6, vel: 0.6, over: KEY_SOUNDS['Rhodes'] } },
  { n: 'Rhodes 7th', id: 'keys', g: 'keys', h: 195, chord: { ks: [0, 2, 4, 6], base: 55, dur: 0.6, vel: 0.52, over: KEY_SOUNDS['Rhodes'] } },
  { n: 'Strings', id: 'keys', g: 'keys', h: 265, chord: { ks: [0, 2, 4], base: 48, dur: 1.3, vel: 0.5, over: KEY_SOUNDS['Strings'] } },
  { n: 'Strings high', id: 'keys', g: 'keys', h: 265, chord: { ks: [2, 4, 7], base: 60, dur: 1.3, vel: 0.5, over: KEY_SOUNDS['Strings'] } },
  { n: 'Stab', id: 'keys', g: 'keys', h: 95, chord: { ks: [0, 2, 4], base: 60, dur: 0.16, vel: 0.6, over: KEY_SOUNDS['Stab'] } },
  { n: 'Stab 7th', id: 'keys', g: 'keys', h: 95, chord: { ks: [0, 2, 4, 6], base: 60, dur: 0.16, vel: 0.52, over: KEY_SOUNDS['Stab'] } },
  { n: 'Bass soft', id: 'bass', g: 'bass', over: BASS_SOUNDS['Soft'], dur: 0.7 },
  { n: 'Keys 7th', id: 'keys', g: 'keys', chord: { ks: [0, 2, 4, 6], base: 60, dur: 0.35, vel: 0.5 } },
];
// the pads of each bank (indices into PADS); the old drum pads (0–9) are no longer shown but old recordings still play them
const BANKS = [[32, 33, 34, 35, 36, 37, 38, 39, 10, 11, 12, 13, 14, 40, 41, 15], Array.from({ length: 16 }, (_, i) => 16 + i)];
const PAD_KEYS = '1234qwerasdfzxcv'; // the 16 pads of the visible bank
function posAt(t) { const sd = 60 / S.bpm / 4; return ((((t - cycleT0) / sd) % (4 * STEPS)) + 4 * STEPS) % (4 * STEPS); } // position in the 4-bar loop, in steps, at AudioContext time t
const padGain = () => 1.7 * Math.pow(S.grp.pads / 80, 1.6);
function padHit(n, t, set, vel = 1) {
  const pd = PADS[n]; if (!pd || !A || S.gmute.pads) return;
  const out = (set || A.aud)[pd.id].vol, sh = playing ? S.prog[Math.floor(posAt(t) / STEPS) % 4] : 0; // always at full level, follows the chord of the bar
  const tap = A.ctx.createGain(); tap.gain.value = vel * padGain(); tap.connect(out); tap.connect(A.gan.pads); // velocity and Pads fader; the tap also feeds the Pads meter
  if (pd.chord) { const c = pd.chord === true ? { ks: [0, 2, 4], base: 60, dur: 0.35, vel: 0.6 } : pd.chord; const ks = c.ks.length === 3 && c.ks[0] === 0 && c.ks[1] === 2 ? [0, 2, 4, 6, 8].slice(0, 3 + S.ext) : c.ks; for (const k of ks) playSound(A.ctx, tap, 'keys', t, c.base + S.key + shiftSemi(k, sh), c.dur, c.vel, 0, c.over || null); }
  else if (pd.vox !== undefined) { S.vgest = pd.vox; playSound(A.ctx, tap, 'vox', t, S.vnote, 0.4, 1, sh, { gest: pd.vox }); }
  else playSound(A.ctx, tap, pd.id, t, pd.fifth ? (Array.from({ length: ROWS }, (_, r) => r).find((r) => semis(r) % 12 === 7) ?? 2) : 0, pd.dur || 0.4, 1, sh, pd.over);
  duck(t); hits.push({ t, id: pd.id, seg: {} }); if (hits.length > 40) hits.shift();
}
let padRec = false, lastPad = 0, padFlash = () => {};
const repeats = new Map(); let repTimer = 0; // pointer or key -> { n, vel, next }
function padDown(n, vel, who) {
  engine(); lastPad = n; const t = A.ctx.currentTime + 0.005;
  padHit(n, t, null, vel); padRecord(n, t, vel); padFlash(n, vel);
  if (S.rep > 0 && PADS[n].vox === undefined) { // (voices do not repeat: a held phrase would pile up)
    const iv = (60 / S.bpm / 4) * S.rep; let nx = playing ? cycleT0 + Math.ceil((t - cycleT0) / iv) * iv : t + iv;
    if (nx - t < 0.03) nx += iv;
    repeats.set(who, { n, vel, next: nx }); if (!repTimer) repTimer = setInterval(repTick, TICK_MS);
  }
}
function padUp(who) { repeats.delete(who); if (!repeats.size && repTimer) { clearInterval(repTimer); repTimer = 0; } }
function repTick() {
  if (!A) return; const iv = (60 / S.bpm / 4) * (S.rep || 1);
  for (const r of repeats.values()) while (r.next < A.ctx.currentTime + LOOKAHEAD) { padHit(r.n, r.next, null, r.vel); padRecord(r.n, r.next, r.vel); padFlash(r.n, r.vel); r.next += iv; }
}
function padRecord(n, t, vel) { if (padRec && playing) S.ploop.ev.push({ p: +posAt(t).toFixed(3), m: n, v: +vel.toFixed(2), s: S.ploop.ses }); }
function startPadRec() { if (!playing) play(); padRec = true; S.mute.pads = false; S.ploop.ses += 1; paintPadsUi(); }
function stopPadRec() { padRec = false; saveAll(); paintPadsUi(); }

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
  const seq = $('#seq'), more = $('#seqMore'), gs = $('#gseq'); seq.innerHTML = ''; more.innerHTML = ''; gs.innerHTML = ''; Object.keys(S.arps).forEach((k) => { $('#aseq-' + k).innerHTML = ''; });
  TRACKS.forEach((tr) => { if (S.arps[tr.id]) return $('#aseq-' + tr.id).appendChild(trackRow(tr)); (tr.group === 'drums' ? (['kick', 'snare', 'hat', 'clap'].includes(tr.id) ? seq : more) : gs).appendChild(trackRow(tr)); });

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
  TRACKS.forEach((tr, ti) => cells[tr.id]?.forEach((b, i) => paintCell(b, S.pat[ti][i])));
  paintFlags(); paintSummaries();
}
function paintFlags() {
  [...TRACKS, BASS, KEYS].forEach((s) => {
    const row = s.id === 'bass' ? $('#bassHead') : s.id === 'keys' ? $('#keysHead') : $(`.trk[data-id="${s.id}"]`);
    if (!row) return;
    row.classList.toggle('muted', !!S.mute[s.id]);
    $('.mute', row).setAttribute('aria-pressed', String(!!S.mute[s.id]));
    $('.solo', row).setAttribute('aria-pressed', String(S.solo === s.id));
  });
  document.body.classList.toggle('has-solo', S.solo != null);
  if (typeof paintKeysUi === 'function') paintKeysUi();
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
  $$('#prog .pbar').forEach((e) => e.classList.toggle('now', +e.dataset.bar === b)); $$('#bardots i').forEach((e, k) => e.classList.toggle('on', k === b));
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
const gridEl = document;
gridEl.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.st'); if (!b) return;
  const i = +b.dataset.i;
  useMine(b.dataset.id === 'bass' ? 'bass' : SLOT_OF[trackIdx(b.dataset.id)]);
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
    if (e.detail === 0) useMine(st.dataset.id === 'bass' ? 'bass' : SLOT_OF[trackIdx(st.dataset.id)]);
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
  const gm = e.target.closest('[data-gm]'); if (gm) { S.gmute[gm.dataset.gm] = !S.gmute[gm.dataset.gm]; applyMix(); paintMixer(); saveAll(); }
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
  if (UI.tab !== 'lab' || !$('#sec-scope').open) return;
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
  $('#status').textContent = playing ? 'Playing' : 'Pick a drum loop to start';
  paintGuide();
}
function paintReadout() {
  const T = 60 / S.bpm, sd = T / 4, late = Math.round((S.swing / 100) * sd * 1000);
  $('#bpmOut').textContent = S.bpm; $('#bpmBar').textContent = S.bpm; $('#bpm').value = S.bpm; $('#swing').value = S.swing;
  $('#swingOut').textContent = `${S.swing} %`; $('#volOut').textContent = `${Math.round(S.vol * 100)} %`;
  $('#phys').textContent = `Beat period T = ${T.toFixed(2)} s · frequency f = 1/T = ${(1 / T).toFixed(2)} Hz · one step = ${Math.round(sd * 1000)} ms`;
  $('#swingNote').textContent = S.swing ? `Every second step is late by ${late} ms.` : 'Steps are perfectly evenly spaced.';
  paintSummaries(); if (typeof paintMixer === 'function') paintMixer();
}
const togglePlay = () => (playing ? stop() : (audioSupported() ? play() : ($('#status').textContent = 'This browser has no Web Audio.')));
$$('.play').forEach((b) => b.addEventListener('click', togglePlay));
const setBpm = (v) => { S.bpm = Math.max(60, Math.min(180, v)); paintReadout(); saveAll(); };
$('#bpm').addEventListener('input', (e) => { S.bpm = +e.target.value; paintReadout(); });
$('#bpmDown').addEventListener('click', () => setBpm(S.bpm - 1)); $('#bpmUp').addEventListener('click', () => setBpm(S.bpm + 1));
$('#swing').addEventListener('input', (e) => { S.swing = +e.target.value; paintReadout(); });
$('#vol').addEventListener('input', (e) => { setMaster(+e.target.value); });
for (const id of ['bpm', 'swing', 'vol']) $('#' + id).addEventListener('change', saveAll);
function playScale() { // hear the scale when you change it (only while stopped: while playing you hear it in the loops)
  if (playing) return;
  engine(); const t0 = A.ctx.currentTime + 0.02, n = Math.min(ROWS, SCALES[S.scale].length + 1);
  for (let r = 0; r < n; r++) hit('bass', t0 + r * 0.2, null, r, 1, 0.17);
}
$('#key').addEventListener('change', (e) => { S.key = +e.target.value; paintProg(); paintBass(); paintSummaries(); saveAll(); renderLab(); playScale(); });
$('#scale').addEventListener('change', (e) => { S.scale = e.target.value; paintProg(); paintBass(); paintSummaries(); saveAll(); renderLab(); playScale(); });

function syncAll() {
  $('#key').value = S.key; $('#scale').value = S.scale;
  paintGrid(); paintBass(); paintReadout(); paintProg(); paintArp(); saveAll(); renderLabPanel(); lab.ghost = null; renderLab(); loopsDirty = true;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function buildLoad() {
  $$('[data-load]').forEach((el) => { const k = el.dataset.load; el.innerHTML = '<span>Load a loop</span>' + CLIPS[k].map((c, i) => grpHead(k, c, i, (g) => `<span class="cg">${g}</span>`) + `<button data-lc="${c.id}" data-slot="${k}">${c.name}</button>`).join('') + `<button data-lc="clear" data-slot="${k}">Clear</button>`; });
}
document.addEventListener('click', (e) => { // Step: put a loop into ONE instrument, the others stay as they are
  const b = e.target.closest('[data-lc]'); if (!b) return;
  const k = b.dataset.slot, id = b.dataset.lc;
  if (id === 'clear') { if (k === 'bass') { S.bass = Array(STEPS).fill(-1); S.bl = Array(STEPS).fill(1); } else TRACKS.forEach((tr, ti) => { if (SLOT_OF[ti] === k) S.pat[ti] = Array(STEPS).fill(0); }); }
  else { copyToMine(k, id); clipExtras(k, id); }
  SL[k].cur = 'mine'; SL[k].next = undefined; stepDirty = true; loopsDirty = true; saveAll();
});

// ---------------------------------------------------------------- views (one instrument at a time) and the Step accordion
const phone = matchMedia('(max-width: 680px)');
const TABS = ['loops', 'song', 'pads', 'keys', 'fx', 'step', 'lab'];
const UI = { tab: TABS.includes(store.get('tab', 'loops')) ? store.get('tab', 'loops') : 'loops', prev: 'loops', seenFx: store.get('seenFx', false) };
const secs = $$('#sections .sec');
let labDirty = true;
function showView(id) {
  if (!TABS.includes(id)) return;
  if (id !== UI.tab) UI.prev = UI.tab;
  if (UI.tab === 'fx' && id !== 'fx') xyLeave();
  UI.tab = id; store.set('tab', id);
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== id));
  $$('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  if (id === 'lab') labDirty = true;
  if (id === 'song') song.show();
  if (id === 'fx') fx.redraw();
  if (id === 'fx') { UI.seenFx = true; store.set('seenFx', true); paintMixer(); }
  paintGuide(); window.scrollTo({ top: 0 });
}
function openSection(id) {
  if (id === 'back') return showView(UI.prev === UI.tab ? 'loops' : UI.prev);
  if (id === 'lab') return showView('lab');
  showView('step'); secs.forEach((d) => { if (d.id === 'sec-' + id) d.open = true; else if (phone.matches) d.open = false; });
}
secs.forEach((d) => d.addEventListener('toggle', () => { if (d.open && phone.matches) secs.forEach((o) => { if (o !== d) o.open = false; }); }));
if (phone.matches) secs.forEach((d) => (d.open = d.id === 'sec-drums'));
$$('#v-lab .sec').forEach((d) => d.addEventListener('toggle', () => { if (d.open) labDirty = true; }));
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showView(b.dataset.tab); });
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-open]'); if (go) openSection(go.dataset.open);
  const pg = e.target.closest('#pager [data-page]');
  if (pg) { $('#bgrid').dataset.page = pg.dataset.page; $$('#pager [data-page]').forEach((b) => b.setAttribute('aria-pressed', String(b === pg))); }
});
function paintSummaries() {
  const set = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const cnt = (a, b) => S.pat.slice(a, b).reduce((x, r) => x + r.filter((v) => v > 0).length, 0);
  const scaleName = SCALE_LIST.find(([k]) => k === S.scale)?.[1] || '';
  set('#sum-drums', `${cnt(0, 6)} hits`); set('#sum-bass', `${S.bass.filter((v) => v >= 0).length} notes · ${NOTE_EN[S.key]} ${scaleName.toLowerCase()}`);
  set('#sum-gtr', `${cnt(6, 9)} hits`); set('#sum-arp', `${cnt(9, 10)} hits`); set('#sum-kchord', `${cnt(10, 11)} hits`); set('#sum-klow', `${cnt(11, 12)} hits`); set('#sum-lab', byId(S.sel).name); set('#sum-prog', S.prog.map((v) => chordName(v)).join(' → ')); set('#sum-groove', `${S.bpm} BPM · swing ${S.swing} %`);
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
  if (typeof paintHarmLink === 'function') paintHarmLink();
}
// ---------------------------------------------------------------- app (PWA): installable and offline
{
  const btn = $('#pwaInstall'), meta = document.querySelector('meta[name="theme-color"]'), root = document.documentElement;
  const paintTheme = () => meta?.setAttribute('content', root.dataset.mode === 'light' ? '#f3efe6' : '#071d19');
  paintTheme(); new MutationObserver(paintTheme).observe(root, { attributes: true, attributeFilter: ['data-mode'] });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) addEventListener('load', () => navigator.serviceWorker.register('groovebox-sw.js').catch(() => {}));
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone, ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let ask = null;
  if (!standalone && ios) btn.hidden = false;      // iOS has no install prompt: the button explains the steps
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ask = e; if (!standalone) btn.hidden = false; });
  addEventListener('appinstalled', () => { ask = null; btn.hidden = true; });
  btn.addEventListener('click', async () => { if (ask) { ask.prompt(); await ask.userChoice; ask = null; btn.hidden = true; } else $('#status').textContent = 'iPhone / iPad: tap Share, then “Add to Home Screen”.'; });
}
// ---------------------------------------------------------------- Export · record: master + Drums + Bass, WAV and/or MP3 320 kbps, in one ZIP
const EXP = { fmt: store.get('expFmt', 'wav'), trk: store.get('expTrk', ['master', 'drums', 'bass']), bars: store.get('expBars', 0) };
const MAX_REC = 300; // seconds: the recording is kept in memory as 16-bit samples
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A stem = the channel strips of one group (Drums or Bass) re-routed through its own copy of the master chain: master level, high-pass + low-pass, reverb and the XY effects. Only the final compressor is shared by the whole mix and cannot be split. */
function buildStem(group, tapIn) {
  const c = A.ctx, G = (v) => { const g = c.createGain(); g.gain.value = v; return g; }, links = [];
  const sum = G(S.vol), hp = c.createBiquadFilter(), lp = c.createBiquadFilter(), out = G(A.master.gain.value * 1.34); // 1.34 = the make-up gain the master compressor adds (threshold −10 dB, knee 8 dB, ratio 4), so drums + bass + the rest sum back to the master
  hp.type = 'highpass'; lp.type = 'lowpass';
  const conv = c.createConvolver(); conv.buffer = A.conv.buffer; const rev = G(S.fx.rev / 100); conv.connect(rev); rev.connect(sum);
  const dry = G(LOOP_TRIM); dry.connect(sum);
  const dl = c.createDelay(0.05); dl.delayTime.value = 0.006; // the master compressor looks 6 ms ahead: the stems get the same delay, so all tracks line up in a DAW
  sum.connect(hp); hp.connect(lp); dl.connect(out); out.connect(tapIn);
  const fx = buildFx(c, lp, dl);
  const link = (a, b) => { a.connect(b); links.push([a, b]); };
  for (const sd of SOUNDS) if (GROUP[sd.id] === group) {
    const l = A.strips?.[sd.id]; if (l) { link(l.vol, dry); link(l.send, conv); }
    const a = A.aud[sd.id]; if (a) { link(a.vol, sum); link(a.send, conv); }
  }
  const st = {
    fx, conv, sync() { const t = c.currentTime; sum.gain.setTargetAtTime(S.vol, t, 0.02); rev.gain.setTargetAtTime(S.fx.rev / 100, t, 0.02); hp.frequency.setTargetAtTime(hpFreq(), t, 0.02); lp.frequency.setTargetAtTime(lpFreq(), t, 0.02); hp.Q.setTargetAtTime(qOf(), t, 0.02); lp.Q.setTargetAtTime(qOf(), t, 0.02); },
    close() { for (const [a, b] of links) { try { a.disconnect(b); } catch (e) {} } for (const n of [sum, hp, lp, dl, out, conv, rev, dry, fx.lfo]) { try { n.disconnect(); } catch (e) {} } try { fx.lfo.stop(); } catch (e) {} },
  };
  st.sync(); return st;
}
const expMsg = (t) => { const o = $('#expStatus'); if (o) o.textContent = t; };
function paintExp() {
  const busy = !!xrec;
  $$('#expFmt [data-fmt]').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.fmt === EXP.fmt)); b.disabled = busy; });
  $$('#expTrk [data-trk]').forEach((b) => { b.setAttribute('aria-pressed', String(EXP.trk.includes(b.dataset.trk))); b.disabled = busy; });
  $$('#expBars [data-bars]').forEach((b) => { b.setAttribute('aria-pressed', String(+b.dataset.bars === EXP.bars)); b.disabled = busy; });
  const go = $('#expGo'); go.disabled = xrec?.state === 'fin' || xrec?.state === 'prep';
  go.textContent = !xrec ? (EXP.bars ? `● Export ${EXP.bars} bars` : '● Rec') : xrec.state === 'fin' ? 'Encoding…' : '■ Stop & save';
  go.setAttribute('aria-pressed', String(!!xrec && xrec.state !== 'fin'));
  $('#expChip').textContent = (EXP.fmt === 'both' ? 'WAV + MP3' : EXP.fmt === 'mp3' ? 'MP3 320' : 'WAV') + ' · ' + EXP.trk.length + (EXP.trk.length === 1 ? ' track' : ' tracks');
}
function tickExp() {
  const x = xrec; if (!x) return;
  if (x.state === 'armed') { expMsg('Armed: it starts on the next bar line…'); return; }
  if (x.state !== 'rec') return;
  const sec = Math.max(0, (A.ctx.currentTime * x.sr - x.t0) / x.sr), mm = Math.floor(sec / 60), ss = Math.floor(sec % 60);
  expMsg(`● ${mm}:${String(ss).padStart(2, '0')} · bar ${x.bar + 1}${x.n ? ' / ' + x.n : ''}`);
}
function recBar(T) { // called by the scheduler at every bar line, with the exact audio time of that bar
  const x = xrec; if (!x) return;
  if (x.state === 'armed') { x.state = 'rec'; x.t0 = Math.round(T * x.sr); x.bar = 0; return; }
  if (x.state === 'rec') { x.bar++; if ((x.n && x.bar >= x.n) || (T * x.sr - x.t0) / x.sr >= MAX_REC) finishExport(false, Math.round(T * x.sr)); }
}
async function startExport(bars = EXP.bars) {
  if (xrec) return;
  const b = engine(), sr = b.ctx.sampleRate;
  xrec = { state: 'prep', n: bars, bar: 0, t0: 0, t1: 0, sr, taps: {}, stems: [], fxs: [], fmt: EXP.fmt, trk: [...EXP.trk], timer: 0 }; paintExp();
  try { await prepareRecorder(b.ctx); } catch (e) { xrec = null; expMsg(e.message); paintExp(); return; }
  const x = xrec; for (const t of x.trk) x.taps[t] = new Tap(b.ctx);
  if (x.taps.master) b.master.connect(x.taps.master.input);
  for (const t of Object.values(x.taps)) t.start();
  x.state = 'armed';
  if (!playing) play();            // the first bar line is right here: recording starts with the music
  for (const g of ['drums', 'bass']) if (x.taps[g]) { const st = buildStem(g, x.taps[g].input); x.stems.push(st); x.fxs.push(st.fx); }
  x.timer = setInterval(tickExp, 200); tickExp(); paintExp();
}
function teardownExport() {
  const x = xrec; if (!x) return; clearInterval(x.timer);
  if (x.taps.master) { try { A.master.disconnect(x.taps.master.input); } catch (e) {} }
  for (const t of Object.values(x.taps)) { t.stop(); t.close(); } for (const st of x.stems) st.close();
}
function cancelExport(msg) { teardownExport(); xrec = null; expMsg(msg || ''); paintExp(); }
let expUrls = [];
function download(name, blob) { const u = URL.createObjectURL(blob); expUrls.push(u); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); return u; }
async function finishExport(manual, f1) {
  const x = xrec; if (!x || x.state === 'fin' || x.state === 'prep') return;
  if (x.state === 'armed') { cancelExport('Cancelled before the first bar.'); return; }
  x.state = 'fin'; x.t1 = f1 ?? Math.round(A.ctx.currentTime * x.sr); paintExp(); clearInterval(x.timer);
  while (A.ctx.currentTime * x.sr < x.t1 + 512) await sleep(15);   // wait until the audio has reached the end point
  await Promise.all(Object.values(x.taps).map((t) => t.flush()));
  const taps = x.taps, sr = x.sr, t0 = x.t0, t1 = x.t1; teardownExport();
  if (t1 - t0 < sr * 0.2) { xrec = null; expMsg('Too short: nothing saved.'); paintExp(); return; }
  try {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), base = `groovebox_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}_${S.bpm}bpm`, files = [];
    const names = { master: 'master', drums: 'drums', bass: 'bass' };
    for (const [id, tap] of Object.entries(taps)) {
      const { L, R } = tap.slice(t0, t1);
      if (x.fmt !== 'mp3') files.push({ name: `${base}_${names[id]}.wav`, data: encodeWav(L, R, sr) });
      if (x.fmt !== 'wav') { expMsg(`Encoding MP3 · ${names[id]}…`); files.push({ name: `${base}_${names[id]}.mp3`, data: await encodeMp3(L, R, sr, 320, (f) => expMsg(`Encoding MP3 · ${names[id]} ${Math.round(f * 100)} %`)) }); }
    }
    const sec = (t1 - t0) / sr, mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    let name, blob, size; for (const u of expUrls) URL.revokeObjectURL(u); expUrls = [];
    if (files.length === 1) { name = files[0].name; blob = new Blob([files[0].data], { type: name.endsWith('mp3') ? 'audio/mpeg' : 'audio/wav' }); } else { name = base + '.zip'; blob = zip(files); }
    size = blob.size; const url = download(name, blob);
    $('#expOut').innerHTML = `<li><a href="${url}" download="${name}">${name}</a> · ${sec.toFixed(1)} s · ${mb(size)}</li>` + (files.length > 1 ? `<li class="note">inside: ${files.map((f) => f.name.replace(base + '_', '')).join(', ')}</li>` : '');
    expMsg(`Saved ${name}`);
  } catch (e) { expMsg('Export failed: ' + e.message); }
  xrec = null; paintExp();
}
{
  const bind = (sel, attr, fn) => $(sel).addEventListener('click', (e) => { const b = e.target.closest(`[${attr}]`); if (b && !xrec) { fn(b.getAttribute(attr)); saveExp(); paintExp(); } });
  const saveExp = () => { store.set('expFmt', EXP.fmt); store.set('expTrk', EXP.trk); store.set('expBars', EXP.bars); };
  bind('#expFmt', 'data-fmt', (v) => { EXP.fmt = v; });
  bind('#expBars', 'data-bars', (v) => { EXP.bars = +v; });
  bind('#expTrk', 'data-trk', (v) => { const i = EXP.trk.indexOf(v); if (i >= 0) { if (EXP.trk.length > 1) EXP.trk.splice(i, 1); } else EXP.trk.push(v); EXP.trk = ['master', 'drums', 'bass'].filter((k) => EXP.trk.includes(k)); });
  $('#expGo').addEventListener('click', () => { if (!xrec) startExport(); else finishExport(true); });
  paintExp();
}
// ---------------------------------------------------------------- Custom waveform editor
const HARM_PRESETS = [['Sine', TIMBRES.sinusoide.amps], ['Flute', TIMBRES.flauto.amps], ['Clarinet', TIMBRES.clarinetto.amps], ['Violin', TIMBRES.violino.amps], ['Voice «a»', TIMBRES.voce.amps], ['Organ', TIMBRES.organo.amps], ['Triangle', [1, 0, 1 / 9, 0, 1 / 25, 0, 1 / 49, 0]], ['Square', TIMBRES.quadra.amps], ['Saw', TIMBRES.dente.amps]];
let harmTone = null;
function paintHarm() {
  $$('#harmSliders input').forEach((r, i) => { r.value = Math.round(S.harm[i] * 100); r.parentNode.querySelector('output').textContent = S.harm[i].toFixed(2); });
  const cv = $('#harmScope'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.scale(dpr, dpr); const cs = getComputedStyle(document.documentElement);
  const N = 400, y = new Float32Array(N); let pk = 1e-9;
  for (let i = 0; i < N; i++) { let v = 0; S.harm.forEach((a, k) => { v += a * Math.sin(2 * Math.PI * (k + 1) * 2 * i / N); }); y[i] = v; pk = Math.max(pk, Math.abs(v)); }
  g.strokeStyle = cs.getPropertyValue('--border') || '#888'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  g.strokeStyle = cs.getPropertyValue('--primary') || '#4a4'; g.lineWidth = 2.2; g.beginPath();
  for (let i = 0; i < N; i++) { const px = (i / (N - 1)) * W, py = H / 2 - (y[i] / pk) * (H / 2 - 6); i ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke();
  const terms = S.harm.map((a, k) => (a > 0.004 ? `${a.toFixed(2)}·sin(${k ? k + 1 : ''}ωt)` : null)).filter(Boolean);
  $('#harmEq').textContent = `y = ${terms.join(' + ') || '0'}  ·  peak-normalised, 2 periods shown`;
  if (harmTone) setWave(A.ctx, harmTone.o, 'custom');
  const chip = $('#harmChip'); if (chip) chip.textContent = S.harm.filter((a) => a > 0.004).length + ' harmonics';
  paintHarmLink();
}
/** The harmonics only sound through a sound whose Waveform is Custom: this row says which one, and links to it. */
function paintHarmLink() {
  const row = $('#harmLink'); if (!row) return; const s = byId(S.sel), q = s.params.find((x) => x.choice), p = S.params[s.id];
  if (!q) row.innerHTML = `<span>The selected sound (${s.name}) has no waveform: choose a synth sound (bass, chords, low, arp, pads…) in the Sound lab above.</span>`;
  else if (p[q.k] === 'custom') row.innerHTML = `<span>✓ <b>${s.name}</b> uses this waveform: the Sound lab chart above follows the sliders.</span><button data-hl="spec">▮ See the spectrum</button><button data-hl="full">∿ See the wave</button>`;
  else row.innerHTML = `<span><b>${s.name}</b> uses <b>${p[q.k]}</b>, so these sliders are not heard yet.</span><button data-hl="use">Use Custom on ${s.name}</button>`;
}
function harmChanged() { // the harmonics changed: if the selected sound uses them, the Lab chart redraws (grey = before)
  const s = byId(S.sel), q = s.params.find((x) => x.choice); if (q && S.params[s.id][q.k] === 'custom') { lab.ghost = lab.buf; renderLab(); }
  fx.chebChanged();
}
{
  $('#harmSliders').innerHTML = S.harm.map((_, i) => `<label><output>0.00</output><input type="range" min="0" max="100" step="1" data-n="${i}" aria-label="Amplitude of harmonic ${i + 1}"><b>${i + 1}</b></label>`).join('');
  $('#harmPresets').innerHTML = HARM_PRESETS.map(([n], i) => `<button data-hp="${i}">${n}</button>`).join('');
  $('#harmSliders').addEventListener('input', (e) => { const r = e.target.closest('input[data-n]'); if (!r) return; S.harm[+r.dataset.n] = +r.value / 100; paintHarm(); saveAll(); harmChanged(); });
  $('#harmPresets').addEventListener('click', (e) => { const b = e.target.closest('[data-hp]'); if (!b) return; const a = HARM_PRESETS[+b.dataset.hp][1], m = Math.max(...a); S.harm = a.map((v) => Math.round((v / m) * 100) / 100); paintHarm(); saveAll(); harmChanged(); });
  $('#harmLink').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]'); if (!b) return; const s = byId(S.sel), q = s.params.find((x) => x.choice);
    if (b.dataset.hl === 'use' && q) { lab.ghost = lab.buf; S.params[s.id][q.k] = 'custom'; renderLabPanel(); saveAll(); paintBass(); renderLab(); preview(S.sel); paintHarmLink(); }
    else if (b.dataset.hl === 'spec' || b.dataset.hl === 'full') { S.labView = b.dataset.hl; paintLabView(); saveAll(); drawLab(); $('#sec-lab').open = true; $('#sec-lab').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  const hb = $('#harmHear'), stop = () => { hb.setAttribute('aria-pressed', 'false'); if (!harmTone) return; const { o, g } = harmTone, t = A.ctx.currentTime; harmTone = null; g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.04); o.stop(t + 0.3); };
  hb.addEventListener('pointerdown', (e) => { e.preventDefault(); engine(); stop(); hb.setPointerCapture?.(e.pointerId); hb.setAttribute('aria-pressed', 'true'); const c = A.ctx, o = c.createOscillator(), g = c.createGain(); setWave(c, o, 'custom'); o.frequency.value = 220; g.gain.value = 0; g.gain.setTargetAtTime(0.22, c.currentTime, 0.02); o.connect(g).connect(A.aud.keys.vol); o.start(); harmTone = { o, g }; });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hb.addEventListener(ev, stop);
  $('#sec-harm').addEventListener('toggle', () => { if ($('#sec-harm').open) paintHarm(); });
  window.addEventListener('resize', () => { if ($('#sec-harm').open) paintHarm(); });
  paintHarm();
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
const PROGS = { 'Stay': [0, 0, 0, 0], 'I–IV–V–IV': [0, 3, 4, 3], 'i–VI–III–VII': [0, 5, 2, 6], 'i–iv–i–v': [0, 3, 0, 4], 'ii–V–I (jazz)': [1, 4, 0, 0], 'I–vi–IV–V (soul)': [0, 5, 3, 4] }; // degrees: the chord qualities follow the scale
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const rootOf = (d) => NOTE_EN[(S.key + rootSemi(d) + 120) % 12];
/** Triad built by stacking two thirds on the degree, inside the chosen scale (only for 7-note scales: the others have no clean triads). */
function triadOf(d) {
  if (SCALES[S.scale].length !== 7) return null;
  const i = dstep(d), t = semis(i + 2) - semis(i), f = semis(i + 4) - semis(i);
  return t === 4 && f === 7 ? '' : t === 3 && f === 7 ? 'm' : t === 3 && f === 6 ? 'dim' : t === 4 && f === 8 ? 'aug' : null;
}
const chordName = (d) => rootOf(d) + (triadOf(d) || '');
const romanOf = (d) => { const q = triadOf(d), r = ROMAN[d]; return q === 'm' || q === 'dim' ? r.toLowerCase() + (q === 'dim' ? '°' : '') : q === 'aug' ? r + '+' : r; };
function buildProg() {
  $('#progPresets').innerHTML = '<span>Progression</span>' + Object.keys(PROGS).map((n) => `<button data-pp="${n}" aria-pressed="false">${n}</button>`).join('');
  $('#perfChords').innerHTML = '<span>Chords</span>' + Object.keys(PROGS).map((n) => `<button data-pp="${n}" aria-pressed="false">${n}</button>`).join('') + '<span class="cg"></span><span>Colour</span>' + ['Triad', '7th', '9th'].map((n, i) => `<button data-ext="${i}" aria-pressed="false">${n}</button>`).join('') + '<output id="chordNow"></output>';
  const opts = ROMAN.map((_, d) => `<option value="${d}"></option>`).join('');
  $('#prog').innerHTML = [0, 1, 2, 3].map((b) => `<div class="pbar" data-bar="${b}"><span class="pn">Bar ${b + 1}</span>` +
    `<select data-bar="${b}" aria-label="Bar ${b + 1}: chord (degree of the scale)">${opts}</select><span class="proot"></span></div>`).join('');
  paintProg();
}
function paintProg() {
  $$('#prog select').forEach((sel) => { [...sel.options].forEach((o, d) => { o.textContent = `${romanOf(d)} · ${chordName(d)}`; }); sel.value = S.prog[+sel.dataset.bar]; });
  $$('#prog .pbar').forEach((e) => { e.querySelector('.proot').textContent = chordName(S.prog[+e.dataset.bar]); });
  $('#chordNow').textContent = S.prog.map((v) => chordName(v)).join(' · ');
  $$('[data-pp]').forEach((b) => b.setAttribute('aria-pressed', String(PROGS[b.dataset.pp].every((v, i) => v === S.prog[i]))));
  $$('[data-ext]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.ext === S.ext)));
  paintSummaries();
}
$('#prog').addEventListener('change', (e) => { const sel = e.target.closest('select'); if (!sel) return; S.prog[+sel.dataset.bar] = +sel.value; paintProg(); saveAll(); });
$('#perfChords').addEventListener('click', (e) => { const b = e.target.closest('[data-ext]'); if (b) { S.ext = +b.dataset.ext; paintProg(); saveAll(); } });
for (const id of ['#progPresets', '#perfChords']) $(id).addEventListener('click', (e) => { const b = e.target.closest('[data-pp]'); if (b) { S.prog = [...PROGS[b.dataset.pp]]; paintProg(); saveAll(); } });

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
  recording = true; S.mute.keys = false; S.kloop.ses += 1; paintFlags(); paintKeysUi();
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
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || UI.tab !== 'keys' || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
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
  $('#kInfo').textContent = recording ? 'Recording: play on the keyboard. Notes are kept exactly as you play them.' : n ? `Loop of 4 bars · ${n} notes${S.mute.keys ? ' · muted: press M to hear it' : ''}. Press Rec again to overdub.` : 'Press Rec, then play: the loop of 4 bars starts from your notes.';
  $('#kUndo').disabled = !n; $('#kClear').disabled = !n; $('#kSave').disabled = !n;
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
  if (UI.tab !== 'keys') return;
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

// ---------------------------------------------------------------- arpeggio controls (Step)
const ARP_MODES = [['up', '↑ Up'], ['down', '↓ Down'], ['updown', '↕ Up-down'], ['random', '⚄ Random'], ['scale', '≈ Scale ↑'], ['scaledown', '≈ Scale ↓'], ['scaleud', '≈ Scale ↕'],
  ['chord', '▮ Chord'], ['root', '● Root'], ['fifths', '5 Fifths'], ['oct', '8 Octaves']];
function buildArp() {
  $$('.arpctl').forEach((el) => {
    el.innerHTML = '<span>Order</span>' + ARP_MODES.map(([k, l]) => `<button data-am="${k}" aria-pressed="false">${l}</button>`).join('') +
      '<span>Notes</span>' + [3, 4, 5, 7].map((n) => `<button data-an="${n}" aria-pressed="false">${n}</button>`).join('') + '<span>Octaves</span>' + [1, 2, 3].map((n) => `<button data-ao="${n}" aria-pressed="false">${n}</button>`).join('');
  });
  paintArp();
}
function paintArp() {
  $$('.arpctl').forEach((el) => {
    const c = S.arps[el.dataset.t];
    $$('[data-am]', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.am === c.mode)));
    $$('[data-an]', el).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.an === c.n)));
    $$('[data-ao]', el).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.ao === c.oct)));
  });
}
$$('.arpctl').forEach((el) => el.addEventListener('click', (e) => {
  const m = e.target.closest('[data-am]'), n = e.target.closest('[data-an]'), o = e.target.closest('[data-ao]'), c = S.arps[el.dataset.t];
  if (m) c.mode = m.dataset.am; if (n) c.n = +n.dataset.an; if (o) c.oct = +o.dataset.ao;
  if (m || n || o) { useMine(SLOT_OF[trackIdx(el.dataset.t)]); resetArp(); paintArp(); saveAll(); }
}));

// ---------------------------------------------------------------- Loops: the clip launcher
const SCENES = { // a scene = six loops (drums, bass, guitar, chords, low, arp) + key, scale, chords, tempo
  House: { c: ['d-house', 'b-walk', 'g-skank', 'k-ud'] }, 'Hip-hop': { c: ['d-hiphop', 'b-neosoul', null, null] }, Trap: { c: ['d-trap', 'b-demb', null, 'k-rand'] },
  Funk: { c: ['d-funk', 'b-neosoul', 'g-scratch', null] }, Breakbeat: { c: ['d-break', 'b-dnb', 'g-combo', null] },
  Reggaeton: { c: ['d-dembow', 'b-demb', 'g-demb', null], key: 0, scale: 'pentatonicaMin', prog: [0, 0, -4, -2], bpm: 95, swing: 0 },
  Techno: { c: ['d-techno', 'b-dnb', null, 'k-gate'], key: 9, scale: 'minore', prog: [0, 0, 0, 0], bpm: 128, swing: 0 },
  Disco: { c: ['d-disco', 'b-walk', 'g-disco', 'k-off'], key: 2, scale: 'dorica', prog: [0, 0, 5, -2], bpm: 118, swing: 0 },
  'Lo-fi': { c: ['d-lofi', 'b-lofi', 'g-long', 'k-pulse'], key: 5, scale: 'dorica', prog: [0, 5, 0, 7], bpm: 78, swing: 25 },
  'Drum & bass': { c: ['d-dnb', 'b-dnb', null, 'k-wide'], key: 7, scale: 'minore', prog: [0, 0, -4, -2], bpm: 172, swing: 0 },
  Jungle: { c: ['d-jungle', 'b-jungle', null, 'k-rand'], key: 4, scale: 'minore', prog: [0, 0, 0, -2], bpm: 160, swing: 0 },
  'UK garage': { c: ['d-garage', 'b-demb', 'g-stabs', 'k-off'], key: 0, scale: 'dorica', prog: [0, 5, 0, 7], bpm: 132, swing: 28 },
  Drill: { c: ['d-drill', 'b-jungle', null, 'k-rand'], key: 6, scale: 'minore', prog: [0, 0, -4, -2], bpm: 142, swing: 0 },
  Reggae: { c: ['d-reggae', 'b-lofi', 'g-skank', 'k-pulse'], key: 9, scale: 'dorica', prog: [0, 5, 0, 5], bpm: 76, swing: 20 },
  Dubstep: { c: ['d-dub', 'b-jungle', null, 'k-wide'], key: 5, scale: 'minore', prog: [0, 0, -4, -2], bpm: 140, swing: 0 },
  Trance: { c: ['d-trance', 'b-dnb', null, 'k-down'], key: 9, scale: 'minore', prog: [0, 0, -4, -2], bpm: 138, swing: 0 },
  Soul: { c: ['d-soul', 'b-neosoul', 'g-soul', 'k-rhodes'], key: 0, scale: 'dorica', prog: [0, 5, 0, 7], bpm: 92, swing: 15 },
  Motown: { c: ['d-motown', 'b-walk', 'g-motown', 'k-motown'], key: 7, scale: 'maggiore', prog: [0, 5, 7, 5], bpm: 112, swing: 0 },
  Gospel: { c: ['d-soul', 'b-gospel', 'g-gospel', 'k-gospel'], key: 5, scale: 'maggiore', prog: [0, 5, 0, 7], bpm: 84, swing: 18 },
  Jazz: { c: ['d-jazz', 'b-jazzwalk', 'g-charleston', 'k-jazz'], key: 5, scale: 'dorica', prog: [2, 7, 0, 0], bpm: 124, swing: 30 },
  Bossa: { c: ['d-bossa', 'b-lofi', 'g-half', 'k-lowjazz'], key: 9, scale: 'dorica', prog: [2, 7, 0, 0], bpm: 128, swing: 0 },
  Afrobeat: { c: ['d-afro', 'b-neosoul', 'g-chic', 'k-bubble'], key: 4, scale: 'dorica', prog: [0, 0, 0, 0], bpm: 105, swing: 10 },
  'Afro house': { c: ['d-afrohouse', 'b-lofi', 'g-muted', 'k-pad'], key: 2, scale: 'dorica', prog: [0, 0, 0, 0], bpm: 122, swing: 8 },
  Roots: { c: ['d-steppers', 'b-lofi', 'g-roots', 'k-bubble'], key: 9, scale: 'dorica', prog: [0, 5, 0, 5], bpm: 80, swing: 20 },
};
for (const o of [...Object.values(STYLES), ...Object.values(SCENES)]) if (o.prog) o.prog = toDeg(o.prog);
Object.assign(SCENES, { // inspired by the reference tracks (degrees; 7th chords)
  'Boom-bap': { c: ['d-break92', 'b-subslow', 'g-soul', 'k-rhodes'], key: 0, scale: 'minore', prog: [2, 0, 0, 2], bpm: 92, swing: 8 },
  'Lazy soul': { c: ['d-lazy95', 'b-soulline', 'g-muted', 'k-rhodes'], key: 0, scale: 'maggiore', prog: [0, 5, 1, 2], bpm: 95, swing: 22 },
  Cosmic: { c: ['d-cosmic', 'b-funkleg', 'g-wahlfo', 'k-rhodes'], key: 10, scale: 'dorica', prog: [0, 0, 3, 0], bpm: 104, swing: 6 },
  'Beach jazz': { c: ['d-brush', 'b-warm', null, 'k-beachpiano'], key: 1, scale: 'maggiore', prog: [0, 1, 2, 1], bpm: 116, swing: 30 },
  'Deep house': { c: ['d-deep130', 'b-rolling', 'g-disco', 'k-pad'], key: 9, scale: 'maggiore', prog: [4, 1, 2, 3], bpm: 130, swing: 0 },
});
for (const sc of Object.values(SCENES)) { // [drums, bass, guitar, chords, low, arp]
  const k = sc.c[3], g = k ? KGRP[k] : null; sc.c = [sc.c[0], sc.c[1], sc.c[2], g === 'Chords' ? k : null, g === 'Low' ? k : null, k && !g ? k : null];
}
Object.assign(SCENES['Beach jazz'].c, { 4: 'k-beachpad' }); Object.assign(SCENES.Soul.c, { 4: 'k-lowslow' }); Object.assign(SCENES.Jazz.c, { 4: 'k-lowjazz' }); Object.assign(SCENES.Gospel.c, { 4: 'k-drone' }); Object.assign(SCENES.Motown.c, { 4: 'k-lowwalk' });
Object.assign(SCENES['Afro house'].c, { 4: 'k-lowfill' }); Object.assign(SCENES.Roots.c, { 4: 'k-root' }); Object.assign(SCENES['Lo-fi'].c, { 3: 'k-rhodes', 4: 'k-lowslow', 5: null });
function miniOf(slot, c) { // 16 little cells: where the loop sounds in its first bar
  const on = Array(STEPS).fill(0);
  if (slot === 'bass') coverOf(c.bars[0].b, c.bars[0].l).forEach((v, i) => (on[i] = +(v >= 0)));
  else c.bars[0].forEach((row) => row && row.forEach((v, i) => { if (v) on[i] = 1; }));
  return on;
}
const RACK = store.get('rack1', {}); // which instruments of the rack show their whole list of loops
function buildLoops() {
  $('#perfScenes').innerHTML =
    Object.keys(SCENES).map((n) => `<button data-scene="${n}">${n}</button>`).join('') + '<button data-scene="Surprise">🎲</button>';
  $('#perf').innerHTML = SLOTS.map(([k, l]) => `<div class="prow" data-slot="${k}" style="--h:${HUE[k]}"><button class="gm toggle" data-gm="${GMK[k] || k}" aria-pressed="false" aria-label="Mute ${l}">M</button>` +
    `<button class="pa" data-pn="-1" data-slot="${k}" aria-label="${l}: previous loop">‹</button><button class="pname" data-pn="0" data-slot="${k}" aria-label="${l}: on or off"></button><button class="pa" data-pn="1" data-slot="${k}" aria-label="${l}: next loop">›</button><button class="lk toggle" data-lk="${k}" aria-pressed="false" aria-label="Lock ${l}: scenes do not change it">🔒</button></div>`).join('');
  $('#scenes').innerHTML = '<span>Scene</span>' + Object.keys(SCENES).map((n) => `<button data-scene="${n}">${n}</button>`).join('') + '<button data-scene="Surprise">🎲 Surprise</button>';
  $('#deck').innerHTML = SLOTS.map(([k, l]) => `<div class="slot${RACK[k] ? ' open' : ''}" data-slot="${k}" style="--h:${HUE[k]}"><div class="slot-h"><button class="gm toggle" data-gm="${GMK[k] || k}" aria-pressed="false" aria-label="Mute ${l}">M</button><button class="sl-toggle" data-rack="${k}" aria-expanded="${!!RACK[k]}" aria-label="${l}: show all the loops"><b>${l}</b><small class="slot-s"></small><i class="chev" aria-hidden="true"></i></button><button class="pa" data-pn="-1" data-slot="${k}" aria-label="${l}: previous loop">‹</button><button class="pa" data-pn="1" data-slot="${k}" aria-label="${l}: next loop">›</button><button class="lk toggle" data-lk="${k}" aria-pressed="false" aria-label="Lock ${l}: scenes do not change it">🔒</button></div>${k === 'drums' ? '<button class="tm" hidden></button>' : ''}<div class="clips" role="group" aria-label="${l} loops">` +
    `<button class="clip" data-slot="${k}" data-clip="mine" aria-pressed="false"><span>★ Mine</span></button>` +
    CLIPS[k].map((c, i) => grpHead(k, c, i, (g) => `<div class="cg">${g}</div>`) + `<button class="clip" data-slot="${k}" data-clip="${c.id}" aria-pressed="false"><span>${c.name}${c.bpm ? ` <small>${c.bpm}</small>` : ''}</span><i class="mini">${miniOf(k, c).map((v) => `<b class="${v ? 'on' : ''}"></b>`).join('')}</i></button>`).join('') +
    `<button class="clip off" data-slot="${k}" data-clip="off" aria-pressed="false"><span>■ Off</span></button></div></div>`).join('');
}
const clipOf = (b) => (b.dataset.clip === 'off' ? null : b.dataset.clip);
function paintLocks() { $$('[data-lk]').forEach((b) => { const on = !!S.lock[b.dataset.lk]; b.setAttribute('aria-pressed', String(on)); b.closest('.prow, .slot')?.classList.toggle('locked', on); }); }
document.addEventListener('click', (e) => { const b = e.target.closest('[data-lk]'); if (b) { S.lock[b.dataset.lk] = !S.lock[b.dataset.lk]; paintLocks(); saveAll(); } });
function paintPerf() {
  paintLocks();
  $$('#deck .slot').forEach((row) => { // the rack rows: mute state, and what plays now → what comes at the next bar
    const k = row.dataset.slot, gk = GMK[k] || k; $('.gm', row).setAttribute('aria-pressed', String(!!S.gmute[gk])); row.classList.toggle('off', !!S.gmute[gk]);
  });
  $$('#perf .prow').forEach((row) => {
    const k = row.dataset.slot, sl = SL[k], nm = (v) => (v === null ? 'Off' : v === 'mine' ? '★ Mine' : CLIP_BY_ID[v].name), q = sl.next !== undefined && sl.next !== sl.cur;
    const b = $('.pname', row); b.textContent = `${SLOTS.find(([x]) => x === k)[1]} · ${q ? '→ ' + nm(sl.next) : nm(sl.cur)}`; b.classList.toggle('q', q); b.classList.toggle('offc', !q && !sl.cur);
    { const gk = GMK[k] || k; $('.gm', row).setAttribute('aria-pressed', String(!!S.gmute[gk])); row.classList.toggle('off', !!S.gmute[gk]); }
  });
}
for (const root of ['#perf', '#deck']) $(root).addEventListener('click', (e) => { // ‹ › step through the loops of one instrument, the name switches it off or on: all land on the next bar
  const b = e.target.closest('[data-pn]'); if (!b) return;
  const k = b.dataset.slot, sl = SL[k], ids = CLIPS[k].map((c) => c.id), dir = +b.dataset.pn, base = sl.next !== undefined ? sl.next : sl.cur;
  let id;
  if (dir === 0) id = base ? null : (lastClip[k] || ids[0]);
  else { const i = ids.indexOf(base); id = ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length]; }
  setSlot(k, id); if (!playing && id && audioSupported()) play();
});
function paintLoops() {
  paintPerf();
  { const t = SL.drums.next !== undefined ? SL.drums.next : SL.drums.cur, c = CLIP_BY_ID[t], b = $('#deck .tm'); // a drum loop has its own tempo: offer to match it
    b.hidden = !(c && (c.bpm !== S.bpm || c.swing !== S.swing)); if (c) b.textContent = `Match tempo · ${c.bpm} BPM`; b.dataset.t = t || ''; }
  $$('#deck .clip').forEach((b) => {
    const sl = SL[b.dataset.slot], id = clipOf(b);
    b.setAttribute('aria-pressed', String(sl.cur === id)); b.classList.toggle('q', sl.next !== undefined && sl.next === id && sl.cur !== id);
  });
  for (const [k] of SLOTS) {
    const sl = SL[k], nm = (v) => (v === null ? 'off' : v === 'mine' ? '★ Mine' : CLIP_BY_ID[v].name);
    $(`.slot[data-slot="${k}"] .slot-s`).textContent = sl.next !== undefined && sl.next !== sl.cur ? `${nm(sl.cur)} → ${nm(sl.next)} at the next bar` : nm(sl.cur);
  }
  paintGuide();
}
/** Choose what an instrument plays. While playing, the change waits for the next bar line (so the groove never breaks). */
function setSlot(slot, id) {
  const sl = SL[slot];
  if (!playing) { sl.cur = id; sl.next = undefined; if (id && id !== 'mine') { clipExtras(slot, id); copyToMine(slot, id); } if (slot === 'drums' && id && id !== 'mine') { S.bpm = CLIP_BY_ID[id].bpm; S.swing = CLIP_BY_ID[id].swing; paintReadout(); } }
  else sl.next = id === sl.cur ? undefined : id;
  if (id && id !== 'mine') lastClip[slot] = id;
  loopsDirty = true; saveAll();
}
$('#deck').addEventListener('click', (e) => {
  const op = e.target.closest('[data-rack]'); if (op) { const sl = op.closest('.slot'), on = !sl.classList.contains('open'); sl.classList.toggle('open', on); op.setAttribute('aria-expanded', String(on)); RACK[op.dataset.rack] = on; store.set('rack1', RACK); return; }
  const tm = e.target.closest('.tm'); if (tm) { const c = CLIP_BY_ID[tm.dataset.t]; if (c) { S.bpm = c.bpm; S.swing = c.swing; paintReadout(); saveAll(); loopsDirty = true; } return; }
  const b = e.target.closest('.clip'); if (!b) return;
  const id = clipOf(b), sl = SL[b.dataset.slot];
  if (playing && sl.next === id && sl.cur !== id) { sl.next = undefined; loopsDirty = true; return; } // tap a blinking loop again: cancel
  setSlot(b.dataset.slot, id);
  if (!playing && id && audioSupported()) play(); // launching a loop with the transport stopped starts the beat (this click is the tap iOS needs)
});
const anyLock = () => SLOTS.some(([k]) => S.lock[k]);
/** With a 🔒 on, a scene only swaps the unlocked layers: key, scale and chord progression (the harmony of everything else) stay as they are. */
function launchScene(n) {
  const sc = SCENES[n], st = STYLES[n] || sc, held = anyLock(), p = held ? null : { key: st.key, scale: st.scale, prog: [...st.prog] }, tempo = S.lock.drums ? {} : { bpm: st.bpm, swing: st.swing };
  if (!playing) Object.assign(S, p || {}, tempo); else if (p) pendScene = p;
  SLOTS.forEach(([k], i) => { if (!S.lock[k]) setSlot(k, sc.c[i]); }); // 🔒 = this layer keeps its loop
  if (!playing) { syncAll(); paintReadout(); if (audioSupported()) play(); }
}
function surprise() {
  const wasStopped = !playing, p = anyLock() ? null : { key: Math.floor(Math.random() * 12), scale: pick(['pentatonicaMin', 'minore', 'dorica', 'blues']), prog: [...pick(Object.values(PROGS))] };
  if (wasStopped) { const c = pick(CLIPS.drums); Object.assign(S, p || {}, S.lock.drums ? {} : { bpm: c.bpm, swing: c.swing }); } else if (p) pendScene = p;
  SLOTS.forEach(([k]) => S.lock[k] || setSlot(k, k === 'drums' || Math.random() < (k === 'bass' ? 0.9 : 0.6) ? pick(CLIPS[k]).id : null));
  if (wasStopped) { syncAll(); paintReadout(); if (audioSupported()) play(); }
}
for (const id of ['#scenes', '#perfScenes']) $(id).addEventListener('click', (e) => { const b = e.target.closest('[data-scene]'); if (!b) return; if (b.dataset.scene === 'Surprise') surprise(); else launchScene(b.dataset.scene); });
/** The guided path (like the steps of Mosaicus): the next thing to do pulses. */
function paintGuide() {
  const g = $('#guide'); if (!g) return;
  const has = (k) => SL[k].cur || SL[k].next !== undefined && SL[k].next !== null;
  let msg, next = null;
  if (!has('drums')) { msg = '① Tap a drum loop, or a ready-made Scene.'; next = '.slot[data-slot="drums"]'; }
  else if (!playing) { msg = '② Press ▶ Play.'; next = '.play'; }
  else if (!has('bass')) { msg = '③ Add a bass loop: it enters at the next bar.'; next = '.slot[data-slot="bass"]'; }
  else if (!has('guitar')) { msg = '④ Add a guitar loop.'; next = '.slot[data-slot="guitar"]'; }
  else if (!has('kchords') && !has('klow') && !has('keys')) { msg = '⑤ Add keys: chords, a low line and an arpeggio can play together.'; next = '.slot[data-slot="kchords"]'; }
  else if (!UI.seenFx) { msg = '⑥ Now play on top: open Mix & FX and touch the XY pad.'; next = '#tabs [data-tab="fx"]'; }
  else msg = 'You are the DJ: swap loops (they change at the next bar), play ◼ Pads and ♪ Keys over them, move the XY pad.';
  g.textContent = msg; $$('.next').forEach((e) => e.classList.remove('next')); if (next) $$(next).forEach((e) => e.classList.add('next'));
}

// ---------------------------------------------------------------- Pads view
function buildPads() {
  $('#mpads').innerHTML = BANKS[S.bank].map((n, i) => { const pd = PADS[n]; return `<button class="mp" data-n="${n}" style="--h:${pd.h ?? HUE[pd.g]}" aria-label="Pad ${i + 1}: ${pd.n}"><i class="v"></i>${pd.n}<small>${PAD_KEYS[i].toUpperCase()}</small></button>`; }).join('');
  paintPadsUi();
}
padFlash = (n, vel) => {
  const el = $(`#mpads .mp[data-n="${n}"]`); if (!el) return;
  el.style.setProperty('--v', `${Math.round(vel * 100)}%`); el.classList.add('hit'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('hit'), 110);
};
function velOf(e, el) { // centre of the pad = loud, edge = soft (distance from the centre of the drum skin)
  const r = el.getBoundingClientRect(), dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  const d = Math.min(1, Math.hypot(dx, dy)); return Math.round((1 - 0.55 * Math.pow(d, 1.4)) * 100) / 100;
}
$('#mpads').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.mp'); if (!b) return; e.preventDefault();
  b.setPointerCapture?.(e.pointerId); padDown(+b.dataset.n, velOf(e, b), 'p' + e.pointerId); paintPadsUi();
});
const padRelease = (e) => padUp('p' + e.pointerId);
$('#mpads').addEventListener('pointerup', padRelease); $('#mpads').addEventListener('pointercancel', padRelease); $('#mpads').addEventListener('lostpointercapture', padRelease);
$('#mpads').addEventListener('click', () => engine()); // iPhone only unlocks audio on a completed tap
$('#mpads').addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (UI.tab !== 'pads' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
  const i = PAD_KEYS.indexOf(e.key.toLowerCase()); if (i >= 0) { const n = BANKS[S.bank][i]; e.preventDefault(); padDown(n, 0.9, 'k' + n); paintPadsUi(); }
});
document.addEventListener('keyup', (e) => { const i = PAD_KEYS.indexOf(e.key.toLowerCase()); if (i >= 0) for (const bk of BANKS) padUp('k' + bk[i]); });
$('#bank').addEventListener('click', (e) => { const b = e.target.closest('[data-bank]'); if (b) { S.bank = +b.dataset.bank; buildPads(); saveAll(); } });
$('#vnote').addEventListener('click', (e) => { const b = e.target.closest('[data-vn]'); if (b) { S.vnote = +b.dataset.vn; paintPadsUi(); saveAll(); } });
$('#repeat').addEventListener('click', (e) => { const b = e.target.closest('[data-rep]'); if (b) { S.rep = +b.dataset.rep; paintPadsUi(); saveAll(); } });
function paintPadsUi() {
  $$('#bank [data-bank]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.bank === S.bank)));
  $('#vnote').hidden = S.bank !== 1; $('#repeat').hidden = S.bank === 1; $$('#vnote [data-vn]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.vn === S.vnote)));
  $$('#repeat [data-rep]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rep === S.rep)));
  $('#pMute').setAttribute('aria-pressed', String(!!S.mute.pads)); $('#pMute').textContent = S.mute.pads ? '🔇 Loop muted' : '🔊 Loop on';
  $('#pRec').setAttribute('aria-pressed', String(padRec)); $('#pRec').textContent = padRec ? '■ Stop rec' : '● Rec';
  const n = S.ploop.ev.length; $('#pMute').hidden = false; $('#pUndo').disabled = !n; $('#pClear').disabled = !n; $('#pSave').disabled = !n;
  $('#pInfo').textContent = padRec ? 'Recording: hit the pads. They are kept exactly as you play them.' : n ? `Loop of 4 bars · ${n} pad hits. Press Rec again to overdub.` : 'Press Rec, then play: the loop of 4 bars starts from your hits.';
}
$('#pMute').addEventListener('click', () => { S.mute.pads = !S.mute.pads; paintPadsUi(); });
$('#pRec').addEventListener('click', () => (padRec ? stopPadRec() : startPadRec()));
$('#pUndo').addEventListener('click', () => { const last = Math.max(...S.ploop.ev.map((e) => e.s)); S.ploop.ev = S.ploop.ev.filter((e) => e.s !== last); saveAll(); paintPadsUi(); });
$('#pSave').addEventListener('click', () => saveLive('lpads'));
$('#kSave').addEventListener('click', () => saveLive('lkeys'));
$('#pClear').addEventListener('click', () => { S.ploop.ev = []; saveAll(); paintPadsUi(); });
$('#padShape').addEventListener('click', () => { select(PADS[lastPad].id); showView('lab'); });

// ---------------------------------------------------------------- Mix & FX: vertical faders, meter
const FADERS = [...GROUPS.map(([k, l]) => ({ k, l, grp: true })), { k: 'live', l: 'Keys live', grp: true }, { k: 'pads', l: 'Pads', grp: true }, { k: 'master', l: 'Master' }];
const fval = (k) => (k === 'master' ? Math.round(S.vol * 100) : S.grp[k]);
const gainDb = (v) => (v <= 0 ? '−∞ dB' : `${(1.6 * 20 * Math.log10(v / 80)).toFixed(1).replace('-', '−')} dB`);
const FMARKS = [[100, '+3'], [80, '0'], [56, '−5'], [39, '−10'], [19, '−20'], [0, '−∞']]; // fader positions (0–100) and their level in dB: dB = 32·log10(v/80)
function buildMixer() {
  const ticks = FMARKS.map(([v]) => `<i class="tk" style="bottom:${v}%"></i>`).join('');
  $('#mixer').innerHTML = `<div class="fd scale"><span style="min-height:2rem"></span><div class="fwrap"><div class="dbs">${FMARKS.map(([v, l]) => `<span style="bottom:${v}%">${l}</span>`).join('')}</div></div><output>&nbsp;</output><span class="fl">dB</span></div>` +
    FADERS.map((f) => `<div class="fd" data-f="${f.k}" style="--h:${HUE[f.k]}">` +
    (f.grp ? `<button class="gm toggle" data-gm="${f.k}" aria-pressed="false" aria-label="Mute ${f.l}">M</button>` : '<span style="min-height:2rem"></span>') +
    `<div class="fwrap"><div class="ftrack" role="slider" tabindex="0" data-f="${f.k}" aria-label="${f.l} volume" aria-valuemin="0" aria-valuemax="100"><div class="travel">${ticks}<div class="knob"></div></div></div>` +
    `<div class="meter" aria-hidden="true"><i></i></div></div><output></output><span class="fl">${f.l}</span></div>`).join('');
  paintMixer();
}
function paintMixer() {
  if (typeof paintPerf === 'function') paintPerf();
  $$('#mixer .fd[data-f]').forEach((fd) => {
    const k = fd.dataset.f, v = fval(k), t = $('.ftrack', fd);
    t.style.setProperty('--v', v); t.setAttribute('aria-valuenow', v); $('output', fd).textContent = gainDb(v);
    if (k !== 'master') { fd.classList.toggle('off', !!S.gmute[k]); $('.gm', fd).setAttribute('aria-pressed', String(!!S.gmute[k])); }
  });
}
function setFader(k, v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  if (k === 'master') setMaster(v); else { S.grp[k] = v; applyMix(); paintMixer(); }
}
function setMaster(v) { S.vol = v / 100; if (A) { A.bus.gain.setTargetAtTime(S.vol, A.ctx.currentTime, 0.02); if (xrec) for (const st of xrec.stems) st.sync(); } $('#vol').value = v; paintReadout(); }
{
  const drag = new Map();
  const at = (e, t) => { const r = $('.travel', t).getBoundingClientRect(); return 100 * (1 - (e.clientY - r.top) / r.height); };
  $('#mixer').addEventListener('pointerdown', (e) => { const t = e.target.closest('.ftrack'); if (!t) return; e.preventDefault(); t.setPointerCapture?.(e.pointerId); drag.set(e.pointerId, t); setFader(t.dataset.f, at(e, t)); });
  $('#mixer').addEventListener('pointermove', (e) => { const t = drag.get(e.pointerId); if (t) setFader(t.dataset.f, at(e, t)); });
  const end = (e) => { if (drag.delete(e.pointerId)) saveAll(); };
  $('#mixer').addEventListener('pointerup', end); $('#mixer').addEventListener('pointercancel', end);
  $('#mixer').addEventListener('keydown', (e) => {
    const t = e.target.closest('.ftrack'); if (!t) return; const k = t.dataset.f, step = { ArrowUp: 2, ArrowRight: 2, ArrowDown: -2, ArrowLeft: -2, PageUp: 10, PageDown: -10 }[e.key];
    if (e.key === 'Home') setFader(k, 0); else if (e.key === 'End') setFader(k, 100); else if (step) setFader(k, fval(k) + step); else return;
    e.preventDefault(); saveAll();
  });
}
$('#mixReset').addEventListener('click', () => { for (const k of [...GROUPS.map(([g]) => g), 'live', 'pads']) S.grp[k] = 80; S.gmute = {}; setMaster(80); applyMix(); paintMixer(); saveAll(); });
const meterLv = {};
function paintMeters() {
  $$('#mixer .fd[data-f]').forEach((fd) => {
    const k = fd.dataset.f, el = $('.meter i', fd); let pk = 0;
    if (A) {
      const an = k === 'master' ? A.an : A.gan[k], b = k === 'master' ? A.buf : A.gbuf;
      an.getFloatTimeDomainData(b); for (let i = b.length - 1024; i < b.length; i++) { const v = Math.abs(b[i]); if (v > pk) pk = v; }
    }
    const db = pk > 0 ? 20 * Math.log10(pk) : -90, lv = Math.max(0, Math.min(1, (db + 54) / 54));
    meterLv[k] = Math.max(lv, (meterLv[k] || 0) - 0.025); el.style.height = `${(meterLv[k] * 100).toFixed(0)}%`;
  });
}

// ---------------------------------------------------------------- Mix & FX: the XY pad (Kaoss style: it plays while your finger is down)
const XY_INFO = {
  filter: { x: ['◀ low-pass (muffled)', 'high-pass (thin) ▶'], y: 'resonance', help: 'Left of centre the highs are cut (low-pass), right of centre the lows are cut (high-pass); up boosts the band around the cutoff (resonance).' },
  reverb: { x: ['dry', 'wet'], y: 'room size', help: 'Reverb is the sound convolved with the “impulse response” of a room: noise that fades to −60 dB in the decay time. Right = more reverb, up = a longer decay (a hall).' },
  echo: { x: ['short echo', 'long echo'], y: 'repeats', help: 'A delay line fed back on itself: the sound comes back after a delay, lower each time. The delay is a fraction of the beat (1/16 … 1 beat), so the echo stays in time. Up = more repeats (feedback).' },
  flanger: { x: ['slow sweep', 'fast sweep'], y: 'depth', help: 'The sound is mixed with a copy delayed by a few milliseconds, and the delay is moved by a slow oscillator: the comb of cancelled frequencies sweeps up and down.' },
};
const xy = { kind: 'filter', x: 0.5, y: 0.5, on: false, hold: false, ptr: null };
const xyCv = $('#xy');
function xyRead() {
  const { kind, x, y } = xy;
  if (kind === 'filter') { const hp = 20 * Math.pow(100, (x > 0.5 ? (x - 0.5) * 200 : 0) / 100), lp = 200 * Math.pow(100, (x < 0.5 ? x * 200 : 100) / 100); return x > 0.5 ? `High-pass ${hz(hp)} · Q ${(0.7 + (10 + y * 80) / 100 * 11).toFixed(1)}` : `Low-pass ${hz(lp)} · Q ${(0.7 + (10 + y * 80) / 100 * 11).toFixed(1)}`; }
  if (kind === 'reverb') return `Wet ${Math.round((0.15 + 0.85 * x) * 100)} % · decay ${(0.6 + 2.2 * y).toFixed(1)} s`;
  if (kind === 'echo') return `Delay ${Math.round((60 / S.bpm) * ECHO_DIV[Math.min(7, Math.floor(x * 8))] * 1000)} ms · feedback ${Math.round((0.2 + 0.65 * y) * 100)} %`;
  return `Sweep ${(0.1 * Math.pow(60, x)).toFixed(1)} Hz · depth ${(0.4 + 2.6 * y).toFixed(1)} ms`;
}
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
function xyApply() { fxApply(xy.kind, xy.x, xy.y, xy.on); $('#xyRead').textContent = xy.on ? xyRead() : ' '; }
function kickTo(on, tc) { kickMul = on ? Math.pow(10, (S.drop || 6) / 20) : 1; if (!A) return; const t = A.ctx.currentTime; for (const set of [A.aud, A.strips]) if (set) set.kick.vol.gain.setTargetAtTime(volGain('kick'), t, tc); }
let kickTimer = 0;
function xyRelease() { const was = xy.on && xy.kind === 'filter'; if (was && S.drop > 0 && playing) { kickTo(true, 0.01); clearTimeout(kickTimer); kickTimer = setTimeout(() => kickTo(false, 0.25), (4 * 60000) / S.bpm); } xy.on = false; fxApply(xy.kind, xy.x, xy.y, false); $('#xyRead').textContent = ' '; }
function xyLeave() { if (!xy.hold) { xy.ptr = null; xyRelease(); } }
function xyMove(e) { const r = xyCv.getBoundingClientRect(); xy.x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); xy.y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); xy.on = true; xyApply(); }
xyCv.addEventListener('pointerdown', (e) => { e.preventDefault(); engine(); xyCv.setPointerCapture?.(e.pointerId); xy.ptr = e.pointerId; xyMove(e); });
xyCv.addEventListener('pointermove', (e) => { if (xy.ptr === e.pointerId) xyMove(e); });
const xyUp = (e) => { if (xy.ptr !== e.pointerId) return; xy.ptr = null; if (!xy.hold) xyRelease(); };
xyCv.addEventListener('pointerup', xyUp); xyCv.addEventListener('pointercancel', xyUp);
xyCv.addEventListener('click', () => engine()); xyCv.addEventListener('contextmenu', (e) => e.preventDefault());
$('#xyKind').addEventListener('click', (e) => {
  const b = e.target.closest('[data-xy]'); if (!b) return;
  if (xy.on) xyRelease(); xy.kind = b.dataset.xy; xy.on = false; paintXyUi();
});
function paintDrop() { $$('[data-drop]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.drop === S.drop))); }
$('#dropRow').addEventListener('click', (e) => { const b = e.target.closest('[data-drop]'); if (b) { S.drop = +b.dataset.drop; paintDrop(); saveAll(); } });
{ const kh = $('#kickHold'); const dn = (e) => { e.preventDefault(); engine(); clearTimeout(kickTimer); kh.setPointerCapture?.(e.pointerId); kh.setAttribute('aria-pressed', 'true'); kickTo(true, 0.01); }, up = () => { kh.setAttribute('aria-pressed', 'false'); kickTo(false, 0.2); };
  kh.addEventListener('pointerdown', dn); kh.addEventListener('pointerup', up); kh.addEventListener('pointercancel', up); kh.addEventListener('lostpointercapture', up); }
paintDrop();
$('#xyHold').addEventListener('click', () => { xy.hold = !xy.hold; if (!xy.hold && xy.ptr == null) xyRelease(); paintXyUi(); });
function paintXyUi() {
  $$('#xyKind [data-xy]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.xy === xy.kind)));
  $('#xyHold').setAttribute('aria-pressed', String(xy.hold)); $('#xyNote').textContent = XY_INFO[xy.kind].help;
}
function drawXY() {
  const w = xyCv.clientWidth, h = xyCv.clientHeight, dpr = devicePixelRatio || 1; if (!w || !h) return;
  if (xyCv.width !== Math.round(w * dpr)) { xyCv.width = Math.round(w * dpr); xyCv.height = Math.round(h * dpr); }
  const c = xyCv.getContext('2d'), cs = getComputedStyle(document.body), css = (v, d) => cs.getPropertyValue(v).trim() || d;
  const prim = css('--primary', '#2a5b8c'), acc = css('--accent', '#e8590c'), fg = css('--fg', '#ccc');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h); c.fillStyle = 'rgba(128,128,128,.10)'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(128,128,128,.35)'; c.lineWidth = 1;
  for (let i = 1; i < 8; i++) { c.beginPath(); c.moveTo((i * w) / 8, 0); c.lineTo((i * w) / 8, h); c.stroke(); c.beginPath(); c.moveTo(0, (i * h) / 8); c.lineTo(w, (i * h) / 8); c.stroke(); }
  const info = XY_INFO[xy.kind], px = xy.x * w, py = (1 - xy.y) * h, live = xy.on;
  c.save(); c.globalAlpha = live ? 0.9 : 0.4; c.lineWidth = 2.5; c.strokeStyle = prim; c.fillStyle = prim;
  if (xy.kind === 'filter' && A) { // the real response of the two filters (high-pass x low-pass), in dB, from the Web Audio nodes
    const N = 120, f = new Float32Array(N), m1 = new Float32Array(N), m2 = new Float32Array(N), p = new Float32Array(N);
    for (let i = 0; i < N; i++) f[i] = 20 * Math.pow(1000, i / (N - 1));
    A.hp.getFrequencyResponse(f, m1, p); A.lp.getFrequencyResponse(f, m2, p);
    c.beginPath(); for (let i = 0; i < N; i++) { const db = 20 * Math.log10(Math.max(1e-4, m1[i] * m2[i])), yy = h * (0.5 - Math.max(-30, Math.min(18, db)) / 60 * 0.9 - 0.12); i ? c.lineTo((i / (N - 1)) * w, yy) : c.moveTo(0, yy); } c.stroke();
  } else if (xy.kind === 'reverb') { // an exponentially decaying tail: longer when y is up
    const T = 0.6 + 2.2 * xy.y; c.beginPath(); for (let i = 0; i <= 100; i++) { const t = (i / 100) * 3, a = Math.pow(10, (-3 * t) / T) * (0.15 + 0.85 * xy.x); const X = (i / 100) * w, Y = h * 0.9 - a * h * 0.7; i ? c.lineTo(X, Y) : c.moveTo(X, Y); } c.stroke();
  } else if (xy.kind === 'echo') { // the repeats: spacing = delay, height falls with the feedback
    const dl = ECHO_DIV[Math.min(7, Math.floor(xy.x * 8))], fbk = 0.2 + 0.65 * xy.y; for (let i = 0, a = 0.8; i < 12 && a > 0.04; i++, a *= fbk) { const X = w * 0.06 + (i * dl * w * 0.22); if (X > w) break; c.fillRect(X, h * 0.9 - a * h * 0.7, 6, a * h * 0.7); }
  } else if (xy.kind === 'flanger') { // a sine at the sweep rate, with the depth as amplitude
    const rate = 0.1 * Math.pow(60, xy.x), amp = (0.1 + 0.9 * xy.y) * h * 0.3; c.beginPath(); for (let i = 0; i <= 200; i++) { const X = (i / 200) * w, Y = h / 2 - amp * Math.sin((i / 200) * Math.PI * 2 * (1 + rate * 0.6)); i ? c.lineTo(X, Y) : c.moveTo(X, Y); } c.stroke();
  }
  c.restore();
  c.fillStyle = 'rgba(128,128,128,.9)'; c.font = '12px system-ui, sans-serif'; c.textBaseline = 'bottom'; c.textAlign = 'left'; c.fillText(info.x[0], 8, h - 6); c.textAlign = 'right'; c.fillText(info.x[1], w - 8, h - 6);
  c.save(); c.translate(14, h / 2); c.rotate(-Math.PI / 2); c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(`${info.y} ▶`, 0, -6); c.restore();
  c.strokeStyle = 'rgba(128,128,128,.55)'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.moveTo(0, py); c.lineTo(w, py); c.stroke(); c.setLineDash([]);
  const g = c.createRadialGradient(px, py, 0, px, py, live ? 46 : 28); g.addColorStop(0, live ? acc : 'rgba(128,128,128,.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.beginPath(); c.arc(px, py, live ? 46 : 28, 0, 7); c.fill(); c.fillStyle = live ? fg : 'rgba(128,128,128,.8)'; c.beginPath(); c.arc(px, py, 7, 0, 7); c.fill();
}

// ---------------------------------------------------------------- main loop
function frame() {
  requestAnimationFrame(frame);
  if (A && playing) { const now = A.ctx.currentTime; let q = null; while (queue.length && queue[0].t <= now) q = queue.shift(); if (q) setCur(q.i, q.bar); }
  if (loopsDirty) { loopsDirty = false; paintLoops(); }
  if (syncDirty) { syncDirty = false; syncAll(); }
  if (stepDirty) { stepDirty = false; paintGrid(); paintBass(); paintArp(); }
  drawScope();
  if (UI.tab === 'keys') drawRoll();
  if (UI.tab === 'fx') { drawXY(); paintMeters(); }
  if (UI.tab === 'lab' && labDirty) { labDirty = false; renderLab(); } // a hidden view has 0-size canvases: draw when it opens
}

buildGrids(); buildLoad(); buildArp(); buildProg(); buildLoops(); buildPads(); buildMixer(); buildKb(); buildKeySounds(); paintKeysUi(); renderLabPanel(); paintLabView(); paintScopeButtons(); paintXyUi();
// ---------------------------------------------------------------- Song: multitrack timeline (gb-song.js)
const song = initSong({
  $, $$, store, SLOTS, LANES, CLIPS, CLIP_BY_ID, SCENES, SL, S, TRACKS, SLOT_OF, libOp,
  isPlaying: () => playing, play: () => play(), stop: () => stop(), now: () => (A ? A.ctx.currentTime : 0), audioSupported,
  setTempoFromClip: (id) => { const c = CLIP_BY_ID[id]; if (c && c.bpm) { S.bpm = c.bpm; S.swing = c.swing; paintReadout(); } },
  startExport: (n) => startExport(n), status: (t) => { $('#status').textContent = t; },
});
const fx = initFx({
  $, $$, store, S, engine: () => engine(), A: () => A, status: (t) => { $('#status').textContent = t; },
  fxList: () => (A ? [A.fx, ...(xrec ? xrec.fxs : [])] : []), bpm: () => S.bpm, isPlaying: () => playing, tabIsFx: () => UI.tab === 'fx',
});
// ---------------------------------------------------------------- descriptions fold away behind an ⓘ (the ⓘ in the top bar opens or closes all of them)
{
  const LIVE = new Set(['xyNote', 'labHint', 'phys']); // descriptions that update themselves: they fold too; status lines (pInfo, kInfo, songInfo…) stay visible
  const fold = (el) => { if (!el || el.closest('details.help')) return; const d = document.createElement('details'), sm = document.createElement('summary'); d.className = 'help'; sm.textContent = 'ⓘ Info'; el.replaceWith(d); d.append(sm, el); };
  $$('.grv p.note').forEach((p) => { if (!p.id || LIVE.has(p.id)) fold(p); });
  fold($('.grv header .sub')); fold($('#guide'));
  const all = $('#helpAll'), setAll = (on) => { $$('details.help').forEach((d) => (d.open = on)); all.setAttribute('aria-pressed', String(on)); store.set('help1', on); };
  all.addEventListener('click', () => setAll(all.getAttribute('aria-pressed') !== 'true'));
  if (store.get('help1', false)) setAll(true);
}
$('#vol').value = Math.round(S.vol * 100); paintReadout(); paintLoops(); paintTransport(); showView(UI.tab);
renderLab();
requestAnimationFrame(frame);

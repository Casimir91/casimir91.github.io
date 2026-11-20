import { fft, spectrum, pitch, findTrigger, harmonics, noteOf, noteFreq, snapToScale, SCALES, synth, TIMBRES } from '../app/js/dsp.js';
import assert from 'node:assert/strict';
const sr = 48000;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// FFT: andata e ritorno
{ const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + 0.3 * i), im = new Float64Array(n), r0 = re.slice();
  fft(re, im); fft(re, im, true); ok(re.every((v, i) => near(v / n, r0[i], 1e-9)), 'fft inversa'); }

// spettro: ampiezza di una sinusoide
{ const x = synth([0.5], 1000, sr, 8192, { normalize: false }); const { mag, df } = spectrum(x, sr);
  let kb = 0; mag.forEach((v, k) => { if (v > mag[kb]) kb = k; });
  ok(near(kb * df, 1000, df), `picco a ${(kb * df).toFixed(1)} Hz`); ok(near(mag[kb], 0.5, 0.08), `ampiezza ${mag[kb].toFixed(3)} ≈ 0.5`); }

// pitch: vari timbri e frequenze, anche con fondamentale debole (voce)
for (const [name, t] of Object.entries(TIMBRES)) for (const f of [110, 220, 440, 987.77]) {
  const x = synth(t.amps, f, sr, 4096, { phases: t.amps.map((_, k) => k * 0.7) });
  for (let i = 0; i < x.length; i++) x[i] += (Math.random() - 0.5) * 0.02;
  const p = pitch(x, sr);
  ok(p && Math.abs(1200 * Math.log2(p.f / f)) < 5, `pitch ${name} ${f} Hz → ${p?.f.toFixed(2)} (clarity ${p?.clarity.toFixed(2)})`);
}
ok(pitch(new Float64Array(4096), sr) === null, 'silenzio → null');

// trigger
{ const x = synth([1], 100, 1000, 100, { phases: [1] , normalize:false});
  const i = findTrigger(x, { edge: 1 }); const tz = i / 1000;   // prima salita per lo zero: sin(2π100t+1)=0, salita → 2π100t+1 = 2π
  ok(near(tz, (2 * Math.PI - 1) / (2 * Math.PI * 100), 2e-4), `trigger salita t=${tz.toFixed(5)}`);
  const j = findTrigger(x, { edge: -1 }); ok(near(j / 1000, (Math.PI - 1) / (2 * Math.PI * 100), 2e-4), `trigger discesa t=${(j/1000).toFixed(5)}`); }

// armoniche: onda quadra 1, 0, 1/3, 0, 1/5
{ const x = synth(TIMBRES.quadra.amps, 220, sr, 16384, { normalize: false }); const { mag, df } = spectrum(x, sr);
  const h = harmonics(mag, df, 220, 6);
  ok(near(h[0].rel, 1, 1e-9) && near(h[1].rel, 0, 0.03) && near(h[2].rel, 1 / 3, 0.03) && near(h[4].rel, 0.2, 0.03), `armoniche quadra ${h.map((q) => q.rel.toFixed(2)).join(' ')}`); }

// note
ok(noteOf(440).label === 'La4' && noteOf(261.63).label === 'Do4' && noteOf(261.63).cents === 0, 'La4, Do4');
ok(noteOf(445).cents === 20, `445 Hz = La4 +${noteOf(445).cents} cent`);
ok(noteOf(27.5).label === 'La0' && noteOf(4186).label === 'Do8', 'estremi del pianoforte');
ok(near(noteFreq(3), 523.25, 0.01), 'Do5 = 523,25 Hz');
ok(near(snapToScale(450, 'cromatica'), 440, 1e-9), 'aggancio cromatico');
ok(near(snapToScale(285, 'maggiore'), 293.66, 0.01) && near(snapToScale(340, 'pentatonica'), 329.63, 0.01) && near(snapToScale(370, "pentatonica"), 392, 0.01), 'aggancio maggiore/pentatonica');
ok(snapToScale(450, 'continua') === 450, 'continua');
// scale modali e tonica: Re dorica = Re Mi Fa Sol La Si Do (solo tasti bianchi); La blues; Mi frigia
ok(near(snapToScale(300, 'dorica', 440, 2), 293.66, 0.01), 'Re dorica: 300 Hz aggancia il Re');
const reD = snapToScale(311.13, 'dorica', 440, 2);
ok(near(reD, 293.66, 0.01) || near(reD, 329.63, 0.01), 'Re dorica: il Re♯ (a metà) va sul Re o sul Mi, mai resta');
ok(near(snapToScale(440 * 2 ** (3 / 12), 'blues', 440, 9), 440 * 2 ** (3 / 12), 1e-6), 'La blues contiene il Do (terza minore)');
ok(near(snapToScale(440 * 2 ** (4 / 12), 'blues', 440, 9), 440 * 2 ** (3 / 12), 1e-6) || near(snapToScale(440 * 2 ** (4 / 12), 'blues', 440, 9), 440 * 2 ** (5 / 12), 1e-6), 'La blues non contiene il Do♯');
// tutte le scale: gradi ordinati, nell'ottava, a partire dalla tonica; ogni nota di una scala aggancia se stessa
for (const [name, deg] of Object.entries(SCALES)) {
  if (!deg) continue;
  ok(deg[0] === 0 && deg.every((d, i) => i === 0 || d > deg[i - 1]) && deg.at(-1) < 12, `scala ${name}: gradi 0…11 crescenti`);
  for (const root of [0, 5, 11]) for (const d of deg) { const f = noteFreq(root + d - 9); ok(near(snapToScale(f, name, 440, root), f, 1e-6), `${name} (tonica ${root}) aggancia se stessa`); }
}
ok(SCALES.maggiore.length === 7 && SCALES.pentatonica.length === 5 && SCALES.blues.length === 6 && SCALES.esatonale.length === 6 && SCALES.diminuita.length === 8, 'numero di note per scala');
ok(SCALES.araba.join() === '0,1,4,5,7,8,11' && SCALES.napoletana.join() === '0,1,3,5,7,8,11' && SCALES.dorica.join() === '0,2,3,5,7,9,10' && SCALES.misolidia.join() === '0,2,4,5,7,9,10', 'intervalli di araba, napoletana, dorica, misolidia');
console.log(fails ? `${fails} FALLITI` : 'tutti ok'); process.exit(fails ? 1 : 0);

import { fitTwoPoint, uncertaintyAt, uReading, trend, isStable, checkPoints, slopeWarning } from '../app/js/calibration.js';
import { EXPERIMENTS, thermistorR, thermistorC } from '../app/js/experiments.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// retta per due punti
{ const f = fitTwoPoint({ meas: 1.2, ref: 0 }, { meas: 50.4, ref: 48.5 });
  ok(near(f.a * 1.2 + f.b, 0, 1e-12) && near(f.a * 50.4 + f.b, 48.5, 1e-12), 'la retta passa per i due punti');
  ok(fitTwoPoint({ meas: 3, ref: 0 }, { meas: 3, ref: 40 }) === null, 'due letture uguali → nessuna retta'); }

// il termistore "vero" ha parametri diversi dal modello: la taratura deve riportare le temperature giuste
{ const cool = EXPERIMENTS.find((e) => e.id === 'cooling');
  const p = Object.fromEntries(cool.params.map((q) => [q.key, q.value]));
  const adcTrue = (Tc, R0, B) => 1023 * 1e4 / (1e4 + R0 * Math.exp(B * (1 / (Tc + 273.15) - 1 / 298.15)));
  const reading = (Tc) => thermistorC(thermistorR(adcTrue(Tc, 10200, 3850), p), p);
  const err = (T, a = 1, b = 0) => a * reading(T) + b - T;
  ok(Math.abs(err(48)) > 0.8, `senza taratura a 48 °C l'errore è ${err(48).toFixed(2)} °C`);
  const f = fitTwoPoint({ meas: reading(0), ref: 0 }, { meas: reading(48), ref: 48 });
  ok(near(err(0, f.a, f.b), 0, 1e-9) && near(err(48, f.a, f.b), 0, 1e-9), 'dopo la taratura i due punti tornano');
  ok(Math.abs(err(25, f.a, f.b)) < 0.35, `a 25 °C (interpolazione) l'errore residuo è ${err(25, f.a, f.b).toFixed(2)} °C`);
  ok(Math.abs(err(70, f.a, f.b)) < Math.abs(err(70)), `a 70 °C (estrapolazione) è comunque meglio di prima: ${err(70, f.a, f.b).toFixed(2)} contro ${err(70).toFixed(2)}`);
  // parse() applica a, b e la correzione manuale
  const adc = adcTrue(30, 10200, 3850);
  const raw = cool.parse([1000, adc], p).T;
  ok(near(cool.parse([1000, adc], { ...p, calA: 2, calB: -1, offset: 0.5 }).T, 2 * raw - 1 + 0.5, 1e-9), 'parse: T = a·T_letta + b + offset');
  ok(near(cool.parse([1000, adc], { ...p, calA: undefined, calB: undefined }).T, raw, 1e-12), 'parse: senza a e b (vecchie misure) nessuna correzione'); }

// incertezza: u agli estremi, u/√2 a metà, cresce fuori
{ const u = 0.5 / Math.sqrt(12), p1 = { meas: 1, u }, p2 = { meas: 51, u };
  ok(near(uncertaintyAt(1, p1, p2), u, 1e-12) && near(uncertaintyAt(51, p1, p2), u, 1e-12), 'incertezza agli estremi = u');
  ok(near(uncertaintyAt(26, p1, p2), u / Math.SQRT2, 1e-12), 'incertezza a metà = u/√2');
  ok(uncertaintyAt(80, p1, p2) > u * 1.5, 'estrapolando l\'incertezza cresce');
  ok(near(uReading(1), 1 / Math.sqrt(12), 1e-15), 'u = δ/√12'); }

// stabilità: rumore, pendenza (°C/min)
{ const mk = (f, n = 40, dt = 500) => Array.from({ length: n }, (_, i) => ({ t: i * dt, Tc: f(i * dt / 1000) }));
  const noise = (s) => (Math.random() - 0.5) * 2 * s;
  const flat = trend(mk(() => 0.4 + noise(0.05)));
  ok(isStable(flat) && Math.abs(flat.slope) < 1, `bagno fermo: stabile (pendenza ${flat.slope.toFixed(2)} °C/min, sd ${flat.sd.toFixed(3)})`);
  const drift = trend(mk((s) => 50 - s / 60 + noise(0.05)));             // acqua calda che si raffredda di 1 °C/min
  ok(isStable(drift) && near(drift.slope, -1, 0.3), `acqua che si raffredda: pendenza ${drift.slope.toFixed(2)} ≈ −1 °C/min, ancora stabile`);
  const settling = trend(mk((s) => 21 - 21 * (1 - Math.exp(-s / 2.5))).slice(0, 16));   // appena immerso: scende velocemente
  ok(!isStable(settling), `appena immerso: non stabile (pendenza ${settling.slope.toFixed(1)} °C/min)`);
  ok(!isStable(trend(mk(() => 20 + noise(1.0)))), 'letture molto rumorose: non stabile'); }

// controlli sui punti
ok(checkPoints({ meas: 1, ref: 0 }, { meas: 12, ref: 10 }) !== null, 'riferimenti a meno di 15 °C: rifiutato');
ok(checkPoints({ meas: 1, ref: 0 }, { meas: 0, ref: 40 }) !== null, 'letture in verso opposto: rifiutato');
ok(checkPoints({ meas: 1, ref: 0 }, { meas: 41, ref: 40 }) === null, 'punti buoni: accettati');
ok(slopeWarning(1.02) === null && slopeWarning(1.3) !== null, 'avviso se a è lontano da 1');

process.exit(fails ? 1 : 0);

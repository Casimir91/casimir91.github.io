// Test del motore di fit — eseguire con: node tests/fits.test.mjs
// Per ogni modello: dati sintetici con rumore noto, il valore vero deve stare entro 4σ.
import { runModel, P } from '../app/js/fits.js';
import assert from 'node:assert/strict';

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = (s) => s * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const make = (n, t0, dt, f, noise) => { const t = [], y = []; for (let i = 0; i < n; i++) { const ti = t0 + i * dt; t.push(ti); y.push(f(ti) + gauss(noise)); } return [t, y]; };
const within = (fit, key, truth, label) => {
  const [v, s] = P(fit, key);
  console.log(`  ${label}: ${v.toPrecision(6)} ± ${s.toPrecision(2)}  (vero ${truth})`);
  assert.ok(Math.abs(v - truth) < 4 * s + 1e-12, `${label} fuori da 4σ`);
};

console.log('retta'); { const [t, y] = make(50, 2, 0.05, (t) => 0.3 + 0.8 * (t - 2), 0.003); const f = runModel('lin', t, y, { x: 's', y: 'm' }); within(f, 'm', 0.8, 'm'); within(f, 'q', 0.3 - 0.8 * 2, 'q (per t = 0)'); }
console.log('parabola a t ≈ 38 s'); { const [t, y] = make(60, 38, 0.05, (t) => 0.25 + 0.1 * (t - 38) + 0.3 * (t - 38) ** 2, 0.002); const f = runModel('poly2', t, y, { x: 's', y: 'm' }); within(f, 'c2', 0.3, 'c₂'); console.log('  ', f.eq); }
console.log('polinomio di grado 3'); { const [t, y] = make(80, 0, 0.05, (t) => 1 - 2 * t + 0.5 * t ** 3, 0.01); const f = runModel('poly3', t, y, { x: 's', y: 'm' }); within(f, 'c3', 0.5, 'c₃'); }
console.log('esponenziale'); { const [t, y] = make(80, 1, 0.1, (t) => 3 * Math.exp(0.4 * (t - 1)), 0.02); const f = runModel('exp', t, y, { x: 's', y: 'V' }); within(f, 'k', 0.4, 'k'); }
console.log('esponenziale con asintoto (raffreddamento)'); { const [t, y] = make(300, 0, 5, (t) => 21 + 54 * Math.exp(-t / 900), 0.15); const f = runModel('expC', t, y, { x: 's', y: '°C' }); within(f, 'k', -1 / 900, 'k'); within(f, 'C', 21, 'C'); }
console.log('esponenziale con asintoto (carica)'); { const [t, y] = make(200, 0, 0.01, (t) => 5 * (1 - Math.exp(-t / 0.47)), 0.01); const f = runModel('expC', t, y, { x: 's', y: 'V' }); within(f, 'k', -1 / 0.47, 'k'); }
console.log('potenza'); { const [t, y] = make(40, 0.2, 0.1, (t) => 4.9 * t ** 2, 0.01); const f = runModel('power', t, y, { x: 's', y: 'm' }); within(f, 'n', 2, 'n'); within(f, 'A', 4.9, 'A'); }
console.log('sinusoide smorzata (come la tua oscillazione)'); {
  const w = 2 * Math.PI / 0.87;
  const [t, y] = make(120, 37.5, 0.05, (t) => -1.35 + 0.105 * Math.exp(-0.05 * (t - 37.5)) * Math.sin(w * (t - 37.5) + 2), 0.002);
  const f = runModel('dsin', t, y, { x: 's', y: 'm' }); within(f, 'w', w, 'ω'); within(f, 'g', 0.05, 'γ'); within(f, 'A', 0.105, 'A');
  console.log('  R² =', f.r2.toFixed(5));
}
console.log('media'); { const [t, y] = make(100, 0, 0.05, () => 0.45, 0.05); const f = runModel('mean', t, y, { x: 's', y: 'm/s²' }); within(f, 'mean', 0.45, 'media'); }
console.log('troppi pochi punti →', runModel('dsin', [1, 2, 3], [1, 2, 3], { x: 's', y: 'm' }).error);
console.log('Tutti i test del motore di fit superati.');

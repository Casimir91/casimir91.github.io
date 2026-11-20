// Test numerici di analysis.js — eseguire con: node tests/analysis.test.mjs
import { polyfit, localPolyDerivs, fitNewtonCooling, formatMeasure } from '../app/js/analysis.js';
import assert from 'node:assert/strict';

// generatore pseudo-casuale riproducibile + rumore gaussiano
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = (s) => s * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// 1) moto uniformemente accelerato: x = 0.25 + 0.10 τ + ½·0.60 τ²
{
  const t = [], x = [];
  for (let i = 0; i < 60; i++) { const ti = 1 + i * 0.05; t.push(ti); x.push(0.25 + 0.10 * (ti - 1) + 0.30 * (ti - 1) ** 2 + gauss(0.002)); }
  const f = polyfit(t, x, 2, t[0]);
  const a = 2 * f.coef[2], sa = 2 * f.sigma[2];
  console.log('accelerazione:', formatMeasure(a, sa, 'm/s²'), 'R²=', f.r2.toFixed(5));
  assert.ok(Math.abs(a - 0.60) < 4 * sa + 1e-9, 'a entro 4σ');
  assert.ok(Math.abs(f.coef[1] - 0.10) < 4 * f.sigma[1], 'v0 entro 4σ');
  const d = localPolyDerivs(t, x, 4);
  const midA = d.d2[30];
  console.log('a locale (punto 30):', midA.toFixed(3));
  assert.ok(Math.abs(midA - 0.6) < 0.4);
  assert.ok(Math.abs(d.d1[30] - (0.10 + 0.60 * (t[30] - 1))) < 0.05, 'v locale');
}

// 2) raffreddamento: T = 21 + 54·exp(−τ/900)
{
  const t = [], T = [];
  for (let i = 0; i < 400; i++) { const ti = i * 5; t.push(ti); T.push(21 + 54 * Math.exp(-ti / 900) + gauss(0.15)); }
  const f = fitNewtonCooling(t, T);
  console.log('Ta=', formatMeasure(f.Ta, f.sTa, '°C'), ' θ=', formatMeasure(f.theta, f.sTheta, 's'), 'R²=', f.r2.toFixed(5));
  assert.ok(Math.abs(f.theta - 900) < 5 * f.sTheta);
  assert.ok(Math.abs(f.Ta - 21) < 5 * f.sTa);
  const g = fitNewtonCooling(t, T, { fixedTa: 21 });
  console.log('Ta fissata: θ=', formatMeasure(g.theta, g.sTheta, 's'));
  assert.ok(Math.abs(g.theta - 900) < 5 * g.sTheta);
}

// 3) formattazione
assert.equal(formatMeasure(0.61234, 0.01432, 'm/s²'), '(0,612 ± 0,014) m/s²');
assert.equal(formatMeasure(912.4, 23.7, 's'), '(912 ± 24) s');
console.log('Tutti i test superati.');

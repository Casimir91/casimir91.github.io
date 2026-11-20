// Test delle formule delle colonne calcolate — eseguire con: node tests/formula.test.mjs
import { compile } from '../app/js/formula.js';
import assert from 'node:assert/strict';
const row = { t: 2, x: 0.5, T: 41, v: -3 };
const cols = Object.keys(row);
const ev = (f) => compile(f, cols).fn(row);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);
close(ev('ln(T − 21)'), Math.log(20));
close(ev('x²'), 0.25);
close(ev('2x + 1'), 2);
close(ev('2·(t+1)^2'), 18);
close(ev('-t^2'), -4);            // il meno vale per tutta la potenza
close(ev('√x'), Math.sqrt(0.5));
close(ev('sqrt(2*g*x)'), Math.sqrt(2 * 9.81 * 0.5));
close(ev('0,5*v'), -1.5);         // virgola decimale
close(ev('abs(v)/t'), 1.5);
close(ev('2^3^2'), 512);          // associativa a destra
assert.ok(Number.isNaN(ev('ln(v)')));
for (const bad of ['ln(T', 'y + 1', '2 $ 3', '', 'x +']) {
  assert.throws(() => compile(bad, cols), (e) => { console.log(`  «${bad}» → ${e.message}`); return true; });
}
console.log('Tutti i test delle formule superati.');

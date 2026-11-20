// DHT11 e MLX90614: conversioni, scarto delle letture sbagliate, e giro completo col simulatore (stesso protocollo del firmware 0.3).
import { EXPERIMENTS, QUANTITIES, byId, defaultParams, dewPointC, dht11Decode, mlxC, emissivityCorrect } from '../app/js/experiments.js';
import { SimulatedLink } from '../app/js/simulator.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// punto di rugiada (Magnus): 20 °C e 50 % → 9,3 °C; 100 % → uguale alla temperatura; più secco → più freddo
ok(near(dewPointC(20, 50), 9.26, 0.05), 'punto di rugiada a 20 °C e 50 % ≈ 9,3 °C');
ok(near(dewPointC(25, 100), 25, 1e-9), 'con UR = 100 % il punto di rugiada è la temperatura');
ok(dewPointC(20, 30) < dewPointC(20, 60), 'più secco → punto di rugiada più basso');
ok(isNaN(dewPointC(20, 0)), 'UR = 0 → NaN');

// DHT11: byte grezzi
{ const d = dht11Decode(46, 0, 22, 0); ok(d.RH === 46 && d.T === 22, 'DHT11: 46 % e 22 °C'); }
{ const d = dht11Decode(40, 5, 3, 0x82); ok(near(d.RH, 40.5, 1e-9) && near(d.T, -3.2, 1e-9), 'DHT11: bit di segno e decimali'); }

// MLX90614: parole a 16 bit → °C
ok(near(mlxC(15487), 36.59, 0.02), 'MLX90614: 15487 → 36,6 °C (0,02 K per conteggio)');
ok(isNaN(mlxC(0)), 'MLX90614: 0 (sensore scollegato) → NaN');
ok(isNaN(mlxC(0x8000)), 'MLX90614: bit di errore (≥ 0x8000) → NaN');

// emissività: ε = 1 non cambia nulla; la correzione inverte esattamente la fisica diretta (ε·T⁴ + (1−ε)·Tₐ⁴)
{ const K = 273.15, Ta = 21, To = 80, e = 0.95;
  const Tr = ((e * (To + K) ** 4 + (1 - e) * (Ta + K) ** 4) ** 0.25) - K;
  ok(Tr < To && near(To - Tr, 2.3, 0.2), `con ε = 0,95 il sensore legge ${Tr.toFixed(2)} °C invece di 80 (circa 2,3 °C in meno)`);
  ok(near(emissivityCorrect(Tr, Ta, e), To, 1e-9), 'emissivityCorrect ritrova la temperatura vera');
  ok(emissivityCorrect(55, 21, 1) === 55, 'ε = 1: nessuna correzione'); }

// i due lab: ci sono, sono in Termologia, i parametri hanno valori e le grandezze sono definite
for (const id of ['humidity', 'irtemp']) {
  const e = byId(id);
  ok(e && e.topic === 'Termologia', `lab «${id}» in Termologia`);
  ok(e.views.every((v) => QUANTITIES[v.key]), `lab «${id}»: ogni vista ha la sua grandezza in QUANTITIES`);
  ok(e.columns.every((c) => c.key === 't' || QUANTITIES[c.key]), `lab «${id}»: ogni colonna ha la sua grandezza`);
  ok(typeof e.derive === 'function' && typeof e.command === 'function', `lab «${id}»: derive e command`);
}
ok(new Set(EXPERIMENTS.map((e) => e.id)).size === EXPERIMENTS.length, 'id dei lab tutti diversi');
ok(new Set(EXPERIMENTS.filter((e) => e.lineType).map((e) => e.lineType + (e.id.startsWith('phone') ? 'p' : ''))).size >= 5, 'lettere delle righe (T, S, H, I, …) distinte');

// parse
{ const h = byId('humidity'), p = defaultParams(h);
  const r = h.parse(['4000', '46', '0', '22', '0', '1'], p);
  ok(r && r.t === 4 && r.RH === 46 && r.Tair === 22 && near(r.Td, dewPointC(22, 46), 1e-9), 'humidity.parse: riga buona');
  ok(h.parse(['5000', '0', '0', '0', '0', '0'], p) === null, 'humidity.parse: riga con checksum sbagliato → scartata');
  ok(h.command(p) === 'START,DHT,2000', 'humidity.command'); }
{ const i = byId('irtemp'), p = defaultParams(i);
  const r = i.parse(['1000', String(Math.round((21 + 273.15) / 0.02)), String(Math.round((60 + 273.15) / 0.02))], p);
  ok(r && near(r.Tamb, 21, 0.02) && near(r.Tobj, 60, 0.02), 'irtemp.parse: riga buona (ε = 1)');
  const r2 = i.parse(['1000', String(Math.round((21 + 273.15) / 0.02)), String(Math.round((60 + 273.15) / 0.02))], { ...p, emiss: 0.95 });
  ok(r2.Tobj > r.Tobj, 'irtemp.parse: con ε < 1 la temperatura corretta è più alta');
  ok(i.parse(['1000', '0', '0'], p) === null, 'irtemp.parse: sensore scollegato (0,0) → scartata');
  ok(i.command({ interval: 500 }) === 'START,IRTEMP,500', 'irtemp.command');
  const rows = i.derive([r]); ok(near(rows[0].lnT, Math.log(r.Tobj - r.Tamb), 1e-12), 'irtemp.derive: ln(T − Tₐ)'); }

// giro completo col simulatore: comando → #ACK → righe che l'app sa leggere
async function giro(id, cmd, ms, lineRe, ackRe) {
  const link = new SimulatedLink(), lines = [];
  link.onLine((l) => lines.push(l));
  await link.write(cmd);
  await new Promise((r) => setTimeout(r, ms));
  await link.write('STOP');
  const e = byId(id), p = defaultParams(e);
  const data = lines.filter((l) => l[0] === e.lineType && l[1] === ',');
  ok(ackRe.test(lines[0]), `${id}: risposta ${lines[0]}`);
  ok(data.length >= 2 && data.every((l) => lineRe.test(l)), `${id}: ${data.length} righe nel formato giusto`);
  const parsed = data.map((l) => e.parse(l.slice(2).split(',').map(Number), p)).filter(Boolean);
  ok(parsed.length >= 1, `${id}: l'app ne legge ${parsed.length}`);
  return parsed;
}
{ const d = await giro('humidity', 'START,DHT,1000', 3300, /^H,\d+,\d+,0,\d+,0,[01]$/, /^#ACK,START,DHT,1000$/);
  ok(d.every((r) => r.RH > 20 && r.RH < 99 && r.Tair > 15 && r.Tair < 30), 'humidity: valori plausibili'); }
{ const d = await giro('irtemp', 'START,IRTEMP,1000', 600, /^I,\d+,\d+,\d+$/, /^#ACK,START,IRTEMP,1000$/);
  ok(d.every((r) => near(r.Tamb, 21, 0.5) && r.Tobj > 60 && r.Tobj < 80), 'irtemp: la tazza è tra 60 e 80 °C, l\'ambiente ≈ 21 °C');
  ok(d.length > 3, 'irtemp: più di 3 punti'); }
{ // il simulatore rispetta i minimi del firmware
  const link = new SimulatedLink(), lines = []; link.onLine((l) => lines.push(l));
  await link.write('START,DHT,100'); await link.write('STOP');
  ok(lines[0] === '#ACK,START,DHT,1000', 'DHT: intervallo minimo 1000 ms, come nel firmware');
  await link.write('START,IRTEMP,50'); await link.write('STOP');
  ok(lines.includes('#ACK,START,IRTEMP,200'), 'IRTEMP: intervallo minimo 200 ms, come nel firmware'); }

console.log(fails ? `\n${fails} FALLITI` : '\ntutto ok');
process.exit(fails ? 1 : 0);

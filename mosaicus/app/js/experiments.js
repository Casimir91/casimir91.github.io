// Mosaicus — catalogo degli esperimenti.
// Ogni esperimento dichiara: argomento (per l'albero), parametri, comando per il
// firmware, conversione della riga grezza in un campione, grandezze derivate,
// grafici, e la descrizione delle grandezze (simbolo, unità, modelli consigliati e
// significato fisico dei parametri) usata dalla pagina Elaborazione.
// Aggiungere un esperimento = aggiungere un oggetto a EXPERIMENTS.

import { localPolyDerivs } from './analysis.js';
import { P } from './fits.js';

// ---------- grandezze fisiche ricavate dai parametri dei fit ----------
// Ogni voce: { label, unit, calc(fit) → [valore, incertezza] }. Propagazione al primo ordine.
const TWO_PI = 2 * Math.PI;
const periodFrom = (unit = 's') => [
  { label: 'periodo T = 2π/ω', unit, calc: (f) => { const [w, s] = P(f, 'w'); return [TWO_PI / w, (TWO_PI * s) / (w * w)]; } },
  { label: 'frequenza f = ω/2π', unit: 'Hz', calc: (f) => { const [w, s] = P(f, 'w'); return [w / TWO_PI, s / TWO_PI]; } },
];

// ---------- icone e schemi dei collegamenti (SVG in linea, funzionano offline) ----------
const ICON_CART = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 15h13l3-6H6"/><circle cx="7" cy="19" r="2"/><circle cx="15" cy="19" r="2"/><path d="M2 6h4"/><path d="M19 4l3 0M20.5 2.5v3" stroke="#D6336C"/></svg>`;
const ICON_SPRING = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v3"/><path d="M8 5h8l-8 2.5h8l-8 2.5h8l-8 2.5h8"/><path d="M12 12.5V15"/><rect x="8" y="15" width="8" height="6" rx="1.5" fill="#FFE1EE" stroke="#D6336C"/></svg>`;
const ICON_PHONE = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/><path d="M3 9c1 1 1 5 0 6M21 9c-1 1-1 5 0 6" stroke="#D6336C"/></svg>`;
const ICON_GYRO = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="5" width="8" height="14" rx="2"/><path d="M4.5 8.5A9 9 0 0 1 12 3" stroke="#D6336C"/><path d="M12 3l-2.2-.6M12 3l-.8 2.1" stroke="#D6336C"/><path d="M19.5 15.5A9 9 0 0 1 12 21" stroke="#D6336C"/></svg>`;
const ICON_SOUND = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path d="M2 8v3M22 8v3" stroke="#D6336C"/></svg>`;
const ICON_THERMO = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13.5V4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7" stroke="#D6336C"/><path d="M17 5h3M17 9h3"/></svg>`;

const ICON_SCOPE = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2.5"/><path d="M5 11c1.5-5 3-5 4.5 0s3 5 4.5 0 3-5 4.5 0" stroke="#D6336C"/><path d="M8 21h8"/></svg>`;
const ICON_SYNTH = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="11" width="20" height="10" rx="1.5"/><path d="M7 11v6M12 11v6M17 11v6"/><path d="M3 6c2-4 4-4 6 0s4 4 6 0 4-4 6 0" stroke="#D6336C"/></svg>`;
const ICON_FREQ = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18M3 20V4"/><path d="M5 14h3l2-6 2 9 2-5h2.5l1.5-2" stroke="#D6336C"/></svg>`;
const ICON_ESCOPE = `<svg viewBox="0 0 24 24" fill="none" stroke="#004D43" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="15" height="12" rx="2"/><path d="M4.5 11l2.5-4 2.5 4 2.5-4 2.5 4" stroke="#D6336C"/><path d="M17 9h3a2 2 0 0 1 2 2v10M9.5 15v3"/></svg>`;

const W5V = '#D6336C', WGND = '#00302A', WSIG = '#2E8BC0';
const SCHEMA_HCSR04 = `
<svg class="schematic" viewBox="0 0 300 132" role="img" aria-label="Collegamenti HC-SR04: VCC a 5V, GND a GND, Trig al pin 12, Echo al pin 11">
  <rect x="4" y="6" width="96" height="120" rx="8" fill="#EAF8C9" stroke="#004D43"/>
  <text x="52" y="24" text-anchor="middle">Arduino</text>
  <text x="92" y="50" text-anchor="end" class="lbl">5V</text><text x="92" y="72" text-anchor="end" class="lbl">GND</text>
  <text x="92" y="94" text-anchor="end" class="lbl">pin 12</text><text x="92" y="116" text-anchor="end" class="lbl">pin 11</text>
  <rect x="200" y="6" width="96" height="120" rx="8" fill="#DDF1FF" stroke="#004D43"/>
  <text x="248" y="24" text-anchor="middle">HC-SR04</text>
  <text x="208" y="50" class="lbl">VCC</text><text x="208" y="72" class="lbl">GND</text>
  <text x="208" y="94" class="lbl">Trig</text><text x="208" y="116" class="lbl">Echo</text>
  <line x1="100" y1="46" x2="200" y2="46" stroke="${W5V}" stroke-width="2.5"/>
  <line x1="100" y1="68" x2="200" y2="68" stroke="${WGND}" stroke-width="2.5"/>
  <line x1="100" y1="90" x2="200" y2="90" stroke="${WSIG}" stroke-width="2.5"/>
  <line x1="100" y1="112" x2="200" y2="112" stroke="${WSIG}" stroke-width="2.5" stroke-dasharray="5 3"/>
</svg>`;
const SCHEMA_TERMISTORE = `
<svg class="schematic" viewBox="0 0 300 132" role="img" aria-label="Partitore: termistore NTC tra 5V e A0, resistenza da 10 kilo-ohm tra A0 e GND">
  <rect x="4" y="6" width="96" height="120" rx="8" fill="#EAF8C9" stroke="#004D43"/>
  <text x="52" y="24" text-anchor="middle">Arduino</text>
  <text x="92" y="50" text-anchor="end" class="lbl">5V</text><text x="92" y="82" text-anchor="end" class="lbl">A0</text><text x="92" y="114" text-anchor="end" class="lbl">GND</text>
  <polyline points="100,46 230,46 230,52" fill="none" stroke="${W5V}" stroke-width="2.5"/>
  <rect x="180" y="52" width="100" height="20" rx="4" fill="#FFE1EE" stroke="#D6336C"/>
  <text x="230" y="66" text-anchor="middle">NTC 10 kΩ</text>
  <line x1="100" y1="78" x2="230" y2="78" stroke="${WSIG}" stroke-width="2.5"/>
  <line x1="230" y1="72" x2="230" y2="84" stroke="${WSIG}" stroke-width="2.5"/>
  <circle cx="230" cy="78" r="3.5" fill="${WSIG}"/>
  <rect x="180" y="84" width="100" height="20" rx="4" fill="#F3F7F6" stroke="#00302A"/>
  <text x="230" y="98" text-anchor="middle">10 kΩ</text>
  <polyline points="230,104 230,110 100,110" fill="none" stroke="${WGND}" stroke-width="2.5"/>
</svg>`;

const SCHEMA_MIC = `
<svg class="schematic" viewBox="0 0 300 132" role="img" aria-label="Modulo microfono: più a 5V, G a GND, AO al pin A0">
  <rect x="4" y="6" width="96" height="120" rx="8" fill="#EAF8C9" stroke="#004D43"/>
  <text x="52" y="24" text-anchor="middle">Arduino</text>
  <text x="92" y="50" text-anchor="end" class="lbl">5V</text><text x="92" y="76" text-anchor="end" class="lbl">GND</text><text x="92" y="102" text-anchor="end" class="lbl">A0</text>
  <rect x="200" y="6" width="96" height="120" rx="8" fill="#FFE1EE" stroke="#004D43"/>
  <text x="248" y="24" text-anchor="middle">microfono</text>
  <text x="208" y="50" class="lbl">+</text><text x="208" y="76" class="lbl">G</text><text x="208" y="102" class="lbl">AO</text><text x="208" y="122" class="lbl" fill="#6B7F7B">DO (libero)</text>
  <line x1="100" y1="46" x2="200" y2="46" stroke="${W5V}" stroke-width="2.5"/>
  <line x1="100" y1="72" x2="200" y2="72" stroke="${WGND}" stroke-width="2.5"/>
  <line x1="100" y1="98" x2="200" y2="98" stroke="${WSIG}" stroke-width="2.5"/>
</svg>`;
const SCHEMA_COIL = `
<svg class="schematic" viewBox="0 0 300 150" role="img" aria-label="Due resistenze da 10 kilo-ohm tra 5V e GND fanno 2,5 V nel punto di mezzo; la bobina va dal punto di mezzo, attraverso 1 kilo-ohm, al pin A0">
  <rect x="4" y="6" width="80" height="138" rx="8" fill="#EAF8C9" stroke="#004D43"/>
  <text x="44" y="24" text-anchor="middle">Arduino</text>
  <text x="76" y="44" text-anchor="end" class="lbl">5V</text><text x="76" y="134" text-anchor="end" class="lbl">GND</text><text x="76" y="92" text-anchor="end" class="lbl">A0</text>
  <polyline points="84,40 130,40 130,48" fill="none" stroke="${W5V}" stroke-width="2.5"/>
  <rect x="116" y="48" width="28" height="22" rx="3" fill="#F3F7F6" stroke="#00302A"/><text x="130" y="63" text-anchor="middle" class="lbl">10k</text>
  <line x1="130" y1="70" x2="130" y2="98" stroke="#2E8BC0" stroke-width="2.5"/>
  <rect x="116" y="98" width="28" height="22" rx="3" fill="#F3F7F6" stroke="#00302A"/><text x="130" y="113" text-anchor="middle" class="lbl">10k</text>
  <polyline points="130,120 130,130 84,130" fill="none" stroke="${WGND}" stroke-width="2.5"/>
  <circle cx="130" cy="84" r="3.5" fill="#2E8BC0"/><text x="138" y="80" class="lbl">2,5 V</text>
  <polyline points="130,84 170,84 170,60 196,60" fill="none" stroke="#2E8BC0" stroke-width="2.5"/>
  <path d="M196 60 q8 -14 16 0 q8 -14 16 0 q8 -14 16 0 q8 -14 16 0" fill="none" stroke="#D6336C" stroke-width="2.5"/>
  <text x="228" y="34" text-anchor="middle">bobina</text>
  <polyline points="260,60 280,60 280,96" fill="none" stroke="#2E8BC0" stroke-width="2.5"/>
  <rect x="234" y="96" width="46" height="18" rx="3" fill="#F3F7F6" stroke="#00302A"/><text x="257" y="109" text-anchor="middle" class="lbl">1k</text>
  <polyline points="234,105 200,105 200,88 84,88" fill="none" stroke="#2E8BC0" stroke-width="2.5" stroke-dasharray="5 3"/>
</svg>`;


const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };


// ------------------------------------------------------------------
// Grandezze: come si chiamano, in che unità, cosa significano i parametri dei fit
// ------------------------------------------------------------------
const Q_T = { sym: 't', name: 'tempo', unit: 's' };
const Q = {
  x: { sym: 'x', name: 'posizione', unit: 'm', models: ['lin', 'poly2', 'dsin'],
    slope: 'velocità',
    physics: {
      lin: [{ label: 'velocità v = m', unit: 'm/s', calc: (f) => P(f, 'm') }],
      poly2: [{ label: 'accelerazione a = 2·c₂', unit: 'm/s²', calc: (f) => { const [c, s] = P(f, 'c2'); return [2 * c, 2 * s]; } }],
      dsin: [...periodFrom(), { label: 'ampiezza A', unit: 'm', calc: (f) => P(f, 'A') },
        { label: 'posizione di equilibrio C', unit: 'm', calc: (f) => P(f, 'C') },
        { label: 'coefficiente di smorzamento γ', unit: 's⁻¹', calc: (f) => P(f, 'g') }],
    } },
  v: { sym: 'v', name: 'velocità', unit: 'm/s', models: ['lin', 'mean', 'dsin'],
    slope: 'accelerazione',
    physics: {
      lin: [{ label: 'accelerazione a = m', unit: 'm/s²', calc: (f) => P(f, 'm') }],
      mean: [{ label: 'velocità media', unit: 'm/s', calc: (f) => P(f, 'mean') }],
      dsin: [...periodFrom(), { label: 'velocità massima', unit: 'm/s', calc: (f) => P(f, 'A') }],
    } },
  a: { sym: 'a', name: 'accelerazione', unit: 'm/s²', models: ['mean', 'dsin'],
    slope: 'variazione dell\'accelerazione',
    physics: {
      mean: [{ label: 'accelerazione media', unit: 'm/s²', calc: (f) => P(f, 'mean') }],
      dsin: [...periodFrom(), { label: 'accelerazione massima', unit: 'm/s²', calc: (f) => P(f, 'A') }],
    } },
  // raw: true = dato tecnico del sensore, utile in Misura (monitor, controllo) ma non inviato a Elaborazione
  d: { sym: 'd', name: 'distanza dal sensore', unit: 'm', models: ['lin', 'poly2'], raw: true },
  echo: { sym: 'eco', name: 'tempo di volo', unit: 'µs', models: [], raw: true },
  T: { sym: 'T', name: 'temperatura', unit: '°C', models: ['expC', 'lin'],
    slope: 'rapidità di variazione della temperatura',
    physics: {
      expC: [
        { label: 'costante di raffreddamento k', unit: 's⁻¹', calc: (f) => { const [k, s] = P(f, 'k'); return [-k, s]; } },
        { label: 'tempo caratteristico θ = 1/k', unit: 's', calc: (f) => { const [k, s] = P(f, 'k'); return [-1 / k, s / (k * k)]; } },
        { label: 'temperatura ambiente Tₐ', unit: '°C', calc: (f) => P(f, 'C') },
      ],
      lin: [{ label: 'rapidità di variazione dT/dt', unit: '°C/s', calc: (f) => P(f, 'm') }],
    } },
  lnT: { sym: 'ln(T − Tₐ)', name: 'temperatura linearizzata', unit: '', models: ['lin'],
    slope: 'opposto della costante di raffreddamento (−k)',
    physics: {
      lin: [
        { label: 'costante di raffreddamento k = −m', unit: 's⁻¹', calc: (f) => { const [m, s] = P(f, 'm'); return [-m, s]; } },
        { label: 'tempo caratteristico θ = 1/k', unit: 's', calc: (f) => { const [m, s] = P(f, 'm'); return [-1 / m, s / (m * m)]; } },
      ],
    } },
  adc: { sym: 'ADC', name: 'lettura grezza', unit: '', models: [], raw: true },
  ...Object.fromEntries(['ax', 'ay', 'az', 'amod'].map((k) => [k, {
    sym: k === 'amod' ? '|a|' : `a${k[1]}`.replace(/a(.)/, 'a_$1'), name: k === 'amod' ? 'accelerazione (modulo)' : `accelerazione lungo ${k[1]}`, unit: 'm/s²',
    models: ['dsin', 'mean', 'lin'], slope: 'variazione dell\'accelerazione',
    physics: {
      dsin: [...periodFrom(), { label: 'ampiezza', unit: 'm/s²', calc: (f) => P(f, 'A') }, { label: 'valore medio C', unit: 'm/s²', calc: (f) => P(f, 'C') }],
      mean: [{ label: 'accelerazione media', unit: 'm/s²', calc: (f) => P(f, 'mean') }],
    } }])),
  ...Object.fromEntries(['wx', 'wy', 'wz'].map((k) => [k, {
    sym: `ω_${k[1]}`, name: `velocità angolare attorno a ${k[1]}`, unit: 'rad/s',
    models: ['dsin', 'mean', 'lin'], slope: 'accelerazione angolare',
    physics: {
      dsin: [...periodFrom(), { label: 'velocità angolare massima', unit: 'rad/s', calc: (f) => P(f, 'A') }, { label: 'smorzamento γ', unit: 's⁻¹', calc: (f) => P(f, 'g') }],
      mean: [{ label: 'velocità angolare media ω', unit: 'rad/s', calc: (f) => P(f, 'mean') },
        { label: 'periodo di rotazione T = 2π/ω', unit: 's', calc: (f) => { const [w, s] = P(f, 'mean'); return [TWO_PI / Math.abs(w), (TWO_PI * s) / (w * w)]; } }],
      lin: [{ label: 'accelerazione angolare α = m', unit: 'rad/s²', calc: (f) => P(f, 'm') }],
    } }])),
  freq: { sym: 'f', name: 'frequenza dominante', unit: 'Hz', models: ['mean', 'lin'],
    physics: { mean: [{ label: 'frequenza media', unit: 'Hz', calc: (f) => P(f, 'mean') }] } },
  level: { sym: 'L', name: 'livello sonoro (relativo)', unit: 'dB', models: ['mean', 'dsin'],
    physics: { dsin: [...periodFrom(), { label: 'frequenza dei battimenti (se la curva è |cos|, è il doppio di f)', unit: 'Hz', calc: (f) => { const [w, s] = P(f, 'w'); return [w / TWO_PI, s / TWO_PI]; } }] } },
  R: { sym: 'R', name: 'resistenza del termistore', unit: 'Ω', models: ['expC', 'exp'], raw: true },
};
export const QUANTITIES = { t: Q_T, ...Q };

// ------------------------------------------------------------------
// Termologia · Raffreddamento (legge di Newton) con termistore NTC
// ------------------------------------------------------------------
const cooling = {
  id: 'cooling',
  topic: 'Termologia',
  title: 'Raffreddamento',
  subtitle: 'Legge di Newton · termistore NTC',
  icon: ICON_THERMO,
  iconBg: 'var(--rosa-t)',
  lineType: 'T',
  sim: 'cooling',
  command: (p) => `START,TEMP,${Math.round(p.interval)}`,
  params: [
    { key: 'interval', label: 'Intervallo di campionamento', unit: 'ms', value: 1000, min: 100, step: 100 },
    { key: 'tAmb', label: 'Temperatura ambiente Tₐ (per la vista linearizzata)', unit: '°C', value: 21, step: 0.1 },
    { key: 'orientation', label: 'Posizione del termistore nel partitore', type: 'select', value: 'ntc5v',
      options: [['ntc5v', 'NTC tra 5 V e A0 (lezione Elegoo)'], ['ntcgnd', 'NTC tra A0 e GND']] },
    { key: 'rSeries', label: 'Resistenza fissa del partitore', unit: 'Ω', value: 10000, step: 100, advanced: true },
    { key: 'r0', label: 'R₀ del termistore (a T₀)', unit: 'Ω', value: 10000, step: 100, advanced: true },
    { key: 't0', label: 'T₀ di riferimento', unit: '°C', value: 25, step: 0.1, advanced: true },
    { key: 'beta', label: 'Coefficiente B (Beta)', unit: 'K', value: 3950, step: 10, advanced: true },
    { key: 'offset', label: 'Correzione di taratura (si somma a T)', unit: '°C', value: 0, step: 0.1, advanced: true },
  ],
  wiring: `${SCHEMA_TERMISTORE}
    <div class="w-block"><h3>Materiale</h3>
      <p>Arduino, il termistore NTC del kit (10 kΩ) e una resistenza da 10 kΩ, oppure il modulo termistore del kit sensori.</p></div>
    <div class="w-block"><h3>Collegamenti</h3>
      <ul>
        <li>Un piedino del termistore a <b>5V</b>, l'altro ad <b>A0</b></li>
        <li>Resistenza da 10 kΩ tra <b>A0</b> e <b>GND</b></li>
      </ul>
      <p class="w-note">Se hai montato il termistore tra A0 e GND, cambia l'opzione «Posizione del termistore».</p></div>
    <div class="w-block"><h3>Consiglio</h3>
      <p class="tip">Infila il termistore in una patata calda (o in acqua calda) e lascialo raffreddare all'aria. Misura Tₐ con un termometro e inseriscila nei parametri.</p></div>`,
  /** fields = [t_ms, adc] */
  parse(fields, p) {
    const tMs = +fields[0], adc = +fields[1];
    if (!isFinite(tMs) || !isFinite(adc)) return null;
    let R;
    if (adc <= 0.5 || adc >= 1022.5) R = NaN; // fuori scala: circuito aperto o in corto
    else if (p.orientation === 'ntc5v') R = p.rSeries * (1023 - adc) / adc;
    else R = p.rSeries * adc / (1023 - adc);
    const Tk = 1 / (1 / (p.t0 + 273.15) + Math.log(R / p.r0) / p.beta);
    const T = Tk - 273.15 + p.offset;
    return { t: tMs / 1000, adc, R, T };
  },
  derive(samples, p) {
    return samples.map((s) => ({ ...s, lnT: s.T - p.tAmb > 0 ? Math.log(s.T - p.tAmb) : NaN }));
  },
  views: [
    { id: 'T', label: 'T(t)', key: 'T', yLabel: 'T (°C)', sym: 'T' },
    { id: 'lnT', label: 'ln(T − Tₐ)', key: 'lnT', yLabel: 'ln[(T − Tₐ) / °C]', sym: 'ln(T−Tₐ)' },
    { id: 'adc', label: 'Dato grezzo (ADC)', key: 'adc', yLabel: 'ADC (0–1023)', sym: 'ADC', raw: true },
  ],
  defaultVisible: ['T'],
  readouts: [{ key: 'T', label: 'Temperatura', unit: '°C', digits: 2 }, { key: 'R', label: 'Resistenza NTC', unit: 'Ω', digits: 0 }],
  columns: [
    { key: 't', head: 't (s)' }, { key: 'adc', head: 'ADC' }, { key: 'R', head: 'R_NTC (ohm)' },
    { key: 'T', head: 'T (°C)' }, { key: 'lnT', head: 'ln(T-Ta)' },
  ],
  xLabel: 't (s)',
};

// ------------------------------------------------------------------
// Cinematica · sensore a ultrasuoni HC-SR04 (parte comune)
// ------------------------------------------------------------------
const SONAR_TIP = `<p class="tip">Il sensore lavora meglio <b>tra 5 cm e circa 1 m</b>, con un bersaglio <b>piatto e largo</b> (almeno un cartoncino A5) rivolto verso di lui. Oltre il metro, o con oggetti piccoli e tondi, l'eco diventa incerto e compaiono punti sparsi. Il fascio è largo circa 30°: tieni sgombra la traiettoria.</p>`;

function sonarExperiment({ id, title, subtitle, icon, iconBg, sim, window = 4, material, idea }) {
  return {
    id, topic: 'Cinematica', title, subtitle, icon, iconBg, sim,
    lineType: 'S',
    command: (p) => `START,SONAR,${Math.round(p.interval)}`,
    params: [
      { key: 'interval', label: 'Intervallo di campionamento', unit: 'ms', value: 50, min: 30, step: 5 },
      { key: 'tAir', label: "Temperatura dell'aria (velocità del suono)", unit: '°C', value: 20, step: 0.5 },
      { key: 'direction', label: 'Verso positivo', type: 'select', value: 'away',
        options: [['away', 'Allontanamento dal sensore'], ['toward', 'Avvicinamento al sensore']] },
      { key: 'window', label: 'Lisciatura per v e a (punti per lato)', unit: '', value: window, min: 1, step: 1, advanced: true },
      { key: 'origin', label: 'Origine delle posizioni (distanza dal sensore)', unit: 'm', value: 0, step: 0.001, advanced: true },
      { key: 'dMin', label: 'Distanza minima accettata', unit: 'm', value: 0.03, step: 0.01, advanced: true },
      { key: 'dMax', label: 'Distanza massima accettata', unit: 'm', value: 3.0, step: 0.1, advanced: true },
      { key: 'spike', label: 'Scarta salti anomali maggiori di', unit: 'm', value: 0.10, step: 0.01, advanced: true },
    ],
    wiring: `${SCHEMA_HCSR04}
      <div class="w-block"><h3>Materiale</h3><p>${material}</p></div>
      <div class="w-block"><h3>Collegamenti</h3>
        <ul>
          <li><b>VCC</b> → 5V &nbsp;·&nbsp; <b>GND</b> → GND</li>
          <li><b>Trig</b> → pin <b>12</b> &nbsp;·&nbsp; <b>Echo</b> → pin <b>11</b></li>
        </ul></div>
      <div class="w-block"><h3>Portata del sensore</h3>${SONAR_TIP}</div>
      <div class="w-block"><h3>Idea</h3><p class="tip">${idea}</p></div>`,
    /** fields = [t_us, eco_us] */
    parse(fields, p) {
      const tUs = +fields[0], echo = +fields[1];
      if (!isFinite(tUs) || !isFinite(echo)) return null;
      const vSound = 331.3 + 0.606 * p.tAir;
      const d = echo > 0 ? (vSound * echo) / 2e6 : NaN;
      return { t: tUs / 1e6, echo, d };
    },
    derive(samples, p) {
      const sign = p.direction === 'toward' ? -1 : 1;
      // 1) validità: eco presente e dentro l'intervallo accettato
      const rows = samples.map((s) => ({ ...s, ok: isFinite(s.d) && s.d >= p.dMin && s.d <= p.dMax }));
      // 2) salti anomali: confronto con la mediana dei vicini validi
      if (p.spike > 0) {
        const idx = rows.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
        const flags = [];
        for (let k = 0; k < idx.length; k++) {
          const neigh = [];
          for (let j = Math.max(0, k - 3); j <= Math.min(idx.length - 1, k + 3); j++) if (j !== k) neigh.push(rows[idx[j]].d);
          if (neigh.length >= 2 && Math.abs(rows[idx[k]].d - median(neigh)) > p.spike) flags.push(idx[k]);
        }
        for (const i of flags) rows[i].ok = false;
      }
      // 3) posizione, velocità e accelerazione (regressione locale)
      const good = rows.filter((r) => r.ok);
      const t = good.map((r) => r.t), x = good.map((r) => sign * (r.d - p.origin));
      const { d1, d2 } = localPolyDerivs(t, x, Math.max(1, Math.round(p.window)));
      good.forEach((r, i) => { r.x = x[i]; r.v = d1[i]; r.a = d2[i]; });
      for (const r of rows) if (!r.ok) { r.x = NaN; r.v = NaN; r.a = NaN; }
      return rows;
    },
    views: [
      { id: 'x', label: 'x(t)', key: 'x', yLabel: 'x (m)', sym: 'x' },
      { id: 'v', label: 'v(t)', key: 'v', yLabel: 'v (m/s)', sym: 'v', line: true },
      { id: 'a', label: 'a(t)', key: 'a', yLabel: 'a (m/s²)', sym: 'a', line: true },
      { id: 'echo', label: 'Dato grezzo (eco)', key: 'echo', yLabel: 'tempo di volo (µs)', sym: 'eco', raw: true },
    ],
    defaultVisible: ['x', 'v', 'a'],
    readouts: [{ key: 'x', label: 'Posizione', unit: 'm', digits: 3 }, { key: 'v', label: 'Velocità', unit: 'm/s', digits: 2 }],
    columns: [
      { key: 't', head: 't (s)' }, { key: 'echo', head: 'eco (us)' }, { key: 'd', head: 'distanza (m)' },
      { key: 'ok', head: 'valido' }, { key: 'x', head: 'x (m)' }, { key: 'v', head: 'v (m/s)' }, { key: 'a', head: 'a (m/s2)' },
    ],
    xLabel: 't (s)',
  };
}

const motion = sonarExperiment({
  id: 'motion', title: 'Moto rettilineo', subtitle: 'Uniforme e accelerato · HC-SR04',
  icon: ICON_CART, iconBg: 'var(--cielo-t)', sim: 'incline',
  material: 'Arduino, sensore a ultrasuoni HC-SR04, un carrello (o un libro) con una superficie piatta rivolta verso il sensore.',
  idea: 'Moto accelerato: piano inclinato, carrello che parte da fermo, sensore in cima alla guida. Moto uniforme: carrello spinto su un tavolo orizzontale.',
});

const harmonic = sonarExperiment({
  id: 'harmonic', title: 'Moto armonico', subtitle: 'Oscillazioni · HC-SR04',
  icon: ICON_SPRING, iconBg: 'var(--rosa-t)', sim: 'spring', window: 2,
  material: 'Arduino, sensore a ultrasuoni HC-SR04, una molla con una massa e un cartoncino piatto attaccato sotto la massa.',
  idea: 'Appendi la massa alla molla, metti il sensore a terra rivolto verso l\'alto, sotto il cartoncino. Sposta la massa di qualche centimetro e lasciala oscillare. Per le oscillazioni rapide la lisciatura è già impostata bassa (2 punti per lato).',
});

// ------------------------------------------------------------------
// Smartphone · i sensori del telefono, senza Arduino (come phyphox)
// ------------------------------------------------------------------
const PHONE_HOW = (what) => `
  <div class="w-block"><h3>Senza Arduino</h3><p>Si usano i sensori del telefono: apri Mosaicus <b>sul telefono</b> (Chrome su Android, Safari su iPhone), scegli l'esperimento e premi <b>«Attiva sensori del telefono»</b>. Su iPhone ti verrà chiesto il permesso.</p></div>
  <div class="w-block"><h3>Idea</h3><p class="tip">${what}</p></div>`;

const AXES_NOTE = `<div class="w-block"><h3>Gli assi del telefono</h3><p>Con il telefono in verticale davanti a te: <b>x</b> verso destra, <b>y</b> verso l'alto lungo lo schermo, <b>z</b> uscente dallo schermo verso di te. A telefono fermo sul tavolo a_z ≈ +9,8 m/s²: è la reazione del tavolo, l'accelerometro "sente" l'opposto della gravità. Se leggi −9,8, cambia il parametro «Convenzione dei segni».</p></div>`;

function phoneMotion(base) {
  return {
    topic: 'Smartphone', source: 'phone', lineType: 'P', sim: 'phone-pendulum',
    command: (p) => `START,MOTION,${Math.round(p.interval)}`,
    params: [
      { key: 'interval', label: 'Intervallo di campionamento', unit: 'ms', value: 20, min: 10, step: 5 },
      { key: 'sign', label: 'Convenzione dei segni dell\'accelerometro', type: 'select', value: 'std',
        options: [['std', 'Standard (telefono sul tavolo: a_z ≈ +9,8)'], ['inv', 'Invertita']], advanced: true },
    ],
    /** fields = [t_ms, ax, ay, az, wx, wy, wz] */
    parse(f, p) {
      if (!isFinite(f[0])) return null;
      const s = p.sign === 'inv' ? -1 : 1;
      const [ax, ay, az] = [f[1], f[2], f[3]].map((v) => s * v);
      return { t: f[0] / 1000, ax, ay, az, amod: Math.hypot(ax, ay, az), wx: f[4], wy: f[5], wz: f[6] };
    },
    derive: (rows) => rows,
    xLabel: 't (s)',
    ...base,
  };
}

const phoneAcc = phoneMotion({
  id: 'phoneAcc', title: 'Accelerometro', subtitle: 'Sensori del telefono · a_x, a_y, a_z',
  icon: ICON_PHONE, iconBg: 'var(--lime-t)',
  wiring: AXES_NOTE + PHONE_HOW('Pendolo: appendi il telefono a due spaghi, schermo verso di te, e fallo oscillare. Ascensore: telefono sul pavimento, guarda a_z alla partenza e all\'arrivo. Moto circolare: telefono in un\'insalatiera centrifuga (ben fissato!).'),
  views: [
    { id: 'ax', label: 'a_x(t)', key: 'ax', yLabel: 'a_x (m/s²)', sym: 'a_x', line: true },
    { id: 'ay', label: 'a_y(t)', key: 'ay', yLabel: 'a_y (m/s²)', sym: 'a_y', line: true },
    { id: 'az', label: 'a_z(t)', key: 'az', yLabel: 'a_z (m/s²)', sym: 'a_z', line: true },
    { id: 'amod', label: '|a|(t)', key: 'amod', yLabel: '|a| (m/s²)', sym: '|a|', line: true },
  ],
  defaultVisible: ['ax', 'ay', 'az'],
  readouts: [{ key: 'amod', label: '|a|', unit: 'm/s²', digits: 2 }, { key: 'az', label: 'a_z', unit: 'm/s²', digits: 2 }],
  columns: [{ key: 't', head: 't (s)' }, { key: 'ax', head: 'a_x (m/s2)' }, { key: 'ay', head: 'a_y (m/s2)' }, { key: 'az', head: 'a_z (m/s2)' }, { key: 'amod', head: '|a| (m/s2)' }],
});

const phoneGyro = phoneMotion({
  id: 'phoneGyro', title: 'Giroscopio', subtitle: 'Sensori del telefono · velocità angolare',
  icon: ICON_GYRO, iconBg: 'var(--cielo-t)',
  wiring: AXES_NOTE + PHONE_HOW('Moto circolare uniforme: telefono appoggiato su una sedia girevole o su un giradischi, ω_z costante. Pendolo: il giroscopio mostra l\'oscillazione con il periodo del pendolo, mentre l\'accelerometro lungo il filo oscilla a frequenza doppia. Perché?'),
  views: [
    { id: 'wx', label: 'ω_x(t)', key: 'wx', yLabel: 'ω_x (rad/s)', sym: 'ω_x', line: true },
    { id: 'wy', label: 'ω_y(t)', key: 'wy', yLabel: 'ω_y (rad/s)', sym: 'ω_y', line: true },
    { id: 'wz', label: 'ω_z(t)', key: 'wz', yLabel: 'ω_z (rad/s)', sym: 'ω_z', line: true },
  ],
  defaultVisible: ['wz'],
  readouts: [{ key: 'wz', label: 'ω_z', unit: 'rad/s', digits: 2 }],
  columns: [{ key: 't', head: 't (s)' }, { key: 'wx', head: 'w_x (rad/s)' }, { key: 'wy', head: 'w_y (rad/s)' }, { key: 'wz', head: 'w_z (rad/s)' }],
});

const phoneSound = {
  id: 'phoneSound', topic: 'Onde e suono', source: 'phone', title: 'Frequenza nel tempo', subtitle: 'Effetto Doppler, glissati · microfono',
  icon: ICON_FREQ, iconBg: 'var(--rosa-t)', lineType: 'M', sim: 'phone-sound',
  command: (p) => `START,SOUND,${Math.round(p.interval)}`,
  params: [{ key: 'interval', label: 'Intervallo di campionamento', unit: 'ms', value: 50, min: 30, step: 10 }],
  wiring: '<div class="w-block"><h3>Che cosa fa</h3><p>Ogni 50 ms legge dal microfono <b>un solo numero</b>, la frequenza della componente più forte, e lo mette in un grafico <b>f(t)</b>: serve a vedere come la frequenza <b>cambia nel tempo</b> (effetto Doppler, una sirena, una glissata). Per vedere la <b>forma</b> dell\'onda usa l\'<b>Oscilloscopio</b>.</p></div>' +
    PHONE_HOW('Effetto Doppler: fai girare il telefono che suona (generatore a 1000 Hz) legato a uno spago e misura con un secondo telefono. Battimenti: due diapason leggermente diversi, il livello sonoro "pulsa". Funziona anche sul computer, con il suo microfono.') +
    '<div class="w-block"><h3>Cosa misura</h3><p>La <b>frequenza dominante</b> (la componente più forte dello spettro, tra 50 Hz e 5 kHz) e il <b>livello sonoro relativo</b> in dB: 0 dB è il massimo che il microfono registra, quindi i valori sono negativi.</p></div>',
  parse(f) { return isFinite(f[0]) ? { t: f[0] / 1000, freq: f[1], level: f[2] } : null; },
  derive: (rows) => rows,
  views: [
    { id: 'freq', label: 'f(t)', key: 'freq', yLabel: 'f (Hz)', sym: 'f' },
    { id: 'level', label: 'livello L(t)', key: 'level', yLabel: 'L (dB)', sym: 'L', line: true },
  ],
  defaultVisible: ['freq', 'level'],
  readouts: [{ key: 'freq', label: 'Frequenza', unit: 'Hz', digits: 1 }, { key: 'level', label: 'Livello', unit: 'dB', digits: 1 }],
  columns: [{ key: 't', head: 't (s)' }, { key: 'freq', head: 'f (Hz)' }, { key: 'level', head: 'L (dB)' }],
  xLabel: 't (s)',
};


// ------------------------------------------------------------------
// Onde e suono · strumenti con un pannello proprio (kind), non serie temporali
// ------------------------------------------------------------------
const instrumentBase = (o) => ({ params: [], views: [], columns: [], readouts: [], ...o });

const scopeAudio = instrumentBase({
  id: 'scope', topic: 'Onde e suono', kind: 'scope', source: 'audio', title: 'Oscilloscopio', subtitle: 'Guarda la forma di un suono',
  icon: ICON_SCOPE, iconBg: 'var(--lime-t)',
  wiring: `<div class="w-block"><h3>Sorgenti</h3><p>🎤 il microfono di questo dispositivo · 🎛 il generatore di Mosaicus · 🎻 suoni di esempio, tutti sulla stessa nota.</p></div>
    <div class="w-block"><h3>Idea</h3><p class="tip">Canta una «a» e congela (A). Poi fischia la stessa nota (B), poi suona un diapason o uno strumento (C). Stessa frequenza, forme diverse: il <b>timbro</b> sta nelle armoniche.</p></div>
    <div class="w-block"><h3>Come si legge</h3><p><b>⟷</b> quanti millisecondi entrano nello schermo. <b>↗ ↘</b> trigger: la traccia parte sempre quando il segnale sale (o scende) attraverso lo zero, così sta ferma. <b>f</b> viene dall'<i>autocorrelazione</i>: di quanto devo spostare il segnale perché si sovrapponga a sé stesso? Quello spostamento è il periodo T.</p></div>`,
});

const synthesizer = instrumentBase({
  id: 'synth', topic: 'Onde e suono', kind: 'synth', source: 'arduino', optionalLink: true, title: 'Sintetizzatore', subtitle: 'Crea un suono e suonalo: tastiera, dito, telefono, HC-SR04',
  icon: ICON_SYNTH, iconBg: 'var(--zaff-t)', sim: 'hand',
  wiring: `<div class="w-block"><h3>Timbro</h3><p>Ogni suono periodico è una <b>somma di sinusoidi</b>: la fondamentale f e le armoniche 2f, 3f, 4f… (serie di Fourier). Le forme d'onda e gli strumenti sono solo "ricette" diverse di armoniche: prova a premere <b>Quadra</b> e guarda i cursori.</p></div>
    <div class="w-block"><h3>Inviluppo</h3><p>Anche il modo in cui il suono nasce e si spegne fa riconoscere uno strumento. <b>Pizzicato</b> e <b>Campana</b> si smorzano in modo esponenziale, A(t) = A₀·e<sup>−t/τ</sup>, con τ ≈ 0,25 s e 1,2 s.</p></div>
    <div class="w-block"><h3>Idea</h3><p class="tip">Battimenti: 🎹 Tastiera, secondo suono, Δf = 2 Hz. Soglia dell'udito: scendi fino a 20 Hz. Guarda il suono con l'Oscilloscopio (sorgente Esempi) mentre suona.</p></div>
    <div class="w-block"><h3>📡 Con Arduino</h3>${SCHEMA_HCSR04}<p>Sensore rivolto verso l'alto, la mano sopra tra 5 e 50 cm. Ogni semitono moltiplica f per 2<sup>1/12</sup> ≈ 1,0595: per questo f = 440 · 2<sup>n/12</sup>.</p></div>`,
});

const scopeArduino = instrumentBase({
  id: 'escope', topic: 'Elettromagnetismo', kind: 'scope', source: 'arduino', title: 'Oscilloscopio elettrico', subtitle: 'Guarda una tensione: microfono, bobina',
  icon: ICON_ESCOPE, iconBg: 'var(--cielo-t)', sim: 'scope',
  wiring: `<div class="w-block warn"><h3>⚠ Sicurezza</h3><p>Solo tensioni tra <b>0 e 5 V</b>, prese da Arduino stesso o da una bobina. <b>Mai la rete elettrica</b>, mai batterie oltre 5 V. Le tensioni negative si "sollevano" a 2,5 V con un partitore.</p></div>
    <div class="w-block"><h3>🎤 Microfono del kit</h3>${SCHEMA_MIC}<p class="tip">Il modulo non amplifica molto: il segnale è di qualche decina di mV. Fischia vicino al microfono. Gira la vite del trimmer finché la media è circa 2,5 V.</p></div>
    <div class="w-block"><h3>🧲 Bobina e magnete</h3>${SCHEMA_COIL}<p class="tip">Avvolgi 200–500 spire di filo smaltato su un tubo di cartone e fai cadere dentro un magnete al neodimio. Usa il trigger <b>singolo</b>: vedi la forza elettromotrice indotta, f.e.m. = −dΦ/dt, prima positiva poi negativa. Variante: il motorino del kit al posto della bobina, fatto girare con le dita, diventa una dinamo.</p></div>
    <div class="w-block"><h3>Corrente</h3><p>Arduino misura solo tensioni. Per una corrente si mette in serie una piccola resistenza nota R (resistenza di <i>shunt</i>) e si misura la tensione ai suoi capi: I = V/R (scegli «Corrente» in Grandezza misurata).</p></div>`,
});

export const EXPERIMENTS = [motion, harmonic, cooling, scopeAudio, synthesizer, phoneSound, scopeArduino, phoneAcc, phoneGyro];
export const TOPICS = ['Cinematica', 'Termologia', 'Onde e suono', 'Elettromagnetismo', 'Smartphone'];
export const byId = (id) => EXPERIMENTS.find((e) => e.id === id);
export const defaultParams = (exp) => Object.fromEntries(exp.params.map((p) => [p.key, p.value]));

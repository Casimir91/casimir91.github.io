// Mosaicus — Arduino simulato. Risponde agli stessi comandi del firmware vero
// e produce le stesse righe grezze, così tutta la catena dell'app viene provata.
//
//  • TEMP: patata calda che si raffredda, T = Ta + (T0 − Ta)·e^(−t/θ), letta da un
//    termistore NTC (R0 = 10,2 kΩ, B = 3850 K: non perfetto, da tarare; partitore con 10 kΩ, NTC verso 5 V).
//    Il tempo è accelerato ×30, così in un minuto si vedono ~25 minuti di misura.
//  • SONAR, scenario «incline»: carrello fermo a 0,25 m per 1 s, poi parte su un piano
//    inclinato con a = 0,45 m/s² e si ferma a fine corsa (1,50 m).
//  • SONAR, scenario «spring»: massa appesa a una molla, 0,40 m sopra il sensore,
//    ampiezza 6 cm, periodo 0,90 s, smorzamento γ = 0,08 s⁻¹.
//  In entrambi: rumore ±2 mm, qualche eco perso, qualche eco spurio.
//  • MOTION (sensori del telefono), scenario «phone-pendulum»: telefono appeso come un
//    pendolo (L = 0,60 m, ampiezza 25°, leggero smorzamento). Il giroscopio vede θ'(t) con il
//    periodo del pendolo; l'accelerometro lungo il filo vede g·cosθ + L·θ'², a frequenza doppia.
//  • SOUND (microfono), scenario «phone-sound»: due diapason a 440 Hz e 443 Hz → battimenti a 3 Hz.
//  • SONAR, scenario «hand»: una mano che sale e scende sopra il sensore (theremin), 10–45 cm.
//  • SCOPE (oscilloscopio elettrico): 400 campioni "a raffica" da un segnale scelto con
//    link.scopeSignal: «mic» = fischio a ~880 Hz letto dal modulo microfono (pochi mV attorno
//    a 2,43 V), «coil» = magnete che cade in una bobina (impulso positivo poi negativo attorno a 2,5 V).
//  • TEMP, scenario «cal» (taratura del termometro): il termistore è in un bagno la cui temperatura
//    (link.calTarget) si cambia dal pannello di taratura; la lettura la raggiunge con τ ≈ 2,5 s, in tempo reale.
//  • DHT (DHT11): aria a ~22 °C e ~46 %, un «soffio» ogni 30 s; valori interi e qualche lettura fallita.
//  • IRTEMP (MLX90614): tazza a 80 °C che si raffredda (ε = 0,95, tempo ×30); il sensore legge come se ε = 1.
//  L'app sceglie lo scenario impostando link.scenario prima del comando START.

const FW = '0.1-sim';
const WARP = 30;

function gauss(s) {
  return s * Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());
}

export class SimulatedLink {
  constructor() {
    this.kind = 'simulatore';
    this._lineCb = () => {};
    this._closeCb = () => {};
    this._timer = null;
    this.warp = WARP;
    this.scenario = 'incline';
    this.scopeSignal = 'mic';
    this.calTarget = 21; this.calT = 21;   // bagno della taratura: obiettivo e temperatura attuale (°C)
  }
  onLine(cb) { this._lineCb = cb; }
  onClose(cb) { this._closeCb = cb; }
  async open() { setTimeout(() => this._emit(`#MOSAICUS,${FW},READY`), 300); }
  async close() { this._stop(); this._closeCb(); }
  _emit(line) { this._lineCb(line); }
  _stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  async write(cmd) {
    const c = cmd.trim();
    if (c === 'ID?') return this._emit(`#MOSAICUS,${FW},READY`);
    if (c === 'STOP') { this._stop(); return this._emit('#ACK,STOP'); }
    let m;
    if ((m = c.match(/^START,(MOTION|SOUND),(\d+)$/))) {
      this._stop();
      const interval = Math.max(m[1] === 'MOTION' ? 10 : 30, +m[2]);
      this._emit(`#ACK,START,${m[1]},${interval}`);
      const t0 = performance.now();
      this._timer = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        this._emit(m[1] === 'MOTION' ? simMotion(t) : simSound(t));
      }, interval);
      return;
    }
    if ((m = c.match(/^START,SCOPE,(\d+),(\d+),(\d+),(-?\d+),([01])$/))) {
      this._stop();
      const dt = Math.max(20, +m[1]), n = Math.min(400, Math.max(10, +m[2])), level = +m[3], edge = +m[4], auto = m[5] === '1';
      this._emit(`#ACK,START,SCOPE,${dt}`);
      const t0 = performance.now();
      let nextCoil = 1.2;                                   // s: prossima caduta del magnete
      this._timer = setInterval(() => {
        const tNow = (performance.now() - t0) / 1000;
        const sig = this.scopeSignal;
        // il segnale "continua" nel tempo reale: cerco il trigger a partire da adesso
        const look = sig === 'coil' ? 0.25 : 0.05;          // s di attesa simulata del trigger
        const step = dt / 1e6, hyst = 3;
        const v = (t) => scopeAdc(sig, t, nextCoil);
        let tTrig = null;
        if (edge !== 0) {
          let armed = false;
          for (let t = tNow; t < tNow + look; t += step) {
            const a = v(t), d = edge > 0 ? a - level : level - a;
            if (d < -hyst) armed = true; else if (armed && d >= 0) { tTrig = t; break; }
          }
        }
        if (tTrig == null && !auto) {                       // singolo: niente trigger, niente traccia
          if (sig === 'coil' && tNow > nextCoil + 0.5) nextCoil = tNow + 1.5 + Math.random();
          return;
        }
        const ts = tTrig ?? tNow;
        const vals = Array.from({ length: n }, (_, i) => v(ts + i * step));
        if (sig === 'coil' && tTrig != null) nextCoil = tTrig + 1.5 + Math.random() * 1.5;   // un magnete alla volta
        this._emit(`W,${tTrig == null ? 0 : 1},${dt},${vals.join(',')}`);
      }, 160);
      return;
    }
    if ((m = c.match(/^START,(TEMP|SONAR),(\d+)$/))) {
      this._stop();
      let interval = +m[2];
      if (m[1] === 'TEMP') interval = Math.max(100, interval);
      if (m[1] === 'SONAR') interval = Math.max(30, interval);
      this._emit(`#ACK,START,${m[1]},${interval}`);
      const t0 = performance.now();
      if (m[1] === 'TEMP' && this.scenario === 'cal') {
        let k = 0, last = performance.now();
        this._timer = setInterval(() => {
          const now = performance.now(), dt = (now - last) / 1000; last = now;
          this.calT += (this.calTarget - this.calT) * (1 - Math.exp(-dt / 2.5));
          this._emit(`T,${k++ * interval},${adcAt(this.calT + gauss(0.03), SIM_NTC.R0, SIM_NTC.B).toFixed(2)}`);
        }, interval);
      } else if (m[1] === 'TEMP') {
        // in tempo accelerato l'intervallo reale si riduce di WARP volte
        const realInterval = Math.max(20, interval / this.warp);
        let k = 0;
        this._timer = setInterval(() => {
          const tMs = k * interval; k++;
          this._emit(`T,${tMs},${simAdcTemp(tMs / 1000).toFixed(2)}`);
        }, realInterval);
      } else {
        this._timer = setInterval(() => {
          const tUs = Math.round((performance.now() - t0) * 1000);
          this._emit(`S,${tUs},${simEcho(tUs / 1e6, this.scenario)}`);
        }, interval);
      }
      return;
    }
    if ((m = c.match(/^START,(DHT|IRTEMP),(\d+)$/))) {
      this._stop();
      const dht = m[1] === 'DHT';
      const interval = Math.max(dht ? 1000 : 200, +m[2]);
      this._emit(`#ACK,START,${m[1]},${interval}`);
      const realInterval = dht ? interval : Math.max(20, interval / this.warp);   // IRTEMP: tempo accelerato come il raffreddamento
      let k = 0;
      this._timer = setInterval(() => {
        const tMs = k * interval; k++;
        this._emit(dht ? simDht(tMs / 1000, tMs) : simIr(tMs / 1000, tMs));
      }, realInterval);
      return;
    }
    this._emit(`#ERR,${c}`);
  }
}

/** Conteggio ADC (0…1023) di un NTC (R0, B) a Tc °C, con NTC verso 5 V e 10 kΩ verso GND. */
function adcAt(Tc, R0, B, Rs = 10000) {
  const T = Tc + 273.15, R = R0 * Math.exp(B * (1 / T - 1 / 298.15));
  return Math.min(1023, Math.max(0, (1023 * Rs) / (Rs + R) + gauss(0.3)));
}

// Il termistore del simulatore non è perfetto, come uno vero: R₀ = 10,2 kΩ e B = 3850 K, mentre il modello dell'app
// ne usa 10 kΩ e 3950 K. Senza taratura la temperatura letta sbaglia di circa −0,4 °C a 21 °C e −1,8 °C a 75 °C.
const SIM_NTC = { R0: 10200, B: 3850 };

function simAdcTemp(t) {
  const Ta = 21, T0 = 75, theta = 900;
  const Tc = Ta + (T0 - Ta) * Math.exp(-t / theta) + gauss(0.05);
  return adcAt(Tc, SIM_NTC.R0, SIM_NTC.B);
}

function simEcho(t, scenario) {
  let x;
  if (scenario === 'hand') {
    x = 0.27 + 0.17 * Math.sin(2 * Math.PI * 0.2 * t) + 0.03 * Math.sin(2 * Math.PI * 0.7 * t);
  } else if (scenario === 'spring') {
    const A = 0.06, T = 0.9, g = 0.08;
    x = 0.40 + A * Math.exp(-g * t) * Math.cos((2 * Math.PI * t) / T);
  } else {
    const x0 = 0.25, a = 0.45, tStart = 1.0, xEnd = 1.5;
    x = x0;
    if (t > tStart) x = Math.min(xEnd, x0 + 0.5 * a * (t - tStart) ** 2);
  }
  x += gauss(0.002);
  if (Math.random() < 0.01) return 0;                // eco perso
  if (Math.random() < 0.005) x += 0.3 + Math.random(); // eco spurio
  const v = 331.3 + 0.606 * 20; // aria a 20 °C
  return Math.round((2 * x / v) * 1e6);
}


/** DHT11 simulato: aria a ~22 °C e ~46 % di umidità, con un «soffio» ogni 30 s (UR sale di ~25 %, T di ~1,5 °C, poi decade).
 *  Come il vero: valori interi, qualche lettura fallita (checksum). */
function simDht(t, tMs) {
  if (Math.random() < 0.02) return `H,${tMs},0,0,0,0,0`;
  let rh = 46 + 2 * Math.sin((2 * Math.PI * t) / 90), T = 22.2 + 0.3 * Math.sin((2 * Math.PI * t) / 120);
  for (let tk = 8; tk <= t; tk += 30) {
    const u = t - tk, b = (1 - Math.exp(-u / 1.5)) * Math.exp(-u / 9);
    rh += 40 * b; T += 2.5 * b;
  }
  const h = Math.max(0, Math.min(99, Math.round(rh + gauss(0.4)))), tt = Math.round(T + gauss(0.1));
  return `H,${tMs},${h},0,${tt},0,1`;
}

/** MLX90614 simulato: tazza a 80 °C che si raffredda in una stanza a 21 °C (θ = 900 s, tempo ×30 come nel lab Raffreddamento).
 *  La tazza ha ε = 0,95: il sensore, che legge come se ε = 1, vede T_letta⁴ = ε·T⁴ + (1−ε)·Tₐ⁴, cioè qualche grado in meno
 *  (circa 2,3 °C a 80 °C) finché nell'app non si imposta ε = 0,95. Parole a 16 bit, 0,02 K per conteggio. */
const SIM_IR = { ta: 21, t0: 80, theta: 900, eps: 0.95 };
function simIr(t, tMs) {
  const K = 273.15, Ta = SIM_IR.ta, e = SIM_IR.eps;
  const To = Ta + (SIM_IR.t0 - Ta) * Math.exp(-t / SIM_IR.theta);
  const Tr = Math.pow(e * (To + K) ** 4 + (1 - e) * (Ta + K) ** 4, 0.25) - K;
  return `I,${tMs},${Math.round((Ta + gauss(0.05) + K) / 0.02)},${Math.round((Tr + gauss(0.1) + K) / 0.02)}`;
}

function simMotion(t) {
  const L = 0.6, g = 9.81, th0 = (25 * Math.PI) / 180, gam = 0.03;
  const w0 = Math.sqrt(g / L);
  const th = th0 * Math.exp(-gam * t) * Math.cos(w0 * t);
  const dth = th0 * Math.exp(-gam * t) * (-w0 * Math.sin(w0 * t) - gam * Math.cos(w0 * t));
  const ay = g * Math.cos(th) + L * dth * dth;   // lungo il filo (asse y del telefono)
  const n = (s) => gauss(s);
  const f = (v) => v.toFixed(4);
  return `P,${Math.round(t * 1000)},${f(n(0.05))},${f(ay + n(0.05))},${f(n(0.05))},${f(n(0.01))},${f(n(0.01))},${f(dth + n(0.01))}`;
}

function simSound(t) {
  const f1 = 440, f2 = 443;
  const amp = Math.abs(Math.cos(Math.PI * (f2 - f1) * t)) * 0.3 + 0.002; // inviluppo dei battimenti
  const level = 20 * Math.log10(amp) + gauss(0.4);
  const freq = (f1 + f2) / 2 + gauss(0.3);
  return `M,${Math.round(t * 1000)},${freq.toFixed(2)},${level.toFixed(2)}`;
}

/** Lettura ADC (0…1023) del segnale simulato per l'oscilloscopio elettrico, all'istante t (s). */
function scopeAdc(sig, t, tCoil) {
  let V;
  if (sig === 'coil') {
    // f.e.m. indotta: derivata di una gaussiana (il flusso sale e poi scende), il secondo
    // lobo è più stretto e più alto perché il magnete esce più veloce (sta cadendo)
    const u = t - tCoil;
    const lobe = (c, s, A) => A * Math.exp(-((u - c) ** 2) / (2 * s * s));
    V = 2.5 + lobe(-0.006, 0.004, 0.28) - lobe(0.006, 0.003, 0.36);
  } else {
    // fischio (~880 Hz) con un po' di seconda armonica, letto dal modulo microfono
    const f = 880 * (1 + 0.004 * Math.sin(2 * Math.PI * 0.3 * t));
    const env = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.5 * t);
    V = 2.43 + env * (0.045 * Math.sin(2 * Math.PI * f * t) + 0.012 * Math.sin(4 * Math.PI * f * t + 1));
  }
  V += gauss(0.004);
  return Math.max(0, Math.min(1023, Math.round((V / 5) * 1023)));
}

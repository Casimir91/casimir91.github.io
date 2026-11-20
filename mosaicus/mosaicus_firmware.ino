/*
  Mosaicus — firmware unico per Arduino Uno R3 (e compatibili, es. Elegoo UNO R3)
  ---------------------------------------------------------------------------------
  Copyright (c) 2026 Ermes Ferdinando Rosi — licenza MIT (testo: https://ermesfrosi.it/mosaicus/app/LICENSE.txt)

  Si carica UNA volta sola. Da quel momento è l'app Mosaicus a decidere quale
  esperimento avviare, inviando comandi testuali sulla porta seriale.

  Filosofia: Arduino invia solo grandezze GREZZE (conteggi ADC, tempi di volo in µs,
  byte del DHT11, parole dell'MLX90614).
  Le conversioni in grandezze fisiche (°C, metri, % di umidità) avvengono nell'app, dove i
  parametri (Beta del termistore, temperatura dell'aria, ...) si cambiano senza
  dover ricaricare il firmware. Così gli studenti vedono anche la catena di misura.

  Collegamenti predefiniti (convenzione dei tutorial Elegoo):
    - Termistore NTC (partitore con resistenza da 10 kΩ) -> A0
    - Sensore a ultrasuoni HC-SR04: TRIG -> D12, ECHO -> D11, VCC -> 5V, GND -> GND
    - Oscilloscopio: segnale su A0, SOLO tra 0 e 5 V (mai la rete elettrica!)
    - DHT11 (temperatura e umidità, modulo a 3 piedini): DATA -> D2, VCC -> 5V, GND -> GND
    - MLX90614 (termometro a infrarossi, modulo GY-906): SDA -> A4, SCL -> A5, VIN -> 5V, GND -> GND

  Protocollo (115200 baud, righe terminate da '\n'):
    App -> Arduino                Arduino -> App
    ID?                           #MOSAICUS,<versione>,READY
    START,TEMP,<intervallo_ms>    #ACK,START,TEMP,<intervallo_ms>
                                  T,<t_ms>,<adc_medio>        (adc 0..1023, media di 16 letture)
    START,SONAR,<intervallo_ms>   #ACK,START,SONAR,<intervallo_ms>
                                  S,<t_us>,<eco_us>           (eco_us = 0 se nessun eco)
    START,DHT,<intervallo_ms>     #ACK,START,DHT,<intervallo_ms>      (intervallo ≥ 1000 ms)
                                  H,<t_ms>,<ur_int>,<ur_dec>,<t_int>,<t_dec>,<ok>
                                  (i 4 byte di dati del DHT11, grezzi; ok = 1 se il checksum torna, altrimenti 0)
    START,IRTEMP,<intervallo_ms>  #ACK,START,IRTEMP,<intervallo_ms>   (intervallo ≥ 200 ms)
                                  I,<t_ms>,<Tamb_raw>,<Toggetto_raw>
                                  (parole a 16 bit dell'MLX90614, 0,02 K per conteggio; 0,0 se il sensore non risponde)
    START,SCOPE,<dt_us>,<n>,<livello>,<fronte>,<auto>
                                  #ACK,START,SCOPE,<dt_us>
                                  W,<trig>,<dt_us>,<a0>,<a1>,...,<a(n-1)>   (una riga per traccia)
        dt_us   tempo tra due campioni (≥ 20 µs); n campioni (≤ 400) letti da A0
        livello soglia del trigger in conteggi ADC (0..1023); fronte 1 = salita, -1 = discesa, 0 = nessuno
        auto    1 = se il trigger non arriva entro 120 ms cattura comunque (trig = 0); 0 = aspetta
    STOP                          #ACK,STOP
    (comando sconosciuto)         #ERR,<testo>

  I tempi t sono misurati dall'istante del comando START.
  Licenza: MIT — vedi LICENSE.
*/

#include <Wire.h>

const char *FW_VERSION = "0.3";

const uint8_t PIN_THERM = A0;
const uint8_t PIN_TRIG  = 12;
const uint8_t PIN_ECHO  = 11;
const uint8_t PIN_DHT   = 2;       // DHT11: linea dati (il modulo a 3 piedini ha già la resistenza di pull-up)
const uint8_t MLX_ADDR  = 0x5A;    // MLX90614: indirizzo I²C di fabbrica (SDA = A4, SCL = A5)

const uint8_t  ADC_SAMPLES    = 16;      // sovracampionamento per ridurre il rumore
const unsigned long ECHO_TIMEOUT_US = 30000UL;  // ~5 m andata e ritorno

enum Mode { IDLE, TEMP, SONAR, SCOPE, DHT, IRTEMP };
Mode mode = IDLE;

unsigned long intervalMs = 1000;
unsigned long t0Ms = 0;        // origine dei tempi (millis) per TEMP
unsigned long t0Us = 0;        // origine dei tempi (micros) per SONAR
unsigned long nextMs = 0;      // prossimo campionamento (millis)

// oscilloscopio
const int SCOPE_MAX = 400;
const int SCOPE_HYST = 3;          // isteresi del trigger (conteggi ADC): ignora il rumore
uint16_t scopeBuf[SCOPE_MAX];
unsigned int scopeDt = 100;        // µs tra due campioni
int scopeN = SCOPE_MAX;
int scopeLevel = 512;
int scopeEdge = 1;
bool scopeAuto = true;

char cmdBuf[48];
uint8_t cmdLen = 0;

void sendHello() {
  Serial.print(F("#MOSAICUS,"));
  Serial.print(FW_VERSION);
  Serial.println(F(",READY"));
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  delay(50);
  sendHello();
}

// ---------- misure ----------

float readThermistorAdc() {
  unsigned long sum = 0;
  for (uint8_t i = 0; i < ADC_SAMPLES; i++) {
    sum += analogRead(PIN_THERM);
  }
  return sum / (float)ADC_SAMPLES;
}

// Restituisce la durata dell'eco in µs (0 se nessun eco) e, in tStampUs,
// l'istante (relativo a t0Us) a cui attribuire la misura: metà del tempo di volo.
unsigned long readSonarUs(unsigned long &tStampUs) {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  unsigned long tTrig = micros();
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long echo = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  tStampUs = (tTrig - t0Us) + echo / 2;
  return echo;
}

// ---------- DHT11 ----------
// Protocollo a un filo: Arduino tiene la linea bassa ≥ 18 ms e la rilascia; il sensore risponde con
// 80 µs bassi + 80 µs alti, poi invia 40 bit (umidità int, umidità dec, T int, T dec, checksum).
// Ogni bit = ~50 µs bassi + una durata alta: ~27 µs = 0, ~70 µs = 1. Si confronta la durata alta con
// quella bassa dello stesso bit (conteggio di cicli, non micros(): durante la lettura gli interrupt sono spenti).
volatile uint8_t *dhtPort;
uint8_t dhtMask;

uint16_t dhtPulse(bool level) {
  uint16_t n = 0;
  while (((*dhtPort & dhtMask) != 0) == level) {
    if (++n >= 600) return 0;          // timeout (circa 300 µs)
  }
  return n ? n : 1;
}

bool readDht(uint8_t d[5]) {
  for (uint8_t i = 0; i < 5; i++) d[i] = 0;
  dhtPort = portInputRegister(digitalPinToPort(PIN_DHT));
  dhtMask = digitalPinToBitMask(PIN_DHT);
  pinMode(PIN_DHT, OUTPUT);
  digitalWrite(PIN_DHT, LOW);
  delay(20);                            // inizio: linea bassa per ≥ 18 ms
  noInterrupts();
  digitalWrite(PIN_DHT, HIGH);
  pinMode(PIN_DHT, INPUT_PULLUP);       // rilascia la linea
  delayMicroseconds(55);
  bool ok = dhtPulse(false) && dhtPulse(true);       // risposta del sensore
  for (uint8_t i = 0; ok && i < 40; i++) {
    uint16_t lo = dhtPulse(false), hi = dhtPulse(true);
    if (!lo || !hi) { ok = false; break; }
    d[i / 8] <<= 1;
    if (hi > lo) d[i / 8] |= 1;
  }
  interrupts();
  return ok && d[4] == (uint8_t)(d[0] + d[1] + d[2] + d[3]);
}

// ---------- MLX90614 (termometro a infrarossi, I²C/SMBus) ----------
// Registri: 0x06 = temperatura ambiente, 0x07 = temperatura dell'oggetto; ogni conteggio vale 0,02 K.
// Il sensore invia 3 byte: parola a 16 bit (prima il byte basso) e PEC (CRC-8, polinomio 0x07).
bool wireOn = false;

uint8_t crc8(uint8_t crc, uint8_t b) {
  crc ^= b;
  for (uint8_t i = 0; i < 8; i++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  return crc;
}

bool mlxRead(uint8_t reg, uint16_t &raw) {
  Wire.beginTransmission(MLX_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;           // nessuna risposta: sensore scollegato?
  if (Wire.requestFrom(MLX_ADDR, (uint8_t)3) != 3) return false;
  uint8_t lo = Wire.read(), hi = Wire.read(), pec = Wire.read();
  uint8_t crc = crc8(0, (uint8_t)(MLX_ADDR << 1));
  crc = crc8(crc, reg);
  crc = crc8(crc, (uint8_t)((MLX_ADDR << 1) | 1));
  crc = crc8(crc, lo);
  crc = crc8(crc, hi);
  if (crc != pec) return false;
  raw = ((uint16_t)hi << 8) | lo;
  return true;
}

// ---------- oscilloscopio ----------
// ADC più veloce: prescaler 16 → clock dell'ADC a 1 MHz, una conversione in ~16 µs
// (con il valore predefinito 128 servono ~112 µs). Si perde un po' di precisione, ma per
// una forma d'onda va benissimo. Per il termistore si torna al prescaler 128.
void adcFast(bool on) {
  ADCSRA = (ADCSRA & ~0x07) | (on ? 0x04 : 0x07);
}

// Attende il trigger (o il tempo massimo in modo auto), poi legge n campioni a passo fisso.
// Restituisce false se è arrivato un comando durante l'attesa.
bool scopeCapture(bool &fired) {
  fired = false;
  bool armed = false;
  unsigned long w0 = millis();
  if (scopeEdge != 0) {
    while (true) {
      int v = analogRead(A0);
      if (scopeEdge > 0) {
        if (v < scopeLevel - SCOPE_HYST) armed = true;
        else if (armed && v >= scopeLevel) { fired = true; break; }
      } else {
        if (v > scopeLevel + SCOPE_HYST) armed = true;
        else if (armed && v <= scopeLevel) { fired = true; break; }
      }
      if (scopeAuto && millis() - w0 > 120) break;
      if (Serial.available() > 0) return false;   // es. STOP: non resto bloccato
    }
  }
  unsigned long start = micros();
  for (int i = 0; i < scopeN; i++) {
    while ((unsigned long)(micros() - start) < (unsigned long)i * scopeDt) { }
    scopeBuf[i] = analogRead(A0);
  }
  return true;
}

void scopeSend(bool fired) {
  Serial.print(F("W,"));
  Serial.print(fired ? 1 : 0);
  Serial.print(',');
  Serial.print(scopeDt);
  for (int i = 0; i < scopeN; i++) {
    Serial.print(',');
    Serial.print(scopeBuf[i]);
  }
  Serial.println();
}

void startScope(char *args) {
  // args: "<dt_us>,<n>,<livello>,<fronte>,<auto>"
  long v[5] = {100, SCOPE_MAX, 512, 1, 1};
  char *p = args;
  for (uint8_t k = 0; k < 5 && p && *p; k++) {
    v[k] = atol(p);
    p = strchr(p, ',');
    if (p) p++;
  }
  scopeDt = (unsigned int)constrain(v[0], 20L, 20000L);
  scopeN = (int)constrain(v[1], 10L, (long)SCOPE_MAX);
  scopeLevel = (int)constrain(v[2], 0L, 1023L);
  scopeEdge = v[3] > 0 ? 1 : (v[3] < 0 ? -1 : 0);
  scopeAuto = v[4] != 0;
  adcFast(true);
  mode = SCOPE;
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.print(F("#ACK,START,SCOPE,"));
  Serial.println(scopeDt);
}

// ---------- comandi ----------

void startMode(Mode m, long interval) {
  if (m == TEMP && interval < 100) interval = 100;      // termistore: almeno 100 ms
  if (m == SONAR && interval < 30) interval = 30;       // HC-SR04: almeno 30 ms tra impulsi
  if (m == DHT && interval < 1000) interval = 1000;     // DHT11: al massimo una lettura al secondo
  if (m == IRTEMP && interval < 200) interval = 200;    // MLX90614: il sensore aggiorna qualche volta al secondo
  if (interval > 600000L) interval = 600000L;           // al massimo 10 minuti
  intervalMs = (unsigned long)interval;
  mode = m;
  t0Ms = millis();
  t0Us = micros();
  nextMs = t0Ms;
  if (m == IRTEMP && !wireOn) {
    Wire.begin();
#ifdef WIRE_HAS_TIMEOUT
    Wire.setWireTimeout(3000, true);    // se il sensore manca, non restare bloccati
#endif
    wireOn = true;
  }
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.print(F("#ACK,START,"));
  Serial.print(m == TEMP ? F("TEMP,") : m == SONAR ? F("SONAR,") : m == DHT ? F("DHT,") : F("IRTEMP,"));
  Serial.println(intervalMs);
}

void handleCommand(char *cmd) {
  if (strcmp(cmd, "ID?") == 0) {
    sendHello();
  } else if (strcmp(cmd, "STOP") == 0) {
    mode = IDLE;
    adcFast(false);
    digitalWrite(LED_BUILTIN, LOW);
    Serial.println(F("#ACK,STOP"));
  } else if (strncmp(cmd, "START,TEMP,", 11) == 0) {
    adcFast(false);
    startMode(TEMP, atol(cmd + 11));
  } else if (strncmp(cmd, "START,SCOPE,", 12) == 0) {
    startScope(cmd + 12);
  } else if (strncmp(cmd, "START,SONAR,", 12) == 0) {
    startMode(SONAR, atol(cmd + 12));
  } else if (strncmp(cmd, "START,DHT,", 10) == 0) {
    adcFast(false);
    startMode(DHT, atol(cmd + 10));
  } else if (strncmp(cmd, "START,IRTEMP,", 13) == 0) {
    adcFast(false);
    startMode(IRTEMP, atol(cmd + 13));
  } else if (cmdLen > 0) {
    Serial.print(F("#ERR,"));
    Serial.println(cmd);
  }
}

void pollSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      cmdBuf[cmdLen] = '\0';
      handleCommand(cmdBuf);
      cmdLen = 0;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    }
  }
}

// ---------- ciclo principale ----------

void loop() {
  pollSerial();
  if (mode == IDLE) return;

  if (mode == SCOPE) {
    bool fired;
    if (scopeCapture(fired)) scopeSend(fired);
    return;
  }

  unsigned long now = millis();
  if ((long)(now - nextMs) < 0) return;   // non è ancora il momento (gestisce l'overflow)
  nextMs += intervalMs;                    // scansione regolare, senza deriva

  if (mode == TEMP) {
    unsigned long t = now - t0Ms;
    float adc = readThermistorAdc();
    Serial.print(F("T,"));
    Serial.print(t);
    Serial.print(',');
    Serial.println(adc, 2);
  } else if (mode == SONAR) {
    unsigned long tUs;
    unsigned long echo = readSonarUs(tUs);
    Serial.print(F("S,"));
    Serial.print(tUs);
    Serial.print(',');
    Serial.println(echo);
  } else if (mode == DHT) {
    uint8_t d[5];
    bool ok = readDht(d);
    Serial.print(F("H,"));
    Serial.print(now - t0Ms);
    for (uint8_t i = 0; i < 4; i++) {
      Serial.print(',');
      Serial.print(ok ? d[i] : 0);
    }
    Serial.print(',');
    Serial.println(ok ? 1 : 0);
  } else if (mode == IRTEMP) {
    uint16_t ta = 0, to = 0;
    if (!(mlxRead(0x06, ta) && mlxRead(0x07, to))) { ta = 0; to = 0; }
    Serial.print(F("I,"));
    Serial.print(now - t0Ms);
    Serial.print(',');
    Serial.print(ta);
    Serial.print(',');
    Serial.println(to);
  }

  // Se siamo rimasti molto indietro (es. intervallo troppo breve), riallinea.
  if ((long)(millis() - nextMs) > (long)(5 * intervalMs)) nextMs = millis() + intervalMs;
}

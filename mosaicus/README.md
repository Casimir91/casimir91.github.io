# Mosaicus

**Micro-laboratorio di fisica.** Un'app web installabile (PWA) che funziona offline. Gli strumenti di misura sono tanti: i sensori collegati ad Arduino e il suono, con oscilloscopio e **Synth**. Vedi i dati in tempo reale, li analizzi (retta a occhio, fit con incertezze, righello), li conservi in un archivio locale e li esporti in Excel o Fogli Google.

Software libero, licenza MIT.

## Lab

| Argomento | Lab | Sensore | Grandezze |
|---|---|---|---|
| Cinematica | **Moto rettilineo** (uniforme e accelerato) | ultrasuoni HC-SR04 | x(t), v(t), a(t) |
| Cinematica | **Moto armonico** (massa e molla) | ultrasuoni HC-SR04 | x(t), v(t), a(t) |
| Termologia | **Raffreddamento** (legge di Newton), con **taratura del termometro** a due punti | termistore NTC 10 kΩ | T(t), ln(T − Tₐ) |
| Termologia | **Umidità e temperatura** | DHT11 (pin 2) | T(t), UR(t), temperatura di rugiada (formula di Magnus) |
| Termologia | **Termometro a infrarossi** (senza contatto) | MLX90614, modulo GY-906 (I²C: A4 = SDA, A5 = SCL) | T dell'oggetto(t), T ambiente(t), ln(Tₒ − Tₐ), con correzione di emissività ε |
| Onde e suono | **Oscilloscopio** | microfono, suoni di esempio e uscita dell'app (Synth) | forma d'onda con trigger, spettro, armoniche, f, T, nota |
| in evidenza | **Synth** | tastiera, dito, inclinazione del telefono o HC-SR04 | timbro come somma di 8 armoniche (forme d'onda e strumenti), inviluppo, volume pareggiato, f = 440·2^(n/12), 20 scale su tonica a scelta (maggiore, modi, minori, pentatoniche, araba, napoletana, blues…) con ascolto al tocco, battimenti |
| Onde e suono | **Frequenzimetro** | microfono del telefono (o del computer) | frequenza dominante e livello nel tempo |
| Elettromagnetismo | **Oscilloscopio elettrico** | tensione su A0 (modulo microfono, bobina e magnete) | 400 campioni a raffica, trigger, V oppure I = V/R |

**Tema chiaro o scuro**: pulsante ☾/☀ in alto. Senza una scelta, l'app segue l'impostazione del sistema. Il tema scuro usa solo verdi, lime, bianchi e grigi.

L'app è impaginata anche per schermi piccoli: sul telefono la barra in basso porta a **Lab**, **Misura** ed **Elaborazione**. Il Synth è in cima all'elenco, gli altri lab sono raggruppati per argomento (si aprono con «+»). Accelerometro e giroscopio del telefono restano nel codice ma sono nascosti (`hidden: true` in `experiments.js`).

## Come si usa

**Pagina Misura**: acquisire, guardare, scegliere il tratto.

1. **Una volta sola per ogni Arduino:** apri `mosaicus_firmware.ino` con l'IDE di Arduino (se chiede di metterlo in una cartella con lo stesso nome, rispondi di sì) e caricalo sulla scheda.
2. Apri Mosaicus con **Chrome o Edge** su computer. Firefox e Safari non supportano la Web Serial API.
3. Premi **Collega Arduino** e scegli la porta, oppure usa il **Simulatore**, che ha uno scenario per ogni lab.
4. Scegli il lab dall'elenco, controlla i collegamenti e premi **Avvia**. Premi **Ferma** per terminare: la misura finisce da sola nel **Quaderno delle misure**.
5. I grafici sono **impilati e sincronizzati**: stesso asse dei tempi, stesso zoom, stessa selezione, mirino comune.
6. Per scegliere un tratto **trascini** su un grafico. Poi:
   - **Invia il tratto a Elaborazione →** lo manda all'altra pagina;
   - **Esporta selezione** lo salva in Excel, CSV o PNG.

**Taratura del termometro** (Raffreddamento, dalla v0.14): prima di ▶ Avvia il percorso guidato propone «Tara il termometro». Due punti: ghiaccio fondente (0 °C) e un bagno caldo letto con un termometro di riferimento (almeno 15 °C più in alto). Per ogni punto l'app mostra la lettura dal vivo, dice quando è stabile e registra la media degli ultimi 3 s. Dai due punti calcola la retta T = a·T_letta + b, con l'incertezza tipo (u = δ/√12 sulla scala del termometro di riferimento, 0,1 °C per il ghiaccio fondente). a e b sono i parametri avanzati «Taratura» e finiscono nell'export Excel; la taratura vale 12 ore, poi la guida la richiede di nuovo. Nel simulatore il termistore ha R₀ = 10,2 kΩ e B = 3850 K (il modello usa 10 kΩ e 3950 K), quindi senza taratura sbaglia di circa −0,4 °C a 21 °C e −1,8 °C a 75 °C.

**Pagina Elaborazione**: lavorare sul grafico. Ogni tratto salvato è un riquadro, con:
- **assi a scelta** tra tutte le colonne, comprese quelle calcolate;
- **Retta a occhio**, il più possibile analogica:
  1. lo studente trascina due maniglie finché la retta media i punti (l'app conta quanti stanno sopra e quanti sotto);
  2. sceglie due punti **sulla retta**, agganciati alla griglia come su carta millimetrata, e calcola Δy/Δx;
  3. il confronto con la retta dei minimi quadrati calcolata dal computer;
- **Tangente** in un punto misurato, con il suo triangolo: è la velocità istantanea sulla x(t);
- **Fit**: retta, polinomi 2–4, esponenziale con o senza asintoto, potenza, sinusoide smorzata. Prima la grandezza fisica con incertezza, poi le spiegazioni a scomparsa (parametri, origine dell'incertezza, R²);
- **Verifica il modello**: grafico dei residui e test delle successioni (Wald–Wolfowitz), con un verdetto in italiano;
- **Foglio dei dati**: colonne affiancate, x e y scelti dall'intestazione, «＋ Nuova colonna» con formula (per esempio `ln(T − 21)`, `x^2`, `√(2·g·h)`) e anteprima del risultato mentre si scrive;
- **Righello**: due cursori verticali e il numero N di periodi tra i due: T = Δt/N, f = 1/T. Sullo spettro misura la distanza tra le armoniche (f₀);
- una **spunta** per scegliere i riquadri da esportare. L'export produce un unico file Excel con i fogli Riepilogo, Analisi e uno per riquadro.

**Umidità e temperatura** e **Termometro a infrarossi** (dalla v0.15, firmware 0.3, nessuna libreria da installare):
- **DHT11** (modulo a 3 piedini: DATA → pin 2, VCC → 5 V, GND → GND). Il sensore dà valori interi (risoluzione 1 °C e 1 %; accuratezza dichiarata ±2 °C e ±5 %): la curva sale a gradini, ed è un buon momento per distinguere **risoluzione** e **accuratezza**. Una lettura al secondo al massimo. Il firmware invia i 4 byte grezzi e un flag di checksum: le letture sbagliate vengono scartate. Il **punto di rugiada** si calcola nell'app con la formula di Magnus (b = 17,62; c = 243,12 °C), valida da −45 a 60 °C. Nel simulatore ogni 30 s c'è un «soffio».
- **MLX90614** (modulo GY-906: SDA → A4, SCL → A5, VIN → 5 V, GND → GND; controlla la tensione ammessa dal tuo modulo). Misura la temperatura dell'oggetto puntato e quella dell'ambiente, senza contatto. Il firmware legge le due parole a 16 bit (0,02 K per conteggio, controllo del PEC) e l'app le converte in °C. Il sensore legge come se l'oggetto fosse un corpo nero (ε = 1); per un oggetto con ε < 1 l'app corregge con la legge di Stefan–Boltzmann: T_letta⁴ = ε·T⁴ + (1 − ε)·T_fondo⁴ (kelvin), prendendo come fondo la temperatura ambiente misurata. Il parametro ε è nel pannello Parametri. Nel simulatore la tazza ha ε = 0,95: con ε = 1 la lettura è circa 2,3 °C più bassa a 80 °C. Con la temperatura ambiente misurata dal sensore stesso, ln(Tₒ − Tₐ) è una retta se vale la legge di Newton.

**Onde e suono** (pannelli propri, non grafici nel tempo):
- **Oscilloscopio**: sorgente 🎤 microfono o 🎻 esempi (diapason, flauto, clarinetto, violino, voce, tutti su La₃ = 220 Hz; suonano solo con ▶ Avvia e tacciono con ❚❚ Pausa o ❄ Congela); gli esempi leggono l'uscita audio dell'app, quindi mostrano anche il Synth se suona. Finestra da 2 a 50 ms, trigger sul fronte di salita o di discesa, spettro con le armoniche numerate, frequenza dall'**autocorrelazione**, nota e scarto in centesimi. **❄ Congela** conserva fino a tre tracce A, B, C sovrapposte e allineate sul trigger; «stessa altezza» le normalizza per confrontare le forme. Le tracce (e gli spettri) vanno in Elaborazione, dove si apre il righello.
- **Synth** (generatore e strumento musicale riuniti): il **timbro** è una somma di 8 armoniche con lo schermo della forma d'onda; le forme d'onda classiche (sinusoide, quadra, triangolare, dente di sega) e gli strumenti (flauto, clarinetto, violino, voce, organo) sono "ricette" di armoniche; toccando un cursore si crea una forma libera. Tre **inviluppi**: continuo, pizzicato (τ ≈ 0,25 s), campana (τ ≈ 1,2 s). Il **volume è pareggiato** sul valore efficace (RMS), così si confronta il timbro e non l'intensità. Si suona con 🎹 tastiera (frequenza esatta, secondo suono per i battimenti; continua a suonare cambiando lab), ✋ nastro, 📱 inclinazione o 📡 HC-SR04 (5–50 cm, più vicina = più acuta).
- **Oscilloscopio elettrico**: serve il firmware 0.2 o successivo. Solo 0–5 V, mai la rete elettrica; segnali negativi sollevati a 2,5 V con un partitore (schema nell'app).

## Versioni

Numerazione *a.b.c* (versionamento semantico). La versione dell'app e quella del firmware atteso stanno in `app/version.json`; la pagina del sito e la scheda della Toolbox la leggono da lì. Devono coincidere con `APP_VERSION` e `FIRMWARE_VERSION` in `app/js/app.js`, con `CACHE` in `app/sw.js` e con `FW_VERSION` nel firmware: lo controlla `node tests/version.test.mjs`. Quando Arduino si collega, l'app confronta la versione del firmware sulla scheda con quella attesa e, se è più vecchia, chiede di aggiornarla.

## Pubblicazione

L'app è statica: basta copiare la cartella `app/` su un server **HTTPS**. Web Serial e service worker richiedono un contesto sicuro, cioè `https://` oppure `http://localhost`.

- **Prova in locale:** `cd app && python3 -m http.server 8000`, poi apri <http://localhost:8000>.
- **Sul sito Quarto:** l'app vive già nel sito, in `mosaicus/app/`, ed è dichiarata tra le risorse in `_quarto.yml` (`mosaicus/app/**`, `mosaicus/mosaicus_firmware.ino`, `mosaicus/media/*`). Esiste una sola copia: si modifica lì, senza ricopiare nulla. Test e strumenti stanno accanto, in `mosaicus/tests/` e `mosaicus/tools/`, e non vengono pubblicati.
- **Installazione per gli studenti:** dopo la prima apertura, dal menu di Chrome/Edge scegli «Installa Mosaicus». Da quel momento l'app si apre come un programma e funziona anche senza rete.
- **Aggiornamenti:** se modifichi i file, cambia `CACHE` in `sw.js` (es. `mosaicus-v0.2`), altrimenti i browser continuano a usare la versione già salvata. Chi usa l'app (anche installata) la aggiorna col pulsante **«↻ Aggiorna l'app»** in fondo alla pagina: cerca la versione nuova, la scarica e ricarica; le misure e le impostazioni restano. Quando l'app torna in primo piano cerca da sola e, se trova qualcosa, mostra l'avviso «Ricarica» (non ricarica mai da sola, per non interrompere una misura).

## Architettura

```
Arduino (firmware unico)  ──USB/seriale 115200──▶  Mosaicus (browser)
  invia dati GREZZI                                   converte, analizza, salva, esporta
  T,<t_ms>,<adc>                                      parametri modificabili anche dopo
  S,<t_us>,<eco_us>                                   la misura (i dati grezzi restano)
```

Il firmware invia **solo grandezze grezze**: conteggi ADC, tempi di volo in µs, byte del DHT11, parole dell'MLX90614. Le conversioni (equazione Beta del termistore, velocità del suono in funzione della temperatura) avvengono nell'app. Questo ha due conseguenze:
- i parametri (B, temperatura dell'aria, origine…) si possono correggere **anche dopo** la misura, e i dati vengono ricalcolati;
- gli studenti vedono la **catena di misura** completa: le viste «Dato grezzo» e il «Monitor seriale» mostrano cosa arriva davvero da Arduino.

| File | Ruolo |
|---|---|
| `mosaicus_firmware.ino` | sketch unico, senza librerie esterne |
| `app/js/experiments.js` | catalogo dei lab: parametri, conversioni, viste, colonne |
| `app/js/analysis.js` | minimi quadrati con incertezze, derivate per regressione locale, Levenberg–Marquardt |
| `app/js/fits.js` | motore di fit unico: modelli, incertezze, equazioni, test delle successioni |
| `app/js/workbench.js` | pagina Elaborazione: riquadri, retta a mano, tangente, fit, export |
| `app/js/formula.js` | formule delle colonne calcolate (analizzatore senza `eval`) |
| `app/js/chart.js` | grafico su canvas con selezione dell'intervallo e cursori trascinabili |
| `app/js/dsp.js` | FFT, spettro, autocorrelazione, trigger, armoniche, note e scale (funzioni pure, testate) |
| `app/js/audio.js` | motore Web Audio condiviso: uscita comune con analizzatore "monitor", microfono, voci |
| `app/js/scope.js` / `screen.js` | oscilloscopio (audio e Arduino) e schermo a divisioni |
| `app/js/synth.js` | Synth: timbro (armoniche), inviluppo, volume pareggiato, tastiera e controlli con la mano |
| `app/js/serial.js` / `phone.js` / `simulator.js` | Arduino (Web Serial), sensori del telefono (DeviceMotion, Web Audio) e simulatore: stessa interfaccia e stesso protocollo |
| `app/js/storage.js` | Quaderno delle misure e riquadri di Elaborazione (IndexedDB) |
| `app/js/export.js` | CSV e XLSX scritti a mano (zip "store" + Office Open XML) |

**Velocità e accelerazione** sono calcolate con una **regressione polinomiale locale**: per ogni punto si adatta una parabola ai 2h+1 punti vicini (Savitzky–Golay generalizzato a campionamento non uniforme). Il parametro «Lisciatura» è h. Gli echi spuri del sensore a ultrasuoni vengono scartati confrontando ogni punto con la mediana dei vicini.

## Protocollo seriale

| App → Arduino | Arduino → App |
|---|---|
| `ID?` | `#MOSAICUS,0.3,READY` |
| `START,TEMP,<ms>` | `#ACK,START,TEMP,<ms>` poi righe `T,<t_ms>,<adc>` |
| `START,SONAR,<ms>` | `#ACK,START,SONAR,<ms>` poi righe `S,<t_us>,<eco_us>` |
| `START,SCOPE,<dt_us>,<n>,<livello>,<fronte>,<auto>` | `#ACK,START,SCOPE,<dt_us>` poi una riga per traccia `W,<trig>,<dt_us>,<a0>,…` (n ≤ 400 conteggi ADC) |
| `START,DHT,<ms>` (≥ 1000) | `#ACK,START,DHT,<ms>` poi righe `H,<t_ms>,<ur_int>,<ur_dec>,<t_int>,<t_dec>,<ok>` (4 byte del DHT11; ok = 1 se il checksum torna) |
| `START,IRTEMP,<ms>` (≥ 200) | `#ACK,START,IRTEMP,<ms>` poi righe `I,<t_ms>,<Tamb_raw>,<Toggetto_raw>` (0,02 K per conteggio; `0,0` se il sensore non risponde) |
| `STOP` | `#ACK,STOP` |

## Aggiungere un lab

1. Nel firmware: un nuovo comando `START,<NOME>,<ms>` e un nuovo tipo di riga (es. `L,<t>,<valore>`).
2. In `experiments.js`: un nuovo oggetto con `lineType`, `command`, `params`, `parse`, `derive`, `views`, `columns`.
3. Facoltativo: un nuovo modello in `fits.js` e una simulazione in `simulator.js`.

## Test

```
node tests/analysis.test.mjs   # derivate e fit di base su dati sintetici con rumore noto
node tests/fits.test.mjs       # tutti i modelli del motore di fit (valore vero entro 4σ)
node tests/formula.test.mjs    # formule delle colonne calcolate
node tests/dsp.test.mjs        # FFT, spettro, frequenza (8 timbri × 4 note), trigger, armoniche, note
node tests/sensori.test.mjs    # DHT11 e MLX90614: conversioni, emissività, punto di rugiada, giro completo col simulatore
node tests/version.test.mjs    # le versioni coincidono ovunque
node tests/xlsx.test.mjs       # genera /tmp/mosaicus_test.xlsx (da aprire con Excel/LibreOffice)
```

## Note e limiti noti (v0.7)

- Il firmware è stato controllato sintatticamente ma va ancora provato su una scheda vera (in particolare le modalità SCOPE, DHT e IRTEMP). Della v0.3 sono stati provati al computer solo il calcolo del PEC dell'MLX90614 e il protocollo col simulatore; la decodifica a impulsi del DHT11 non è stata provata su un sensore vero.
- Il modulo microfono del kit amplifica poco: il segnale su A0 è di qualche decina di mV, pochi conteggi ADC.
- Gli esempi dell'oscilloscopio sono timbri sintetici plausibili, non registrazioni di strumenti veri.
- Quaderno e riquadri vivono nel browser: se si cancellano i dati di navigazione, si perdono. Per conservarli, esportali.
- Le schede Elegoo usano il convertitore USB-seriale CH340: se Windows non mostra la porta, serve il driver WCH (CH341SER).

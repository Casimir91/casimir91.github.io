---
description: Commit separati per argomento, push su main e pubblicazione del sito (quarto publish gh-pages)
argument-hint: [contesto opzionale per i messaggi di commit]
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git log:*), Bash(git branch:*), Bash(git push origin main), Bash(node mosaicus/tests/:*), Bash(quarto publish gh-pages:*)
---

Pubblica le modifiche fatte al sito. Contesto aggiunto dall'utente (può essere vuoto): $ARGUMENTS

## Stato attuale

- Ramo: !`git branch --show-current`
- File cambiati: !`git status --short`
- Riepilogo modifiche: !`git diff HEAD --stat`
- Ultimi commit (per lo stile del messaggio): !`git log --oneline -5`

## Procedura, in quest'ordine

1. **Controlla le modifiche.** Leggi `git diff HEAD` per capire che cosa è cambiato davvero. Se non c'è niente da committare, dillo e chiedi se pubblicare comunque (passa direttamente al punto 7). Segnala se tra i file cambiati c'è qualcosa di inatteso (file enormi, credenziali, `.env`): in quel caso fermati e chiedi.
2. **Ramo.** Se il ramo non è `main`, fermati e chiedi.
3. **Test di Mosaicus.** Se sono cambiati file in `mosaicus/`, lancia i test uno per volta: `node mosaicus/tests/<nome>.test.mjs` per ogni file in `mosaicus/tests/`. Se anche uno solo fallisce, fermati: mostra l'errore così com'è e non fare commit, push né pubblicazione. (`version.test.mjs` controlla che `version.json`, `APP_VERSION`, `FIRMWARE_VERSION`, `CACHE` in `sw.js` e `FW_VERSION` nel firmware coincidano.)
4. **Commit separati, uno per argomento.** Raggruppa i file cambiati così:
   - **Mosaicus**: tutto ciò che sta in `mosaicus/`;
   - **Python Lab**: `toolbox/python*.qmd`, `toolbox/tealab.py`, `toolbox/lab.css`, `toolbox/lab.js`;
   - **Toolbox**: gli altri file in `toolbox/`;
   - **altre aree**: una per cartella principale (`stories/`, `didattica/…`, `edtech/`, `libro/`, ecc.); i file in radice del sito (`_quarto.yml`, `.gitignore`, ecc.) insieme, in un commit "Sito: …".
   
   Non usare `git add -A`: per ogni gruppo `git add -- <percorsi del gruppo>`, poi `git commit`. Messaggio **in italiano**, nello stile dei commit recenti: area, due punti, descrizione breve (es. "Terza: aggiunti practice test e mock test (13/10) con soluzioni"). Per Mosaicus indica la versione letta da `mosaicus/app/version.json` (es. "Mosaicus v0.16.0: pulsante «Aggiorna l'app»"). Una riga sola per commit, salvo modifiche ampie. Se un file non sta chiaramente in nessun gruppo, o la divisione è dubbia (un file condiviso tra due argomenti), chiedi prima di committare.
5. **Controllo.** Dopo l'ultimo commit `git status --short` deve essere vuoto. Se resta qualcosa, chiedi che cosa farne.
6. **Push.** `git push origin main`, una sola volta dopo tutti i commit. Se viene rifiutato, fermati e riferisci l'errore: mai `--force`, mai `git reset --hard`, nessun tentativo di aggirare il problema.
7. **Pubblicazione.** `quarto publish gh-pages --no-prompt --no-browser`. Rigenera il sito e aggiorna il ramo `gh-pages`. Se fallisce, mostra l'errore così com'è e non ritentare alla cieca.
8. **Riepilogo.** In poche righe: l'elenco dei commit (hash e messaggio), esito del push e della pubblicazione. Ricorda che il sito (ermesfrosi.it) può impiegare uno o due minuti ad aggiornarsi.

## Regole

- Non modificare nessun file per conto tuo: solo test, commit, push e publish di ciò che l'utente ha già cambiato.
- Le modifiche vanno fatte nei sorgenti (`.qmd`, `slides.html` in `didattica/…`), non in `_site/`, che è rigenerata a ogni render e ignorata da git. Se vedi che l'utente ha toccato file dentro `_site/`, avvisalo.
- **Mosaicus vive solo in `mosaicus/`** (app, firmware, video, test, strumenti). La vecchia cartella `~/Mosaicus` non è più usata: non c'è nessuna copia da allineare né un repository separato.
- `_to_delete/` è ignorata da git (cartella di transito): non toccarla e non committarla.
- Non aggiungere righe di attribuzione oltre a quelle che Claude Code mette di suo.

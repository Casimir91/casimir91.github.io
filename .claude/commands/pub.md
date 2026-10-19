---
description: Commit, push su main e pubblicazione del sito (quarto publish gh-pages)
argument-hint: [contesto opzionale per il messaggio di commit]
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git log:*), Bash(git branch:*), Bash(git push origin main), Bash(quarto publish gh-pages:*)
---

Pubblica le modifiche fatte al sito. Contesto aggiunto dall'utente (può essere vuoto): $ARGUMENTS

## Stato attuale

- Ramo: !`git branch --show-current`
- File cambiati: !`git status --short`
- Riepilogo modifiche: !`git diff HEAD --stat`
- Ultimi commit (per lo stile del messaggio): !`git log --oneline -5`

## Procedura, in quest'ordine

1. **Controlla le modifiche.** Leggi `git diff HEAD` per capire che cosa è cambiato davvero. Se non c'è niente da committare, dillo e chiedi se pubblicare comunque (passa direttamente al punto 5). Segnala se tra i file cambiati c'è qualcosa di inatteso (file enormi, credenziali, `.env`): in quel caso fermati e chiedi.
2. **Ramo.** Se il ramo non è `main`, fermati e chiedi.
3. **Commit.** `git add -A`, poi un commit con messaggio **in italiano**, nello stile dei commit recenti: area, due punti, descrizione breve (es. "Terza: aggiunti practice test e mock test (13/10) con soluzioni"). Il messaggio descrive che cosa è cambiato e, se il contesto dell'utente lo spiega, anche perché. Una riga sola, salvo modifiche ampie.
4. **Push.** `git push origin main`. Se viene rifiutato, fermati e riferisci l'errore: mai `--force`, mai `git reset --hard`, nessun tentativo di aggirare il problema.
5. **Pubblicazione.** `quarto publish gh-pages --no-prompt --no-browser`. Rigenera il sito e aggiorna il ramo `gh-pages`. Se fallisce, mostra l'errore così com'è e non ritentare alla cieca.
6. **Riepilogo.** In poche righe: hash e messaggio del commit, esito del push, esito della pubblicazione. Ricorda che il sito (ermesfrosi.it) può impiegare uno o due minuti ad aggiornarsi.

## Regole

- Non modificare nessun file per conto tuo: solo commit, push e publish di ciò che l'utente ha già cambiato.
- Le modifiche vanno fatte nei sorgenti (`.qmd`, `slides.html` in `didattica/…`), non in `_site/`, che è rigenerata a ogni render e ignorata da git. Se vedi che l'utente ha toccato file dentro `_site/`, avvisalo.
- Non aggiungere righe di attribuzione oltre a quelle che Claude Code mette di suo.

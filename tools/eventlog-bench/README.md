# @bonbon/eventlog-bench

M0-Spike: Event Log unter Last, Absturzsicherheit und Manipulationsnachweis.

```
pnpm eventlog                     alle Messungen (dauert ~12 Minuten)
pnpm eventlog -- --dauerlast      nur die Dauerlast
pnpm eventlog -- --stoss          nur den Stoßbetrieb
pnpm eventlog -- --absturz        nur die Absturzsicherheit
pnpm eventlog -- --manipulation   nur den Manipulationsnachweis
pnpm eventlog -- --minuten 1      kürzere Dauerlast
```

Gemessen wird der **echte Schreibpfad** aus Regel 2, keine vereinfachte
Nachbildung: SQLite im WAL-Modus, `synchronous = NORMAL`, Hash-Kette über den
Vorgänger, lückenlose Sequenznummer je Gerät, `UNIQUE (device_id, seq)`.

SQLite kommt aus `node:sqlite` — Node bringt es mit, keine Abhängigkeit.

---

## Aufbau

Die Kettenlogik liegt in `@bonbon/core`, weil sie fachlich zu Regel 2 gehört
und im Client wie im Backend identisch laufen muss. Der Kern darf aber kein
`crypto` benutzen (Regel 11), deshalb kommt die Hashfunktion als `Hasher` von
außen herein — genau wie `Clock` und `IdGenerator`:

```
@bonbon/core
  events.ts        SaleEvent, ChainedEvent, Hasher
                   eventHashInput, hashEvent, chainEvent, verifyChain

tools/eventlog-bench
  store.ts         SQLite-Ablage, WAL, append-only, blockweise Prüfung
  main.ts          die vier Messungen
  schreiber.ts     eigener Prozess für den Absturztest
```

### Warum die Hash-Eingabe längenpräfigiert ist

```
64:0000…|12:EVT-0001|8:KASSE-01|1:1|25:2026-08-21T10:00:00+02:00|20:Position…
```

Ohne Längenpräfix ließen sich Zeichen zwischen benachbarten Feldern
verschieben, ohne den Hash zu ändern: `type="a", payload="bc"` und
`type="ab", payload="c"` ergäben bei einfacher Verkettung dieselbe Eingabe.
Ein Test hält das fest.

---

## Was geprüft wird

### Absturzsicherheit

Ein Kindprozess schreibt ununterbrochen und wird mitten im Schreiben mit
`SIGKILL` beendet. Danach werden drei Invarianten geprüft:

1. **Die Kette ist intakt** — jede Zeile hasht auf ihren Nachfolger.
2. **`count === höchste seq`** — die Datei enthält einen lückenlosen Präfix
   `1..N`. Das schließt aus, dass mitten in der Kette etwas fehlt; verloren
   gehen kann nur ein Stück am Ende.
3. **Kein bestätigtes Ereignis fehlt** — was der Schreibvorgang zurückgemeldet
   hat, steht in der Datei.

Ein halb geschriebenes Ereignis gibt es nicht: SQLite schreibt die Zeile
entweder ganz oder gar nicht.

> **Einordnung, damit die Aussage nicht größer klingt als sie ist:**
> `SIGKILL` beendet den Prozess, nicht den Rechner. Die übergebenen Daten
> liegen noch im Cache des Betriebssystems. Geprüft ist damit der **Absturz
> der Anwendung**.
>
> Bei einem **Stromausfall** kann `synchronous = NORMAL` im WAL-Modus die
> letzten Transaktionen verlieren — die Datei bleibt aber konsistent und die
> Kette intakt. Das ist der bewusst eingegangene Handel: `FULL` wäre sicherer
> und deutlich langsamer. Ein fehlendes letztes Ereignis fällt auf, eine
> kaputte Datei nicht.
>
> Ein echter Stromausfalltest gehört in M6 an die Pilothardware.

### Manipulationsnachweis

Das ist die Funktion, die bei einer Kassennachschau zählt.

**Fall 1 — ein Betrag wird nachträglich geändert.** Die Prüfung meldet
`hash-mismatch` und nennt die Sequenznummer, die Ereignis-ID und beide Hashes.

**Fall 2 — ein Ereignis wird gelöscht.** Die Prüfung meldet `sequence-gap`
(„Nach Sequenznummer 24 folgt 26 — es fehlen 1 Ereignisse") **und**
`prev-hash-mismatch`, weil die Kette an der Stelle zerschnitten ist.

Im Kern zusätzlich getestet: doppelte Ereignisse, eingeschobene Ereignisse,
eine Kette, die nicht am Anfang beginnt, und der raffiniertere Angriff, bei
dem Inhalt **und** Hash passend gefälscht werden — dann bricht der Nachfolger.

Die Prüfung hört nicht beim ersten Fund auf. Bei einer Kassennachschau ist die
Frage nicht nur *ob*, sondern *wo* und *wie oft*.

`tamperForTest` und `deleteForTest` stehen ausdrücklich nur für diesen
Nachweis in der Ablage. Der Betrieb kennt sie nicht — der Log ist append-only.

---

## Messmaschine

Die Zahlen unten stammen von:

```
Windows 11 (10.0.26200)
AMD Ryzen 5 3400G, 8 Kerne
23,9 GB RAM
TOSHIBA HDWD110 — HDD   (mechanische Festplatte, 7200 U/min)
Node v24.13.1
```

Zielhardware laut CLAUDE.md ist Windows 10, 4 GB RAM, möglicherweise mit
Festplatte statt SSD.

**Der Vergleich fällt gemischt aus:** Die Festplatte ist der realistische,
langsame Fall — genau richtig für diese Messung. Prozessor und Arbeitsspeicher
sind dagegen deutlich besser als das Ziel. Die Schreiblatenz wird von der
Platte bestimmt und ist damit belastbar; die Hash-Rechenzeit in der
Hochrechnung ist optimistisch und auf schwächerer Hardware etwa um den Faktor
2 bis 3 höher anzusetzen.

Der Bericht gibt die Messmaschine bei jedem Lauf selbst aus, damit die Zahlen
nie ohne ihren Maßstab herumliegen.

---

## Ergebnisse

Gemessen mit `pnpm eventlog` auf der oben genannten Maschine (mechanische
Festplatte).

### Dauerlast — 500 Ereignisse pro Minute über zehn Minuten

| | |
|---|---|
| p50 | 0,300 ms |
| p95 | 0,588 ms |
| p99 | 2,224 ms |
| max | **267,619 ms** |
| über 50 ms | 11 von 5000 |
| über 10 ms | 44 von 5000 |

Datenbank wächst gleichmäßig auf 1,86 MB, die WAL-Datei bleibt konstant bei
rund 4 MB — SQLite recycelt sie, statt sie wachsen zu lassen. Kette nach dem
Lauf intakt.

### Stoßbetrieb — 20 Ereignisse in 8 Sekunden, fünf Runden

| | |
|---|---|
| p50 | 0,334 ms |
| p95 | 0,733 ms |
| p99 | 1,407 ms |
| max | 1,407 ms |
| über 10 ms | **0 von 100** |

Die WAL-Datei wächst hier stetig (358 kB → 1694 kB), weil zwischen den Stößen
kein Checkpoint ausgelöst wird.

### Die Überraschung: der Stoßbetrieb ist der gutmütigere Fall

Erwartet war das Gegenteil — Latenzspitzen nach einer Ruhephase. Gemessen ist
es umgekehrt: der Stoßbetrieb hat **keinen einzigen** Wert über 10 ms, die
Dauerlast dagegen 44, davon 11 über 50 ms und einen bei 268 ms.

Der Grund ist der WAL-Checkpoint. Unter Dauerlast läuft die WAL-Datei voll und
SQLite schreibt sie in die Datenbank zurück — auf einer mechanischen Festplatte
kostet das die beobachteten Aussetzer. Im Stoßbetrieb bleibt die WAL klein
genug, dass in den fünf Runden kein Checkpoint fällig wird; die Datei wächst
nur an.

**Was das praktisch heißt:** 268 ms Verzögerung beim Bonabschluss sind am
Tresen spürbar, aber nicht schlimm — es traf 11 von 5000 Schreibvorgängen. Ein
Café erreicht die hier gemessene Dauerlast ohnehin nicht: 500 Ereignisse pro
Minute wären rund 60 Bons pro Minute. Der reale Betrieb liegt beim
Stoßbetriebsprofil, und dort gab es keine Ausreißer.

**Trotzdem im Auge behalten:** Bei einem Kunden mit echter Dauerlast oder einer
langsameren Platte würde der Checkpoint störender. Falls das auftritt, ist der
Hebel `wal_autocheckpoint` — den Checkpoint kleiner und häufiger machen, statt
selten und groß. Das ist keine Änderung am Datenmodell, sondern eine Stellschraube.

### Zehn Jahre — Hochrechnung

Annahme aus dem Auftrag: 100 Bons am Tag, 8 Ereignisse je Bon.

```
pro Tag      800 Ereignisse
pro Jahr     292.000
zehn Jahre   2.920.000
```

| | |
|---|---|
| je Hash | 2,15 µs (464.759 Hashes/s) |
| reine Rechenzeit für 2.920.000 Hashes | **6,3 s** |
| mit Lesen aus SQLite (grob geschätzt) | **rund 4,5 Minuten** |
| je Ereignis auf der Platte | 390 Byte (gemessen) |
| Datenbestand nach zehn Jahren | **1,06 GB** |

**Die Prüfung der gesamten Kette dauert keine Stunden.** Sie kann als Ganzes
laufen, etwa auf Verlangen bei einer Kassennachschau. Die Schätzung für das
Lesen ist bewusst konservativ (30 % der Schreiblatenz); real dürfte es
schneller sein, weil sequenzielles Lesen der Platte entgegenkommt.

Zwei Dinge sind trotzdem einzuplanen:

1. **Speicher.** Bei 4 GB RAM darf die Prüfung nicht die ganze Kette laden.
   `EventLog.verify` liest deshalb blockweise (5000 Zeilen) und braucht
   konstant wenig Speicher — unabhängig von der Länge der Kette.
2. **Prüfpunkt je Tagesabschluss.** Hash und Sequenznummer des letzten
   Ereignisses festhalten. Dann muss im Alltag nur der laufende Tag geprüft
   werden — rund 800 Ereignisse statt 2.920.000. Die vollständige Prüfung
   bleibt für den Ernstfall.

---

## Offene Punkte

Aus der Auswertung von M0 stehengeblieben. **Nicht umgesetzt** — hier notiert,
damit sie zum richtigen Zeitpunkt entschieden werden.

### 1. `synchronous = NORMAL` gegen `FULL` — Entscheidung in M3

`NORMAL` kann bei **Stromverlust** die letzten Transaktionen verlieren. Für
eine Kasse heißt das konkret:

> Bon gedruckt, TSE signiert, Kunde hat bezahlt — und das lokale Log kennt den
> Vorgang nicht mehr.

Das ist nicht dasselbe wie „ein Ereignis fehlt". Der Vorgang ist nach außen
vollzogen: der Kunde hat einen Beleg, die TSE hat signiert, das Geld ist in
der Lade. Nur die eigene Aufzeichnung fehlt.

**In M3 zu tun:** `FULL` unter denselben zwei Lastprofilen messen und
bewusst entscheiden. Bei p50 von 0,300 ms ist Luft; die Frage ist, was `FULL`
auf einer mechanischen Platte aus dem p99 und dem Maximum macht. Fällt die
Entscheidung für `NORMAL`, gehört die Begründung dokumentiert — dann ist es
ein bewusstes Restrisiko und kein Versehen.

Ein echter Stromausfalltest an der Pilothardware gehört ohnehin in M6.

### 2. Der Prüfpunkt je Tagesabschluss muss in der Kette liegen

Oben empfohlen: Hash und Sequenznummer des letzten Ereignisses je
Tagesabschluss festhalten, damit im Alltag nur der laufende Tag zu prüfen ist.

**Der Prüfpunkt darf dabei nicht neben der Kette liegen, sondern muss selbst
Teil von ihr sein** — also ein eigenes Ereignis mit `prev_hash` und `hash` wie
jedes andere.

Läge er daneben, in einer eigenen Tabelle oder Datei, ließe er sich fälschen:
Wer den Prüfpunkt neu berechnet, versteckt damit **jede** Manipulation davor,
weil die Prüfung ja nur noch ab dem Prüfpunkt läuft. Als Kettenglied geht das
nicht — ein gefälschter Prüfpunkt bricht die Kette an seiner eigenen Stelle.

### 3. Bündelung der Ereignisse eines Bons in einer Transaktion

Der stärkere Hebel gegen Checkpoint-Aussetzer als `wal_autocheckpoint`: alle
Ereignisse eines Bons in **einer** SQLite-Transaktion schreiben. Statt acht
Commits je Bon einer.

**Kollidiert aber mit geparkten Bons.** Wer einen Bon offen liegen lässt und
weiterkassiert, erwartet, dass die bereits erfassten Positionen haltbar sind —
nicht in einer offenen Transaktion hängen, die ein Absturz verwirft.

Denkbar wäre eine Bündelung nur für den Abschluss (Zahlung, Bonabschluss,
Belegausgabe), während einzelne Positionen weiterhin sofort committen.

**Bei p99 von 1,4 ms im realistischen Stoßprofil ist das kein Anlass.** Hier
notiert für den Fall, dass ein Kunde mit echter Dauerlast oder langsamerer
Hardware auffällt.

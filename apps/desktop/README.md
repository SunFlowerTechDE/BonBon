# @bonbon/desktop — die Kasse

Tauri v2, React im Webview, angebunden an `@bonbon/core` und die vorhandenen
Adapter.

```
pnpm --filter @bonbon/desktop dev      nur der Webview, im Browser
pnpm --filter @bonbon/desktop start    die Tauri-App (braucht Rust)
pnpm --filter @bonbon/desktop typecheck
```

Der Entwicklungsserver lauscht auf **`http://localhost:1420/`**. Unter Windows
bindet er auf `::1`; `127.0.0.1` schlägt fehl, `localhost` funktioniert.

---

## Was steht

- Artikelraster mit 12 Artikeln in drei Warengruppen
- Ein Tipp legt eine Position an, weitere Tipps erhöhen die Menge
- Bon rechts mit Steuerkennzeichen A/B, Steuerausweis je Satz und Gesamt
- Dauersichtbarer Umschalter **Hier essen / Mitnehmen**, groß und nicht in
  einem Menü — er nutzt `DiningModeChanged` und ist jederzeit vor dem
  Abschluss bedienbar
- Zahlung bar oder Karte, Schnellbeträge aus dem echten Bonbetrag berechnet
  (bei 7,40 also 7,40 / 8 / 10 / 20), Rückgeld groß auf dunklem Grund
- Abschluss: TSE-Signatur, Event Log, Bondruck — alles über die Ports
- TSE-Statuspunkt grün/gelb/rot im Kopf
- Nach dem Abschluss zurück zum Raster, ohne Bestätigungsdialog

## Steuersätze — Vorschlag, keine Auskunft

Die Zuordnung steht **je Produkt** in [`stammdaten.ts`](src/stammdaten.ts), getrennt
für „im Haus" und „außer Haus", jeweils mit **Begründung und Fundstelle**. Beide
gehen in den Event Log: bei einer Prüfung lautet die Frage nicht „welcher Satz",
sondern „warum dieser".

Eine Sammelregel („im Haus 19, mitnehmen 7") war für den größeren Teil des
Sortiments falsch — und der Fehler war von außen nicht zu sehen, weil die Kasse
zuverlässig den falschen Satz rechnete.

| Produkt | im Haus | außer Haus | warum |
|---|---|---|---|
| Kaffee, Espresso, Tee | 19 % | 19 % | zubereitetes Getränk, steht nicht in Anlage 2 |
| Cappuccino | 19 % | 19 % | Milchanteil rund zwei Drittel — unter 75 % |
| Latte Macchiato | 19 % | **7 %** | Lieferung eines Milchmischgetränks ≥ 75 % Milch |
| Latte mit Haferdrink | 19 % | 19 % | Milchersatz ist keine Milch |
| Kuchen, Gebäck | **7 %** | **7 %** | Speise — seit 1.1.2026 unabhängig von der Verzehrart |
| Wasser 0,33, Apfelschorle | 19 % | 19 % | Getränk; Trinkwasser in Fertigpackung ausgenommen |

Fundstellen: § 12 Abs. 2 Nr. 15 UStG (Steueränderungsgesetz 2025, seit 1.1.2026,
[ZDH](https://www.zdh.de/ueber-uns/fachbereich-steuern-und-finanzen/umsatzsteuer/ermaessigter-umsatzsteuersatz-fuer-die-gastronomie-ab-112026/))
· Anlage 2 Nr. 4 und Nr. 34 zu § 12 Abs. 2 Nr. 1 UStG · FG Baden-Württemberg,
Urteil vom 14.3.2024, 1 K 232/24.

**Seit dem 1. Januar 2026 bewegt die Verzehrart den Steuersatz nur noch bei
Milchmischgetränken.** Dass der große Umschalter beim Kuchen nichts mehr ändert,
ist das richtige Verhalten — kein übersehener Fall.

Jede Zuordnung ist änderbar, und die Oberfläche trägt sichtbar den Hinweis
„Steuersätze sind Vorschläge und mit dem Steuerberater zu prüfen". Ohne den
wirkt die Vorbelegung wie eine Auskunft, und die darf diese Software nicht
geben (§ 5 StBerG, CLAUDE.md Regel 20).

## Verzehrart je Position

„Zwei Cappuccino, einer bleibt hier, einer geht" ist im Café Alltag. Weil die
Kasse gleiche Artikel zu einer Zeile zusammenfasst, teilten sie sich vorher eine
Verzehrart — die Regel „pro Position überschreibbar" stand da, war aber nicht
bedienbar.

Jede Bonzeile hat deshalb einen eigenen kleinen Umschalter (`Hier` / `Mit`). Ein
Tipp bewegt **ein Stück** in die andere Verzehrart und spaltet die Zeile dabei
auf: Storno plus zwei neue Zeilen, beide mit `ersetzt` auf die alte, weil der Log
append-only ist. Die abgespaltene Zeile bekommt Herkunft `position` und wird vom
großen Umschalter nicht mehr mitgerissen.

Einzeln gesetzte Zeilen sind **markiert** — Pfirsich-Streifen plus Legende. Ohne
die Kennzeichnung wundert sich das Personal, warum der große Schalter manche
Zeilen nicht ändert, und hält es für einen Fehler.

Im Fenster nachgemessen:

```
1 × Latte Macchiato   Hier   A   4,20
1 × Latte Macchiato   Mit    B   4,20   [einzeln]
Steuerausweis:  B 7 % netto 3,93 USt 0,27 · A 19 % netto 3,53 USt 0,67
```

---

## Farbwelt und Schrift

Die Farbwerte stehen an **einer** Stelle: [`src/farben.ts`](src/farben.ts).
Dort liegt nicht nur die Palette, sondern die Liste der **Flächen** — welche
Schrift auf welchem Grund steht. Eine Farbe für sich ist weder lesbar noch
unlesbar; lesbar ist immer nur ein Paar.

| Rolle | Farbe | Schrift darauf | Kontrast |
|---|---|---|---|
| Anwendungshintergrund | Neutral `#F4F6F8` | dunkel | 13,55:1 |
| Flächen, Kopf, Summe | Mint `#ABE6CF` | dunkel | 10,45:1 |
| Auswahl, Aktiv | Türkis `#5DD5D6` | dunkel | 8,36:1 |
| Hinweis, Rückgeld | Pfirsich `#FFC69E` | dunkel | 9,66:1 |
| **nur** Warnung und Löschen | Koralle `#FF7D7D` | dunkel | 5,93:1 |
| Primäraktion | Beere `#B03A6A` | **weiß** | 5,74:1 |

Weiße Schrift steht **nur auf Beere**. Auf Mint, Türkis, Koralle und Pfirsich
käme sie auf 1,40:1 bis 2,48:1 — das ist nicht knapp, das ist unlesbar.
Koralle ist keine Aktionsfarbe: Aktionen gehen über Beere.

`stil.css` schreibt die Werte noch einmal hin, weil CSS keine TypeScript-Datei
lesen kann. [`test/farben.test.ts`](test/farben.test.ts) hält beide zusammen und
liest dafür **das echte Stylesheet**:

1. Jeder Farbwert im Stylesheet stammt aus der Palette — kein Wert nebenbei.
2. Jede Regel, die Schrift und Grund zugleich setzt, ist als Fläche eingetragen.
3. Jede Fläche erreicht 4,5:1 (WCAG 2.2 AA).

Und weil eine Prüfung, die nicht fehlschlagen kann, nichts beweist, prüft der
letzte Block die Prüfung selbst: weiße Schrift auf Mint **muss** durchfallen.
Nachgestellt wurde das auch von Hand — eine eingeschmuggelte Regel
`.probe { background: var(--mint); color: var(--weiss) }` bringt den Test zu
Fall, ebenso ein `#f0f0f0` an der Palette vorbei.

### Der TSE-Punkt ist kein Markenelement

Die Zustandsanzeige benutzt **eigene Signalfarben**, keine Markenfarben. Wären
Türkis „bereit" und Koralle „ausgefallen", wären dieselben Farben gleichzeitig
Auswahl und Alarm — dann sagt der Farbton nichts mehr darüber, ob etwas hübsch
oder kaputt ist.

Und die Farbe steht nie allein. Rund 8 % der Männer unterscheiden Rot und Grün
schlecht; wer den Zustand nur am Farbton ablesen müsste, sähe keinen
Unterschied zwischen „bereit" und „ausgefallen". Jeder Zustand trägt deshalb
**Farbe plus Zeichen plus ausgeschriebenes Wort**:

| Zustand | Farbe | Zeichen | Wort |
|---|---|---|---|
| bereit | `#1B7A4B` | ✓ | TSE bereit |
| gestört | `#8A5A00` | ! | TSE gestört |
| ausgefallen | `#B02A2A` | ✕ | TSE ausgefallen |
| unbekannt | `#8A5A00` | ? | TSE unbekannt |

Der Punkt selbst hebt sich mit mindestens 3,80:1 vom Mint des Kopfes ab (WCAG
1.4.11 verlangt 3:1 für grafische Elemente).

### Schrift

**Poppins** in vier Schnitten (400/500/600/700), Subsets `latin` und
`latin-ext`, zusammen 53 kB. Die Dateien liegen in
[`public/schriften/`](public/schriften/) und werden **mitgeliefert, nicht
nachgeladen**: die CSP erlaubt nur `self`, und die Einrichtung im Laden
passiert oft ohne verlässliches WLAN.

Erneuern über [`werkzeuge/schriften-holen.mjs`](../../werkzeuge/schriften-holen.mjs);
danach die `unicode-range`-Angaben in `stil.css` abgleichen. Lizenz: SIL OFL
1.1, `public/schriften/OFL.txt`.

---

## Der Bon lebt im Log, von Anfang an

Jedes Ereignis wird geschrieben, **wenn es passiert** — `SaleStarted` beim
Öffnen, `LineAdded` beim Antippen, `DiningModeChanged` beim Umschalten. Nicht
beim Abschluss: ein Log, der erst am Ende schreibt, ist kein append-only-Log.
Bis dahin liegt der ganze Vorgang im Arbeitsspeicher, und ein Absturz nimmt ihn
spurlos mit. Der Preis ist gemessen: im M0-Lasttest kosteten einzeln
geschriebene Ereignisse unter Stoßlast **p99 1,4 ms**.

Daraus folgt dreierlei:

- **Erst schreiben, dann übernehmen.** Scheitert das Schreiben, hat auch der
  Bon das Ereignis nicht — sonst zeigte die Kasse eine Position, die nirgends
  steht.
- **Der Log kommt vor der Signatur.** Ein Absturz dazwischen ist reparierbar
  (die offene Transaktion wird beim nächsten Start abgeschlossen); umgekehrt
  stünde ein signierter, ausgegebener Vorgang im Log als abgebrochen.
- **Ein verworfener Bon hinterlässt `SaleCancelled` mit Grund.** Er verschwindet
  nicht, und seine Belegnummer ist verbraucht.

### Was beim Start passiert

`Kasse.richteEin()` — vor dem ersten Bon:

1. **Belegnummer aus dem Log.** Aus dem letzten `SaleStarted`, nicht aus einer
   Zählung. Die Zählung stimmte nur, solange jeder begonnene Bon auch
   abgeschlossen wurde; ein verworfener Bon hätte seine Nummer ein zweites Mal
   vergeben lassen.
2. **Unbeendeter Bon.** Wurde einer begonnen und nie beendet, bekommt er sein
   `SaleCancelled`. Er wird **nicht** fortgesetzt: was zwischen dem letzten
   geschriebenen Ereignis und dem Absturz noch getippt wurde, weiß niemand.
3. **Offene TSE-Transaktionen.**

### Die Signaturdaten stehen im Log

Direkt nach Rückkehr der Signatur schreibt die Kasse `TseSignaturErfasst` —
Transaktionsnummer, Signaturzähler, beide Zeitstempel, Seriennummer, Signatur
und Prüfwert. Bleibt die Signatur aus, schreibt sie stattdessen
`TseSignaturAusgefallen` mit Grund und Zeitpunkt (Regel 8).

Warum das mehr ist als eine Exportfrage: stürzt die Kasse **nach** der Signatur,
aber **vor** dem Festhalten ab, findet der Transaktionsabgleich nichts — die
TSE-Transaktion ist abgeschlossen, steht also nirgends offen. Die Signaturdaten
wären dauerhaft aus dem Log verschwunden, und nichts wiese auf ihr Fehlen hin.

Deshalb der zweite Abgleichfall beim Start: jeder Bon mit `SaleFinished`, aber
ohne Signaturnachweis, wird bei der TSE nachgefragt. Was sie liefert, wird als
`nachgetragen` gekennzeichnet; was sie nicht kennt, wird als Lücke vermerkt
statt weggelassen. Antwortet sie gar nicht, wird **nichts** geschrieben und
beim nächsten Start erneut versucht — „ich weiß es nicht" darf nicht zu „gibt
es nicht" werden.

Erst das Ausfall-Ereignis macht die beiden Fälle unterscheidbar: ein
dokumentierter TSE-Ausfall sieht sonst genauso aus wie ein Datenverlust.

### Verwaiste TSE-Transaktionen

Die TSE-Transaktion wird beim **Bonbeginn** geöffnet — die KassenSichV verlangt
die Protokollierung mit Beginn des Aufzeichnungsvorgangs. Stürzt die Kasse
danach ab, steht sie offen, ohne lokales Gegenstück, und bleibt es. Eine echte
TSE hat dafür eine Obergrenze; irgendwann nimmt sie keine neue mehr an.

| Was der Log sagt | Was passiert |
|---|---|
| Bon vollständig (`SaleFinished` steht drin) | Transaktion abschließen — der Vorgang hat stattgefunden |
| sonst | Transaktion als abgebrochen beenden |

Beides geht als eigenes Ereignis (`TseTransaktionAufgeloest`) in den Log.
Stillschweigend bereinigen wäre die stille Änderung aus Regel 1. Antwortet die
TSE beim Start nicht, wird die Kasse **nicht** gesperrt (Regel 8) — der
Abgleich wird beim nächsten Start nachgeholt, und der Aufschub wird gemeldet.

Nachgeschlagen wird über die **Belegreferenz**, nicht über „der zuletzt
begonnene Bon". Der Unterschied ist nicht kosmetisch: ein tatsächlich
stattgefundener Verkauf stünde sonst in der TSE als abgebrochen — eine falsche
Aufzeichnung.

Festgehalten wird nur der **Erfolg**. Ein gescheiterter Versuch bekommt kein
Ereignis, sonst gälte die Transaktion beim nächsten Start als erledigt und
bliebe für immer offen. (Gefunden, als zwei Abstürze hintereinander
nachgestellt wurden.)

#### Woher die Kasse weiß, was offen ist — gemessen, nicht nachgeschlagen

Eine Runde lang galt: die Antwort des Zero-Receipts (`0x4445000000000002`) trage
einen TSE-Status mit `CurrentStartedTransactionNumbers`. Die Annahme stammte
**nicht aus der fiskaltrust-Dokumentation**, sondern aus einer Fehldeutung der
Launcher-Ausgabe beim Start; eine Websuche schien sie zu bestätigen. **Am
laufenden Launcher gemessen stimmt sie nicht:**

```
pnpm --filter @bonbon/tse-spike exec tsx src/tse-info-probe.ts
```

- Der Zero-Receipt antwortet mit 16 Signaturen, von `start-transaction-result`
  bis `<public-key>` — **keine** führt offene Transaktionen auf.
- Der Journal-Endpunkt beantwortet jeden versuchten `ftJournalType` mit
  derselben Versionsauskunft (243 Zeichen).
- Die Antwort auf `start-transaction` enthält genau **eine** Signatur
  (`start-transaction-signature`) und **keine Transaktionsnummer**.

`CurrentStartedTransactionNumbers` ist ein **ausgehendes** Feld: es geht im
`ftReceiptCaseData` eines impliziten Fail-Transaction-Belegs mit, um
Transaktionen zu schließen, die die Middleware nicht kennt. Zum Abfragen ist es
nicht da — die Middleware ordnet über `cbReceiptReference` zu.

Daraus folgt der Entwurf: **der Log ist die Quelle.** Die Kasse schreibt
`TseTransaktionBegonnen`, sobald sie eine Transaktion öffnet, und weiß daraus
selbst, was offen steht. `offeneTransaktionen()` bleibt als zweite Quelle für
Reste, die nicht von dieser Kasse stammen. Antwortet die TSE nicht, wird der
Log trotzdem abgeglichen.

---

## Was noch nicht dran ist

Kein Rabatt in der Oberfläche, kein Bon parken, keine Bedienerverwaltung, kein
Tagesabschluss, keine Artikelverwaltung.

---

## Adapter — nichts ist fest verdrahtet

Welche TSE, welcher Drucker, welcher Event Log steht in einer
**`bonbon.config.json` neben der Anwendung** und wird beim Start gelesen
(CLAUDE.md, Ports und Adapter). Vorlage:
[`bonbon.config.beispiel.json`](bonbon.config.beispiel.json).

Sie lag vorher in `public/` und wurde beim Bauen ins Anwendungsbündel gepackt —
damit war sie ohne neuen Bau nicht zu ändern. Für eine Kasse unbrauchbar: jeder
Laden hat eine andere Drucker-IP, und niemand baut deswegen die Software neu.

```
bonbon-kasse.exe
bonbon.config.json        ← hierhin
bonbon-eventlog.db        ← ein relativer Pfad meint dieses Verzeichnis
bonbon-tse-zustand.json   ← Zustand der MockTse
```

Drei Fälle, die auseinandergehalten werden:

| | |
|---|---|
| Datei fehlt | Vorgaben gelten (Mock-TSE, Vorschaudrucker, Event Log im Speicher) — **und es wird gesagt, wo sie erwartet wurde** |
| Datei ist da, aber unlesbar | Fehler, gemeldet mit Grund. Nicht als „fehlt" durchgewunken — sonst liefe die Kasse mit Vorschaudrucker weiter, obwohl ein echter eingerichtet war |
| Datei ist da und gültig | gilt |

Ist `tcp` eingestellt und escpresso läuft nicht, wird der Verkauf trotzdem
abgeschlossen und signiert; der Bon gilt als **nicht gedruckt** und der Grund
steht in der Abschlussmeldung. Ein fehlender Drucker darf einen Umsatz nicht
verhindern.

Die TSE steht auf `mock`. `fiskaltrust` ist noch nicht angebunden (M3); wird es
eingestellt, meldet die Kasse ausdrücklich, dass trotzdem der Mock läuft und
die Signaturen keine echten sind.

---

## Aufteilung Webview und Rust

Der Webview kann kein TCP und keine Dateien. Im Rust-Teil stehen deshalb genau
vier Befehle als **schmale Transportschicht**:

| Befehl | wofür |
|---|---|
| `tcp_senden` | ESC/POS-Bytes an Port 9100 |
| `tcp_erreichbar` | Druckerprüfung ohne zu drucken |
| `eventlog_anhaengen` | SQLite, WAL, Hash-Kette |
| `eventlog_anzahl` | Zählen |
| `eventlog_letztes_ereignis` | das letzte `SaleStarted` — daraus die Belegnummer |
| `eventlog_ereignisse_ab` | den zuletzt begonnenen Bon zurückholen |
| `datei_lesen` · `datei_schreiben` | Konfiguration und TSE-Zustand |
| `anwendungsverzeichnis` | wo die Anwendung liegt |

**Keine Fachlogik in Rust.** Steuer- und Rundungslogik darf es nur einmal
geben; sie liegt in `@bonbon/core` und läuft unverändert im Client und im
Backend (CLAUDE.md, Stack). Jede Zeile Fachlogik im Rust-Teil wäre eine zweite
Implementierung — genau der Fehler, den Tauri hier vermeiden soll.

Eine Ausnahme gibt es: die **Hash-Eingabe** der Kette muss auf beiden Seiten
Byte für Byte gleich gebildet werden, sonst bricht die Kette beim Wechsel des
Schreibwegs. Beide Seiten prüfen deshalb gegen **dieselbe Datei**,
[`testvektoren/hash-eingabe.json`](../../testvektoren/hash-eingabe.json):

```
64:0000…0000|8:EVT-0001|8:KASSE-01|1:1|25:2026-08-21T10:00:00+02:00|20:PositionHinzugefuegt|2:{}
```

Ein festgeschriebener Wert im Rust-Test hätte heute gehalten und wäre
stillschweigend gedriftet, sobald jemand dem Ereignis ein Feld hinzufügt: der
Test bliebe grün, während die Ketten auseinanderlaufen. Mit der gemeinsamen
Datei schlagen beide Seiten fehl. Das ist gewollt.

---

## Nachweis, dass der Rust-Weg wirklich läuft

```
cd apps/desktop/src-tauri && cargo test --lib
cd apps/desktop/src-tauri && cargo test --lib -- --ignored   # braucht escpresso
node werkzeuge/verkauf-im-fenster.mjs                        # braucht den Release-Bau
```

[`src/pfadtests.rs`](src-tauri/src/pfadtests.rs) ruft die Befehle **nicht** als
gewöhnliche Rust-Funktionen auf, sondern über `tauri::test::get_ipc_response` —
also über dieselbe IPC-Brücke, die auch der Webview benutzt, mit denselben
JSON-Argumenten. Ein direkter Funktionsaufruf würde die Serialisierung
überspringen, und genau dort könnte ein `Vec<u8>` unbemerkt verbogen werden.

[`werkzeuge/verkauf-im-fenster.mjs`](../../werkzeuge/verkauf-im-fenster.mjs)
schließt die letzte Lücke: es startet die **gebaute Exe** mit
`--remote-debugging-port` und klickt die Knöpfe im laufenden Fenster. Damit ist
auch das echte WebView2 im Weg, nicht nur die Mock-Runtime.

## Windows

`tauri.conf.json` setzt `webviewInstallMode` auf **`offlineInstaller`** — nie
`downloadBootstrapper`. Die Einrichtung im Laden passiert oft ohne
verlässliches WLAN (CLAUDE.md, Umgebung).

## Regel 6

Zwischen `beginneBon()` und `schliesseAb()` liegt **keine** Entitlement-, Abo-
oder Netzwerkprüfung. Die einzigen Netzaufrufe auf diesem Weg gehen an die TSE
und an den Drucker — beides Geräte, keine Lizenzserver.

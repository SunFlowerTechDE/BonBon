# BonBon — Projektkontext

Kassensoftware (POS) für kleine gastronomische Betriebe in Deutschland — Cafés, Eisdielen, Kioske, Backstuben mit 25.000–100.000 € Jahresumsatz. Diese Betriebe sind **freiwillige Nutzer unterhalb der gesetzlichen Kassenpflicht**: Sie arbeiten heute mit offener Ladenkasse und handschriftlichem Kassenbericht.

**Reihenfolge der Plattformen:** Desktop (Windows 10+) → Android → iOS. Eine Codebasis, Geräteanbindung austauschbar.

---

## Stack

| | |
|---|---|
| Client | **Tauri v2** — Rust-Kern, Web-Frontend (TypeScript + React) im Webview |
| Domänenkern | **`@bonbon/core`** — reines TypeScript, plattformfrei, läuft identisch im Client und im Backend |
| Lokale Daten | **SQLite** im WAL-Modus, Event Log mit hoher Schreiblast |
| Backend | **Node/TypeScript, Fastify, PostgreSQL**, Hosting in DE/EU |
| Fiskalisierung | **fiskaltrust Middleware** über den lokalen Launcher (HTTP/gRPC auf localhost), alternativ fiskaly SIGN DE V2 |
| Drucker | **ESC/POS über TCP Port 9100** (Epson TM-m30III) |
| Kartenzahlung | **ZVT über TCP Port 20007** (Desktop), später Payment-SDKs (Mobile) |

**Warum Tauri und nicht Flutter:** Der Domänenkern muss TypeScript bleiben, weil er **identisch im Client und im Backend** laufen soll. Steuer- und Rundungslogik zweimal zu implementieren ist der teuerste denkbare Fehler in diesem Produkt.

---

## Die harten Regeln

Diese Regeln kommen aus dem deutschen Steuerrecht, nicht aus Stilempfehlungen. Ein Verstoß ist kein Codegeruch, sondern ein Haftungsrisiko — bis hin zur persönlichen, unbegrenzten Haftung des Entwicklers für die Steuerschulden des Kunden (§ 71 AO). **Wenn eine Anforderung diesen Regeln widerspricht, nicht umsetzen, sondern nachfragen.**

### 1. Keine stille Änderungsmöglichkeit — nirgends

Jeder Storno, jeder Rabatt, jede Stammdatenänderung, jeder Trainings- oder Testmodus **wird protokolliert**. Es darf keinen Weg geben, einen erfassten Vorgang unbemerkt zu verändern oder zu entfernen.

Verboten sind insbesondere: Löschfunktionen für einzelne Buchungen, ein Trainingsmodus, der wie der Echtbetrieb aussieht und nicht signiert, Umbuchen von Bar auf Karte ohne Protokoll, Stammdatenänderung ohne Historie.

### 2. Der Event Log ist append-only

```
sale_events: id (ULID) · device_id · seq (lückenlos je Gerät) · occurred_at (ISO 8601 mit Zeitzone)
             type · payload (JSON) · prev_hash · hash · synced_at
```

Kein `UPDATE`, kein `DELETE`. Korrekturen sind neue Ereignisse. Die Hash-Kette über den Vorgänger ist nicht gesetzlich vorgeschrieben, kostet aber fast nichts und macht bei einer Kassennachschau sofort belegbar, dass lokal nichts nachträglich verändert wurde.

Projektionen (`sales`, `sale_lines`, `daily_totals`) werden aus dem Log abgeleitet und dürfen aktualisiert werden — sie sind kein Beweismittel.

### 3. Geldbeträge sind Ganzzahlen in Cent — mit eigenem Typ

Niemals Fließkomma. Kein `number` für Beträge im Domänenmodell, kein `parseFloat`. Umrechnung nach Euro passiert ausschließlich in der Darstellungsschicht.

`number` allein reicht dafür nicht: `3.80` und `380` sind beide `number`, und die Verwechslung fällt erst im Bon des Kunden auf. Beträge tragen deshalb einen eigenen Typ:

```ts
export type Cents = number & { readonly __brand: unique symbol }
```

Ein roher `number` ist an einer `Cents`-Stelle nicht zuweisbar. Erzeugt werden Beträge nur über `cents()`, das `Number.isSafeInteger` prüft und sonst wirft. Gerechnet wird mit `addCents`, `subtractCents`, `sumCents` und `multiplyCents` (Menge als nicht-negative Ganzzahl) — jedes Ergebnis läuft wieder durch die Prüfung, ein Überlauf wirft statt still Präzision zu verlieren.

**Keine Division ohne explizit benannte Rundungsregel.** Jede Geldteilung erzeugt einen Rest, und wohin der Rest geht, ist eine fachliche Entscheidung. In `@bonbon/core` existiert deshalb keine allgemeine Divisionsfunktion; die Rundungsregeln kommen in M1 einzeln benannt.

Negative Beträge sind erlaubt — Stornos und Rabatte brauchen sie.

### 4. Der Steuersatz ist kein Feld am Produkt

Er ist eine Funktion aus `(Produkt, Verzehrart, Datum)`. Die Verzehrart („hier essen" vs. „mitnehmen") entscheidet über 7 % oder 19 % und ist für diese Zielgruppe die wichtigste Einzelinteraktion der ganzen App.

Sie wird **pro Bon** gesetzt und ist **pro Position überschreibbar**. Und: Die Entscheidung wird im Event Log mitgeschrieben, nicht nur das Ergebnis — bei einer Prüfung muss nachvollziehbar sein, *warum* 7 % berechnet wurden.

### 5. Preise werden nie überschrieben

`product_prices` hat einen Gültigkeitszeitraum. Eine Preisänderung legt einen neuen Satz an und beendet den alten. Sonst zeigt der DSFinV-K-Export vom März die Preise von heute, und der Steuerberater kann die Umsätze nicht nachrechnen.

### 6. Keine Lizenzprüfung im Verkaufspfad

Zwischen „Kunde steht am Tresen" und „Bon ist abgeschlossen" darf **keine** Entitlement-, Abo- oder Netzwerkprüfung liegen. Die Kasse kennt an dieser Stelle keine Lizenzabfrage.

### 7. Diese Funktionen sind niemals sperrbar

Auch nicht bei abgelaufenem Abo, gekündigtem Vertrag oder fehlender Modulbuchung:

- Kassieren, Bonabschluss, TSE-Signatur, Belegausgabe
- Datenzugriff, DSFinV-K-Export, Belegarchiv, Kassennachschau-Modus

Der Kunde ist zehn Jahre aufbewahrungspflichtig (§ 147 AO). Eine Sperre wäre für ihn ein rechtliches Problem.

### 8. Die Kasse läuft offline weiter

Verkaufen, abschließen und drucken funktionieren ohne Internet vollständig. Bei TSE-Ausfall: Verkauf lokal abschließen, Signatur in die Warteschlange, Ausfall mit Zeitpunkt und Ursache protokollieren, Beleg trägt den Ausfallhinweis, Nachsignierung im Hintergrund und als solche markiert.

**Zwei Zustände, die nie gleich aussehen dürfen.** Beide führen dazu, dass keine Signatur zurückkommt — aber sie verlangen entgegengesetztes Verhalten:

| | TSE ausgefallen | TSE nicht in Betrieb genommen oder falsch konfiguriert |
|---|---|---|
| Was ist es | Dokumentierter Notbetrieb | Einrichtungsfehler |
| Verkauf | läuft weiter | **muss scheitern** |
| Beleg | trägt den Ausfallhinweis | wird nicht ausgegeben |
| Vorgang | geht in die Nachsignierungs-Warteschlange | geht **nicht** in die Warteschlange |
| Sichtbarkeit | protokolliert, im Hintergrund geheilt | laut und sichtbar, blockiert die Einrichtung |

Ein Einrichtungsfehler darf **nicht in den Ausfallpfad rutschen**. Sonst verkauft die Kasse wochenlang scheinbar normal, sammelt Vorgänge für eine Nachsignierung, die nie kommen kann — und der Betreiber merkt es erst bei der Kassennachschau. Der Ausfallpfad ist für eine TSE gedacht, die in Betrieb ist und gerade nicht antwortet, nicht für eine, die es nie war.

### 9. Keine Konformitätsversprechen in UI, Texten oder Code-Kommentaren

Nie: „rechtssicher", „finanzamtssicher", „GoBD-konform", „steuerlich korrekt". Jede dieser Formulierungen ist eine Beschaffenheitsgarantie nach § 434 BGB und schaltet die Haftungsbegrenzung in den AGB aus.

Stattdessen beschreibend: „exportiert im Format DSFinV-K 2.4", „bereitet die Meldung vor".

### 10. Der ELSTER-Meldeassistent sendet nicht

Er erzeugt die XML-Datei mit den technischen Angaben und führt durch den Upload. **Der Kunde sendet selbst ab, mit seinem eigenen ELSTER-Zugang.** Ein Absenden im Namen des Kunden wäre unbefugte Hilfeleistung in Steuersachen (§ 5 StBerG, BFH VII R 22/21).

### 11. `@bonbon/core` ist deterministisch

Der Kern hat **keine eigene Quelle für Zeit oder Zufall**. In `packages/core/**` verboten:

`Date.now()` · `new Date()` ohne Argument · `Math.random()` · `crypto.randomUUID()` · `performance.now()`

Zeitstempel und IDs werden von außen hineingereicht — als Parameter oder über eine injizierte Abhängigkeit (`Clock`, `IdGenerator`). Der Kern deklariert diese Schnittstellen, implementiert sie aber nicht.

Der Grund ist kein Stilempfinden: Bonberechnung und Event Log müssen deterministisch testbar sein. Genau diese Tests schützen vor Rundungs- und Steuerfehlern, und die fallen sonst erst in der Betriebsprüfung beim Kunden auf — Jahre später, mit Zinsen.

**Zeitstempel immer ISO 8601 mit Zeitzonen-Offset, nie ohne.** Keine impliziten Annahmen über die lokale Zeitzone im Kern. Der Steuersatz ist eine Funktion aus `(Produkt, Verzehrart, Datum)`; an einer Sommerzeitgrenze oder auf einem Server in einer anderen Zone darf sich daran nichts ändern.

`new Date('2026-08-21T10:15:00+02:00')` und `Date.parse(…)` bleiben erlaubt — das ist Umrechnung, nicht Uhrablesen.

**Die TSE-Seriennummer ist keine Konstante.** Bei der InMemory-TSE der Sandbox wechselt sie mit jedem Neustart des Launchers — im M0-Spike erst `dace6975-…`, nach einem Neustart `a0a5ba77-…`. **Kein Test darf auf eine feste Seriennummer prüfen.** Getestet wird, *dass* eine da ist und auf dem Beleg steht, nicht *welche*. Dasselbe gilt für Transaktionsnummer und Signaturzähler: sie zählen je Queue hoch und sind nach jedem Lauf andere.

**Schaltsekunde:** `IsoTimestamp` lässt `23:59:60` zu, weil ISO 8601 sie kennt und ein gültiger TSE-Zeitstempel nicht abgewiesen werden soll. `Date` kennt sie nicht — `Date.parse('2016-12-31T23:59:60Z')` liefert `NaN`. **Jede Umwandlung von `IsoTimestamp` nach `Date` muss den Fall deshalb ausdrücklich behandeln: entweder ablehnen oder `:60` auf `:59.999` normalisieren.** Stillschweigend durchreichen ist der eine verbotene Weg — sonst steht ein `Invalid Date` im Event Log, und das fällt erst beim Export auf.

**TSE-Zeitstempel sind keine Uhr für Reihenfolge oder Dauer.** Sie dürfen **niemals** zur Bestimmung von Reihenfolge oder Dauer verwendet werden. Die Reihenfolge der Ereignisse ergibt sich ausschließlich aus der lückenlosen Sequenznummer je Gerät (Regel 2).

Gemessen an einem echten Vorgang aus dem M0-Spike:

```
Startzeit (start-transaction):  2026-08-21T17:03:43.120Z
Log-Zeit  (finish-transaction): 2026-08-21T17:03:43.000Z
```

Die Log-Zeit hat nur Sekundengenauigkeit (`utcTimeWithSeconds`), die Startzeit Millisekunden. Das Ende liegt dadurch **120 ms vor dem Anfang**. Das ist kein Fehler der TSE, sondern die unterschiedliche Auflösung zweier Felder.

Folgen für den Code:

- Keine Sortierung nach TSE-Zeitstempeln.
- Keine Dauerberechnung, die auf ein positives Ergebnis angewiesen ist.
- Wird trotzdem irgendwo eine Differenz aus TSE-Zeitstempeln gebildet — etwa für eine Anzeige —, **muss sie negative Werte vertragen** und darf daran nicht scheitern.
- Kein `assert start <= ende` über TSE-Zeiten.

Im M0-Spike zweimal gemessen, mit **entgegengesetztem** Ergebnis:

```
Lauf 1:  Beginn 17:03:43.120Z   Logzeit 17:03:43.000Z   Ende 120 ms VOR dem Start
Lauf 2:  Beginn 18:58:12.878Z   Logzeit 18:58:13.000Z   Ende 122 ms nach dem Start
```

Die Reihenfolge ist also nicht einmal stabil falsch — sie hängt davon ab, wo die Sekunde gerade steht. Wer daraus eine Dauer bildet, bekommt mal ein positives, mal ein negatives Ergebnis für denselben Vorgang.

### 12. Ohne Signatur kein Erfolg

Ein Vorgang ohne TSE-Signatur ist **niemals** ein Erfolg. Kein Codepfad darf einen fehlenden Signaturzähler, eine fehlende Transaktionsnummer oder eine leere Signatur stillschweigend durchreichen.

**`ftState` wird immer bitweise ausgewertet.** Die unteren 32 Bit sind unabhängige Flags, keine Zustandszahl. Nur der Wert `0` in den unteren Bits gilt als Normalbetrieb.

- Ein gesetztes Flag ist auszuwerten und im Klartext zu melden.
- Ein **unbekanntes** Bit ist ein Fehler, kein „ok". Was die Dokumentation nicht kennt, wird nicht durchgewinkt.
- `EEEE_EEEE` (Error) und `FFFF_FFFF` (Fail) sind harte Fehler.

Gefunden bei genau diesem Fehler im eigenen Code: Die Queue nahm Belege an, verbuchte sie und lieferte `ftState = 0x4445000000000001` zurück. Der Spike prüfte nur auf `EEEE_EEEE`/`FFFF_FFFF` und meldete „ok" — obwohl Bit 0 „Security Mechanism ausser Betrieb" bedeutet und **keine einzige Signatur** zurückkam. Nichts stürzte ab. Ein unsignierter Bon, der als Erfolg gemeldet wird, ist genau das Szenario, das bei einer Kassennachschau zum Problem wird.

Wer einen Beleg abschließt, prüft deshalb aktiv, dass die Signaturdaten **da** sind — und verlässt sich nicht darauf, dass ein Fehler schon geworfen worden wäre.

### 13. Die Inbetriebnahme der TSE löst niemals die Software aus

Die Inbetriebnahme (Initial-operation receipt) ist ein **bewusster, einmaliger Schritt mit ausdrücklicher Bestätigung durch den Kunden**. Sie darf nicht automatisch erfolgen — nicht beim ersten Start, nicht bei der Einrichtung, nicht als stiller Reparaturversuch, wenn die Signatur fehlt.

Grund: Sie erzeugt das **Inbetriebnahmedatum**, das später in die Meldung nach **§ 146a Abs. 4 AO** eingeht. Ein von der Software selbst gesetztes Datum wäre eine Angabe gegenüber der Finanzverwaltung, die der Kunde nie getroffen hat.

Dasselbe gilt spiegelbildlich für die Außerbetriebnahme (Out-of-operation receipt). Beide Vorgänge gehören hinter eine ausdrückliche Bestätigung, werden im Event Log festgehalten und sind nie Teil eines automatischen Ablaufs.


### 14. Signatur und Vorgang sind untrennbar

Eine TSE-Signatur gehört zu **genau einem** Vorgang. Auf einem Beleg dürfen niemals die Positionen des einen und die Signatur eines anderen stehen.

**Das wird strukturell verhindert, nicht durch Sorgfalt.** Belegdruck, Export und Anzeige nehmen keine zwei unabhängigen Parameter für Vorgangsdaten und Signaturdaten entgegen, sondern **einen abgeschlossenen Vorgang, der seine Signatur bereits enthält**. Dieser Typ ist nur über eine Konstruktorfunktion zu bekommen, die beides bindet. Damit gibt es keine Aufrufstelle, an der sich die beiden vertauschen ließen.

Die Konstruktorfunktion prüft zusätzlich, dass sie zusammenpassen. Der Prüfwert nach KassenSichV enthält die Beträge des signierten Vorgangs im Klartext:

```
V0;<Kassenseriennummer>;Kassenbeleg-V1;Beleg^<19%>_<7%>_<10,7%>_<5,5%>_<0%>^<Zahlbetrag>:<Zahlart>;<TrxNr>;<SigZähler>
```

Verglichen werden Kassenseriennummer, Transaktionsnummer, Signaturzähler, Zahlbetrag und die Summen je Steuersatz. Bei einer Abweichung wird nicht gedruckt, sondern geworfen — mit Nennung jeder einzelnen Abweichung.

Ein **unlesbarer** Prüfwert gilt als Abweichung, nicht als Ausnahme. Was sich nicht nachweisen lässt, wird nicht durchgewunken (siehe Regel 12).

Gefunden im M0-Spike: Der ESC/POS-Testbon zeigte drei Positionen über 9,40 €, trug im Fuß aber die Signatur eines vorherigen Vorgangs über 3,80 €. Für einen Drucktest folgenlos — im Betrieb ein schwerer Mangel, und bei einer Kassennachschau nicht erklärbar.

### 15. Eine Kartenzahlung ohne eindeutiges Ergebnis gilt nie als bezahlt

Dieselbe Regel wie bei der TSE-Signatur (Regel 12), nur teurer: Bei der Signatur fehlt ein Beweis, bei der Kartenzahlung fehlt womöglich Geld.

Der Ausgang einer Kartenzahlung hat **vier** Zustände, nicht zwei:

| | Kunde hat bezahlt? | Kasse tut |
|---|---|---|
| `approved` | ja | Bon als bezahlt abschließen |
| `declined` | **sicher nicht** | Bon bleibt offen, andere Zahlart möglich |
| `aborted` | **sicher nicht** | wie `declined` |
| `unknown` | **nicht feststellbar** | weder noch — erst auflösen |

`unknown` darf nicht mit `declined` zusammengelegt werden. „Abgelehnt" heißt, der Kunde hat sicher nicht bezahlt. „Unbekannt" heißt, wir wissen es nicht — und diese beiden verlangen entgegengesetztes Verhalten. Ein `if (approved) … else …` ist an dieser Stelle immer falsch.

**Der Fall, für den das Mock-Terminal existiert:** Das Terminal autorisiert beim Netzbetreiber, dann reißt die Verbindung ab, bevor die Status-Information bei der Kasse ankommt. Der Kunde ist belastet, die Kasse weiß nichts davon.

Auflösung nach ZVT-Spezifikation, in dieser Reihenfolge:

1. **Status-Information erneut anfordern** — negative Quittung `84 9C` („Repeat Statusinfo"). Der günstigste Fall, es wird nichts rückgängig gemacht.
2. **Nachfragen** — `05 01` Status-Enquiry.
3. **Stornieren** — `06 30` Reversal mit `87<receipt-no>`. Der sichere Weg, wenn 1 und 2 nichts ergeben: lieber eine Zahlung stornieren, die nie stattgefunden hat — das Terminal antwortet dann schlicht „Storno nicht möglich" —, als eine erfolgte Belastung zu übersehen.

Bleibt es auch danach unklar, entscheidet ein Mensch: Terminal-Beleg prüfen, Tagesjournal abgleichen. Die Software rät nicht.

Im M0-Spike durchgespielt: Zahlung über 9,40 € → `unknown` ohne Belegnummer. Storno auf Beleg 0001 → angenommen über 9,40 €, der Kunde **war** also belastet. Dasselbe Storno erneut → „Storno nicht möglich". Die Kette ist damit belegt, nicht behauptet.
---

## Struktur

```
bonbon/
├── packages/
│   ├── core/          @bonbon/core — reines TS, KEIN React, KEIN Tauri, KEIN Node-API
│   │                  Bonberechnung · Steuerlogik · Rabatte · Rundung
│   │                  Event-Typen · DSFinV-K-Mapping
│   │                  → 100 % Testabdeckung, läuft auch im Backend
│   ├── ports/         Interfaces der Geräteschicht + Mock-Implementierungen
│   └── ui/            React-Komponenten
├── apps/
│   ├── desktop/       Tauri-App (Rust: Drucker, ZVT, Dateisystem)
│   └── backend/       Fastify + PostgreSQL
└── tools/
    └── mock-terminal/ ZVT-Terminalsimulator auf Port 20007
```

**`@bonbon/core` darf nichts importieren, das nicht in jeder JS-Laufzeitumgebung existiert.** Kein `fs`, kein `window`, kein React. Der Kern wird im Browser-Webview *und* im Node-Backend ausgeführt.

---

## Ports und Adapter

Alles, was Geld kostet oder Hardware braucht, liegt hinter einem schmalen Interface mit einer Mock- und einer Echt-Implementierung. Umgeschaltet wird über Konfiguration, nie über Code.

| Port | Mock | Echt |
|---|---|---|
| `TsePort` | `MockTse` — lokale Fantasiesignaturen, Ausfall auf Knopfdruck | fiskaltrust Launcher (localhost) bzw. fiskaly, später Swissbit |
| `PrinterPort` | escpresso auf `localhost:9100` | Epson TM-m30III, gleiche IP-Logik |
| `CashDrawerPort` | Log-Zeile plus Symbol in der UI | `ESC p` über den Drucker |
| `PaymentPort` | `MockTerminal` auf `localhost:20007` | CCV Base Next über ZVT |

**Jeder Mock muss kaputtgehen können.** Ein Mock, der immer funktioniert, testet nur den Schönwetterfall — und der Ausfallpfad ist bei einer Kasse der rechtlich heikelste Teil. Jeder Mock braucht Schalter für Timeout, Ablehnung und Totalausfall.

**Mocks sind Produktionscode**, kein Wegwerfzeug. Sie bleiben dauerhaft in der Testsuite.

---

## Testregeln

- `@bonbon/core` wird **vollständig** getestet, inklusive Property-based Tests für Rundung und gemischte Steuersätze.
- Kein Test darf Netzwerk brauchen. Dafür sind die Mocks da.
- Der TSE-Ausfallpfad hat eigene Tests: Ausfall mitten in der Transaktion, Nachsignierung, doppelte Zustellung.
- Der Verkaufspfad wird mit abgelaufenem Entitlement-Token getestet — er muss trotzdem durchlaufen (Regel 6).

---

## Stand und Meilensteine

**Aktuell: vor M0.** Es existiert noch kein Code. fiskaltrust-Sandbox-Konto ist angelegt (Rolle: KassenHersteller), Konto-ID und Access Token liegen vor.

| | Inhalt |
|---|---|
| **M0** | Spike, zwei Wochen, kostenlos: fiskaltrust-Launcher-Rundlauf · ESC/POS gegen escpresso · ZVT gegen eigenen Mock · SQLite-Event-Log unter Last (500 Events/Minute) |
| **M1** | `@bonbon/core` — Bonberechnung, Steuerlogik, Rabatte, Rundung, Event-Typen. Keine UI |
| **M2** | Tauri-App, Artikelraster, Bon, Bardruck. Vollständig offline |
| **M3** | Backend, Sync, TSE, Ausfallpfad, Signaturdaten auf dem Beleg |
| **M4** | Tagesabschluss, Kassensturz, DSFinV-K-Export, ELSTER-Meldeassistent |
| **M5** | ZVT-Kartenzahlung, ein Terminalmodell |
| **M6** | Pilotbetrieb mit echten Geräten |

---

## Was nicht gebaut wird

Tischplan, Kellnerabrechnung, Küchenmonitor mit Routing, Reservierungen, Hotelanbindung. Wenn ein Kunde das braucht, ist er nicht unser Kunde.

Genau zwei Druckermodelle und ein Terminalmodell werden offiziell unterstützt. Alles andere „auf eigenes Risiko" — Peripheriekompatibilität ist sonst eine Support-Hölle.

---

## Umgebung und Geheimnisse

- Zugangsdaten ausschließlich in `.env`, und `.env` steht in `.gitignore` **vor dem ersten Commit**
- TSE-Zugangsdaten gehören ins Backend bzw. in den Rust-Teil, **niemals ins Web-Bundle** — das kann jeder Kunde auslesen
- Systemanforderung Desktop: **Windows 10 64-bit, 4 GB RAM**. Windows 7/8.1 wird von keinem Baustein mehr unterstützt
- Beim Tauri-Windows-Installer `offlineInstaller` oder `fixedVersion` für WebView2 verwenden, nie `downloadBootstrapper` — Einrichtung im Laden passiert oft ohne verlässliches WLAN

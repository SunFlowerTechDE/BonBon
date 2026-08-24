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
| Fiskalisierung | **fiskaltrust Middleware** über den lokalen Launcher (HTTP/gRPC auf localhost), alternativ fiskaly SIGN DE V2 (*angenommen*, nie angefasst) |
| Drucker | **ESC/POS über TCP Port 9100** (Epson TM-m30III — *angenommen*, gemessen ist escpresso) |
| Kartenzahlung | **ZVT über TCP Port 20007** (Desktop — *angenommen*, gemessen ist der eigene Mock), später Payment-SDKs (Mobile) |

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

Er ist eine Funktion aus `(Produkt, Verzehrart, Datum)`.

### Was die Verzehrart heute noch bewirkt — und was nicht mehr

Bis zum 31. Dezember 2025 entschied die Verzehrart („hier essen" vs. „mitnehmen") bei fast jedem Artikel über 7 % oder 19 %, und der Umschalter war damit **die wichtigste Einzelinteraktion der ganzen App**. Dieser Satz stand hier, und er war richtig.

**Er ist es seit dem 1. Januar 2026 nicht mehr.** § 12 Abs. 2 Nr. 15 UStG (eingefügt durch das Steueränderungsgesetz 2025) stellt Speisen in der Gastronomie dauerhaft auf den ermäßigten Satz — unabhängig von der Verzehrart. Getränke bleiben in beiden Fällen beim Regelsatz. Der Umschalter bewegt den Steuersatz seitdem **nur noch bei Milchmischgetränken ab 75 % Milchanteil**: in einem Café zwei bis vier Artikel von zwanzig.

**Das Recht hat sich geändert, nicht die Einschätzung.** Wer die alte Formulierung wiederfindet, findet einen überholten Stand, keinen anderen Blickwinkel. Die Fundstellen stehen in Regel 20.

Daraus folgt für die Oberfläche: der Umschalter **richtet sich nach seiner Wirkung**. Enthält der Bon einen Artikel, bei dem die Verzehrart den Satz ändert, steht er prominent; sonst bleibt er klein und unauffällig — erreichbar, aber nicht mehr im Weg. Das verhindert auch, dass jemand ihn aus Gewohnheit betätigt, wo er folgenlos ist.

**Aufzuzeichnen bleibt sie in jedem Fall.** Die DSFinV-K will die Verzehrart sehen, ob sie den Satz bewegt oder nicht.

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

### 16. Belegdaten und Belegdarstellung sind getrennt

**Was im Event Log und im Archiv liegt, ist immer der strukturierte Belegdatensatz — niemals nur eine gerenderte Form.**

Ab 2028 wird der digitale Beleg zum Standard und Papier zur Ausnahme. Das Format dafür steht noch nicht fest; es kommt später über eine Rechtsverordnung. Wer bis dahin nur ESC/POS-Bytes oder PDF-Dateien aufbewahrt, kann daraus kein neues Format erzeugen — und der Kunde ist zehn Jahre aufbewahrungspflichtig (§ 147 AO).

Papier ist deshalb **eine von mehreren Ausgabeformen**, nicht *der* Beleg.

Der Aufbau:

```
Beleg (@bonbon/core)          strukturiert: Händlerangaben, Positionen mit
                              Menge, Preis, Steuersatz und Verzehrart,
                              Zahlungen, Steuerausweis je Satz,
                              TSE-Signaturdaten, Prüfwert, Zeitpunkte
   │
   ├── EscPosReceiptRenderer  heute: Bondrucker
   ├── HtmlReceiptRenderer    später: digitaler Beleg mit QR-Code
   └── ?                      später: das Standardformat der Rechtsverordnung
```

Im Datensatz stehen **keine** formatierten Zeichenketten: keine Zeilenumbrüche, keine Ausrichtung, keine Papierbreite, keine Euro-Zeichenketten. Beträge bleiben `Cents`, Zeitpunkte bleiben `IsoTimestamp`, der Steuersatz bleibt Promille als Ganzzahl.

Umrechnung nach Euro und jede Formatierung passieren ausschließlich im Renderer — das ist dieselbe Grenze wie in Regel 3, nur an einer Stelle festgemacht.

Ein Renderer liest den Datensatz und erzeugt eine Ausgabe. Umgekehrt geht es nicht: aus gerenderten Bytes lässt sich der Datensatz nicht zurückgewinnen.

### 17. Steuer wird je Steuersatz einmal gerundet, nicht je Position

Zwei Wege wären denkbar, und sie liefern **unterschiedliche Ergebnisse**:

| | |
|---|---|
| (a) | je Position runden, dann die gerundeten Steuerbeträge summieren |
| (b) | je Steuersatz die Bruttosumme bilden und **einmal** daraus runden |

**Gewählt ist (b).** Die DSFinV-K gibt es vor.

In der Datei `Bonpos_USt` (lines_vat.csv) haben `POS_BRUTTO`, `POS_NETTO` und `POS_UST` **fünf Dezimalstellen** — auf Positionsebene wird also gar nicht auf Cent gerundet.

In der Datei `Bonkopf_USt` (transactions_vat.csv) steht zu `BON_BRUTTO` wörtlich:

> „An dieser Stelle ist nicht einfach die Summe aus den betroffenen Positionen zu bilden. Vielmehr muss der gedruckte Betrag dargestellt werden (Rechnungsdoppel). Beträge sind mit zwei Dezimalstellen darzustellen, obwohl das Datenfeld eigentlich auf 5 Dezimalstellen ausgelegt ist."
>
> — DSFinV-K Version 2.4, Anhang D, Datei „Bonkopf_USt"

Der auf dem Beleg gedruckte Betrag je Steuersatz ist also der maßgebliche Wert, und er entsteht aus der Summe — nicht aus gerundeten Einzelteilen.

Weg (a) hätte außerdem einen praktischen Nachteil: bei jeder Position entsteht ein Rundungsfehler, der sich über den Bon aufaddiert. Drei Positionen zu 3,33 € bei 19 % ergeben je Position gerundet 159 Cent Steuer, je Summe gerundet 160. Bei zwanzig Positionen werden daraus schnell mehrere Cent, und der Beleg zeigte eine Steuersumme, die zur Bruttosumme nicht passt.

### Die Rundungsregel: kaufmännisch, halbe Einheit vom Nullpunkt weg

Nicht „aufwärts". Bei positiven Beträgen ist beides dasselbe; sie unterscheiden sich nur bei negativen. „Aufwärts" (Richtung +∞) macht aus −2,5 → −2, „vom Nullpunkt weg" macht −3.

Die Kasse braucht die zweite Variante, weil nur sie diese Zusicherung gibt:

```
steuer(−brutto) === −steuer(brutto)
```

Ein Storno muss den Verkauf **exakt** aufheben. Rundete die Retoure anders als der Verkauf, bliebe je Storno ein Cent stehen — und der fällt erst auf, wenn der Steuerberater die Summen nicht mehr nachrechnen kann.

Gerechnet wird ausschließlich in Ganzzahlen: `rest * 2 >= nenner` statt einer Division. Kein Fließkomma, nirgends (Regel 3).

### Netto wird nie eigenständig gerundet

`netto = brutto − steuer`. Damit gilt ausnahmslos `netto + steuer === brutto`, auf jeder Zeile und in der Summe. Würde Netto eigen gerundet, ginge diese Gleichung gelegentlich um einen Cent daneben.

**Geldbeträge sind nie negative Null.** `cents()` ebnet `-0` zu `0` ein. `-0 === 0` ist zwar wahr, `Object.is(-0, 0)` aber nicht — und in der Darstellung würde daraus „-0,00" auf dem Beleg.

### 18. Ein Bonrabatt ist eine eigene Position, verteilt über die Steuersätze

**Wie die DSFinV-K es darstellt** — nachgeschlagen, Kapitel 4.2.4 „Preisnachlässe, Rabatte, Entgeltminderungen":

> „Einige Entgeltminderungen (z. B. Zwischensummenrabatte) beziehen sich nicht auf die einzelne Positionszeile, sondern auf den gesamten Bon (z. B. 3% Preisnachlass bei Kundenkarte) […]. **Diese Rabatte sind als gesonderte Positionszeile mit negativen Vorzeichen in der Datei Bonpos darzustellen. Die Aufteilung der Entgeltminderung erfolgt in der Datei Bonpos_USt.**"

Und zur Frage, ob überhaupt aufgeteilt werden muss:

> „Die erleichterte Trennung der Entgelte ist jedoch bei der Nutzung elektronischer Kassensysteme nicht möglich. Hier sind die Entgeltminderungen also **direkt zuzuordnen**."
>
> — DSFinV-K Version 2.4, Kapitel 4.2.4

Daraus folgt das Datenmodell:

- Ein Bonrabatt ist **eine eigene Position** mit negativem Betrag, keine Minderung der Positionspreise.
- Diese Position trägt **je Steuersatz einen Anteil**.
- `Bonpos_USt` führt fünf Dezimalstellen (Regel 17) — verteilt wird deshalb in höherer Genauigkeit, gerundet erst dort, wo auch die Steuer gerundet wird.

### Verteilt wird über die laufende Summe — deshalb bleibt kein Restcent übrig

Nicht durch eine Regel „wer den Rest bekommt", sondern durch die Bauweise. Für jeden Steuersatz wird die **kumulierte** Bemessungsgrundlage gerundet, und der Anteil ist die Differenz zweier gerundeter Kumulierter:

```
Anteil_k = runde(kumuliert_k) − runde(kumuliert_{k−1})
Summe    = runde(kumuliert_n) − 0 = runde(gesamt)
```

Die Zwischenwerte heben sich weg. Die Summe der Anteile ist damit **immer** exakt der Gesamtrabatt — bei jeder Anzahl Steuersätze, bei jedem Verhältnis. Ein Rabatt von 100 % ergibt exakt null, weil die kumulierten Werte schon ganzzahlig sind und das Runden zur Identität wird.

Verteilt wird proportional zur **Bemessungsgrundlage je Steuersatz**. Die Steuersätze werden aufsteigend abgearbeitet, damit das Ergebnis nicht von der Eingabereihenfolge abhängt.

### Bon mit Retoure

Enthält der Bon bereits eine Rücknahme als negative Position, wird **auf die vorzeichenbehaftete Grundlage** verteilt. Ein Satz mit negativer Grundlage bekommt einen positiven Anteil — seine Rücknahme fällt also kleiner aus.

Das ist richtig: Der Rabatt bezieht sich auf das, was der Kunde tatsächlich zahlt, und der Retourenteil mindert die Zahlung bereits. Klammerte man ihn aus, wäre der Rabatt auf den Verkaufsteil höher als vereinbart.

**Ist die Bemessungsgrundlage null** — Verkauf und Retoure heben sich auf —, wird ein fester Rabattbetrag **abgelehnt**. Es gäbe keine nachvollziehbare Zuordnung zu den Steuersätzen; alles auf einen Satz zu legen wäre eine erfundene Steuerzuordnung. Ein Prozentrabatt ist in dem Fall zulässig, weil er null ergibt.

### Die Verzehrart des Bons ist umschaltbar — über ein eigenes Ereignis

Regel 1 verbietet die **stille** Änderung, nicht die Änderung. `DiningModeChanged` ist der vorgesehene Weg.

Drei Bedingungen:

1. **Positionen mit eigener Verzehrart bleiben unberührt.** Wer eine Zeile ausdrücklich abweichend gesetzt hat (Herkunft `'position'`), will sie nicht vom Bon-Umschalter mitgerissen bekommen. Das Ereignis führt diese Zeilen unter `unberuehrt` auf — sonst sähe es bei einer Prüfung nach einem übersehenen Fall aus.
2. **Das Ereignis hält je betroffener Zeile fest, welcher Steuersatz vorher und nachher galt.** Bei einer Prüfung ist genau das die Frage: warum 7 %.
3. **Nur vor `SaleFinished`.** Danach ist der Bon signiert und ausgegeben.

Der Steuersatz wird dabei über die `Steuersatzregel` neu bestimmt — eine Funktion aus `(Produkt, Verzehrart, Datum)`, wie Regel 4 es verlangt. Sie ist kein Feld am Artikel und liegt nicht im Kern, weil sie sich mit dem Datum ändert.

### Der Bon ist die Faltung seiner Ereignisse

Kein veränderbares Objekt. Ein Storno setzt ein Kennzeichen, die Zeile bleibt stehen (Regel 1). Es gibt bewusst **kein** Ereignis „Menge geändert": Eine Mengenänderung ist ein Storno plus eine neue Zeile, die über `ersetzt` auf die alte verweist. Bei einer Prüfung ist das der aussagekräftigere Verlauf.

Die Verzehrart wird je Position mit ihrer **Herkunft** festgehalten (`bon` oder `position`) — nicht nur das Ergebnis, sondern die Entscheidung (Regel 4).

### 19. Die Belegnummer läuft fort und wiederholt sich nie

Sie wird **beim Öffnen des Bons** vergeben, kommt aus dem Event Log und ist über Neustarts, Abstürze und verworfene Bons hinweg fortlaufend. Zweimal dieselbe Nummer ist nachträglich nicht zu reparieren.

Der Log ist dabei die einzige Quelle. Kein Zähler im Arbeitsspeicher, keine eigene Zählerdatei — eine zweite Quelle kann vom Log abweichen, und dann ist unklar, welche gilt.

**Auch eine Zählung ist keine zulässige Quelle.** „Anzahl der `SaleStarted`-Ereignisse plus eins" stimmt nur, solange jeder begonnene Bon auch abgeschlossen wird. Sobald ein Bon verworfen, geparkt oder von einem Absturz unterbrochen wird, vergibt sie eine Nummer ein zweites Mal. Gelesen wird deshalb die **zuletzt tatsächlich vergebene** Nummer aus dem letzten `SaleStarted`.

Eine einmal vergebene Nummer ist verbraucht, auch wenn der Bon nie ein Beleg wurde. Ein verworfener Bon hinterlässt `SaleCancelled` mit Grund und behält seine Nummer.

Gefunden im M2-Beweislauf, und nur dort zu finden: `bonNummer` lebte im Arbeitsspeicher und stand nach jedem Start wieder auf 0. Der zweite Verkauf nach einem Neustart bekam wieder `…-00001`, kollidierte im Primärschlüssel des Event Logs und brach ab — **nachdem die TSE bereits signiert hatte**. Die Kasse hatte den Vorgang gebucht, der Kunde hätte gezahlt, und kein Beleg wäre gekommen. In den kopflosen Tests konnte das nicht auffallen: dort lebt jede Kasse nur für die Dauer eines Tests.

### Ereignisse werden geschrieben, wenn sie passieren

`SaleStarted` beim Öffnen des Bons, `LineAdded` beim Antippen, `DiningModeChanged` beim Umschalten — jeweils sofort, nicht beim Abschluss. Ein Log, der erst am Ende schreibt, ist kein append-only-Log: bis dahin liegt der ganze Vorgang im Arbeitsspeicher, und ein Absturz nimmt ihn spurlos mit.

Der Preis ist gemessen und tragbar: im M0-Lasttest kosteten einzeln geschriebene Ereignisse unter Stoßlast **p99 1,4 ms**.

**Erst schreiben, dann übernehmen.** Scheitert das Schreiben, hat auch der Bon das Ereignis nicht. Sonst zeigte die Kasse eine Position, die nirgends steht.

**Der Log kommt vor der Signatur.** Stürzt die Kasse dazwischen ab, sagt der Log „abgeschlossen", während die TSE-Transaktion noch offen steht — das ist beim nächsten Start reparierbar. Umgekehrt stünde ein signierter, ausgegebener Vorgang im Log als abgebrochen, und das ist es nicht.

### Eine begonnene TSE-Transaktion muss aufgelöst werden

Die Transaktion wird beim **Bonbeginn** geöffnet, nicht beim Abschluss — die KassenSichV verlangt die Protokollierung mit Beginn des Aufzeichnungsvorgangs. Daraus folgt ein Zustand, den es vorher nicht gab: eine Transaktion, die begonnen wurde und nie endete.

**Die Quelle für „was steht offen" ist der Event Log, nicht die TSE.** Die Kasse schreibt `TseTransaktionBegonnen`, sobald sie eine Transaktion öffnet, und weiß daraus selbst, was offen steht. Eine Abfrage an die TSE bleibt **Zweitquelle** — für Reste, die nicht von dieser Kasse stammen, und für Geräte, die die Frage überhaupt beantworten können.

Jede offene Transaktion wird gegen den Event Log abgeglichen, nachgeschlagen über die **Belegreferenz**:

| Log | Was passiert |
|---|---|
| Bon vollständig (`SaleFinished` steht drin) | Transaktion abschließen — der Vorgang hat stattgefunden |
| sonst | Transaktion als abgebrochen beenden (Fail-Transaction `0x444500000000000B`) |

**Der Vorgang wird protokolliert, nicht stillschweigend bereinigt** — er geht als eigenes Ereignis in den Log. Festgehalten wird nur der **Erfolg**: ein gescheiterter Versuch bekommt kein Ereignis, sonst gälte die Transaktion beim nächsten Start als erledigt und bliebe für immer offen. Eine offene Transaktion klammheimlich zu schließen wäre die stille Änderung aus Regel 1.

Antwortet die TSE beim Start nicht, wird die Kasse **nicht** gesperrt (Regel 8). Der Log wird trotzdem abgeglichen; was an der TSE hängt, wird beim nächsten Start nachgeholt und der Aufschub gemeldet.

#### Widerlegte Annahme: `CurrentStartedTransactionNumbers` ist kein Abfrageweg

Hier stand bis zum 24. August 2026 das Gegenteil: die Kasse solle beim Start die TSE nach offenen Transaktionen fragen, der Launcher liefere dafür das Feld `CurrentStartedTransactionNumbers` — in der Antwort des Zero-Receipts `0x4445000000000002`.

**Das stimmt nicht.** Der Absatz steht hier, damit die Korrektur nicht in vier Monaten von jemandem zurückgedreht wird, der die alte Fassung für die durchdachtere hält.

**Woher die Annahme kam.** Sie stammte nicht aus der fiskaltrust-Dokumentation, sondern aus einer Fehldeutung der Launcher-Ausgabe beim Start: dort taucht der Feldname auf, und er wurde als Abfrageweg gelesen. Eine Websuche schien das zu bestätigen — die Trefferzusammenfassung behauptete, die Antwort des Zero-Receipts trage einen TSE-Status mit diesem Feld. Die Dokumentation selbst beschreibt das Feld ausschließlich als **ausgehend**.

**Wie es festgestellt wurde.** Gemessen mit [`tools/tse-spike/src/tse-info-probe.ts`](tools/tse-spike/src/tse-info-probe.ts) gegen den laufenden Launcher. Drei Befunde:

- Der **Zero-Receipt** antwortet mit 16 Signaturen, von `start-transaction-result` bis `<public-key>`. **Keine** davon führt offene Transaktionen auf; der Feldname kommt in der Antwort nicht vor.
- Der **Journal-Endpunkt** beantwortet jeden versuchten `ftJournalType` mit derselben Versionsauskunft (243 Zeichen). Es gibt dort keinen TSE-Status.
- Die Antwort auf **`start-transaction`** enthält genau **eine** Signatur (`start-transaction-signature`) und **keine Transaktionsnummer**. Die Kasse erfährt beim Öffnen also nicht einmal, welche Nummer ihre Transaktion bekommen hat.

**Was tatsächlich gilt.** `CurrentStartedTransactionNumbers` ist ein **ausgehendes** Feld: es geht im `ftReceiptCaseData` eines **impliziten** Fail-Transaction-Belegs mit, um Transaktionen zu schließen, die die Middleware nicht kennt (`cbReceiptReference` muss dann leer sein). Im Normalfall ordnet die Middleware über `cbReceiptReference` zu — der **explizite** Fail-Transaction-Beleg braucht deshalb nur die Belegreferenz, keine Nummer.

**Das ist keine geänderte Schnittstelle, sondern eine widerlegte Annahme.** Der Launcher hat sich nicht geändert; er wurde vorher nur nicht gefragt. Wer die Regel wieder umdrehen will, muss vorher messen — die Sonde liegt dafür bereit:

```
pnpm --filter @bonbon/tse-spike exec tsx src/tse-info-probe.ts
```

### Mocks führen ihren Zustand fort

Ein Mock, der bei Transaktionsnummer 1 wieder anfängt und offene Transaktionen vergisst, verdeckt genau die Fehler, die im Laden auffallen. Eine echte TSE ist ein Gerät, kein Prozess: sie vergisst beim Neustart der Kasse nichts. Transaktionsnummer, Signaturzähler und offene Transaktionen überdauern deshalb auch beim `MockTse` einen Neustart.

Das ist dieselbe Regel wie „jeder Mock muss kaputtgehen können", nur andersherum: ein Mock, der bequemer ist als das echte Gerät, testet den falschen Fall.


### 20. BonBon schlägt Steuersätze vor. Es entscheidet sie nicht.

Die Software liefert eine **Vorbelegung mit Fundstelle**, keine Auskunft. Drei Bedingungen, alle drei nicht verhandelbar:

1. **Jede Zuordnung ist änderbar.** Eine feste Zuordnung wäre faktisch eine Entscheidung.
2. **Jede Zuordnung trägt ihre Fundstelle und eine Begründung**, und beide gehen in den Event Log. Bei einer Prüfung lautet die Frage nicht „welcher Satz", sondern „warum dieser Satz" — und die Antwort muss aus den Daten kommen, nicht aus der Erinnerung dessen, der die Kasse eingerichtet hat.
3. **Die Oberfläche sagt sichtbar**, dass die Zuordnung mit dem Steuerberater zu prüfen ist. Nicht in den Einstellungen versteckt: ohne den Hinweis wirkt die Vorbelegung wie eine Auskunft.

**Im Support wird die Frage nie beantwortet, welcher Steuersatz für ein konkretes Produkt gilt.** Auch nicht „unter uns", auch nicht als „ich würde sagen". Das ist unbefugte Hilfeleistung in Steuersachen (§ 5 StBerG). Die zulässige Antwort ist, wo es steht und wie man es ändert — nicht, was richtig ist. Dieselbe Grenze wie bei Regel 10 (ELSTER): den Weg zeigen, nicht die Sache entscheiden.

### Der Steuersatz gehört zum Produkt, nicht zu einer Sammelregel

„Im Haus 19, mitnehmen 7" ist keine Vereinfachung, sondern falsch. Der Satz hängt am einzelnen Produkt, und die Verzehrart ist nur einer von mehreren Faktoren.

Gefunden im M2-Sortiment, nachgeschlagen statt angenommen:

| Produkt | im Haus | außer Haus | warum |
|---|---|---|---|
| Kaffee, Espresso, Tee | 19 % | 19 % | zubereitetes Getränk, steht nicht in Anlage 2 |
| Cappuccino | 19 % | 19 % | Milchanteil rund zwei Drittel — unter 75 % |
| Latte Macchiato | 19 % | **7 %** | Lieferung eines Milchmischgetränks ≥ 75 % Milch |
| Latte mit Haferdrink | 19 % | 19 % | Milchersatz ist keine Milch |
| Kuchen, Gebäck | **7 %** | **7 %** | Speise — seit 1.1.2026 unabhängig von der Verzehrart |
| Wasser 0,33, Apfelschorle | 19 % | 19 % | Getränk; Trinkwasser in Fertigpackung ist ausgenommen |

Fundstellen: § 12 Abs. 2 Nr. 15 UStG (Steueränderungsgesetz 2025, seit 1.1.2026) · Anlage 2 Nr. 4 und Nr. 34 zu § 12 Abs. 2 Nr. 1 UStG · FG Baden-Württemberg, Urteil vom 14.3.2024, 1 K 232/24.

**Seit dem 1. Januar 2026 bewegt die Verzehrart den Steuersatz nur noch bei Milchmischgetränken.** Speisen sind in beiden Fällen ermäßigt, Getränke in beiden Fällen Regelsatz. Was das für den Umschalter heißt, steht in Regel 4.

### Der Zeitbezug hat jetzt einen konkreten Stichtag

**Der Parameter `zeitpunkt` ist keine Zierde.** Er wird bisher nicht ausgewertet; die Vorbelegung bildet nur den Stand ab 1.1.2026 ab. Ein DSFinV-K-Export für einen Zeitraum davor bekäme die heutigen Sätze — und damit falsche.

Diese Lücke war bis zum 1. Januar 2026 theoretisch. Jetzt ist sie es nicht mehr, und der erste echte Stichtag steht fest. **Testfall für M4**, an einem realen Fall statt an einem erfundenen:

| Zeitpunkt | Artikel | Verzehrart | erwarteter Satz |
|---|---|---|---|
| `2025-12-31T23:00:00+01:00` | Käsekuchen | im Haus | **19 %** |
| `2025-12-31T23:00:00+01:00` | Käsekuchen | außer Haus | 7 % |
| `2026-01-01T00:00:00+01:00` | Käsekuchen | im Haus | **7 %** |
| `2026-01-01T00:00:00+01:00` | Käsekuchen | außer Haus | 7 % |
| beide | Latte Macchiato | außer Haus | 7 % — unverändert |
| beide | Kaffee | beide | 19 % — unverändert |

Die Silvesternacht ist dabei kein Zufallsdatum: für sie gilt vereinfachend, dass für die ganze Nacht noch der Satz von 2025 angewandt werden kann. Ein Zeitbezug, der nur auf das Kalenderdatum sieht, trifft diesen Fall nicht — und genau daran soll die M4-Umsetzung gemessen werden.

### Eine Position darf von der Verzehrart des Bons abweichen — und das muss erreichbar sein

„Zwei Cappuccino, einer bleibt hier, einer geht" ist im Café Alltag. Weil die Kasse gleiche Artikel zu einer Zeile zusammenfasst, teilen sie sich sonst eine Verzehrart, und die Regel stünde zwar da, wäre aber nicht bedienbar.

Deshalb: jede Bonzeile hat ihren eigenen Umschalter. Wird er benutzt, **spaltet sich die Zeile auf** — Storno plus zwei neue Zeilen, beide mit `ersetzt` auf die alte, weil der Log append-only ist. Die abgespaltene Zeile bekommt Herkunft `position` und wird vom Bon-Umschalter nicht mehr mitgerissen.

**Einzeln gesetzte Zeilen sind sichtbar zu kennzeichnen.** Sonst wundert sich das Personal, warum der große Schalter manche Zeilen nicht ändert — und hält es für einen Fehler.



### 21. Der Diagnose-Modus ist ein Entwicklungswerkzeug

Die Kasse kann sich selbst vermessen: Zeitstempel für jeden Artikeltipp, jedes Umschalten, die Wahl der Zahlungsart, die Bestätigung des Betrags, das Freiwerden des Rasters — dazu getrennt die Maschinenphasen TSE-Signatur, Event Log und Bondruck. Auf dem Entwicklungsrechner ist das harmlos und nützlich.

**Bei einem Kunden ist es etwas anderes.** Zu messen, wie schnell eine Aushilfe kassiert, ist Verhaltens- und Leistungskontrolle. Das braucht in Deutschland eine Rechtsgrundlage nach DSGVO und, wo ein Betriebsrat besteht, dessen Mitbestimmung nach **§ 87 Abs. 1 Nr. 6 BetrVG** — der greift bereits, wenn eine Einrichtung zur Überwachung *objektiv geeignet* ist; auf die Absicht kommt es nicht an. Eine Kasse, die Sekundenabstände je Bedienvorgang aufzeichnet, ist das.

Daraus vier Bedingungen, alle vier nicht verhandelbar:

1. **In ausgelieferten Fassungen standardmäßig aus.** Ein Vorgabewert `an` wäre kein Bequemlichkeitsdetail, sondern ein Rechtsproblem. Ein Test hält den Vorgabewert fest.
2. **Nie ohne ausdrückliche Einwilligung des Betriebs aktiviert.** Nicht durch uns, nicht aus der Ferne, nicht „zur Fehlersuche" beiläufig mitgeschaltet. Wer ihn einschaltet, tut es selbst und weiß, was er tut — die Anwendung sagt es beim Start noch einmal laut ins Protokoll.
3. **Die Daten bleiben lokal.** Keine automatische Übertragung an uns, in keiner Form, auch nicht aggregiert. Wer uns eine Messreihe schicken will, schickt die Datei.
4. **Keine Personenbezüge.** Gemessen werden Vorgänge, nicht Personen. Solange es keine Bedienerverwaltung gibt, ist das leicht einzuhalten — kommt eine, gehört diese Regel neu bewertet, bevor der Modus jemanden zuordnen kann.

### Zwei technische Bedingungen, die den Entwurf bestimmen

**Die Messwerte gehen nicht in den Event Log.** Der ist die steuerliche Aufzeichnung nach § 146a AO; Diagnosedaten haben darin nichts zu suchen — weder rechtlich noch fachlich. Eigene Datei, eigener Speicher, eigenes Format. Ein Test prüft, dass während eines gemessenen Verkaufs kein Messwert im Log landet.

**Nichts davon darf im Verkaufspfad bremsen oder blockieren (Regel 6).** Messen heißt: einen Zeitstempel in ein Array schieben. Keine Datei, kein `await`, keine Formatierung während des Verkaufs. Geschrieben wird **nach** dem Abschluss, und ein Fehler dabei erreicht den Verkauf nicht. Ist der Modus aus, steht an der Stelle ein Objekt mit leeren Methoden — der Verkaufspfad zahlt dafür nichts. Auch das ist geprüft: während eines gemessenen Verkaufs wird keine Datei angefasst.

### Gemessen werden Abstände, nicht nur Summen

Eine Gesamtdauer sagt wenig. Eine lange Pause **vor der Betragsbestätigung** heißt etwas anderes als eine lange Pause **zwischen zwei Artikeln**: das eine ist Kopfrechnen, das andere Suchen im Raster. Die Auswertung nennt deshalb die längste Pause **und wovor sie lag**, und die CSV führt den Abstand als eigene Spalte — eine Zahl, die man erst herleiten muss, wird nicht angesehen.

Die Messung beginnt beim **ersten Artikeltipp**, nicht bei einem Startknopf. Sonst misst man die Überlegungszeit des Kunden mit, und die gehört ihm, nicht der Kasse.

Als Uhr dient eine **monotone** Quelle, nicht die Wanduhr. Wer die Systemzeit stellt oder eine Zeitumstellung erwischt, bekommt sonst negative Abstände — derselbe Fehler wie bei den TSE-Zeitstempeln in Regel 11, nur an anderer Stelle.


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
| `TsePort` | `MockTse` — lokale Fantasiesignaturen, Ausfall auf Knopfdruck | fiskaltrust Launcher (localhost) · fiskaly und Swissbit *angenommen* |
| `PrinterPort` | escpresso auf `localhost:9100` | Epson TM-m30III — *angenommen*, die gleiche IP-Logik ist ungeprüft |
| `CashDrawerPort` | Log-Zeile plus Symbol in der UI | `ESC p` über den Drucker |
| `PaymentPort` | `MockTerminal` auf `localhost:20007` | CCV Base Next über ZVT — *angenommen*, nie angefasst |

**Jeder Mock muss kaputtgehen können.** Ein Mock, der immer funktioniert, testet nur den Schönwetterfall — und der Ausfallpfad ist bei einer Kasse der rechtlich heikelste Teil. Jeder Mock braucht Schalter für Timeout, Ablehnung und Totalausfall.

**Mocks sind Produktionscode**, kein Wegwerfzeug. Sie bleiben dauerhaft in der Testsuite.

---

## Gemessen oder angenommen

Dieses Verzeichnis existiert, weil eine falsche Annahme in diesem Dokument teurer ist als anderswo: was hier steht, steht mit Autorität, und in vier Monaten baut jemand darauf. Regel 19 trägt dafür ein ausformuliertes Beispiel — `CurrentStartedTransactionNumbers` galt eine Runde lang als Abfrageweg, bis jemand gemessen hat.

**Angenommen heißt nicht falsch.** Es heißt: nicht überprüft. Wer darauf baut, misst vorher.

### Gemessen

| Was | Wie |
|---|---|
| fiskaltrust-Rundlauf, `ftState`-Flags, Signaturdaten | `tools/tse-spike`, gegen den laufenden Launcher (Sandbox, InMemory-TSE) |
| TSE-Zeitstempel taugen nicht für Reihenfolge oder Dauer | zwei Läufe im M0-Spike, mit entgegengesetztem Ergebnis (Regel 11) |
| TSE-Seriennummer wechselt beim Neustart des Launchers | M0-Spike |
| `CurrentStartedTransactionNumbers` ist kein Abfrageweg | `tools/tse-spike/src/tse-info-probe.ts` (Regel 19) |
| Start-Transaction liefert keine Transaktionsnummer | dieselbe Sonde |
| Fail-Transaction über `cbReceiptReference` schließt eine offene Transaktion | dieselbe Sonde, mit anschließender Kontrolle des `ftState` |
| ESC/POS-Bon, Zeilenbreite, Umlaute, `GS !`-Verhalten | escpresso, byteweise gegen `testbon-referenz.bin` |
| ZVT-Ablauf inklusive `unknown` und Storno | eigener Mock auf Port 20007 (M0) |
| SQLite-Event-Log unter Last, Absturzsicherheit, p99 1,4 ms je Ereignis | `tools/eventlog-bench` |
| Der Rust-Weg der Tauri-App | `apps/desktop/src-tauri/src/pfadtests.rs` über die echte IPC-Brücke |
| Ein Verkauf durch die gebaute Anwendung | `werkzeuge/verkauf-im-fenster.mjs` gegen die Release-Exe |
| Steuersätze der Beispielartikel | nachgeschlagen mit Fundstelle (Regel 20) — **Vorbelegung, keine Auskunft** |

### Angenommen

| Was | Warum es offen ist |
|---|---|
| **Epson TM-m30III** | Nie angefasst. Alles, was über ESC/POS gesagt wird, ist gegen **escpresso** gemessen — Codepage WPC1252, 48 Zeichen je Zeile, `GS !` mit vertauschten Nibbles, `ESC p` für die Lade. Ein echtes Gerät kann in jedem dieser Punkte abweichen; „gleiche IP-Logik" ist eine Vermutung, kein Befund. |
| **CCV Base Next** | Nie angefasst. Der ZVT-Ablauf ist gegen den **selbst geschriebenen** Mock gemessen, und der kann nur so richtig sein wie die Lesart der Spezifikation, aus der er entstand. Zirkelschluss-Gefahr: Mock und Adapter stammen aus derselben Quelle. |
| **ZVT-Revision** | Der Mock folgt Revision 13.09. Ob 13.13 abweicht, ist ungeprüft (offener Punkt aus M0). |
| **fiskaly SIGN DE V2, Swissbit** | Nie angefasst. Beide stehen als Alternative in der Tabelle, weil der Port sie tragen soll — nicht, weil es probiert wurde. |
| **Expliziter Start gefolgt von einem Kassenbeleg** | Gemessen sind: impliziter Rundlauf (M0) und Start gefolgt von Fail-Transaction (Sonde). Die Kombination, die die Kasse tatsächlich fährt — `start-transaction`, dann Abschluss über einen Kassenbeleg — ist **nie gelaufen**. Das gehört an den Anfang von M3. |
| **Systemanforderung Windows 10 64-bit, 4 GB RAM** | Aus den Anforderungen der Bausteine abgeleitet, nicht auf einem solchen Gerät ausprobiert. |
| **`offlineInstaller` für WebView2** | Eine Entscheidung, keine Messung — der Installer wurde noch auf keinem frischen Rechner ausgeführt. |
| **`synchronous NORMAL` gegen `FULL`** | Offener Punkt aus M0, siehe `tools/eventlog-bench/README.md`. |
| **Zeitliche Änderung der Steuersätze** | Der Parameter `zeitpunkt` steht in der Signatur, wird aber nicht ausgewertet. Die Vorbelegung bildet nur den Stand ab 1.1.2026 ab. |

### Wie eine Annahme zur Messung wird

Nicht durch eine Websuche. Eine Trefferzusammenfassung hat in Regel 19 die falsche Annahme bestätigt, die die Messung anschließend widerlegte. Eine Annahme wird zur Messung, wenn ein Werkzeug im Repositorium sie gegen das echte Gerät prüft und der Lauf wiederholbar ist.

Wer eine Zeile aus der unteren Tabelle in die obere verschiebt, bringt das Werkzeug mit.


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
| **M3** | Backend, Sync, TSE, Ausfallpfad, Signaturdaten auf dem Beleg. Dazu die Entscheidung `synchronous NORMAL` gegen `FULL` — siehe [offene Punkte](tools/eventlog-bench/README.md#offene-punkte) |
| **M4** | Tagesabschluss, Kassensturz, DSFinV-K-Export, ELSTER-Meldeassistent. Dazu der **Zeitbezug der Steuersätze** — Testfall ist der Stichtag 1.1.2026, siehe Regel 20 |
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
- Systemanforderung Desktop: **Windows 10 64-bit, 4 GB RAM** (*angenommen* — aus den Anforderungen der Bausteine abgeleitet, nie auf einem solchen Geraet ausprobiert). Windows 7/8.1 wird von keinem Baustein mehr unterstützt
- Beim Tauri-Windows-Installer `offlineInstaller` oder `fixedVersion` für WebView2 verwenden, nie `downloadBootstrapper` — Einrichtung im Laden passiert oft ohne verlässliches WLAN

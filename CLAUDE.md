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

**Schaltsekunde:** `IsoTimestamp` lässt `23:59:60` zu, weil ISO 8601 sie kennt und ein gültiger TSE-Zeitstempel nicht abgewiesen werden soll. `Date` kennt sie nicht — `Date.parse('2016-12-31T23:59:60Z')` liefert `NaN`. **Jede Umwandlung von `IsoTimestamp` nach `Date` muss den Fall deshalb ausdrücklich behandeln: entweder ablehnen oder `:60` auf `:59.999` normalisieren.** Stillschweigend durchreichen ist der eine verbotene Weg — sonst steht ein `Invalid Date` im Event Log, und das fällt erst beim Export auf.

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

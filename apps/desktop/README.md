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

## Was noch nicht dran ist

Kein Rabatt in der Oberfläche, kein Bon parken, keine Bedienerverwaltung, kein
Tagesabschluss, keine Artikelverwaltung.

---

## Adapter — nichts ist fest verdrahtet

Welche TSE, welcher Drucker, welcher Event Log steht in
[`public/bonbon.config.json`](public/bonbon.config.json) und wird zur Laufzeit
gelesen (CLAUDE.md, Ports und Adapter).

Die mitgelieferte Datei steht auf dem **echten Weg** — escpresso auf Port 9100
und SQLite:

```json
{
  "drucker":  { "art": "tcp", "host": "127.0.0.1", "port": 9100 },
  "eventLog": { "art": "sqlite", "pfad": "bonbon-eventlog.db" }
}
```

Fehlt die Datei oder ist sie unlesbar, gilt die Vorgabe aus
[`src/konfiguration.ts`](src/konfiguration.ts) — Mock-TSE, Vorschaudrucker,
Event Log im Speicher. Die App startet damit **ohne jede Peripherie**, und sie
sagt im Protokoll, dass die Vorgabe greift.

Ist `tcp` eingestellt und escpresso läuft nicht, wird der Verkauf trotzdem
abgeschlossen und signiert; der Bon gilt als **nicht gedruckt** und der Grund
steht in der Abschlussmeldung. Ein fehlender Drucker darf einen Umsatz nicht
verhindern.

> **Offener Punkt.** Die Datei liegt in `public/` und wird beim Bau in das
> Anwendungsbündel gepackt. Sie lässt sich also derzeit **nicht ändern, ohne
> neu zu bauen** — für eine Kasse im Laden zu wenig. Die Konfiguration gehört
> neben die Anwendung, gelesen über den Rust-Teil. Steht für M3 an.

`tcp` und `sqlite` brauchen den Rust-Teil. Im Browser fällt die App auf
Vorschau und Speicher zurück **und sagt es im Protokoll** — statt es zu
verschweigen.

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

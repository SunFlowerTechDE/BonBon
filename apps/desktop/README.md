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
Tagesabschluss, keine Artikelverwaltung. Und die Farbwelt fehlt — das Aussehen
ist bewusst schlicht.

---

## Adapter — nichts ist fest verdrahtet

Welche TSE, welcher Drucker, welcher Event Log steht in
[`public/bonbon.config.json`](public/bonbon.config.json) und wird zur Laufzeit
gelesen (CLAUDE.md, Ports und Adapter).

Die Vorgaben sind so gewählt, dass die App **ohne Launcher und ohne Drucker
startet**:

```json
{
  "tse":      { "art": "mock" },
  "drucker":  { "art": "vorschau", "zeichenProZeile": 48, "kassenlade": true },
  "eventLog": { "art": "speicher" }
}
```

Gegen escpresso und mit SQLite:

```json
{
  "drucker":  { "art": "tcp", "host": "127.0.0.1", "port": 9100 },
  "eventLog": { "art": "sqlite", "pfad": "bonbon-eventlog.db" }
}
```

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
Schreibwegs. Ein Rust-Test hält den erwarteten Wert fest, und er wurde gegen
`eventHashInput` aus `@bonbon/core` geprüft:

```
64:0000…0000|8:EVT-0001|8:KASSE-01|1:1|25:2026-08-21T10:00:00+02:00|20:PositionHinzugefuegt|2:{}
```

## Windows

`tauri.conf.json` setzt `webviewInstallMode` auf **`offlineInstaller`** — nie
`downloadBootstrapper`. Die Einrichtung im Laden passiert oft ohne
verlässliches WLAN (CLAUDE.md, Umgebung).

## Regel 6

Zwischen `beginneBon()` und `schliesseAb()` liegt **keine** Entitlement-, Abo-
oder Netzwerkprüfung. Die einzigen Netzaufrufe auf diesem Weg gehen an die TSE
und an den Drucker — beides Geräte, keine Lizenzserver.

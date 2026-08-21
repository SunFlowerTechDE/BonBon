# apps/desktop — Platzhalter

Hier entsteht die Tauri-v2-App (Rust-Kern: Drucker, ZVT, Dateisystem; Webview:
TypeScript + React).

**Noch nicht initialisiert.** `pnpm create tauri-app` wird bewusst erst in M2
ausgefuehrt, damit das Geruest vorher steht und begutachtet werden kann. Dieser
Ordner enthaelt daher noch keine `package.json` und gehoert noch nicht zum
pnpm-Workspace.

Beim spaeteren Aufsetzen beachten (CLAUDE.md, Umgebung und Geheimnisse):

- Windows-Installer mit WebView2 als `offlineInstaller` oder `fixedVersion`
  konfigurieren — nie `downloadBootstrapper`. Die Einrichtung im Laden passiert
  oft ohne verlaessliches WLAN.
- Zielsystem ist Windows 10 64-bit mit 4 GB RAM.
- TSE-Zugangsdaten gehoeren in den Rust-Teil, niemals ins Web-Bundle.

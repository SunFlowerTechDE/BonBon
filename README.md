# BonBon

Kassensoftware fuer kleine gastronomische Betriebe in Deutschland.
Projektkontext, harte Regeln und Meilensteine stehen in [CLAUDE.md](CLAUDE.md).

**Stand: M0-Geruest.** Es gibt noch keine Fachlogik.

## Voraussetzungen

- Node.js >= 20 (getestet mit 24.13)
- pnpm 10

## Erste Schritte

```bash
pnpm install
cp .env.example .env    # Werte aus dem fiskaltrust Portal eintragen
```

`.env` wird nie committet, siehe [.gitignore](.gitignore).

## Befehle

| | |
|---|---|
| `pnpm typecheck` | TypeScript ueber alle Pakete, strict |
| `pnpm lint` | ESLint, inklusive der Plattformfreiheits-Regeln fuer `@bonbon/core` |
| `pnpm test` | Vitest (Watch: `pnpm test:watch`) |
| `pnpm build` | baut die Pakete unter `packages/` |
| `pnpm spike` | fiskaltrust-Rundlauf gegen den lokalen Launcher ([Anleitung](tools/tse-spike/README.md)) |
| `pnpm testbon` | ESC/POS-Testbon gegen escpresso auf Port 9100 ([Anleitung](tools/escpos-testbon/README.md)) |
| `pnpm terminal` | ZVT-Mock-Terminal auf Port 20007 ([Anleitung](tools/mock-terminal/README.md)) |
| `pnpm zahlung` | Kartenzahlung gegen das Mock-Terminal ([Anleitung](tools/zvt-spike/README.md)) |
| `pnpm eventlog` | Event Log unter Last, Absturz- und Manipulationstest ([Anleitung](tools/eventlog-bench/README.md)) |
| `pnpm --filter @bonbon/desktop dev` | die Kasse im Browser ([Anleitung](apps/desktop/README.md)) |

## Struktur

```
packages/core/          @bonbon/core — reines TS, plattformfrei          [Geruest]
packages/ports/         Geraete-Interfaces + Mocks                       [Platzhalter]
packages/ui/            React-Komponenten                                [Platzhalter]
apps/desktop/           Tauri-App — die Kasse (M2)                       [Verkauf laeuft]
apps/backend/           Fastify + PostgreSQL                             [Platzhalter]
tools/mock-terminal/    ZVT-Terminalsimulator, Port 20007                [fertig]
tools/zvt-spike/        Kartenzahlung gegen das Mock-Terminal (M0)        [fertig]
tools/eventlog-bench/   Event Log unter Last (M0)                        [fertig]
tools/tse-spike/        fiskaltrust-Rundlauf (M0)                        [fertig]
tools/escpos-testbon/   ESC/POS-Testbon (M0)                             [fertig]
```

### Was an `@bonbon/core` technisch erzwungen ist

Drei der harten Regeln aus [CLAUDE.md](CLAUDE.md) haengen nicht an Disziplin im Review,
sondern brechen den Build. Jede ist mit einer Wegwerf-Sonde nachgewiesen worden.

**Regel 3 — Geld hat einen eigenen Typ.** `Cents` ist ein Branded Type; ein roher `number`
ist an einer `Cents`-Stelle nicht zuweisbar, `cents()` wirft bei allem, was keine sichere
Ganzzahl ist. `parseFloat` und `.toFixed()` sind im Kern per Lint gesperrt.

**Regel 11 — Determinismus.** `Date.now()`, `new Date()` ohne Argument, `Math.random()`,
`crypto.randomUUID()` und `performance.now()` sind in `packages/core/**` per Lint gesperrt.
Zeit und IDs kommen ueber `Clock` bzw. `IdGenerator` herein. `IsoTimestamp` akzeptiert nur
ISO 8601 mit Zonenangabe und prueft den Kalender selbst — `Date.parse` nimmt `2026-02-30`
klaglos an und rollt auf den 2. Maerz weiter.

### Plattformfreiheit von `@bonbon/core`

Der Kern laeuft unveraendert im Tauri-Webview und im Node-Backend. Das wird auf
zwei Ebenen erzwungen, nicht nur per Konvention:

- `packages/core/tsconfig.json` setzt `"lib": ["ES2022"]` und `"types": []` —
  `window`, `document` und Node-Kernmodule sind schon beim Typecheck unbekannt.
- `eslint.config.js` verbietet in `packages/core/**` die Node-Kernmodule, `node:*`,
  React, `@tauri-apps/*` und die anderen Workspace-Pakete.

Beides zusammen faengt einen versehentlichen `import { readFileSync } from 'node:fs'`
ab, bevor er in einen Commit geraet.

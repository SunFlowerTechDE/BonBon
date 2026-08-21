/**
 * ZVT-Mock-Terminal, TCP auf Port 20007.
 *
 * Aufruf:
 *   pnpm terminal                          startet mit Fehlerbild "erfolg"
 *   pnpm terminal -- --szenario timeout    startet mit einem anderen Fehlerbild
 *   pnpm terminal -- --port 20008          anderer Port
 *
 * Im laufenden Betrieb umschalten: Namen des Fehlerbilds eintippen und Enter.
 * `liste` zeigt die Auswahl, `status` den aktuellen Stand, `ende` beendet.
 */

import { createInterface } from 'node:readline'

import { MockTerminal } from './server.js'
import { SCENARIOS, SCENARIO_NAMES, isScenarioName } from './scenarios.js'

function argWert(argv: readonly string[], name: string, vorgabe: string): string {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : vorgabe
}

function zeigeListe(): void {
  console.log('')
  console.log('Fehlerbilder:')
  for (const name of SCENARIO_NAMES) {
    console.log('  ' + name.padEnd(28) + SCENARIOS[name].beschreibung)
  }
  console.log('')
  console.log('  Namen eintippen und Enter zum Umschalten. liste / status / ende')
  console.log('')
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const port = Number.parseInt(argWert(argv, '--port', '20007'), 10)
  const start = argWert(argv, '--szenario', 'erfolg')
  const verzoegerung = Number.parseInt(argWert(argv, '--delay', '250'), 10)

  if (!isScenarioName(start)) {
    console.error('Unbekanntes Fehlerbild: ' + start)
    console.error('Moeglich: ' + SCENARIO_NAMES.join(', '))
    return 2
  }

  const terminal = new MockTerminal({
    port,
    stepDelayMs: verzoegerung,
    onLog: (nachricht) => {
      console.log(nachricht)
    },
  })
  terminal.setScenario(start)

  try {
    const { host, port: p } = await terminal.start()
    console.log('='.repeat(78))
    console.log('BonBon — ZVT-Mock-Terminal')
    console.log('='.repeat(78))
    console.log('  lauscht auf   tcp://' + host + ':' + String(p))
    console.log('  Fehlerbild    ' + terminal.currentScenario.name)
    console.log('  Schrittpause  ' + String(verzoegerung) + ' ms')
    zeigeListe()
  } catch (fehler) {
    console.error('Start fehlgeschlagen:')
    console.error(fehler instanceof Error ? fehler.message : String(fehler))
    if ((fehler as { code?: string }).code === 'EADDRINUSE') {
      console.error('Port ' + String(port) + ' ist belegt. Laeuft schon ein Terminal?')
    }
    return 1
  }

  // Ohne Terminal am stdin (Hintergrundprozess, Dienst, CI) gibt es sofort
  // EOF. Dann darf der Server nicht mitsterben — er soll ja lauschen. Das
  // Fehlerbild waehlt man in dem Fall beim Start mit --szenario.
  if (process.stdin.isTTY !== true) {
    console.log('  (kein interaktives Terminal — Umschalten per Eingabe entfaellt)')
    console.log('  Fehlerbild beim Start waehlen:  --szenario <name>')
    console.log('')
    await new Promise<void>((resolve) => {
      const beenden = (): void => {
        resolve()
      }
      process.once('SIGINT', beenden)
      process.once('SIGTERM', beenden)
    })
    await terminal.stop()
    return 0
  }

  const zeilen = createInterface({ input: process.stdin })
  for await (const zeile of zeilen) {
    const eingabe = zeile.trim().toLowerCase()
    if (eingabe === '') continue
    if (eingabe === 'ende' || eingabe === 'exit' || eingabe === 'quit') break
    if (eingabe === 'liste' || eingabe === 'help' || eingabe === '?') {
      zeigeListe()
      continue
    }
    if (eingabe === 'status') {
      console.log('  Fehlerbild: ' + terminal.currentScenario.name)
      console.log('  autorisierte Vorgaenge im Speicher: ' + String(terminal.autorisierteVorgaenge.length))
      for (const v of terminal.autorisierteVorgaenge) {
        console.log('    Beleg ' + v.receiptNumber + ': ' + String(v.amountInCents) + ' Cent')
      }
      continue
    }
    if (isScenarioName(eingabe)) {
      terminal.setScenario(eingabe)
      continue
    }
    console.log('  Unbekannt: ' + eingabe + '   (liste zeigt die Auswahl)')
  }

  await terminal.stop()
  console.log('Terminal beendet.')
  return 0
}

process.exitCode = await main()

/**
 * M0-Spike: Kartenzahlung gegen das ZVT-Mock-Terminal auf Port 20007.
 *
 * Aufruf:
 *   pnpm zahlung                       3,80 EUR an localhost:20007
 *   pnpm zahlung -- --betrag 940       anderer Betrag, in Cent
 *   pnpm zahlung -- --host 192.168.1.9 gegen ein echtes Terminal
 *   pnpm zahlung -- --kassenschnitt    statt Zahlung einen Kassenschnitt
 *   pnpm zahlung -- --storno 0001      Storno einer Belegnummer
 *
 * Die Anwendungslogik oeffnet hier keinen Socket. Sie kennt nur PaymentPort
 * (CLAUDE.md, Ports und Adapter).
 */

import { cents } from '@bonbon/core'
import {
  PaymentError,
  type PaymentOutcome,
  type PaymentPort,
  UnresolvedPaymentError,
  assertSettled,
} from '@bonbon/ports'
import { ZvtPaymentTerminal } from '@bonbon/ports/node'

function argWert(argv: readonly string[], name: string, vorgabe: string): string {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : vorgabe
}

function euro(betrag: number): string {
  const rest = betrag % 100
  return String((betrag - rest) / 100) + ',' + String(rest).padStart(2, '0') + ' EUR'
}

function beschreibeFehler(fehler: unknown): string {
  const zeilen: string[] = []
  let aktuell: unknown = fehler
  let tiefe = 0
  while (aktuell !== undefined && aktuell !== null && tiefe < 5) {
    const prefix = tiefe === 0 ? '' : 'verursacht durch: '
    if (aktuell instanceof PaymentError) {
      zeilen.push(prefix + aktuell.name + ': ' + aktuell.message)
      zeilen.push('  Ziel: ' + aktuell.target)
    } else if (aktuell instanceof Error) {
      zeilen.push(prefix + aktuell.name + ': ' + aktuell.message)
      const code = (aktuell as { code?: unknown }).code
      if (typeof code === 'string') zeilen.push('  code: ' + code)
    } else {
      zeilen.push(prefix + JSON.stringify(aktuell))
    }
    aktuell = aktuell instanceof Error ? aktuell.cause : undefined
    tiefe += 1
  }
  return zeilen.join('\n')
}

/**
 * Wertet den Ausgang aus — und zeigt, wie eine Kasse damit umgehen muss.
 *
 * Der Punkt ist der `unknown`-Zweig: er darf nicht in einem `else` landen, das
 * „nicht bezahlt" bedeutet, und schon gar nicht in einem, das „bezahlt"
 * bedeutet (CLAUDE.md, Regel 15).
 */
async function auswerten(
  ausgang: PaymentOutcome,
  drucker: PaymentPort,
  erwarteterBetrag: number,
): Promise<number> {
  console.log('')
  console.log('='.repeat(78))

  switch (ausgang.kind) {
    case 'approved':
      console.log('ZAHLUNG ANGENOMMEN')
      console.log('='.repeat(78))
      console.log('  Betrag:      ' + euro(ausgang.amount))
      console.log('  Belegnummer: ' + (ausgang.receiptNumber ?? '—'))
      console.log('  Trace:       ' + (ausgang.traceNumber ?? '—'))
      console.log('  Terminal-ID: ' + (ausgang.terminalId ?? '—'))
      console.log('')
      console.log('  Die Kasse darf den Bon jetzt als bezahlt abschliessen.')
      return 0

    case 'declined':
      console.log('ZAHLUNG ABGELEHNT')
      console.log('='.repeat(78))
      console.log('  Grund: ' + ausgang.reason)
      console.log('  Code:  0x' + ausgang.resultCode.toString(16).toUpperCase())
      console.log('')
      console.log('  Der Kunde hat sicher NICHT bezahlt. Der Bon bleibt offen,')
      console.log('  eine andere Zahlart ist moeglich.')
      return 1

    case 'aborted':
      console.log('ZAHLUNG ABGEBROCHEN')
      console.log('='.repeat(78))
      console.log('  Grund: ' + ausgang.reason)
      console.log('')
      console.log('  Abbruch durch Kunde oder Zeitablauf. Ebenfalls sicher NICHT bezahlt.')
      return 1

    case 'unknown': {
      console.log('UNKLARER AUSGANG — DAS IST DER GEFAEHRLICHE FALL')
      console.log('='.repeat(78))
      console.log('  Grund:       ' + ausgang.reason)
      console.log('  Belegnummer: ' + (ausgang.receiptNumber ?? 'unbekannt'))
      console.log('')
      console.log('  Das Terminal kann die Zahlung beim Netzbetreiber autorisiert haben.')
      console.log('  Die Kasse weiss es nicht. Sie darf den Vorgang weder als bezahlt')
      console.log('  buchen noch verwerfen.')
      console.log('')
      console.log('  Dass hier nichts stillschweigend als Erfolg gilt, sichert der Typ:')
      try {
        assertSettled(ausgang)
        console.log('  (unerwartet: assertSettled hat nicht geworfen)')
      } catch (fehler) {
        if (fehler instanceof UnresolvedPaymentError) {
          console.log('    ' + fehler.name + ': ' + fehler.message)
        }
      }
      console.log('')
      console.log('  Aufloesung nach Spezifikation, in dieser Reihenfolge:')
      console.log('    1. Status-Information erneut anfordern (NAK 84 9C) — geht nur,')
      console.log('       solange der Dialog steht. Beim Abriss ist er weg.')
      console.log('    2. Nachfragen mit Repeat Receipt (06 20) — liefert Ergebnis UND Belegnummer')
      console.log('    3. Stornieren mit Reversal (06 30) und 87<receipt-no>')
      console.log('')

      // --- Schritt 1: nachfragen ---------------------------------------
      //
      // Ohne diesen Schritt kennt die Kasse die Belegnummer gar nicht und
      // koennte auch nicht stornieren. Im Betrieb faellt sie nicht vom Himmel.
      console.log('  Der Spike geht Weg 2 und fragt nach:')
      console.log('')
      const nachfrage = await drucker.queryLastTransaction()
      console.log('')

      if (nachfrage.kind === 'approved') {
        const passt = nachfrage.amount === erwarteterBetrag
        console.log('  Das Terminal meldet einen erfolgreichen letzten Vorgang:')
        console.log('    Betrag      ' + euro(nachfrage.amount))
        console.log('    Belegnummer ' + (nachfrage.receiptNumber ?? '—'))
        console.log('')

        if (passt) {
          console.log('  Der Betrag stimmt mit dem angeforderten ueberein. Der Vorgang ist')
          console.log('  damit aufgeklaert: der Kunde HAT bezahlt.')
          console.log('')
          console.log('  Die Kasse kann den Bon jetzt als bezahlt abschliessen — mit der')
          console.log('  Belegnummer aus der Nachfrage. Ein Storno waere hier falsch.')
          return 0
        }

        console.log('  ACHTUNG: Der Betrag weicht ab (angefordert ' + euro(erwarteterBetrag) + ').')
        console.log('  Der letzte Vorgang gehoert also womoeglich zu einem anderen Bon.')
        console.log('  Hier darf nicht automatisch storniert werden — ein Mensch muss ran.')
        return 3
      }

      if (nachfrage.kind === 'declined' || nachfrage.kind === 'aborted') {
        console.log('  Das Terminal meldet zum letzten Vorgang: ' + nachfrage.reason)
        console.log('  Es gab also keine erfolgreiche Zahlung. Der Bon bleibt offen.')
        return 1
      }

      console.log('  Auch die Nachfrage blieb ohne klares Ergebnis: ' + nachfrage.reason)
      console.log('')

      // --- Schritt 3: stornieren ---------------------------------------
      const belegnummer = nachfrage.receiptNumber ?? ausgang.receiptNumber
      if (belegnummer === undefined) {
        console.log('  Ohne Belegnummer ist auch kein Storno moeglich.')
        console.log('  Jetzt muss ein Mensch ran: Terminal-Beleg pruefen, Tagesjournal')
        console.log('  abgleichen. Die Software raet nicht.')
        return 3
      }

      console.log('  Der Spike geht Weg 3 und storniert vorsichtshalber Beleg ' + belegnummer + ':')
      console.log('')
      const storno = await drucker.reverse(belegnummer)
      console.log('')
      if (storno.kind === 'approved') {
        console.log('  Storno erfolgreich — es GAB also eine Zahlung, sie ist jetzt zurueck.')
        console.log('  Der Bon bleibt offen, der Kunde zahlt erneut oder anders.')
      } else if (storno.kind === 'declined') {
        console.log('  Terminal meldet: ' + storno.reason)
        console.log('  Das ist die gute Nachricht — es gab nichts zu stornieren,')
        console.log('  der Kunde wurde nie belastet.')
      } else {
        console.log('  Auch das Storno blieb ohne klares Ergebnis. Jetzt muss ein Mensch ran:')
        console.log('  Terminal-Beleg pruefen, Tagesjournal abgleichen.')
      }
      return 3
    }
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const host = argWert(argv, '--host', '127.0.0.1')
  const port = Number.parseInt(argWert(argv, '--port', '20007'), 10)
  const betrag = cents(Number.parseInt(argWert(argv, '--betrag', '380'), 10))
  const timeout = Number.parseInt(argWert(argv, '--timeout', '15000'), 10)

  const terminal: PaymentPort = new ZvtPaymentTerminal({
    host,
    port,
    timeoutMs: timeout,
    onLog: (nachricht) => {
      console.log('  [ZVT] ' + nachricht)
    },
  })

  console.log('='.repeat(78))
  console.log('BonBon — Kartenzahlung (M0-Spike)')
  console.log('='.repeat(78))
  console.log('  Ziel:      ' + terminal.info.target)
  console.log('  Zeitlimit: ' + String(timeout) + ' ms')

  try {
    console.log('')
    console.log('--- Registrierung ' + '-'.repeat(60))
    await terminal.register()
    console.log('  Terminal angemeldet.')

    if (argv.includes('--kassenschnitt')) {
      console.log('')
      console.log('--- Kassenschnitt ' + '-'.repeat(60))
      const ausgang = await terminal.endOfDay()
      return auswerten(ausgang, terminal, betrag)
    }

    const stornoNummer = argWert(argv, '--storno', '')
    if (stornoNummer !== '') {
      console.log('')
      console.log('--- Storno Beleg ' + stornoNummer + ' ' + '-'.repeat(50))
      const ausgang = await terminal.reverse(stornoNummer)
      return auswerten(ausgang, terminal, betrag)
    }

    console.log('')
    console.log('--- Autorisierung ueber ' + euro(betrag) + ' ' + '-'.repeat(44))
    const ausgang = await terminal.authorize({
      amount: betrag,
      onProgress: (fortschritt) => {
        console.log('  Anzeige am Tresen: ' + fortschritt.text)
      },
    })
    return auswerten(ausgang, terminal, betrag)
  } catch (fehler) {
    console.error('')
    console.error('='.repeat(78))
    console.error('Fehlgeschlagen. Vollstaendige Meldung:')
    console.error('='.repeat(78))
    console.error('')
    console.error(beschreibeFehler(fehler))
    console.error('')
    console.error('Hinweise:')
    console.error('  - Laeuft das Mock-Terminal?  pnpm terminal')
    console.error('  - Es lauscht auf 127.0.0.1:20007.')
    return 1
  }
}

process.exitCode = await main()

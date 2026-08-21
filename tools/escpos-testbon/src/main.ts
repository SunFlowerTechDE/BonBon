/**
 * M0-Spike: ESC/POS-Testbon gegen escpresso auf TCP 9100.
 *
 * Aufruf:
 *   pnpm testbon                      an localhost:9100
 *   pnpm testbon --host 192.168.1.50  an einen echten TM-m30III
 *   pnpm testbon --mock               ohne Netzwerk, nur Ausgabe auf der Konsole
 *   pnpm testbon --no-drawer          ohne Kassenladen-Impuls
 *   pnpm testbon --hexdump            zusaetzlich die rohen Bytes
 *
 * Die Anwendungslogik oeffnet hier keinen Socket. Sie kennt nur PrinterPort;
 * welche Implementierung dahintersteht, entscheidet das Aufrufargument
 * (CLAUDE.md, Ports und Adapter).
 */

import {
  MockPrinter,
  PrinterError,
  type PrinterPort,
  TcpPrinter,
  cashDrawerPulse,
  hexdump,
  previewBox,
} from '@bonbon/ports'
import { cents } from '@bonbon/core'

import {
  type Betriebsdaten,
  type Signaturdaten,
  SignaturPasstNichtError,
  type Vorgangsdaten,
  abschliessen,
  baueTestbon,
} from './testbon.js'

// --- Bondaten --------------------------------------------------------------

const BETRIEB: Betriebsdaten = {
  betrieb: 'Café Sonnenblume',
  strasse: 'Bäckerstraße 12',
  ort: '66111 Saarbrücken',
  steuernummer: '040/123/45678',
}

const VORGANG: Vorgangsdaten = {
  belegnummer: 'ftC#T4',
  zeitpunkt: '21.08.2026 18:58',
  kasse: 'BONBON-DEV-001',
  positionen: [
    {
      menge: 1,
      bezeichnung: 'Käsekuchen',
      einzelpreis: cents(390),
      steuersatzPromille: 190,
      verzehrart: 'im Haus',
    },
    {
      menge: 1,
      bezeichnung: 'Cappuccino mit Hafermilch',
      einzelpreis: cents(380),
      steuersatzPromille: 190,
      verzehrart: 'im Haus',
    },
    {
      menge: 2,
      bezeichnung: 'Brötchen',
      einzelpreis: cents(85),
      steuersatzPromille: 70,
      verzehrart: 'außer Haus',
    },
  ],
}

/**
 * Signatur aus einem echten Rundlauf gegen den lokalen fiskaltrust Launcher,
 * erzeugt mit `pnpm spike --warenkorb` — also fuer genau diesen Warenkorb.
 *
 * Der Pruefwert weist es aus: Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar
 * Das sind 19 % = 7,70, 7 % = 1,70 und ein Zahlbetrag von 9,40 — dieselben
 * Zahlen, die der Bon zeigt. `abschliessen()` prueft das beim Zusammenbauen
 * und weigert sich sonst (CLAUDE.md, Regel 14).
 */
const SIGNATUR: Signaturdaten = {
  transaktionsnummer: '4',
  signaturzaehler: '8',
  startzeit: '2026-08-21T18:58:12.878Z',
  logzeit: '2026-08-21T18:58:13.000Z',
  signatur:
    'AgECBgkEAH8ABwMHAQGAEUZpbmlzaFRyYW5zYWN0aW9ugQ5CT05CT04tREVWLTAwMYInQmVsZWdeNy43MF8xLjcwXzAuMDBfMC4wMF8wLjAwXjkuNDA6QmFygw5LYXNzZW5iZWxlZy1WMYUBAAQgiIgRERFMKIRLhUheNbK2wFzKK2cZJ53Xf4TemZmZmZkwDAYKBAB/AAcBAQQBAwIBCBcNMjYwODIxMTg1ODEyWg==',
  tseSeriennummer: 'a0a5ba77-0c80-4095-b915-e1d63e698b2f',
  pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8',
}

// --- Hilfen ----------------------------------------------------------------

function argWert(argv: readonly string[], name: string, vorgabe: string): string {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : vorgabe
}

/** Gibt auch Nicht-Error-Werte lesbar aus, statt [object Object] zu zeigen. */
function safeStringify(wert: unknown): string {
  if (typeof wert === 'string') return wert
  try {
    return JSON.stringify(wert) ?? Object.prototype.toString.call(wert)
  } catch {
    return Object.prototype.toString.call(wert)
  }
}

function beschreibeFehler(fehler: unknown): string {
  const zeilen: string[] = []
  let aktuell: unknown = fehler
  let tiefe = 0
  while (aktuell !== undefined && aktuell !== null && tiefe < 5) {
    const prefix = tiefe === 0 ? '' : 'verursacht durch: '
    if (aktuell instanceof PrinterError) {
      zeilen.push(prefix + aktuell.name + ': ' + aktuell.message)
      zeilen.push('  Ziel: ' + aktuell.target)
    } else if (aktuell instanceof Error) {
      zeilen.push(prefix + aktuell.name + ': ' + aktuell.message)
      const code = (aktuell as { code?: unknown }).code
      if (typeof code === 'string') zeilen.push('  code: ' + code)
    } else {
      zeilen.push(prefix + safeStringify(aktuell))
    }
    aktuell = aktuell instanceof Error ? aktuell.cause : undefined
    tiefe += 1
  }
  return zeilen.join('\n')
}

// --- Ablauf ----------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const mock = argv.includes('--mock')
  const mitLade = !argv.includes('--no-drawer')
  const host = argWert(argv, '--host', '127.0.0.1')
  const port = Number.parseInt(argWert(argv, '--port', '9100'), 10)

  const protokoll = (nachricht: string): void => {
    console.log('  [Drucker] ' + nachricht)
  }

  const drucker: PrinterPort = mock
    ? new MockPrinter({ onLog: protokoll })
    : new TcpPrinter({ host, port, onLog: protokoll })

  console.log('='.repeat(78))
  console.log('BonBon — ESC/POS-Testbon (M0-Spike)')
  console.log('='.repeat(78))
  console.log('  Ziel:              ' + drucker.info.target)
  console.log('  Zeichen pro Zeile: ' + String(drucker.info.charactersPerLine) + '  (80 mm, Font A)')
  console.log('  Codepage:          WPC1252, gesetzt mit ESC t 16')
  console.log('  Kassenlade:        ' + (mitLade ? 'ja' : 'nein (--no-drawer)'))

  console.log('\n--- Bon bauen ' + '-'.repeat(63))
  let bytes: Uint8Array
  try {
    // Vorgang und Signatur werden hier gebunden — und dabei geprueft, dass
    // sie zusammengehoeren. Danach sind sie nicht mehr zu trennen.
    const vorgang = abschliessen(VORGANG, SIGNATUR)
    bytes = baueTestbon(BETRIEB, vorgang, drucker.info.charactersPerLine)
  } catch (fehler) {
    console.error('\nDer Bon liess sich nicht kodieren:\n')
    if (fehler instanceof SignaturPasstNichtError) {
      console.error('')
      console.error('='.repeat(78))
      console.error('SIGNATUR GEHOERT NICHT ZU DIESEM VORGANG')
      console.error('='.repeat(78))
    }
    console.error(beschreibeFehler(fehler))
    return 1
  }
  console.log('  ' + String(bytes.length) + ' Bytes')

  const umlaute = [...'äöüÄÖÜß'].filter((z) => Buffer.from(bytes).includes(z.charCodeAt(0)))
  console.log('  Umlaute im Bon:    ' + umlaute.join(' ') + '  (je ein Byte, nicht UTF-8)')

  console.log('\n--- Vorschau ' + '-'.repeat(64))
  console.log(previewBox(bytes, drucker.info.charactersPerLine))

  if (argv.includes('--hexdump')) {
    console.log('\n--- Rohe Bytes ' + '-'.repeat(62))
    console.log(hexdump(bytes))
  }

  console.log('\n--- Senden ' + '-'.repeat(66))
  try {
    await drucker.print(bytes)
    console.log('  Bon gesendet.')

    if (mitLade) {
      const impuls = cashDrawerPulse()
      console.log(
        '  Kassenladen-Impuls: ESC p ' +
          impuls
            .slice(2)
            .map((b) => String(b))
            .join(' ') +
          '  =  ' +
          impuls.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') +
          '   (Pin 2, 100 ms Impuls, 100 ms Pause)',
      )
      await drucker.openCashDrawer()
      console.log('  Impuls gesendet.')
    }
  } catch (fehler) {
    console.error('\n' + '='.repeat(78))
    console.error('Senden fehlgeschlagen. Vollstaendige Meldung:')
    console.error('='.repeat(78) + '\n')
    console.error(beschreibeFehler(fehler))
    console.error('\nHinweise:')
    console.error('  - Laeuft escpresso? Es lauscht auf 127.0.0.1:9100.')
    console.error('  - Ohne Drucker pruefen:  pnpm testbon --mock')
    return 1
  }

  console.log('\n' + '='.repeat(78))
  console.log('Fertig')
  console.log('='.repeat(78))
  return 0
}

process.exitCode = await main()

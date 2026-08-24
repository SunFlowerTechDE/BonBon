/**
 * Messen statt nachschlagen: woher kommen die offenen Transaktionsnummern?
 *
 * `TsePort.offeneTransaktionen()` braucht sie, um nach einem Absturz verwaiste
 * TSE-Transaktionen aufzuloesen. Eine Runde lang galt, die Antwort des
 * Zero-Receipts (`0x4445000000000002`) trage einen TSE-Status mit
 * `CurrentStartedTransactionNumbers` — eine Fehldeutung der Launcher-Ausgabe
 * beim Start, nicht eine Angabe aus der Dokumentation.
 *
 * **Gemessen stimmt das nicht.** Die Antwort enthaelt 16 Signaturen — von
 * `start-transaction-result` bis `<public-key>` —, aber keine fuehrt offene
 * Transaktionen auf. Dieses Werkzeug probiert deshalb den Journal-Endpunkt
 * durch und zeigt zu jedem versuchten `ftJournalType`, was tatsaechlich
 * zurueckkommt: Laenge, und ob die gesuchte Zeichenkette darin vorkommt.
 *
 * Damit ueberhaupt etwas offen steht, oeffnet es vorher eine Transaktion und
 * schliesst sie hinterher wieder. Eine Sandbox mit einer liegengebliebenen
 * offenen Transaktion waere genau der Zustand, den die Kasse aufloesen soll.
 *
 * Aufruf (Launcher muss laufen):
 *   pnpm --filter @bonbon/tse-spike exec tsx src/tse-info-probe.ts
 */

import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.js'
import { FiskaltrustClient, RECEIPT_CASE, describeError, signatureCaption, signatureData } from './fiskaltrust.js'
import { toHex, uint64 } from './json64.js'

/** Fail-transaction — beendet eine offene Transaktion ohne Beleg. */
const FAIL_TRANSACTION = 0x444500000000000bn

/** Journaltypen, die einen TSE-Status tragen koennten. */
const KANDIDATEN: readonly (readonly [string, string])[] = [
  ['0 — Version Information', '0'],
  ['0x4445000000000001', '4919338167972134913'],
  ['0x4445000000000002', '4919338167972134914'],
  ['0x4445000000000003', '4919338167972134915'],
  ['-1 — alles', '-1'],
]

const GESUCHT = ['CurrentStartedTransactionNumbers', 'StartedTransaction', 'TseInfo', 'tseInfo']

function referenz(): string {
  const stempel = new Date().toISOString().replace(/[-:.TZ]/g, '')
  return 'BONBON-PROBE-' + stempel
}

function beleg(cashBoxId: string, ftReceiptCase: bigint, ref: string): Record<string, unknown> {
  const jetzt = new Date().toISOString()
  return {
    ftCashBoxID: cashBoxId,
    cbTerminalID: 'BONBON-PROBE',
    cbReceiptReference: ref,
    cbReceiptMoment: jetzt,
    ftReceiptCase: uint64(ftReceiptCase),
    cbChargeItems: [],
    cbPayItems: [],
    cbReceiptAmount: 0,
  }
}

async function main(): Promise<void> {
  // Dieselbe Projektwurzel wie der Spike: die .env liegt im Repositoriumsstamm.
  // `fileURLToPath` statt `.pathname` — sonst blieben Prozentzeichen im Pfad
  // stehen, und der Ordnername hier enthaelt ein Leerzeichen.
  const wurzel = fileURLToPath(new URL('../../..', import.meta.url))
  const config = loadConfig(process.argv.slice(2), wurzel)
  const client = new FiskaltrustClient(config)
  const ref = referenz()

  console.log('=== Transaktion oeffnen ===')
  const start = await client.sign(beleg(config.cashBoxId, RECEIPT_CASE.startTransaction, ref))
  const nummer = (start.response.ftSignatures ?? []).find((s) =>
    signatureCaption(s).includes('transaktions-nummer'),
  )
  console.log('  Referenz:           ' + ref)
  console.log('  Transaktionsnummer: ' + (nummer ? signatureData(nummer) : '(nicht gefunden)'))
  console.log('  Alle Signaturen der Start-Antwort:')
  for (const sig of start.response.ftSignatures ?? []) {
    const daten = signatureData(sig)
    console.log(
      '    ' + signatureCaption(sig).padEnd(28) + daten.slice(0, 48) +
        (daten.length > 48 ? ' …' : ''),
    )
  }

  console.log('\n=== Zero-Receipt: welche Signaturen kommen? ===')
  const zero = await client.sign(
    beleg(config.cashBoxId, RECEIPT_CASE.zeroReceipt | 0x0000000100000000n, referenz()),
  )
  for (const s of zero.response.ftSignatures ?? []) {
    const daten = signatureData(s)
    console.log(
      '  ' + signatureCaption(s).padEnd(28) + daten.slice(0, 60) +
        (daten.length > 60 ? ' …' : ''),
    )
  }
  const imZero = GESUCHT.filter((w) => JSON.stringify(zero.response).includes(w))
  console.log(
    '  → gesuchte Felder in der Antwort: ' + (imZero.length === 0 ? 'KEINE' : imZero.join(', ')),
  )

  console.log('\n=== Journal durchprobieren ===')
  for (const [name, typ] of KANDIDATEN) {
    for (const query of ['ftJournalType=' + typ + '&from=0&to=0', 'type=' + typ]) {
      try {
        const { text } = await client.post('v0', 'Journal', undefined, query)
        const treffer = GESUCHT.filter((w) => text.includes(w))
        console.log(
          '  ' + name.padEnd(26) + ' [?' + query + ']  ' +
            String(text.length).padStart(7) + ' Zeichen' +
            (treffer.length > 0 ? '  ← ENTHAELT ' + treffer.join(', ') : ''),
        )
        if (treffer.length > 0) {
          const stelle = text.indexOf(treffer[0] as string)
          console.log('      ' + text.slice(Math.max(0, stelle - 150), stelle + 400))
        }
      } catch (fehler) {
        const meldung = describeError(fehler).split('\n')[0] ?? ''
        console.log('  ' + name.padEnd(26) + ' [?' + query + ']  Fehler: ' + meldung)
      }
    }
  }

  console.log('\n=== Transaktion wieder schliessen ===')
  // Explizit, ueber dieselbe Belegreferenz.
  const fail = await client.sign(beleg(config.cashBoxId, FAIL_TRANSACTION, ref))
  console.log('  Fail-Transaction ' + toHex(FAIL_TRANSACTION) + ' gesendet.')
  console.log('  Beleg: ' + String(fail.response.ftReceiptIdentification ?? '?'))
  // ftState kommt als BigInt durch `json64` — nicht ueber String() umwegen.
  const zustand = fail.response.ftState
  console.log('  ftState: ' + (typeof zustand === 'bigint' ? toHex(zustand) : String(zustand)))
}

await main()

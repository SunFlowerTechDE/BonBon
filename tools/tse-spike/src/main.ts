/**
 * M0-Spike: ein vollstaendiger Vorgang gegen den lokal laufenden
 * fiskaltrust Launcher.
 *
 *   1. Verbindung pruefen und Version ausgeben
 *   2. StartTransaction
 *   3. Position buchen: 1x Cappuccino, 3,80 EUR, 19 %, Verzehr im Haus
 *   4. FinishTransaction mit Barzahlung
 *   5. Alle Signaturdaten ausgeben
 *
 * Der Spike liegt bewusst in tools/ und nicht in packages/core: er darf die Uhr
 * lesen und Netzwerk benutzen. Regel 11 gilt nur fuer den Kern. Die Betraege
 * kommen trotzdem als Cents aus @bonbon/core — das ist die erste Probe, ob der
 * Kern ausserhalb seines eigenen Pakets benutzbar ist.
 *
 * Aufruf:
 *   pnpm spike              expliziter Ablauf (Start- und Abschlussbeleg)
 *   pnpm spike --implicit   ein einziger Sign-Aufruf, Middleware macht beides
 *   pnpm spike --verbose    zusaetzlich jeden Request und jede Antwort roh
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { cents, multiplyCents, sumCents, type Cents } from '@bonbon/core'

import { ConfigError, loadConfig, mask, type SpikeConfig } from './config.js'
import { decimal, decimalFromCents, uint64 } from './json64.js'
import {
  CHARGE_ITEM_CASE,
  FiskaltrustClient,
  PAY_ITEM_CASE,
  RECEIPT_CASE,
  RECEIPT_CASE_FLAG,
  SIGNATURE_TYPE,
  type ReceiptResponse,
  describeError,
  describeState,
  findSignature,
  indent,
  isFailureState,
  signatureCaption,
  signatureData,
  stateFlags,
  stateOf,
  unknownStateBits,
  toHex,
} from './fiskaltrust.js'
import { readUint64 } from './json64.js'

// --- Der Vorgang -----------------------------------------------------------

interface SpikePosition {
  readonly menge: number
  readonly bezeichnung: string
  readonly einzelpreis: Cents
  readonly chargeItemCase: bigint
  readonly steuersatzText: string
  readonly verzehrart: string
}

/**
 * Die Verzehrart bestimmt den Steuersatz: im Haus 19 %, ausser Haus 7 %.
 *
 * Wichtig fuers Projekt: die TSE erfaehrt nur den Steuersatz, nicht den Grund.
 * Warum 19 % und nicht 7 % berechnet wurden, muss unser eigener Event Log
 * festhalten (CLAUDE.md, Regel 4). Der Spike zeigt damit auch, was die
 * Fiskalisierung gerade *nicht* fuer uns erledigt.
 */
const CAPPUCCINO: SpikePosition = {
  menge: 1,
  bezeichnung: 'Cappuccino',
  einzelpreis: cents(380),
  chargeItemCase: CHARGE_ITEM_CASE.vatNormal19,
  steuersatzText: '19.00',
  verzehrart: 'Verzehr im Haus',
}

/** Vorgabe: der Vorgang aus dem urspruenglichen Auftrag. */
const WARENKORB_EINZELN: readonly SpikePosition[] = [CAPPUCCINO]

/**
 * Derselbe Warenkorb, den der ESC/POS-Testbon druckt. Damit laesst sich eine
 * Signatur erzeugen, die zu genau diesem Beleg gehoert (CLAUDE.md, Regel 14).
 */
const WARENKORB_TESTBON: readonly SpikePosition[] = [
  {
    menge: 1,
    bezeichnung: 'Kaesekuchen',
    einzelpreis: cents(390),
    chargeItemCase: CHARGE_ITEM_CASE.vatNormal19,
    steuersatzText: '19.00',
    verzehrart: 'Verzehr im Haus',
  },
  CAPPUCCINO,
  {
    menge: 2,
    bezeichnung: 'Broetchen',
    einzelpreis: cents(85),
    chargeItemCase: CHARGE_ITEM_CASE.vatReduced7,
    steuersatzText: '7.00',
    verzehrart: 'ausser Haus',
  },
]

function heading(text: string): void {
  console.log('\n' + '='.repeat(78))
  console.log(text)
  console.log('='.repeat(78))
}

function step(text: string): void {
  console.log('\n--- ' + text + ' ' + '-'.repeat(Math.max(0, 74 - text.length)))
}

function euro(amount: Cents): string {
  // Cents ist ein Branded Type; fuer die reine Darstellung wird hier bewusst
  // auf number zurueckgefallen. Das ist die Darstellungsschicht des Spikes,
  // die einzige Stelle, an der Cent zu Euro werden (CLAUDE.md, Regel 3).
  const value: number = amount
  const negative = value < 0
  const abs = negative ? -value : value
  const rest = abs % 100
  const whole = (abs - rest) / 100
  return (negative ? '-' : '') + String(whole) + ',' + String(rest).padStart(2, '0') + ' EUR'
}

/** Belegreferenz. Der Spike darf die Uhr lesen — er ist nicht der Kern. */
function newReceiptReference(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '')
  const noise = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0')
  return 'BONBON-SPIKE-' + stamp + '-' + noise
}

/** cbReceiptMoment muss in UTC uebergeben werden (docs: data-structures). */
function utcMoment(): string {
  return new Date().toISOString()
}

interface ReceiptOptions {
  readonly config: SpikeConfig
  readonly receiptCase: bigint
  readonly reference: string
  readonly moment: string
  readonly withPayment: boolean
  readonly withCharge?: boolean
  readonly positionen: readonly SpikePosition[]
}

function buildReceiptRequest(options: ReceiptOptions): Record<string, unknown> {
  const positionen = options.positionen
  const total = sumCents(positionen.map((p) => multiplyCents(p.einzelpreis, p.menge)))

  const request: Record<string, unknown> = {
    ftCashBoxID: options.config.cashBoxId,
    cbTerminalID: 'BONBON-SPIKE-1',
    cbReceiptReference: options.reference,
    cbReceiptMoment: options.moment,
    ftReceiptCase: uint64(options.receiptCase),
    cbChargeItems: (options.withCharge ?? true)
      ? positionen.map((position, index) => ({
          Position: index + 1,
          Quantity: position.menge,
          Description: position.bezeichnung,
          Amount: decimalFromCents(multiplyCents(position.einzelpreis, position.menge)),
          VATRate: decimal(position.steuersatzText),
          ftChargeItemCase: uint64(position.chargeItemCase),
          Moment: options.moment,
        }))
      : [],
    cbPayItems: options.withPayment
      ? [
          {
            Position: 1,
            Quantity: 1,
            Description: 'Bar',
            Amount: decimalFromCents(total),
            ftPayItemCase: uint64(PAY_ITEM_CASE.cashNationalCurrency),
            Moment: options.moment,
          },
        ]
      : [],
    cbReceiptAmount: decimalFromCents(options.withPayment ? total : cents(0)),
  }

  return request
}

// --- Ausgabe der Signaturdaten ---------------------------------------------

const REQUESTED_FIELDS: readonly (readonly [string, bigint])[] = [
  ['Transaktionsnummer', SIGNATURE_TYPE.transactionNumber],
  ['Signaturzaehler', SIGNATURE_TYPE.signatureCounter],
  ['Zeitstempel Start', SIGNATURE_TYPE.startTime],
  ['Zeitstempel Log/Ende', SIGNATURE_TYPE.logTime],
  ['Signatur', SIGNATURE_TYPE.signature],
  ['TSE-Seriennummer', SIGNATURE_TYPE.tseSerialNumber],
  ['Pruefwert (QR-Code-Inhalt)', SIGNATURE_TYPE.qrCodeContent],
]

function printSignatures(response: ReceiptResponse): void {
  console.log('\nSignaturdaten der TSE:')
  for (const [label, type] of REQUESTED_FIELDS) {
    const item = findSignature(response, type)
    const value = item === undefined ? '— nicht in der Antwort —' : signatureData(item)
    console.log('  ' + (label + ':').padEnd(28) + value)
  }

  const all = response.ftSignatures ?? []
  console.log('\nAlle ' + String(all.length) + ' Eintraege aus ftSignatures, ungefiltert:')
  if (all.length === 0) {
    console.log('  (keine)')
  }
  for (const [index, item] of all.entries()) {
    const type = readUint64(item.ftSignatureType)
    const format = readUint64(item.ftSignatureFormat)
    console.log('  [' + String(index) + '] ftSignatureType   ' + (type === undefined ? '?' : toHex(type)))
    console.log('      ftSignatureFormat ' + (format === undefined ? '?' : toHex(format)))
    console.log('      Caption           ' + signatureCaption(item))
    console.log('      Data              ' + signatureData(item))
  }
}

function printReceiptResponse(response: ReceiptResponse, rawText: string, verbose: boolean): void {
  const state = stateOf(response)
  console.log('  ftState:                  ' + describeState(state))
  for (const flag of stateFlags(state)) {
    console.log('      ' + (flag.blocksSignature ? '!! ' : '   ') + flag.text)
  }
  console.log('  ftQueueID:                ' + (response.ftQueueID ?? '—'))
  console.log('  ftQueueItemID:            ' + (response.ftQueueItemID ?? '—'))
  const row = readUint64(response.ftQueueRow)
  console.log('  ftQueueRow:               ' + (row === undefined ? '—' : row.toString()))
  console.log('  ftCashBoxIdentification:  ' + (response.ftCashBoxIdentification ?? '—'))
  console.log('  ftReceiptIdentification:  ' + (response.ftReceiptIdentification ?? '—'))
  console.log('  ftReceiptMoment:          ' + (response.ftReceiptMoment ?? '—'))

  if (response.ftStateData !== undefined && response.ftStateData !== null) {
    console.log('  ftStateData:')
    console.log(indent(JSON.stringify(response.ftStateData, null, 2), '    '))
  }

  const unbekannt = unknownStateBits(state)
  if (unbekannt !== 0n) {
    console.log('      !! ftState enthaelt Bits, die die Dokumentation nicht kennt: ' + toHex(unbekannt))
    console.log('         Das gilt als Fehler, nicht als ok (CLAUDE.md, Regel 12).')
  }

  if (isFailureState(state)) {
    console.log('\n  Die Middleware meldet einen Fehlerzustand.')
    console.log('  Laut Dokumentation steht der Grund in den ftSignatures dieser Antwort.')
    printSignatures(response)
    console.log('\n  Vollstaendige Antwort:')
    console.log(indent(rawText, '    '))
    throw new Error('Sign-Aufruf mit Fehlerzustand beantwortet: ' + describeState(state))
  }

  if (verbose) {
    console.log('\n  Vollstaendige Antwort:')
    console.log(indent(rawText, '    '))
  }
}

// --- Ablauf ----------------------------------------------------------------

/**
 * Prueft, ob die TSE tatsaechlich signiert hat.
 *
 * Ohne diese Pruefung meldet der Spike "Rundlauf abgeschlossen", obwohl gar
 * keine Signatur zurueckkam — die Queue nimmt Belege naemlich auch dann an,
 * wenn die SecurityMechanism ausser Betrieb ist. Genau diese still falsche
 * Erfolgsmeldung waere hier der gefaehrlichste Fehler.
 */
function assertSigned(response: ReceiptResponse): void {
  const gefunden = REQUESTED_FIELDS.filter(([, type]) => findSignature(response, type) !== undefined)
  if (gefunden.length > 0) return

  const flags = stateFlags(stateOf(response)).filter((f) => f.blocksSignature)

  console.log('\n' + '='.repeat(78))
  console.log('KEINE TSE-SIGNATUR IN DER ANTWORT')
  console.log('='.repeat(78))
  console.log('Die Queue hat den Beleg angenommen und verbucht, aber nichts signiert.')
  console.log('Der Rundlauf ist damit NICHT gelungen — das Ziel war die Signatur.')
  if (flags.length > 0) {
    console.log('\nftState nennt den Grund:')
    for (const flag of flags) console.log('  - ' + flag.text)
  }
  console.log('\nNaechster Schritt:')
  console.log('  Ist die Queue noch nie in Betrieb genommen worden, fehlt der')
  console.log('  Inbetriebnahmebeleg (Initial-operation receipt, ' + toHex(RECEIPT_CASE.initialOperation) + ').')
  console.log('  Einmalig pro Queue:  pnpm spike --init')
  console.log('\n  Danach mit  pnpm spike --zero  die Verbindung zur TSE testen,')
  console.log('  dann den normalen Rundlauf erneut starten.')
  throw new Error('Rundlauf ohne TSE-Signatur beendet')
}

/** Lebenszyklus-Beleg: Inbetriebnahme oder Nullbeleg. */
async function runLifecycle(config: SpikeConfig, client: FiskaltrustClient): Promise<void> {
  const istInit = config.init
  const belegart = istInit ? RECEIPT_CASE.initialOperation : RECEIPT_CASE.zeroReceipt
  const name = istInit ? 'Inbetriebnahmebeleg (Initial-operation)' : 'Nullbeleg (Zero-receipt)'

  heading('BonBon — ' + name)
  console.log('  Queue-URL:   ' + config.baseUrl)
  console.log('  CashBox-ID:  ' + mask(config.cashBoxId))
  if (istInit) {
    console.log('\n  Dieser Beleg nimmt die SecurityMechanism samt TSE in Betrieb.')
    console.log('  Er ist einmalig pro Queue und wird nur auf ausdrueckliches --init gesendet.')
  } else {
    console.log('\n  Kommunikations- und Funktionstest. Kein Umsatz, keine Position.')
  }

  // Lebenszyklus-Belege laufen laut Doku ausschliesslich im impliziten Ablauf.
  const receiptCase = belegart | RECEIPT_CASE_FLAG.implicitTransaction
  step(name + ' (' + toHex(receiptCase) + ')')

  const request = buildReceiptRequest({
    config,
    receiptCase,
    reference: newReceiptReference(),
    moment: utcMoment(),
    withPayment: false,
    withCharge: false,
    positionen: [],
  })
  const { response, text } = await client.sign(request)
  printReceiptResponse(response, text, config.verbose)
  printSignatures(response)

  const blockierend = stateFlags(stateOf(response)).filter((f) => f.blocksSignature)
  heading(blockierend.length === 0 ? 'Erledigt' : 'Erledigt, aber ftState meldet weiterhin')
  for (const flag of blockierend) console.log('  !! ' + flag.text)
  if (blockierend.length === 0) {
    console.log('  Die Queue meldet kein blockierendes Flag mehr.')
    console.log('  Naechster Schritt:  pnpm spike')
  }
}

async function run(config: SpikeConfig): Promise<void> {
  const client = new FiskaltrustClient(config)

  if (config.init || config.zero) {
    await runLifecycle(config, client)
    return
  }

  heading('BonBon — fiskaltrust-Rundlauf (M0-Spike)')
  console.log('  Queue-URL:      ' + config.baseUrl)
  console.log('  CashBox-ID:     ' + mask(config.cashBoxId))
  console.log('  Access Token:   ' + mask(config.accessToken))
  console.log('  Zeitlimit:      ' + String(config.timeoutMs) + ' ms')
  console.log('  Ablauf:         ' + (config.implicit ? 'implizit (ein Sign-Aufruf)' : 'explizit (Start- und Abschlussbeleg)'))

  // --- 1. Verbindung und Version ---
  step('1. Verbindung pruefen')
  const echo = await client.echo('BonBon M0 Spike')
  console.log('  Echo beantwortet von ' + echo.url)
  console.log('  Antwort: ' + echo.text)

  console.log('\n  Version (Journal, ftJournalType 0 = Version Information):')
  const version = await client.versionInformation()
  if (version.ok) {
    console.log('  Variante: ' + version.variant)
    console.log(indent(version.text === '' ? '(leere Antwort)' : version.text, '    '))
  } else {
    console.log('  Keine der dokumentierten Varianten hat geantwortet.')
    console.log('  Die Verbindung steht trotzdem — Echo oben war erfolgreich.')
    for (const failure of version.failures) {
      console.log('\n' + indent(failure, '  '))
    }
  }

  const warenkorb = config.warenkorb ? WARENKORB_TESTBON : WARENKORB_EINZELN
  console.log('  Warenkorb:      ' + (config.warenkorb ? 'Testbon (3 Positionen)' : 'einzeln (1x Cappuccino)'))

  const reference = newReceiptReference()
  console.log('\n  cbReceiptReference fuer diesen Vorgang: ' + reference)

  // --- 2. StartTransaction ---
  if (!config.implicit) {
    step('2. StartTransaction (Start-transaction-receipt, ' + toHex(RECEIPT_CASE.startTransaction) + ')')
    const startRequest = buildReceiptRequest({
      config,
      receiptCase: RECEIPT_CASE.startTransaction,
      reference,
      moment: utcMoment(),
      withPayment: false,
      positionen: warenkorb,
    })
    const start = await client.sign(startRequest)
    printReceiptResponse(start.response, start.text, config.verbose)
    printSignatures(start.response)
  } else {
    step('2. StartTransaction — entfaellt')
    console.log('  Im impliziten Ablauf fuehrt die Middleware StartTransaction und')
    console.log('  FinishTransaction der TSE selbst aus, innerhalb eines Sign-Aufrufs.')
    console.log('  Flag: Implicit Transaction ' + toHex(RECEIPT_CASE_FLAG.implicitTransaction))
  }

  // --- 3. Positionen ---
  step('3. Positionen')
  for (const position of warenkorb) {
    const summe = multiplyCents(position.einzelpreis, position.menge)
    console.log(
      '  ' +
        String(position.menge) +
        'x ' +
        position.bezeichnung.padEnd(14) +
        euro(summe).padStart(9) +
        '   a ' +
        euro(position.einzelpreis) +
        '   ' +
        position.steuersatzText +
        ' %  ' +
        position.verzehrart,
    )
    console.log('     ftChargeItemCase: ' + toHex(position.chargeItemCase))
  }
  const bonSumme = sumCents(warenkorb.map((p) => multiplyCents(p.einzelpreis, p.menge)))
  console.log('  ' + 'Summe'.padEnd(16) + euro(bonSumme).padStart(9) + '   (intern ' + String(bonSumme) + ' Cent)')
  console.log('')
  console.log('  Hinweis: Die Positionen reisen in cbChargeItems mit dem Beleg —')
  console.log('  fiskaltrust kennt keinen eigenen Aufruf zum Buchen einer Zeile.')

  // --- 4. FinishTransaction ---
  const finishCase = config.implicit
    ? RECEIPT_CASE.posReceipt | RECEIPT_CASE_FLAG.implicitTransaction
    : RECEIPT_CASE.posReceipt
  step('4. FinishTransaction mit Barzahlung (Pos-receipt, ' + toHex(finishCase) + ')')
  const finishRequest = buildReceiptRequest({
    config,
    receiptCase: finishCase,
    reference,
    moment: utcMoment(),
    withPayment: true,
    positionen: warenkorb,
  })
  const finish = await client.sign(finishRequest)
  printReceiptResponse(finish.response, finish.text, config.verbose)

  // --- 5. Signaturdaten ---
  step('5. Signaturdaten des Abschlussbelegs')
  printSignatures(finish.response)

  assertSigned(finish.response)

  heading('Rundlauf abgeschlossen')
  console.log('  Belegreferenz: ' + reference)
  console.log('  Beleg-ID:      ' + (finish.response.ftReceiptIdentification ?? '—'))
}

// --- Einstieg --------------------------------------------------------------

async function main(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url))
  const projectRoot = resolve(here, '..', '..', '..')

  let config: SpikeConfig
  try {
    config = loadConfig(process.argv.slice(2), projectRoot)
  } catch (error) {
    console.error('\nKonfiguration unvollstaendig:\n')
    console.error(error instanceof ConfigError ? error.message : describeError(error))
    return 2
  }

  try {
    await run(config)
    return 0
  } catch (error) {
    console.error('\n' + '='.repeat(78))
    console.error('Der Rundlauf ist gescheitert. Vollstaendige Meldung:')
    console.error('='.repeat(78) + '\n')
    console.error(describeError(error))
    console.error('\nHinweise zur Eingrenzung:')
    console.error('  - Laeuft der Launcher? Test-Modus: test.cmd im Launcher-Ordner.')
    console.error('  - Stimmt FISKALTRUST_URL? Portal -> Configuration -> Queue, Detailbereich.')
    console.error('  - Ist die Queue in der CashBox-Konfiguration einer TSE/SCU zugeordnet?')
    console.error('  - Bei --implicit gegenpruefen, ob es am expliziten Ablauf liegt.')
    return 1
  }
}

process.exitCode = await main()

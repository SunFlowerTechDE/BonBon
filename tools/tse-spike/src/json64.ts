/**
 * JSON mit 64-Bit-Ganzzahlen.
 *
 * Die fiskaltrust-Schnittstelle benutzt uint64 fuer ftReceiptCase,
 * ftChargeItemCase, ftPayItemCase, ftSignatureType und ftState. Diese Werte
 * liegen oberhalb von Number.MAX_SAFE_INTEGER, und JavaScript verliert sie
 * still in beide Richtungen:
 *
 *   JSON.stringify({ ftReceiptCase: 4919338172267102209 })
 *     -> {"ftReceiptCase":4919338172267102000}     (falscher Beleg-Typ)
 *
 *   JSON.parse('4919338167972134935')  // Transaktionsnummer
 *   JSON.parse('4919338167972134936')  // Signaturzaehler
 *     -> beide 4919338167972135000     (nicht mehr unterscheidbar)
 *
 * Beides faellt nicht auf, es wird einfach falsch. Deshalb gehen 64-Bit-Werte
 * hier als BigInt durch und werden erst beim Serialisieren als roher
 * Zahlen-Token in den JSON-Text gesetzt.
 */

const RAW_OPEN = '@@bonbon-raw:'
const RAW_CLOSE = ':bonbon-raw@@'

/** Zahlen-Literal, das woertlich im JSON landen soll — ohne Umweg ueber double. */
export type RawNumber = number & { readonly __rawJsonNumber: unique symbol }

/**
 * Markiert ein Zahlen-Literal. Der Rueckgabewert traegt den Typ `number`, damit
 * er in die Request-Typen passt, ist zur Laufzeit aber ein String mit Marke.
 */
function raw(literal: string): RawNumber {
  return (RAW_OPEN + literal + RAW_CLOSE) as unknown as RawNumber
}

/** Dezimalzahl als woertliches Literal, z. B. Steuersatz "19.00". */
export function decimal(literal: string): RawNumber {
  if (!/^-?\d+(?:\.\d+)?$/.test(literal)) {
    throw new RangeError(`Kein gueltiges Dezimalliteral: ${literal}`)
  }
  return raw(literal)
}

/** uint64-Kennzahl (ftReceiptCase und Verwandte) als exaktes Literal. */
export function uint64(value: bigint): RawNumber {
  return raw(value.toString())
}

/**
 * Cent-Betrag als Dezimalzahl mit zwei Nachkommastellen.
 *
 * Die Umrechnung laeuft ausschliesslich ueber Ganzzahl-Arithmetik und endet in
 * einem Text — es entsteht zu keinem Zeitpunkt ein Fliesskommawert
 * (CLAUDE.md, Regel 3). Die Schnittstelle verlangt an dieser Stelle eine
 * Dezimalzahl; das ist die Systemgrenze, an der Cent zu Euro werden.
 */
export function decimalFromCents(amountInCents: number): RawNumber {
  if (!Number.isSafeInteger(amountInCents)) {
    throw new RangeError(`Betrag muss eine sichere Ganzzahl in Cent sein: ${String(amountInCents)}`)
  }
  const negative = amountInCents < 0
  const abs = negative ? -amountInCents : amountInCents
  const restCents = abs % 100
  const euros = (abs - restCents) / 100
  return raw(`${negative ? '-' : ''}${String(euros)}.${String(restCents).padStart(2, '0')}`)
}

const RAW_TOKEN = /"@@bonbon-raw:(-?[0-9]+(?:\.[0-9]+)?):bonbon-raw@@"/g

/** Serialisiert und setzt die markierten Literale als echte JSON-Zahlen ein. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(RAW_TOKEN, '$1')
}

/**
 * Diese Felder kommen als uint64 zurueck und muessen vor dem Parsen in Strings
 * verwandelt werden, sonst rundet JSON.parse sie kaputt.
 */
const UINT64_FIELDS = [
  'ftState',
  'ftReceiptCase',
  'ftChargeItemCase',
  'ftPayItemCase',
  'ftSignatureType',
  'ftSignatureFormat',
  'ftQueueRow',
]

const UINT64_PATTERN = new RegExp(
  String.raw`"(${UINT64_FIELDS.join('|')})"\s*:\s*(-?\d+)`,
  'gi',
)

/**
 * Parst eine Antwort und haelt die uint64-Felder als String fest, damit sie
 * verlustfrei nach BigInt umgewandelt werden koennen.
 */
export function parse(text: string): unknown {
  return JSON.parse(text.replace(UINT64_PATTERN, '"$1":"$2"'))
}

/** Liest ein uint64-Feld, das `parse()` als String erhalten hat. */
export function readUint64(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  return undefined
}

/** `0x4445000000000017` — lesbare Form fuer die Ausgabe. */
export function toHex(value: bigint): string {
  return `0x${value.toString(16).toUpperCase().padStart(16, '0')}`
}

/**
 * ZVT-Protokoll — Grundbausteine.
 *
 * Quelle: "ECR-Interface ZVT-Protocol, Commands, Bitmaps, Error Messages",
 * Revision 13.09 final vom 20.11.2020, Verband der Terminalhersteller in
 * Deutschland e.V. (PA00P015_13.09_final_en.pdf, frei beim VdTH).
 * Gegengeprueft an der Umsetzung von Portalum.Zvt (MIT).
 *
 * Reine Byte-Arbeit, kein I/O — dadurch im Test vollstaendig pruefbar.
 */

// --- APDU ------------------------------------------------------------------

/**
 * "The APDU consists of a Control-field (2 bytes), Length-field (1 byte/3
 * bytes) and Data-block."
 *
 * Das Laengenfeld ist einstellig, solange die Daten kuerzer als 255 Byte sind.
 * Bei 0xFF folgen zwei weitere Bytes, niederwertiges zuerst. Beispiel aus der
 * Spezifikation: `06 D3 FF 5D 03 …` — 0x035D = 861 Byte Daten.
 */
export interface Apdu {
  /** Erstes Byte des Control-fields (CLASS bzw. CCRC). */
  readonly controlClass: number
  /** Zweites Byte des Control-fields (INSTR bzw. APRC). */
  readonly controlInstruction: number
  readonly data: Uint8Array
}

export class ZvtProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZvtProtocolError'
  }
}

export function encodeApdu(apdu: Apdu): Uint8Array {
  const laenge = apdu.data.length
  const kopf: number[] = [apdu.controlClass, apdu.controlInstruction]

  if (laenge < 0xff) {
    kopf.push(laenge)
  } else if (laenge <= 0xffff) {
    kopf.push(0xff, laenge & 0xff, (laenge >> 8) & 0xff)
  } else {
    throw new ZvtProtocolError('APDU zu lang: ' + String(laenge) + ' Byte, erlaubt sind 65535')
  }

  const bytes = new Uint8Array(kopf.length + laenge)
  bytes.set(kopf, 0)
  bytes.set(apdu.data, kopf.length)
  return bytes
}

export interface DecodedApdu {
  readonly apdu: Apdu
  /** Wie viele Bytes des Puffers verbraucht wurden. */
  readonly bytesConsumed: number
}

/**
 * Liest eine APDU vom Anfang des Puffers.
 *
 * Liefert `undefined`, wenn der Puffer noch unvollstaendig ist — bei TCP
 * kommen Nachrichten geteilt an, und ein halber Befehl darf nicht als
 * Protokollfehler gelten.
 */
export function decodeApdu(buffer: Uint8Array): DecodedApdu | undefined {
  if (buffer.length < 3) return undefined

  const controlClass = buffer[0] as number
  const controlInstruction = buffer[1] as number
  const ersteLaenge = buffer[2] as number

  let laenge: number
  let kopfLaenge: number
  if (ersteLaenge === 0xff) {
    if (buffer.length < 5) return undefined
    laenge = (buffer[3] as number) | ((buffer[4] as number) << 8)
    kopfLaenge = 5
  } else {
    laenge = ersteLaenge
    kopfLaenge = 3
  }

  if (buffer.length < kopfLaenge + laenge) return undefined

  return {
    apdu: {
      controlClass,
      controlInstruction,
      data: buffer.slice(kopfLaenge, kopfLaenge + laenge),
    },
    bytesConsumed: kopfLaenge + laenge,
  }
}

// --- BCD -------------------------------------------------------------------

/**
 * Betrag als 6 Byte gepacktes BCD (BMP 04).
 *
 * Der Betrag ist in Cent zu uebergeben. Die Kasse rechnet nirgends in Euro
 * (CLAUDE.md, Regel 3), und ZVT will ebenfalls die kleinste Waehrungseinheit —
 * 3,80 EUR sind `00 00 00 00 03 80`.
 */
export function encodeAmount(amountInCents: number): Uint8Array {
  if (!Number.isSafeInteger(amountInCents) || amountInCents < 0) {
    throw new ZvtProtocolError(
      'Betrag muss eine nicht-negative Ganzzahl in Cent sein: ' + String(amountInCents),
    )
  }
  const ziffern = String(amountInCents).padStart(12, '0')
  if (ziffern.length > 12) {
    throw new ZvtProtocolError('Betrag passt nicht in 6 Byte BCD: ' + String(amountInCents))
  }
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i += 1) {
    // Gepacktes BCD: hoeherwertige Ziffer ins obere Halbbyte.
    const paar = ziffern.slice(i * 2, i * 2 + 2)
    bytes[i] = (Number(paar[0]) << 4) | Number(paar[1])
  }
  return bytes
}

export function decodeAmount(bytes: Uint8Array): number {
  let ziffern = ''
  for (const b of bytes) {
    ziffern += String((b >> 4) & 0x0f) + String(b & 0x0f)
  }
  if (!/^\d+$/.test(ziffern)) {
    throw new ZvtProtocolError('Kein gueltiges BCD: ' + [...bytes].join(' '))
  }
  return Number.parseInt(ziffern, 10)
}

/** Beliebige Dezimalstellen als gepacktes BCD fester Laenge (Passwort, Trace). */
export function encodeBcd(value: number, byteLength: number): Uint8Array {
  const ziffern = String(value).padStart(byteLength * 2, '0')
  if (ziffern.length > byteLength * 2) {
    throw new ZvtProtocolError(
      String(value) + ' passt nicht in ' + String(byteLength) + ' Byte BCD',
    )
  }
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i += 1) {
    bytes[i] = (Number(ziffern[i * 2]) << 4) | Number(ziffern[i * 2 + 1])
  }
  return bytes
}

export function decodeBcd(bytes: Uint8Array): string {
  let ziffern = ''
  for (const b of bytes) ziffern += String((b >> 4) & 0x0f) + String(b & 0x0f)
  return ziffern
}

// --- Bitmaps ---------------------------------------------------------------

/**
 * Fester Teil der Bitmap-Tabelle (Kapitel 13, "Summary of utilised BMPs").
 * Nur die Bitmaps mit fester Laenge, die dieser Spike braucht.
 */
export const BMP_LENGTH: ReadonlyMap<number, number> = new Map([
  [0x01, 1], // <timeout>
  [0x02, 1], // <max status infos>
  [0x03, 1], // <service-byte>
  [0x04, 6], // <amount>            6 byte BCD
  [0x05, 1], // <pump no.>
  [0x0b, 3], // <trace>             3 byte BCD
  [0x0c, 3], // <time>              3 byte BCD HHMMSS
  [0x0d, 2], // <date>              2 byte BCD MMDD
  [0x0e, 2], // <expiry date>       2 byte BCD YYMM
  [0x17, 2], // <card sequence no>  2 byte BCD
  [0x19, 1], // <payment type>
  [0x27, 1], // <result-code>
  [0x29, 4], // <terminal-ID>       4 byte BCD
  [0x37, 3], // <orig. trace>       3 byte BCD
  [0x49, 2], // <currency code CC>  2 byte BCD
  [0x87, 2], // <receipt-no>        2 byte BCD
  [0x88, 3], // <turnover-no>       3 byte BCD
  [0x8a, 1], // <card-type>
  [0x8b, 0], // LL-Var
  [0x8c, 1], // <card-type ID>
])

export interface Bitmap {
  readonly id: number
  readonly value: Uint8Array
}

/**
 * Liest die Bitmaps eines Datenblocks, soweit ihre Laenge bekannt ist.
 *
 * Trifft der Parser auf eine unbekannte Bitmap, bricht er ab und meldet, wie
 * weit er gekommen ist. Er raet nicht, wie lang das Feld sein koennte — sonst
 * verschiebt sich alles Folgende still, und der Betrag stuende womoeglich
 * falsch im Ergebnis.
 */
export function parseBitmaps(data: Uint8Array): {
  bitmaps: Bitmap[]
  unparsedFrom?: number
} {
  const bitmaps: Bitmap[] = []
  let i = 0
  while (i < data.length) {
    const id = data[i] as number
    const laenge = BMP_LENGTH.get(id)
    if (laenge === undefined || laenge === 0) {
      return { bitmaps, unparsedFrom: i }
    }
    if (i + 1 + laenge > data.length) {
      return { bitmaps, unparsedFrom: i }
    }
    bitmaps.push({ id, value: data.slice(i + 1, i + 1 + laenge) })
    i += 1 + laenge
  }
  return { bitmaps }
}

export function findBitmap(bitmaps: readonly Bitmap[], id: number): Uint8Array | undefined {
  return bitmaps.find((b) => b.id === id)?.value
}

/** Baut einen Datenblock aus Bitmaps. */
export function buildBitmaps(entries: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  const bytes: number[] = []
  for (const [id, value] of entries) {
    bytes.push(id, ...value)
  }
  return Uint8Array.from(bytes)
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

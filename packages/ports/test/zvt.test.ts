import { describe, expect, it } from 'vitest'

import {
  ACK,
  ECR_COMMAND,
  PT_COMMAND,
  RESULT_CODE,
  UnresolvedPaymentError,
  assertSettled,
  decodeAmount,
  decodeApdu,
  decodeBcd,
  encodeAmount,
  encodeApdu,
  encodeBcd,
  findBitmap,
  intermediateText,
  isAbort,
  isPositiveAck,
  type PaymentOutcome,
  parseBitmaps,
  resultText,
  toHex,
} from '../src/index.js'

const hex = (bytes: Uint8Array): string => toHex(bytes)

describe('APDU', () => {
  it('baut Control-field, Laenge und Datenblock', () => {
    const bytes = encodeApdu({
      controlClass: 0x06,
      controlInstruction: 0x00,
      data: Uint8Array.from([0x00, 0x00, 0x00, 0x96, 0x09, 0x78]),
    })
    expect(hex(bytes)).toBe('06 00 06 00 00 00 96 09 78')
  })

  it('baut eine leere APDU', () => {
    const bytes = encodeApdu({ controlClass: 0x80, controlInstruction: 0x00, data: new Uint8Array(0) })
    expect(hex(bytes)).toBe('80 00 00')
  })

  it('nutzt das dreistellige Laengenfeld ab 255 Byte', () => {
    // Spezifikation: "Length-field (1 byte/3 bytes)". Bei 0xFF folgen zwei
    // weitere Bytes, niederwertiges zuerst — Beispiel aus der Doku:
    // 06 D3 FF 5D 03 … entspricht 0x035D = 861 Byte.
    const bytes = encodeApdu({
      controlClass: 0x06,
      controlInstruction: 0xd3,
      data: new Uint8Array(861),
    })
    expect(hex(bytes.slice(0, 5))).toBe('06 D3 FF 5D 03')
    expect(bytes.length).toBe(5 + 861)
  })

  it('liest eine APDU wieder ein', () => {
    const gelesen = decodeApdu(Uint8Array.from([0x04, 0xff, 0x01, 0x0a]))
    expect(gelesen?.apdu.controlClass).toBe(0x04)
    expect(gelesen?.apdu.controlInstruction).toBe(0xff)
    expect([...(gelesen?.apdu.data ?? [])]).toEqual([0x0a])
    expect(gelesen?.bytesConsumed).toBe(4)
  })

  it('meldet unvollstaendige Puffer, statt zu raten', () => {
    // Bei TCP kommen Nachrichten geteilt an. Ein halber Befehl ist kein
    // Protokollfehler, sondern noch nicht fertig.
    expect(decodeApdu(Uint8Array.from([0x06]))).toBeUndefined()
    expect(decodeApdu(Uint8Array.from([0x06, 0x01, 0x0a, 0x04]))).toBeUndefined()
    expect(decodeApdu(Uint8Array.from([0x06, 0xd3, 0xff, 0x5d]))).toBeUndefined()
  })

  it('laesst mehrere APDUs im Puffer hintereinander lesen', () => {
    const puffer = Uint8Array.from([0x80, 0x00, 0x00, 0x04, 0xff, 0x01, 0x0a])
    const erste = decodeApdu(puffer)
    expect(erste?.bytesConsumed).toBe(3)
    const zweite = decodeApdu(puffer.slice(erste?.bytesConsumed ?? 0))
    expect(zweite?.apdu.controlInstruction).toBe(0xff)
  })

  it('geht durch Kodieren und Dekodieren unveraendert', () => {
    const original = { controlClass: 0x06, controlInstruction: 0x01, data: Uint8Array.from([1, 2, 3]) }
    const zurueck = decodeApdu(encodeApdu(original))
    expect(zurueck?.apdu.controlClass).toBe(original.controlClass)
    expect([...(zurueck?.apdu.data ?? [])]).toEqual([1, 2, 3])
  })
})

describe('Betraege als BCD (BMP 04)', () => {
  it('kodiert 3,80 EUR als 6 Byte gepacktes BCD', () => {
    expect(hex(encodeAmount(380))).toBe('00 00 00 00 03 80')
  })

  it('kodiert 9,40 EUR', () => {
    expect(hex(encodeAmount(940))).toBe('00 00 00 00 09 40')
  })

  it('kodiert null', () => {
    expect(hex(encodeAmount(0))).toBe('00 00 00 00 00 00')
  })

  it('kodiert grosse Betraege', () => {
    // 123456 Cent = 1234,56 EUR -> Ziffern 000000123456
    expect(hex(encodeAmount(123456))).toBe('00 00 00 12 34 56')
  })

  it('liest Betraege zurueck', () => {
    for (const betrag of [0, 1, 380, 940, 123456, 999999999999]) {
      expect(decodeAmount(encodeAmount(betrag))).toBe(betrag)
    }
  })

  it('weist Euro-Betraege ab — hier gilt Cent', () => {
    expect(() => encodeAmount(3.8)).toThrow()
  })

  it('weist negative Betraege ab', () => {
    expect(() => encodeAmount(-380)).toThrow()
  })
})

describe('BCD allgemein', () => {
  it('kodiert das Passwort als 3 Byte', () => {
    expect(hex(encodeBcd(0, 3))).toBe('00 00 00')
    expect(hex(encodeBcd(123456, 3))).toBe('12 34 56')
  })

  it('kodiert die Waehrung 978 als 2 Byte', () => {
    expect(hex(encodeBcd(978, 2))).toBe('09 78')
  })

  it('liest zurueck', () => {
    expect(decodeBcd(encodeBcd(1, 2))).toBe('0001')
  })

  it('weist zu grosse Werte ab', () => {
    expect(() => encodeBcd(1234567, 3)).toThrow()
  })
})

describe('Bitmaps', () => {
  it('liest Ergebniscode und Betrag aus einer Status-Information', () => {
    const daten = Uint8Array.from([0x27, 0x00, 0x04, ...encodeAmount(940), 0x87, 0x00, 0x01])
    const { bitmaps, unparsedFrom } = parseBitmaps(daten)
    expect(unparsedFrom).toBeUndefined()
    expect(findBitmap(bitmaps, 0x27)?.[0]).toBe(0x00)
    expect(decodeAmount(findBitmap(bitmaps, 0x04) as Uint8Array)).toBe(940)
    expect(decodeBcd(findBitmap(bitmaps, 0x87) as Uint8Array)).toBe('0001')
  })

  it('bricht bei einer unbekannten Bitmap ab, statt weiterzuraten', () => {
    // Wuerde der Parser die Laenge schaetzen, verschoebe sich alles Folgende
    // still — und der Betrag stuende falsch im Ergebnis.
    const daten = Uint8Array.from([0x27, 0x00, 0xf5, 0x01, 0x02, 0x04, ...encodeAmount(940)])
    const { bitmaps, unparsedFrom } = parseBitmaps(daten)
    expect(bitmaps).toHaveLength(1)
    expect(unparsedFrom).toBe(2)
  })

  it('bricht ab, wenn eine Bitmap abgeschnitten ist', () => {
    const { bitmaps, unparsedFrom } = parseBitmaps(Uint8Array.from([0x04, 0x00, 0x00]))
    expect(bitmaps).toHaveLength(0)
    expect(unparsedFrom).toBe(0)
  })
})

describe('Quittungen', () => {
  it('erkennt 80 00 und 84 00 als positiv', () => {
    expect(isPositiveAck(0x80, 0x00)).toBe(true)
    expect(isPositiveAck(0x84, 0x00)).toBe(true)
  })

  it('erkennt 84 xx als nicht positiv', () => {
    expect(isPositiveAck(0x84, 0x66)).toBe(false)
    expect(isPositiveAck(0x84, 0x9c)).toBe(false)
  })

  it('kennt 84 9C als Aufforderung, die Statusinfo zu wiederholen', () => {
    // Der dokumentierte Ausweg aus einem unklaren Ausgang.
    expect([...ACK.repeatStatusInformation]).toEqual([0x84, 0x9c])
  })
})

describe('Befehlscodes', () => {
  it('stimmen mit Kapitel 14 der Spezifikation ueberein', () => {
    expect([...ECR_COMMAND.registration]).toEqual([0x06, 0x00])
    expect([...ECR_COMMAND.authorisation]).toEqual([0x06, 0x01])
    expect([...ECR_COMMAND.reversal]).toEqual([0x06, 0x30])
    expect([...ECR_COMMAND.endOfDay]).toEqual([0x06, 0x50])
    expect([...PT_COMMAND.statusInformation]).toEqual([0x04, 0x0f])
    expect([...PT_COMMAND.intermediateStatus]).toEqual([0x04, 0xff])
    expect([...PT_COMMAND.completion]).toEqual([0x06, 0x0f])
    expect([...PT_COMMAND.abort]).toEqual([0x06, 0x1e])
  })
})

describe('Ergebniscodes', () => {
  it('kennt die Codes aus Kapitel 10', () => {
    expect(resultText(RESULT_CODE.noError)).toBe('kein Fehler')
    expect(resultText(RESULT_CODE.creditNotSufficient)).toContain('Guthaben')
    expect(resultText(RESULT_CODE.cardInBlockedList)).toContain('Sperrliste')
    expect(resultText(RESULT_CODE.cardExpired)).toContain('verfallen')
  })

  it('gibt einen unbekannten Code offen zu, statt ihn zu beschoenigen', () => {
    expect(resultText(0x42)).toContain('unbekannter')
    expect(resultText(0x42)).toContain('0x42')
  })

  it('trennt Abbruch von Ablehnung', () => {
    // Fachlich verschieden: beim Abbruch hat der Kunde beendet, bei der
    // Ablehnung die Karte widersprochen.
    expect(isAbort(RESULT_CODE.abortViaTimeoutOrAbortKey)).toBe(true)
    expect(isAbort(RESULT_CODE.creditNotSufficient)).toBe(false)
  })
})

describe('Zwischenstatus', () => {
  it('benutzt die deutsche Spalte der Spezifikation', () => {
    // Die englische Spalte verrutscht beim Extrahieren aus dem PDF um eine
    // Zeile: bei 0A steht dort "Expired card", die deutsche Spalte sagt
    // "Karte einstecken" — und Portalum.Zvt sagt "Insert card".
    expect(intermediateText(0x0a)).toBe('Karte einstecken')
    expect(intermediateText(0x0b)).toBe('Bitte Karte entnehmen')
    expect(intermediateText(0x0c)).toBe('Karte nicht lesbar')
    expect(intermediateText(0x01)).toContain('PIN-Pad')
  })

  it('gibt einen unbekannten Zwischenstatus offen aus', () => {
    expect(intermediateText(0xab)).toContain('0xAB')
  })
})

describe('assertSettled — Regel 15', () => {
  const angenommen: PaymentOutcome = { kind: 'approved', amount: 940 as never }
  const abgelehnt: PaymentOutcome = { kind: 'declined', resultCode: 0x71, reason: 'x' }
  const abgebrochen: PaymentOutcome = { kind: 'aborted', resultCode: 0x6c, reason: 'x' }
  const unklar: PaymentOutcome = { kind: 'unknown', reason: 'Verbindung abgerissen' }

  it('laesst eindeutige Ausgaenge durch', () => {
    expect(assertSettled(angenommen).kind).toBe('approved')
    expect(assertSettled(abgelehnt).kind).toBe('declined')
    expect(assertSettled(abgebrochen).kind).toBe('aborted')
  })

  it('wirft bei einem unklaren Ausgang', () => {
    expect(() => assertSettled(unklar)).toThrow(UnresolvedPaymentError)
  })

  it('sagt in der Meldung, was zu tun ist', () => {
    try {
      assertSettled(unklar)
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      const e = fehler as UnresolvedPaymentError
      expect(e.message).toContain('weder als bezahlt noch als nicht bezahlt')
      expect(e.message).toContain('nachgefragt oder storniert')
    }
  })

  it('nennt die Belegnummer, wenn sie bekannt ist — sie braucht man fuers Storno', () => {
    const mitBeleg: PaymentOutcome = { kind: 'unknown', reason: 'x', receiptNumber: '0001' }
    try {
      assertSettled(mitBeleg)
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      expect((fehler as Error).message).toContain('0001')
    }
  })

  it('haelt unknown und declined auseinander', () => {
    // Der Kern von Regel 15: die beiden duerfen nie zusammenfallen.
    expect(() => assertSettled(abgelehnt)).not.toThrow()
    expect(() => assertSettled(unklar)).toThrow()
  })
})

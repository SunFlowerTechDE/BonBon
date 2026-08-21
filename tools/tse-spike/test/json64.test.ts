import { describe, expect, it } from 'vitest'

import { decimal, decimalFromCents, parse, readUint64, stringify, toHex, uint64 } from '../src/json64.js'

describe('uint64 im Request', () => {
  it('serialisiert ftReceiptCase exakt, nicht als gerundeten double', () => {
    // Ueber den normalen Weg waere daraus 4919338172267102000 geworden.
    const json = stringify({ ftReceiptCase: uint64(0x4445000100000001n) })
    expect(json).toContain('"ftReceiptCase": 4919338172267102209')
    expect(json).not.toContain('4919338172267102000')
  })

  it('schreibt die Kennzahl als JSON-Zahl, nicht als String', () => {
    const json = stringify({ ftChargeItemCase: uint64(0x4445000000000001n) })
    expect(json).toMatch(/"ftChargeItemCase":\s*4919338167972134913(?!")/)
  })

  it('haelt benachbarte Kennzahlen auseinander', () => {
    const a = stringify({ x: uint64(0x4445000000000017n) })
    const b = stringify({ x: uint64(0x4445000000000018n) })
    expect(a).not.toBe(b)
  })
})

describe('uint64 in der Antwort', () => {
  it('liest ftSignatureType verlustfrei', () => {
    const body = '{"ftSignatureType":4919338167972134935,"Data":"x"}'
    const parsed = parse(body) as { ftSignatureType: unknown }
    expect(readUint64(parsed.ftSignatureType)).toBe(0x4445000000000017n)
  })

  it('unterscheidet Transaktionsnummer und Signaturzaehler', () => {
    // Genau hier scheitert JSON.parse: beide Werte werden sonst zu
    // 4919338167972135000 und sind nicht mehr zu trennen.
    const transaktionsnummer = parse('{"ftSignatureType":4919338167972134935}') as {
      ftSignatureType: unknown
    }
    const signaturzaehler = parse('{"ftSignatureType":4919338167972134936}') as {
      ftSignatureType: unknown
    }
    expect(readUint64(transaktionsnummer.ftSignatureType)).toBe(0x4445000000000017n)
    expect(readUint64(signaturzaehler.ftSignatureType)).toBe(0x4445000000000018n)
    expect(readUint64(transaktionsnummer.ftSignatureType)).not.toBe(
      readUint64(signaturzaehler.ftSignatureType),
    )
  })

  it('kommt mit dem naiven Weg zum Vergleich nicht durcheinander', () => {
    expect(JSON.parse('4919338167972134935')).toBe(JSON.parse('4919338167972134936'))
  })

  it('laesst gewoehnliche Felder unangetastet', () => {
    const parsed = parse('{"ftQueueID":"abc","ftReceiptIdentification":"ft1#42"}') as Record<
      string,
      unknown
    >
    expect(parsed['ftQueueID']).toBe('abc')
    expect(parsed['ftReceiptIdentification']).toBe('ft1#42')
  })

  it('liest ftState verlustfrei', () => {
    // 0x44450000EEEEEEEE — Fehlerzustand "Error" im Markt DE.
    const parsed = parse('{"ftState":4919338171980771054}') as { ftState: unknown }
    const state = readUint64(parsed.ftState)
    expect(state).toBe(0x44450000eeeeeeeen)
    expect(toHex(state as bigint)).toBe('0x44450000EEEEEEEE')
  })
})

describe('decimalFromCents', () => {
  it('macht aus 380 Cent die Dezimalzahl 3.80', () => {
    expect(stringify({ Amount: decimalFromCents(380) })).toContain('"Amount": 3.80')
  })

  it('schreibt immer zwei Nachkommastellen', () => {
    expect(stringify({ a: decimalFromCents(300) })).toContain('"a": 3.00')
    expect(stringify({ a: decimalFromCents(305) })).toContain('"a": 3.05')
    expect(stringify({ a: decimalFromCents(5) })).toContain('"a": 0.05')
    expect(stringify({ a: decimalFromCents(0) })).toContain('"a": 0.00')
  })

  it('behandelt negative Betraege', () => {
    expect(stringify({ a: decimalFromCents(-380) })).toContain('"a": -3.80')
    expect(stringify({ a: decimalFromCents(-5) })).toContain('"a": -0.05')
  })

  it('rechnet grosse Betraege ohne Fliesskomma-Rest', () => {
    expect(stringify({ a: decimalFromCents(123456789) })).toContain('"a": 1234567.89')
  })

  it('weist Euro-Betraege ab', () => {
    expect(() => decimalFromCents(3.8)).toThrow(RangeError)
  })

  it('erzeugt nie eine Zahl mit Fliesskomma-Rest im Text', () => {
    // 12 x 3,80 EUR: in Euro gerechnet waere das 45.599999999999994.
    expect(stringify({ a: decimalFromCents(12 * 380) })).toContain('"a": 45.60')
  })
})

describe('decimal', () => {
  it('schreibt den Steuersatz woertlich', () => {
    expect(stringify({ VATRate: decimal('19.00') })).toContain('"VATRate": 19.00')
    expect(stringify({ VATRate: decimal('7.00') })).toContain('"VATRate": 7.00')
  })

  it('weist Unsinn ab', () => {
    expect(() => decimal('neunzehn')).toThrow(RangeError)
    expect(() => decimal('19,00')).toThrow(RangeError)
  })
})

describe('stringify', () => {
  it('liefert gueltiges JSON', () => {
    const json = stringify({
      ftReceiptCase: uint64(0x4445000100000001n),
      cbChargeItems: [{ Amount: decimalFromCents(380), VATRate: decimal('19.00') }],
      cbReceiptReference: 'BONBON-SPIKE-1',
    })
    expect(() => {
      JSON.parse(json)
    }).not.toThrow()
    const roundTrip = JSON.parse(json) as { cbReceiptReference: string }
    expect(roundTrip.cbReceiptReference).toBe('BONBON-SPIKE-1')
  })

  it('laesst gewoehnliche Strings unberuehrt', () => {
    const json = stringify({ Description: 'Cappuccino' })
    expect(json).toContain('"Description": "Cappuccino"')
  })
})

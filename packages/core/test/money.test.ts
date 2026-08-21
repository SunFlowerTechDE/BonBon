import { describe, expect, it } from 'vitest'

import {
  type Cents,
  ZERO_CENTS,
  addCents,
  cents,
  multiplyCents,
  subtractCents,
  sumCents,
} from '../src/index.js'

const CAPPUCCINO: Cents = cents(380)

describe('cents()', () => {
  it('nimmt ganzzahlige Cent-Betraege an', () => {
    expect(cents(380)).toBe(380)
    expect(cents(0)).toBe(0)
  })

  it('nimmt negative Betraege an — Storno und Rabatt brauchen sie', () => {
    expect(cents(-380)).toBe(-380)
  })

  it('weist Euro-Betraege ab, statt sie still zu runden', () => {
    // Der eigentliche Zweck des Typs: 3.80 statt 380.
    expect(() => cents(3.8)).toThrow(RangeError)
    expect(() => cents(3.8)).toThrow(/Regel 3/)
  })

  it('weist NaN und Unendlich ab', () => {
    expect(() => cents(Number.NaN)).toThrow(RangeError)
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => cents(Number.NEGATIVE_INFINITY)).toThrow(RangeError)
  })

  it('weist Werte jenseits des sicheren Ganzzahlbereichs ab', () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })

  it('nennt den fehlerhaften Wert in der Meldung', () => {
    expect(() => cents(3.8)).toThrow(/3\.8/)
  })
})

describe('addCents / subtractCents', () => {
  it('addiert', () => {
    expect(addCents(CAPPUCCINO, cents(250))).toBe(630)
  })

  it('subtrahiert und laesst negative Ergebnisse zu', () => {
    expect(subtractCents(CAPPUCCINO, cents(500))).toBe(-120)
  })

  it('wirft bei Ueberlauf statt Praezision zu verlieren', () => {
    const grenze = cents(Number.MAX_SAFE_INTEGER)
    expect(() => addCents(grenze, cents(1))).toThrow(RangeError)
  })

  it('ZERO_CENTS ist das neutrale Element', () => {
    expect(addCents(CAPPUCCINO, ZERO_CENTS)).toBe(380)
    expect(subtractCents(CAPPUCCINO, ZERO_CENTS)).toBe(380)
  })
})

describe('sumCents', () => {
  it('summiert die Positionen eines Bons', () => {
    expect(sumCents([cents(380), cents(250), cents(199)])).toBe(829)
  })

  it('ist bei leerer Liste null', () => {
    expect(sumCents([])).toBe(0)
  })

  it('wirft bei Ueberlauf', () => {
    expect(() => sumCents([cents(Number.MAX_SAFE_INTEGER), cents(1)])).toThrow(RangeError)
  })
})

describe('multiplyCents', () => {
  it('rechnet Einzelpreis mal Menge', () => {
    expect(multiplyCents(CAPPUCCINO, 3)).toBe(1140)
  })

  it('ist bei Menge 0 null', () => {
    expect(multiplyCents(CAPPUCCINO, 0)).toBe(0)
  })

  it('weist gebrochene Mengen ab — die brauchen eine benannte Rundungsregel (M1)', () => {
    expect(() => multiplyCents(CAPPUCCINO, 0.25)).toThrow(RangeError)
  })

  it('weist negative Mengen ab', () => {
    expect(() => multiplyCents(CAPPUCCINO, -1)).toThrow(RangeError)
  })

  it('wirft bei Ueberlauf', () => {
    expect(() => multiplyCents(cents(Number.MAX_SAFE_INTEGER), 2)).toThrow(RangeError)
  })
})

describe('Rechenwege bleiben exakt', () => {
  it('12 x 3,80 EUR ergibt exakt 45,60 EUR — kein Fliesskomma-Rest', () => {
    // In Euro gerechnet waere 12 * 3.80 === 45.599999999999994.
    expect(multiplyCents(CAPPUCCINO, 12)).toBe(4560)
  })

  it('0,10 + 0,20 ergibt exakt 0,30 EUR', () => {
    // In Euro gerechnet waere 0.1 + 0.2 === 0.30000000000000004.
    expect(addCents(cents(10), cents(20))).toBe(30)
  })
})

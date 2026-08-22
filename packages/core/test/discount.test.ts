import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  type RabattBasis,
  RabattNichtVerteilbarError,
  STEUERSATZ,
  VOLLER_RABATT,
  bruttosumme,
  cents,
  mindereBasis,
  nettosumme,
  negateCents,
  rabattsumme,
  steuerausweis,
  steuersumme,
  verteileRabatt,
} from '../src/index.js'

const betrag = fc.integer({ min: -100_000, max: 100_000 }).map((n) => cents(n))
const positiverBetrag = fc.integer({ min: 1, max: 100_000 }).map((n) => cents(n))
const satz = fc.constantFrom(STEUERSATZ.regel, STEUERSATZ.ermaessigt, STEUERSATZ.null)

const basisEintrag: fc.Arbitrary<RabattBasis> = fc.record({
  brutto: positiverBetrag,
  steuersatzPromille: satz,
})

/** Warenkorb mit ausschliesslich positiven Positionen. */
const warenkorb = fc.array(basisEintrag, { minLength: 1, maxLength: 12 })

/** Prozentsatz in Hundertstel Prozent: 0 bis 10000. */
const prozent = fc.integer({ min: 0, max: VOLLER_RABATT })

const summe = (basis: readonly RabattBasis[]): number =>
  basis.reduce((a, e) => a + e.brutto, 0)

// ---------------------------------------------------------------------------

describe('verteileRabatt — Beispiele', () => {
  const bon: RabattBasis[] = [
    { steuersatzPromille: STEUERSATZ.regel, brutto: cents(770) },
    { steuersatzPromille: STEUERSATZ.ermaessigt, brutto: cents(170) },
  ]

  it('verteilt 10 % auf beide Steuersaetze', () => {
    // Gesamt 9,40 -> 10 % = 0,94.
    // Kumuliert: 7% -> 170 * 1000/10000 = 17,0 -> 17
    //            19% -> 940 * 1000/10000 = 94,0 -> 94, Anteil 94-17 = 77
    const v = verteileRabatt(bon, { art: 'prozent', hundertstelProzent: 1000 })
    expect(v.gesamt).toBe(-94)
    expect(v.anteile).toEqual([
      { steuersatzPromille: 70, betrag: -17 },
      { steuersatzPromille: 190, betrag: -77 },
    ])
    expect(rabattsumme(v)).toBe(v.gesamt)
  })

  it('verteilt einen festen Betrag anteilig', () => {
    // 1,00 EUR auf 9,40 EUR Basis.
    // Kumuliert: 7% -> 100 * 170/940 = 18,08 -> 18
    //            19% -> 100 * 940/940 = 100    -> 100, Anteil 82
    const v = verteileRabatt(bon, { art: 'betrag', betrag: cents(100) })
    expect(v.gesamt).toBe(-100)
    expect(v.anteile).toEqual([
      { steuersatzPromille: 70, betrag: -18 },
      { steuersatzPromille: 190, betrag: -82 },
    ])
  })

  it('gibt bei 100 % genau die Bemessungsgrundlage zurueck', () => {
    const v = verteileRabatt(bon, { art: 'prozent', hundertstelProzent: VOLLER_RABATT })
    expect(v.gesamt).toBe(-940)
    expect(v.anteile).toEqual([
      { steuersatzPromille: 70, betrag: -170 },
      { steuersatzPromille: 190, betrag: -770 },
    ])
  })

  it('gibt bei 0 % nichts', () => {
    const v = verteileRabatt(bon, { art: 'prozent', hundertstelProzent: 0 })
    expect(v.gesamt).toBe(0)
    expect(v.anteile.every((a) => a.betrag === 0)).toBe(true)
  })

  it('sortiert die Anteile aufsteigend nach Steuersatz', () => {
    const v = verteileRabatt(
      [
        { steuersatzPromille: 190, brutto: cents(100) },
        { steuersatzPromille: 0, brutto: cents(100) },
        { steuersatzPromille: 70, brutto: cents(100) },
      ],
      { art: 'prozent', hundertstelProzent: 1000 },
    )
    expect(v.anteile.map((a) => a.steuersatzPromille)).toEqual([0, 70, 190])
  })
})

describe('verteileRabatt — kein Cent geht verloren', () => {
  it('die Summe der Anteile ist exakt der Gesamtrabatt (Prozent)', () => {
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        expect(rabattsumme(v)).toBe(v.gesamt)
      }),
      { numRuns: 500 },
    )
  })

  it('die Summe der Anteile ist exakt der Gesamtrabatt (Betrag)', () => {
    fc.assert(
      fc.property(
        warenkorb.chain((basis) =>
          fc.tuple(fc.constant(basis), fc.integer({ min: 0, max: Math.max(1, summe(basis)) })),
        ),
        ([basis, b]) => {
          const v = verteileRabatt(basis, { art: 'betrag', betrag: cents(b) })
          expect(rabattsumme(v)).toBe(v.gesamt)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('ein Betragsrabatt kommt exakt heraus — kein Cent mehr, kein Cent weniger', () => {
    // Die Zusicherung, um die es geht: was gewaehrt wurde, wird auch verteilt.
    fc.assert(
      fc.property(
        warenkorb.chain((basis) =>
          fc.tuple(fc.constant(basis), fc.integer({ min: 0, max: Math.max(1, summe(basis)) })),
        ),
        ([basis, b]) => {
          const v = verteileRabatt(basis, { art: 'betrag', betrag: cents(b) })
          // Als Summe formuliert: bei b === 0 waere `-b` eine negative Null,
          // und die Erwartung wuerde am eigenen Vorzeichen scheitern.
          expect(v.gesamt + b).toBe(0)
          expect(rabattsumme(v) + b).toBe(0)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('100 % ergibt exakt null — kein Restcent', () => {
    fc.assert(
      fc.property(warenkorb, (basis) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: VOLLER_RABATT })
        const danach = mindereBasis(basis, v)
        for (const zeile of danach) expect(zeile.brutto).toBe(0)
        expect(danach.reduce((a, z) => a + z.brutto, 0)).toBe(0)
        expect(v.gesamt + summe(basis)).toBe(0)
      }),
      { numRuns: 300 },
    )
  })

  it('100 % ergibt auch keinen Steuerbetrag mehr', () => {
    fc.assert(
      fc.property(warenkorb, (basis) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: VOLLER_RABATT })
        const zeilen = steuerausweis(mindereBasis(basis, v))
        expect(bruttosumme(zeilen)).toBe(0)
        expect(steuersumme(zeilen)).toBe(0)
        expect(nettosumme(zeilen)).toBe(0)
      }),
    )
  })
})

describe('verteileRabatt — Eigenschaften', () => {
  it('jeder Anteil ist hoechstens null (ein Rabatt mindert)', () => {
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        for (const anteil of v.anteile) expect(anteil.betrag).toBeLessThanOrEqual(0)
      }),
    )
  })

  it('kein Anteil ist negative Null', () => {
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        for (const anteil of v.anteile) expect(Object.is(anteil.betrag, -0)).toBe(false)
        expect(Object.is(v.gesamt, -0)).toBe(false)
      }),
    )
  })

  it('kein Anteil uebersteigt die Bemessungsgrundlage seines Satzes', () => {
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        const jeSatz = new Map<number, number>()
        for (const e of basis) {
          jeSatz.set(e.steuersatzPromille, (jeSatz.get(e.steuersatzPromille) ?? 0) + e.brutto)
        }
        for (const anteil of v.anteile) {
          expect(negateCents(anteil.betrag)).toBeLessThanOrEqual(
            jeSatz.get(anteil.steuersatzPromille) ?? 0,
          )
        }
      }),
      { numRuns: 300 },
    )
  })

  it('die Reihenfolge der Eingabe aendert nichts', () => {
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const wert = { art: 'prozent', hundertstelProzent: bp } as const
        expect(verteileRabatt([...basis].reverse(), wert)).toEqual(verteileRabatt(basis, wert))
      }),
    )
  })

  it('weicht je Satz nie um mehr als einen Cent vom exakten Anteil ab', () => {
    // Die laufende Summe garantiert die Gesamtsumme; jeder einzelne Anteil
    // bleibt trotzdem dicht am exakten Wert.
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        const jeSatz = new Map<number, number>()
        for (const e of basis) {
          jeSatz.set(e.steuersatzPromille, (jeSatz.get(e.steuersatzPromille) ?? 0) + e.brutto)
        }
        for (const anteil of v.anteile) {
          const exakt = ((jeSatz.get(anteil.steuersatzPromille) ?? 0) * bp) / VOLLER_RABATT
          expect(Math.abs(negateCents(anteil.betrag) - exakt)).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('zeigt den Fall, in dem ein Anteil um fast einen vollen Cent abweicht', () => {
    // Der teuerste bekannte Fall, gefunden durch Absuchen aller Grundlagen bis
    // 3,00 EUR und aller Prozentsaetze in Hundertstelschritten. Er ist kein
    // Fehler, sondern der Preis der Teleskop-Konstruktion: die Gesamtsumme
    // stimmt exakt, der einzelne Anteil weicht dafuer um bis zu (knapp) einen
    // vollen Cent ab statt um einen halben.
    // Abgearbeitet wird aufsteigend nach Steuersatz, also erst 7 %, dann 19 %.
    // Die Abweichung trifft den zweiten Anteil.
    const v = verteileRabatt(
      [
        { steuersatzPromille: STEUERSATZ.ermaessigt, brutto: cents(217) },
        { steuersatzPromille: STEUERSATZ.regel, brutto: cents(283) },
      ],
      { art: 'prozent', hundertstelProzent: 9470 },
    )

    const zweiter = v.anteile.find((a) => a.steuersatzPromille === STEUERSATZ.regel)
    const exakt = (283 * 9470) / VOLLER_RABATT // 268,001
    expect(negateCents(zweiter?.betrag ?? cents(0))).toBe(269)
    expect(Math.abs(269 - exakt)).toBeCloseTo(0.999, 3)

    // Trotzdem: die Summe stimmt auf den Cent.
    expect(rabattsumme(v)).toBe(v.gesamt)
    expect(v.gesamt).toBe(-474) // 500 * 0,9470 = 473,5 -> 474 (halbe Einheit auf)
  })

  it('weist einen Prozentsatz ueber 100 ab', () => {
    expect(() =>
      verteileRabatt([{ steuersatzPromille: 190, brutto: cents(100) }], {
        art: 'prozent',
        hundertstelProzent: VOLLER_RABATT + 1,
      }),
    ).toThrow(RabattNichtVerteilbarError)
  })

  it('weist einen negativen Rabattbetrag ab', () => {
    expect(() =>
      verteileRabatt([{ steuersatzPromille: 190, brutto: cents(100) }], {
        art: 'betrag',
        betrag: cents(-100),
      }),
    ).toThrow(/nicht negativ/)
  })
})

describe('verteileRabatt — Bon mit Retoure', () => {
  // Der Grenzfall aus der Praxis: ein Bon enthaelt bereits eine Ruecknahme als
  // negative Position, und darauf kommt ein Rabatt.
  const mitRetoure: RabattBasis[] = [
    { steuersatzPromille: STEUERSATZ.regel, brutto: cents(1000) },
    { steuersatzPromille: STEUERSATZ.ermaessigt, brutto: cents(-400) },
  ]

  it('verteilt anteilig auf die vorzeichenbehaftete Grundlage', () => {
    // Basis 6,00 EUR. 10 % = 0,60.
    // Kumuliert: 7%  -> -400 * 1000/10000 = -40   -> -40, Anteil +40 Erhoehung
    //            19% ->  600 * 1000/10000 =  60   ->  60, Anteil -100
    // Summe der Anteile: -60. Exakt der Gesamtrabatt.
    const v = verteileRabatt(mitRetoure, { art: 'prozent', hundertstelProzent: 1000 })
    expect(v.gesamt).toBe(-60)
    expect(rabattsumme(v)).toBe(-60)
    expect(v.anteile).toEqual([
      { steuersatzPromille: 70, betrag: 40 },
      { steuersatzPromille: 190, betrag: -100 },
    ])
  })

  it('mindert die Retoure mit, statt sie zu vergroessern', () => {
    // Der Anteil auf den 7-%-Satz ist positiv: die Ruecknahme faellt um 40 Cent
    // kleiner aus. Das ist richtig — der Rabatt bezieht sich auf das, was der
    // Kunde tatsaechlich zahlt, und der Retourenteil mindert die Zahlung
    // bereits. Wuerde man ihn ausklammern, waere der Rabatt auf den
    // Verkaufsteil hoeher als vereinbart.
    const danach = mindereBasis(mitRetoure, {
      gesamt: cents(-60),
      anteile: [
        { steuersatzPromille: 70, betrag: cents(40) },
        { steuersatzPromille: 190, betrag: cents(-100) },
      ],
    })
    expect(danach).toEqual([
      { steuersatzPromille: 70, brutto: -360 },
      { steuersatzPromille: 190, brutto: 900 },
    ])
    expect(danach.reduce((a, z) => a + z.brutto, 0)).toBe(540) // 6,00 - 0,60
  })

  it('haelt die Zusicherung auch bei gemischten Vorzeichen', () => {
    const gemischt = fc.array(
      fc.record({ brutto: betrag, steuersatzPromille: satz }),
      { minLength: 1, maxLength: 10 },
    )
    fc.assert(
      fc.property(gemischt, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        expect(rabattsumme(v)).toBe(v.gesamt)
      }),
      { numRuns: 500 },
    )
  })

  it('weist einen festen Betrag ab, wenn die Grundlage null ist', () => {
    // Verkauf und Retoure heben sich auf. Ein fester Rabattbetrag haette dann
    // keine nachvollziehbare Zuordnung zu den Steuersaetzen.
    expect(() =>
      verteileRabatt(
        [
          { steuersatzPromille: 190, brutto: cents(500) },
          { steuersatzPromille: 70, brutto: cents(-500) },
        ],
        { art: 'betrag', betrag: cents(100) },
      ),
    ).toThrow(RabattNichtVerteilbarError)
  })

  it('nennt in der Meldung, warum es nicht geht', () => {
    try {
      verteileRabatt([{ steuersatzPromille: 190, brutto: cents(0) }], {
        art: 'betrag',
        betrag: cents(50),
      })
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      expect((fehler as Error).message).toContain('Bemessungsgrundlage ist null')
    }
  })

  it('laesst einen Prozentrabatt auf einer Grundlage von null zu — er ist null', () => {
    const v = verteileRabatt(
      [
        { steuersatzPromille: 190, brutto: cents(500) },
        { steuersatzPromille: 70, brutto: cents(-500) },
      ],
      { art: 'prozent', hundertstelProzent: 1000 },
    )
    expect(v.gesamt).toBe(0)
    expect(rabattsumme(v)).toBe(0)
  })

  it('laesst einen Rabattbetrag von null immer zu', () => {
    const v = verteileRabatt(
      [
        { steuersatzPromille: 190, brutto: cents(500) },
        { steuersatzPromille: 70, brutto: cents(-500) },
      ],
      { art: 'betrag', betrag: cents(0) },
    )
    expect(v.gesamt).toBe(0)
  })
})

describe('Rabatt und Steuerausweis zusammen', () => {
  it('kein Cent geht zwischen Rabatt und Steuer verloren', () => {
    // Die vollstaendige Kette: Warenkorb -> Rabatt -> geminderte Basis ->
    // Steuerausweis. Am Ende muss netto + steuer wieder brutto ergeben, und
    // brutto muss der Bonsumme nach Rabatt entsprechen.
    fc.assert(
      fc.property(warenkorb, prozent, (basis, bp) => {
        const v = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp })
        const zeilen = steuerausweis(mindereBasis(basis, v))

        expect(nettosumme(zeilen) + steuersumme(zeilen)).toBe(bruttosumme(zeilen))
        expect(bruttosumme(zeilen)).toBe(summe(basis) + v.gesamt)
      }),
      { numRuns: 500 },
    )
  })

  it('gilt auch fuer mehrere Rabatte nacheinander', () => {
    fc.assert(
      fc.property(warenkorb, prozent, prozent, (basis, bp1, bp2) => {
        const v1 = verteileRabatt(basis, { art: 'prozent', hundertstelProzent: bp1 })
        const nachEins = mindereBasis(basis, v1)
        const v2 = verteileRabatt(nachEins, { art: 'prozent', hundertstelProzent: bp2 })
        const nachZwei = mindereBasis(nachEins, v2)

        expect(rabattsumme(v1)).toBe(v1.gesamt)
        expect(rabattsumme(v2)).toBe(v2.gesamt)
        expect(nachZwei.reduce((a, z) => a + z.brutto, 0)).toBe(summe(basis) + v1.gesamt + v2.gesamt)

        const zeilen = steuerausweis(nachZwei)
        expect(nettosumme(zeilen) + steuersumme(zeilen)).toBe(bruttosumme(zeilen))
      }),
      { numRuns: 300 },
    )
  })
})

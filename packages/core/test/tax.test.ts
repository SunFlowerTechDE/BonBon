import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  STEUERSATZ,
  type SteuerzeileEingabe,
  bruttosumme,
  cents,
  negateCents,
  nettoAusBrutto,
  nettosumme,
  rundeKaufmaennisch,
  steuerAusBrutto,
  steuerausweis,
  steuersumme,
} from '../src/index.js'

/** Beträge im Bereich, in dem eine Kasse arbeitet: −10.000 bis +10.000 Euro. */
const betrag = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((n) => cents(n))
const positiverBetrag = fc.integer({ min: 0, max: 1_000_000 }).map((n) => cents(n))
const satz = fc.constantFrom(STEUERSATZ.regel, STEUERSATZ.ermaessigt, STEUERSATZ.null)

const eintrag: fc.Arbitrary<SteuerzeileEingabe> = fc.record({
  brutto: betrag,
  steuersatzPromille: satz,
})

// ---------------------------------------------------------------------------

describe('rundeKaufmaennisch', () => {
  it('rundet unter der Haelfte ab', () => {
    expect(rundeKaufmaennisch(4, 10)).toBe(0)
    expect(rundeKaufmaennisch(49, 100)).toBe(0)
  })

  it('rundet die Haelfte auf', () => {
    expect(rundeKaufmaennisch(5, 10)).toBe(1)
    expect(rundeKaufmaennisch(50, 100)).toBe(1)
    expect(rundeKaufmaennisch(15, 10)).toBe(2)
  })

  it('rundet ueber der Haelfte auf', () => {
    expect(rundeKaufmaennisch(6, 10)).toBe(1)
  })

  it('rundet negative Werte vom Nullpunkt weg', () => {
    // "Aufwaerts" ergaebe hier 0 bzw. -1. Vom Nullpunkt weg ergibt -1 bzw. -2.
    expect(rundeKaufmaennisch(-5, 10)).toBe(-1)
    expect(rundeKaufmaennisch(-15, 10)).toBe(-2)
    expect(rundeKaufmaennisch(-4, 10)).toBe(0)
  })

  it('weist einen Nenner von null oder kleiner ab', () => {
    expect(() => rundeKaufmaennisch(1, 0)).toThrow(RangeError)
    expect(() => rundeKaufmaennisch(1, -10)).toThrow(RangeError)
  })

  it('weist Fliesskomma ab', () => {
    expect(() => rundeKaufmaennisch(1.5, 10)).toThrow(RangeError)
  })

  it('ist punktsymmetrisch — fuer jeden Wert', () => {
    // Als Summe formuliert statt als Negation: -0 und 0 sind unter Object.is
    // verschieden, und die Erwartung wuerde sonst selbst ein -0 erzeugen.
    // "Beide heben sich auf" ist ohnehin die Aussage, um die es geht.
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (z, n) => {
          expect(rundeKaufmaennisch(-z, n) + rundeKaufmaennisch(z, n)).toBe(0)
        },
      ),
    )
  })

  it('liefert nie negative Null', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        (z, n) => {
          expect(Object.is(rundeKaufmaennisch(z, n), -0)).toBe(false)
        },
      ),
    )
  })

  it('weicht nie um mehr als eine halbe Einheit vom exakten Wert ab', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (z, n) => {
          const exakt = z / n
          expect(Math.abs(rundeKaufmaennisch(z, n) - exakt)).toBeLessThanOrEqual(0.5)
        },
      ),
    )
  })
})

describe('steuerAusBrutto — Beispiele', () => {
  it('rechnet 19 % aus 7,70 EUR heraus', () => {
    // 770 * 190 / 1190 = 122,94 -> 123
    expect(steuerAusBrutto(cents(770), STEUERSATZ.regel)).toBe(123)
  })

  it('rechnet 7 % aus 1,70 EUR heraus', () => {
    // 170 * 70 / 1070 = 11,12 -> 11
    expect(steuerAusBrutto(cents(170), STEUERSATZ.ermaessigt)).toBe(11)
  })

  it('rechnet 19 % aus 3,80 EUR heraus', () => {
    // 380 * 190 / 1190 = 60,67 -> 61
    expect(steuerAusBrutto(cents(380), STEUERSATZ.regel)).toBe(61)
  })

  it('gibt bei Steuersatz null nichts zurueck', () => {
    expect(steuerAusBrutto(cents(1000), STEUERSATZ.null)).toBe(0)
  })

  it('gibt bei Betrag null nichts zurueck', () => {
    expect(steuerAusBrutto(cents(0), STEUERSATZ.regel)).toBe(0)
  })

  it('weist einen negativen Steuersatz ab', () => {
    expect(() => steuerAusBrutto(cents(100), -190)).toThrow(RangeError)
  })
})

describe('steuerAusBrutto — Eigenschaften', () => {
  it('ist nie groesser als der Bruttobetrag', () => {
    fc.assert(
      fc.property(positiverBetrag, satz, (brutto, s) => {
        expect(steuerAusBrutto(brutto, s)).toBeLessThanOrEqual(brutto)
      }),
    )
  })

  it('ist nie negativ bei positivem Brutto', () => {
    fc.assert(
      fc.property(positiverBetrag, satz, (brutto, s) => {
        expect(steuerAusBrutto(brutto, s)).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('liefert immer eine Ganzzahl — nie einen halben Cent', () => {
    fc.assert(
      fc.property(betrag, satz, (brutto, s) => {
        expect(Number.isInteger(steuerAusBrutto(brutto, s))).toBe(true)
      }),
    )
  })

  it('kehrt sich bei negativem Betrag exakt um (Retoure, Storno)', () => {
    // Die Zusicherung, wegen der vom Nullpunkt weg gerundet wird: ein Storno
    // hebt den Verkauf exakt auf, es bleibt kein Cent stehen.
    fc.assert(
      fc.property(betrag, satz, (brutto, s) => {
        expect(steuerAusBrutto(negateCents(brutto), s) + steuerAusBrutto(brutto, s)).toBe(0)
      }),
    )
  })

  it('netto plus steuer ergibt immer exakt brutto', () => {
    fc.assert(
      fc.property(betrag, satz, (brutto, s) => {
        const steuer = steuerAusBrutto(brutto, s)
        const netto = nettoAusBrutto(brutto, s)
        expect(netto + steuer).toBe(brutto)
      }),
    )
  })

  it('waechst monoton mit dem Bruttobetrag', () => {
    fc.assert(
      fc.property(positiverBetrag, positiverBetrag, satz, (a, b, s) => {
        const klein = a <= b ? a : b
        const gross = a <= b ? b : a
        expect(steuerAusBrutto(klein, s)).toBeLessThanOrEqual(steuerAusBrutto(gross, s))
      }),
    )
  })
})

describe('Geldbetraege sind nie negative Null', () => {
  it('gilt fuer jede Steuerberechnung', () => {
    fc.assert(
      fc.property(betrag, satz, (brutto, s) => {
        expect(Object.is(steuerAusBrutto(brutto, s), -0)).toBe(false)
        expect(Object.is(nettoAusBrutto(brutto, s), -0)).toBe(false)
      }),
    )
  })

  it('gilt fuer jede Zeile des Steuerausweises', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 20 }), (eintraege) => {
        for (const zeile of steuerausweis(eintraege)) {
          expect(Object.is(zeile.brutto, -0)).toBe(false)
          expect(Object.is(zeile.netto, -0)).toBe(false)
          expect(Object.is(zeile.steuer, -0)).toBe(false)
        }
      }),
    )
  })
})

describe('steuerausweis — kein Cent geht verloren', () => {
  it('Summe netto plus Summe steuer ergibt exakt die Bruttosumme', () => {
    // Die wichtigste Eigenschaft ueberhaupt. Sie gilt, weil netto je Satz als
    // brutto minus steuer gebildet wird — nie eigenstaendig gerundet.
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 40 }), (eintraege) => {
        const zeilen = steuerausweis(eintraege)
        expect(nettosumme(zeilen) + steuersumme(zeilen)).toBe(bruttosumme(zeilen))
      }),
    )
  })

  it('die Bruttosumme des Ausweises entspricht der Summe der Eingaben', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 40 }), (eintraege) => {
        const erwartet = eintraege.reduce((a, e) => a + e.brutto, 0)
        expect(bruttosumme(steuerausweis(eintraege))).toBe(erwartet)
      }),
    )
  })

  it('je Zeile gilt netto plus steuer gleich brutto', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 40 }), (eintraege) => {
        for (const zeile of steuerausweis(eintraege)) {
          expect(zeile.netto + zeile.steuer).toBe(zeile.brutto)
        }
      }),
    )
  })
})

describe('steuerausweis — Reihenfolge ist egal', () => {
  it('liefert bei vertauschten Positionen dasselbe Ergebnis', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 30 }), (eintraege) => {
        const umgedreht = [...eintraege].reverse()
        expect(steuerausweis(umgedreht)).toEqual(steuerausweis(eintraege))
      }),
    )
  })

  it('liefert bei beliebiger Permutation dasselbe Ergebnis', () => {
    fc.assert(
      fc.property(
        fc.array(eintrag, { minLength: 1, maxLength: 20 }).chain((liste) =>
          fc.tuple(fc.constant(liste), fc.shuffledSubarray(liste, { minLength: liste.length })),
        ),
        ([original, gemischt]) => {
          expect(steuerausweis(gemischt)).toEqual(steuerausweis(original))
        },
      ),
    )
  })

  it('sortiert die Zeilen aufsteigend nach Steuersatz', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 30 }), (eintraege) => {
        const saetze = steuerausweis(eintraege).map((z) => z.steuersatzPromille)
        expect([...saetze].sort((a, b) => a - b)).toEqual(saetze)
      }),
    )
  })

  it('fasst gleiche Steuersaetze zu genau einer Zeile zusammen', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 30 }), (eintraege) => {
        const saetze = steuerausweis(eintraege).map((z) => z.steuersatzPromille)
        expect(new Set(saetze).size).toBe(saetze.length)
      }),
    )
  })
})

describe('steuerausweis — negative Betraege', () => {
  it('eine Retoure hebt den Verkauf exakt auf', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { maxLength: 20 }), (eintraege) => {
        const retoure = eintraege.map((e) => ({ ...e, brutto: negateCents(e.brutto) }))
        const verkauf = steuerausweis(eintraege)
        const zurueck = steuerausweis(retoure)

        expect(zurueck).toHaveLength(verkauf.length)
        for (const [i, zeile] of verkauf.entries()) {
          expect((zurueck[i]?.brutto ?? 0) + zeile.brutto).toBe(0)
          expect((zurueck[i]?.steuer ?? 0) + zeile.steuer).toBe(0)
          expect((zurueck[i]?.netto ?? 0) + zeile.netto).toBe(0)
        }
      }),
    )
  })

  it('Verkauf und Retoure zusammen ergeben null', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { minLength: 1, maxLength: 20 }), (eintraege) => {
        const beides = [...eintraege, ...eintraege.map((e) => ({ ...e, brutto: negateCents(e.brutto) }))]
        const zeilen = steuerausweis(beides)
        expect(bruttosumme(zeilen)).toBe(0)
        expect(steuersumme(zeilen)).toBe(0)
        expect(nettosumme(zeilen)).toBe(0)
      }),
    )
  })
})

describe('steuerausweis — gemischte Steuersaetze', () => {
  it('rechnet den Beispielbon richtig', () => {
    // Kaesekuchen 3,90 + Cappuccino 3,80 bei 19 %, Broetchen 2x0,85 bei 7 %.
    const zeilen = steuerausweis([
      { brutto: cents(390), steuersatzPromille: STEUERSATZ.regel },
      { brutto: cents(380), steuersatzPromille: STEUERSATZ.regel },
      { brutto: cents(170), steuersatzPromille: STEUERSATZ.ermaessigt },
    ])
    expect(zeilen).toEqual([
      { steuersatzPromille: 70, brutto: 170, netto: 159, steuer: 11 },
      { steuersatzPromille: 190, brutto: 770, netto: 647, steuer: 123 },
    ])
  })

  it('zeigt, warum je Position gerundet ein anderes Ergebnis gaebe', () => {
    // Drei Positionen zu 3,33 EUR bei 19 %.
    //   je Position:  3,33 -> 53,17 Cent -> 53, dreimal = 159
    //   je Summe:     9,99 -> 159,50 Cent -> 160
    // Ein Cent Unterschied — und die DSFinV-K verlangt den gedruckten
    // Summenbetrag, also 160.
    const jePosition = 3 * steuerAusBrutto(cents(333), STEUERSATZ.regel)
    const jeSumme = steuerausweis([
      { brutto: cents(333), steuersatzPromille: STEUERSATZ.regel },
      { brutto: cents(333), steuersatzPromille: STEUERSATZ.regel },
      { brutto: cents(333), steuersatzPromille: STEUERSATZ.regel },
    ])[0]?.steuer

    expect(jePosition).toBe(159)
    expect(jeSumme).toBe(160)
    expect(jeSumme).not.toBe(jePosition)
  })

  it('haelt die Zusicherung auch bei vielen Positionen und Saetzen', () => {
    fc.assert(
      fc.property(fc.array(eintrag, { minLength: 30, maxLength: 200 }), (eintraege) => {
        const zeilen = steuerausweis(eintraege)
        expect(nettosumme(zeilen) + steuersumme(zeilen)).toBe(bruttosumme(zeilen))
        expect(bruttosumme(zeilen)).toBe(eintraege.reduce((a, e) => a + e.brutto, 0))
      }),
      { numRuns: 200 },
    )
  })

  it('behandelt einen leeren Bon', () => {
    expect(steuerausweis([])).toEqual([])
    expect(bruttosumme([])).toBe(0)
  })
})

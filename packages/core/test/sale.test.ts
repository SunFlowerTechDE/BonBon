import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  type Bon,
  BonFehler,
  type Kontext,
  STEUERSATZ,
  type SaleEventData,
  type Steuersatzregel,
  VOLLER_RABATT,
  aendereMenge,
  aktiveZeilen,
  bemessungsgrundlage,
  bonAusEreignissen,
  bonSteuerausweis,
  bonZeilensumme,
  brichBonAb,
  cents,
  fuegePositionHinzu,
  gesamtbetrag,
  gewaehreRabatt,
  gezahlt,
  isoTimestamp,
  nettosumme,
  nimmZahlung,
  rabattsumme,
  schliesseBonAb,
  starteBon,
  stornierePosition,
  wechsleVerzehrart,
  steuersumme,
  bruttosumme,
} from '../src/index.js'

/** Deterministischer Kontext — Zeit und IDs kommen von aussen (Regel 11). */
function kontext(startNummer = 1): Kontext {
  let n = startNummer
  return {
    occurredAt: isoTimestamp('2026-08-22T10:00:00+02:00'),
    naechsteId: () => 'ID-' + String(n++).padStart(3, '0'),
  }
}

/**
 * Steuersatz als Funktion aus (Produkt, Verzehrart, Datum) — Regel 4.
 *
 * Speisen und Getraenke: im Haus 19 %, ausser Haus 7 %. Alkohol immer 19 %.
 */
const regel: Steuersatzregel = (artikelId, verzehrart) => {
  if (artikelId === 'BIER') return STEUERSATZ.regel
  return verzehrart === 'im-haus' ? STEUERSATZ.regel : STEUERSATZ.ermaessigt
}

const KAESEKUCHEN = {
  artikelId: 'KUCHEN',
  bezeichnung: 'Käsekuchen',
  menge: 1,
  einzelpreis: cents(390),
}
const BROETCHEN = {
  artikelId: 'BROETCHEN',
  bezeichnung: 'Brötchen',
  menge: 2,
  einzelpreis: cents(85),
}

/** Baut einen Bon aus einer Folge von Erzeugerschritten. */
function baue(
  schritte: (bon: Bon, k: Kontext) => SaleEventData[],
): { bon: Bon; ereignisse: SaleEventData[] } {
  const k = kontext()
  const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
  let ereignisse: SaleEventData[] = [start]
  let bon = bonAusEreignissen(ereignisse)
  for (const e of schritte(bon, k)) {
    ereignisse = [...ereignisse, e]
    bon = bonAusEreignissen(ereignisse)
  }
  return { bon, ereignisse }
}

// ---------------------------------------------------------------------------

describe('Bon aus Ereignissen', () => {
  it('beginnt mit SaleStarted', () => {
    const k = kontext()
    const bon = bonAusEreignissen([starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')])
    expect(bon.saleId).toBe('BON-1')
    expect(bon.zustand).toBe('offen')
    expect(bon.verzehrart).toBe('im-haus')
    expect(bon.zeilen).toEqual([])
  })

  it('weist eine Folge ohne SaleStarted ab', () => {
    expect(() => bonAusEreignissen([])).toThrow(BonFehler)
  })

  it('weist Ereignisse eines anderen Bons ab', () => {
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    const bon = bonAusEreignissen([start])
    const fremd = { ...fuegePositionHinzu(bon, k, KAESEKUCHEN, regel), saleId: 'BON-2' }
    expect(() => bonAusEreignissen([start, fremd])).toThrow(/anderen Bon/)
  })

  it('ist eine reine Faltung — dieselben Ereignisse ergeben denselben Bon', () => {
    const { ereignisse } = baue((bon, k) => [fuegePositionHinzu(bon, k, KAESEKUCHEN, regel)])
    expect(bonAusEreignissen(ereignisse)).toEqual(bonAusEreignissen(ereignisse))
  })
})

describe('Positionen', () => {
  it('fuegt eine Position hinzu', () => {
    const { bon } = baue((b, k) => [fuegePositionHinzu(b, k, KAESEKUCHEN, regel)])
    expect(bon.zeilen).toHaveLength(1)
    expect(bon.zeilen[0]?.bezeichnung).toBe('Käsekuchen')
    expect(gesamtbetrag(bon)).toBe(390)
  })

  it('rechnet Menge mal Einzelpreis', () => {
    const { bon } = baue((b, k) => [fuegePositionHinzu(b, k, BROETCHEN, regel)])
    expect(bonZeilensumme(bon.zeilen[0] as never)).toBe(170)
  })

  it('laesst negative Mengen zu — Warenruecknahme (DSFinV-K 4.2.5)', () => {
    const { bon } = baue((b, k) => [
      fuegePositionHinzu(b, k, { ...KAESEKUCHEN, menge: -1 }, regel),
    ])
    expect(gesamtbetrag(bon)).toBe(-390)
  })

  it('weist Menge null ab', () => {
    const { bon } = baue(() => [])
    expect(() =>
      fuegePositionHinzu(bon, kontext(), { ...KAESEKUCHEN, menge: 0 }, regel),
    ).toThrow(BonFehler)
  })

  it('storniert eine Position, ohne sie zu entfernen', () => {
    // Regel 1: keine stille Aenderung. Die Zeile bleibt stehen.
    const { bon } = baue((b, k) => {
      const hinzu = fuegePositionHinzu(b, k, KAESEKUCHEN, regel)
      const nachHinzu = bonAusEreignissen([
        ...[starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')],
        hinzu,
      ])
      return [hinzu, stornierePosition(nachHinzu, k, hinzu.lineId, 'Kunde wollte doch nicht')]
    })
    expect(bon.zeilen).toHaveLength(1)
    expect(bon.zeilen[0]?.storniert).toBe(true)
    expect(bon.zeilen[0]?.stornogrund).toBe('Kunde wollte doch nicht')
    expect(aktiveZeilen(bon)).toHaveLength(0)
    expect(gesamtbetrag(bon)).toBe(0)
  })

  it('verlangt einen Grund fuer das Storno', () => {
    const { bon } = baue((b, k) => [fuegePositionHinzu(b, k, KAESEKUCHEN, regel)])
    expect(() => stornierePosition(bon, kontext(), bon.zeilen[0]?.lineId ?? '', '   ')).toThrow(
      /Grund/,
    )
  })

  it('storniert nicht zweimal', () => {
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    let ereignisse: SaleEventData[] = [start]
    let bon = bonAusEreignissen(ereignisse)
    const hinzu = fuegePositionHinzu(bon, k, KAESEKUCHEN, regel)
    ereignisse = [...ereignisse, hinzu]
    bon = bonAusEreignissen(ereignisse)
    const storno = stornierePosition(bon, k, hinzu.lineId, 'Irrtum')
    expect(() => bonAusEreignissen([...ereignisse, storno, storno])).toThrow(/bereits storniert/)
  })

  it('aendert die Menge als Storno plus neue Zeile', () => {
    // Es gibt bewusst kein Ereignis "Menge geaendert" — der Log ist
    // append-only, und die Historie soll zeigen, was passiert ist.
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    let ereignisse: SaleEventData[] = [start]
    let bon = bonAusEreignissen(ereignisse)
    const hinzu = fuegePositionHinzu(bon, k, BROETCHEN, regel)
    ereignisse = [...ereignisse, hinzu]
    bon = bonAusEreignissen(ereignisse)

    const [storno, neu] = aendereMenge(bon, k, hinzu.lineId, 5)
    bon = bonAusEreignissen([...ereignisse, storno, neu])

    expect(bon.zeilen).toHaveLength(2)
    expect(bon.zeilen[0]?.storniert).toBe(true)
    expect(bon.zeilen[0]?.stornogrund).toBe('Mengenaenderung')
    expect(bon.zeilen[1]?.menge).toBe(5)
    expect(bon.zeilen[1]?.ersetzt).toBe(hinzu.lineId)
    expect(gesamtbetrag(bon)).toBe(5 * 85)
  })
})

describe('Verzehrart', () => {
  it('erbt die Verzehrart des Bons', () => {
    const { bon, ereignisse } = baue((b, k) => [fuegePositionHinzu(b, k, KAESEKUCHEN, regel)])
    expect(bon.zeilen[0]?.verzehrart).toBe('im-haus')
    expect(bon.zeilen[0]?.verzehrartQuelle).toBe('bon')
    const hinzu = ereignisse[1]
    expect(hinzu?.type).toBe('LineAdded')
  })

  it('laesst sich je Position ueberschreiben', () => {
    const { bon } = baue((b, k) => [
      fuegePositionHinzu(b, k, { ...KAESEKUCHEN, verzehrart: 'ausser-haus' }, regel),
    ])
    expect(bon.zeilen[0]?.verzehrart).toBe('ausser-haus')
    expect(bon.zeilen[0]?.verzehrartQuelle).toBe('position')
  })

  it('schreibt die Entscheidung mit, nicht nur das Ergebnis', () => {
    // Regel 4: bei einer Pruefung muss nachvollziehbar sein, WARUM ein
    // Steuersatz galt. "ausser-haus, weil an dieser Position abweichend
    // gesetzt" ist etwas anderes als "ausser-haus, weil der ganze Bon so ist".
    const { ereignisse } = baue((b, k) => [
      fuegePositionHinzu(b, k, KAESEKUCHEN, regel),
      fuegePositionHinzu(b, k, { ...BROETCHEN, verzehrart: 'ausser-haus' }, regel),
    ])
    const zeilen = ereignisse.filter((e) => e.type === 'LineAdded')
    expect(zeilen[0]).toMatchObject({ verzehrart: 'im-haus', verzehrartQuelle: 'bon' })
    expect(zeilen[1]).toMatchObject({ verzehrart: 'ausser-haus', verzehrartQuelle: 'position' })
  })

  it('gilt als vom Bon geerbt, wenn sie zufaellig gleich ist', () => {
    const { bon } = baue((b, k) => [
      fuegePositionHinzu(b, k, { ...KAESEKUCHEN, verzehrart: 'im-haus' }, regel),
    ])
    expect(bon.zeilen[0]?.verzehrartQuelle).toBe('bon')
  })
})

describe('Rabatte auf dem Bon', () => {
  function bonMitZweiSaetzen(): { bon: Bon; ereignisse: SaleEventData[] } {
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    let ereignisse: SaleEventData[] = [start]
    let bon = bonAusEreignissen(ereignisse)
    // Zwei Steuersaetze auf einem Bon: die zweite Position ist ausdruecklich
    // "ausser Haus" und faellt damit unter den ermaessigten Satz (Regel 4).
    for (const p of [
      { ...KAESEKUCHEN, einzelpreis: cents(770) },
      { ...BROETCHEN, menge: 1, einzelpreis: cents(170), verzehrart: 'ausser-haus' as const },
    ]) {
      const e = fuegePositionHinzu(bon, k, p, regel)
      ereignisse = [...ereignisse, e]
      bon = bonAusEreignissen(ereignisse)
    }
    return { bon, ereignisse }
  }

  it('verteilt einen Bonrabatt ueber beide Steuersaetze', () => {
    const { bon, ereignisse } = bonMitZweiSaetzen()
    const rabatt = gewaehreRabatt(bon, kontext(9), 'Kundenkarte', { art: 'bon' }, {
      art: 'prozent',
      hundertstelProzent: 1000,
    })
    const danach = bonAusEreignissen([...ereignisse, rabatt])
    expect(rabatt.verteilung.gesamt).toBe(-94)
    expect(gesamtbetrag(danach)).toBe(940 - 94)
  })

  it('haelt Entscheidung und Ergebnis beide fest', () => {
    // Regel 1: was gewaehrt wurde UND was daraus wurde.
    const { bon } = bonMitZweiSaetzen()
    const rabatt = gewaehreRabatt(bon, kontext(9), 'Kundenkarte', { art: 'bon' }, {
      art: 'prozent',
      hundertstelProzent: 1000,
    })
    expect(rabatt.wert).toEqual({ art: 'prozent', hundertstelProzent: 1000 })
    expect(rabatt.verteilung.anteile).toHaveLength(2)
    expect(rabattsumme(rabatt.verteilung)).toBe(rabatt.verteilung.gesamt)
  })

  it('legt einen Positionsrabatt ganz auf den Satz dieser Position', () => {
    const { bon, ereignisse } = bonMitZweiSaetzen()
    const zielId = bon.zeilen[0]?.lineId ?? ''
    const rabatt = gewaehreRabatt(
      bon,
      kontext(9),
      'Bruchrabatt',
      { art: 'position', positionId: zielId },
      { art: 'prozent', hundertstelProzent: 5000 },
    )
    expect(rabatt.verteilung.anteile).toEqual([{ steuersatzPromille: 190, betrag: -385 }])
    const danach = bonAusEreignissen([...ereignisse, rabatt])
    expect(gesamtbetrag(danach)).toBe(940 - 385)
  })

  it('weist einen Rabatt auf eine unbekannte Position ab', () => {
    const { bon } = bonMitZweiSaetzen()
    expect(() =>
      gewaehreRabatt(bon, kontext(9), 'x', { art: 'position', positionId: 'gibtsnicht' }, {
        art: 'betrag',
        betrag: cents(10),
      }),
    ).toThrow(BonFehler)
  })

  it('rechnet mehrere Rabatte nacheinander auf die schon geminderte Basis', () => {
    const { bon, ereignisse } = bonMitZweiSaetzen()
    const r1 = gewaehreRabatt(bon, kontext(9), 'A', { art: 'bon' }, {
      art: 'prozent',
      hundertstelProzent: 1000,
    })
    const nachEins = bonAusEreignissen([...ereignisse, r1])
    const r2 = gewaehreRabatt(nachEins, kontext(19), 'B', { art: 'bon' }, {
      art: 'prozent',
      hundertstelProzent: 1000,
    })
    const nachZwei = bonAusEreignissen([...ereignisse, r1, r2])

    expect(gesamtbetrag(nachEins)).toBe(846)
    expect(r2.verteilung.gesamt).toBe(-85) // 10 % von 846
    expect(gesamtbetrag(nachZwei)).toBe(846 - 85)
  })

  it('macht bei 100 % exakt null aus dem Bon', () => {
    const { bon, ereignisse } = bonMitZweiSaetzen()
    const rabatt = gewaehreRabatt(bon, kontext(9), 'Aufs Haus', { art: 'bon' }, {
      art: 'prozent',
      hundertstelProzent: VOLLER_RABATT,
    })
    const danach = bonAusEreignissen([...ereignisse, rabatt])
    expect(gesamtbetrag(danach)).toBe(0)
    for (const zeile of bonSteuerausweis(danach)) {
      expect(zeile.brutto).toBe(0)
      expect(zeile.steuer).toBe(0)
    }
  })
})

describe('Zahlung und Abschluss', () => {
  function bezahlterBon(zahlbetrag: number): { bon: Bon; ereignisse: SaleEventData[] } {
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    let ereignisse: SaleEventData[] = [start]
    let bon = bonAusEreignissen(ereignisse)
    const e = fuegePositionHinzu(bon, k, KAESEKUCHEN, regel)
    ereignisse = [...ereignisse, e]
    bon = bonAusEreignissen(ereignisse)
    const z = nimmZahlung(bon, k, 'bar', cents(zahlbetrag))
    ereignisse = [...ereignisse, z]
    bon = bonAusEreignissen(ereignisse)
    return { bon, ereignisse }
  }

  it('schliesst ab und rechnet das Rueckgeld', () => {
    const { bon, ereignisse } = bezahlterBon(500)
    const ende = schliesseBonAb(bon, kontext(9))
    expect(ende.gesamtbetrag).toBe(390)
    expect(ende.rueckgeld).toBe(110)
    expect(bonAusEreignissen([...ereignisse, ende]).zustand).toBe('abgeschlossen')
  })

  it('weigert sich abzuschliessen, solange nicht genug gezahlt ist', () => {
    const { bon } = bezahlterBon(200)
    expect(() => schliesseBonAb(bon, kontext(9))).toThrow(/noch nicht bezahlt/)
  })

  it('summiert mehrere Zahlungen', () => {
    const k = kontext()
    const start = starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')
    let ereignisse: SaleEventData[] = [start]
    let bon = bonAusEreignissen(ereignisse)
    const e = fuegePositionHinzu(bon, k, KAESEKUCHEN, regel)
    ereignisse = [...ereignisse, e]
    bon = bonAusEreignissen(ereignisse)
    ereignisse = [
      ...ereignisse,
      nimmZahlung(bon, k, 'karte', cents(200), '0001'),
      nimmZahlung(bon, k, 'bar', cents(190)),
    ]
    bon = bonAusEreignissen(ereignisse)
    expect(gezahlt(bon)).toBe(390)
    expect(bon.zahlungen[0]?.terminalBelegnummer).toBe('0001')
  })

  it('nimmt nach dem Abschluss nichts mehr an', () => {
    const { bon, ereignisse } = bezahlterBon(390)
    const ende = schliesseBonAb(bon, kontext(9))
    const abgeschlossen = bonAusEreignissen([...ereignisse, ende])
    const weitere = fuegePositionHinzu(abgeschlossen, kontext(19), BROETCHEN, regel)
    expect(() => bonAusEreignissen([...ereignisse, ende, weitere])).toThrow(/abgeschlossen/)
  })

  it('bricht mit Grund ab', () => {
    const { bon, ereignisse } = bezahlterBon(0)
    const abbruch = brichBonAb(bon, kontext(9), 'Kunde ist gegangen')
    expect(bonAusEreignissen([...ereignisse, abbruch]).zustand).toBe('abgebrochen')
  })

  it('verlangt einen Grund fuer den Abbruch', () => {
    const { bon } = bezahlterBon(0)
    expect(() => brichBonAb(bon, kontext(9), '')).toThrow(/Grund/)
  })
})

describe('Eigenschaften ueber beliebige Bons', () => {
  const position = fc.record({
    bezeichnung: fc.constantFrom('Kaffee', 'Kuchen', 'Brötchen'),
    menge: fc.integer({ min: -5, max: 5 }).filter((n) => n !== 0),
    einzelpreis: fc.integer({ min: 1, max: 5000 }).map((n) => cents(n)),
    artikelId: fc.constantFrom('KUCHEN', 'BROETCHEN', 'BIER'),
  })

  it('der Steuerausweis geht immer auf', () => {
    fc.assert(
      fc.property(
        fc.array(position, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: VOLLER_RABATT }),
        (positionen, bp) => {
          const k = kontext()
          let ereignisse: SaleEventData[] = [starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')]
          let bon = bonAusEreignissen(ereignisse)
          for (const p of positionen) {
            const e = fuegePositionHinzu(bon, k, p, regel)
            ereignisse = [...ereignisse, e]
            bon = bonAusEreignissen(ereignisse)
          }

          const rabatt = gewaehreRabatt(bon, k, 'R', { art: 'bon' }, {
            art: 'prozent',
            hundertstelProzent: bp,
          })
          bon = bonAusEreignissen([...ereignisse, rabatt])

          const zeilen = bonSteuerausweis(bon)
          expect(nettosumme(zeilen) + steuersumme(zeilen)).toBe(bruttosumme(zeilen))
          expect(bruttosumme(zeilen)).toBe(gesamtbetrag(bon))
          expect(rabattsumme(rabatt.verteilung)).toBe(rabatt.verteilung.gesamt)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('stornierte Positionen aendern die Summe nicht mehr', () => {
    fc.assert(
      fc.property(fc.array(position, { minLength: 1, maxLength: 8 }), (positionen) => {
        const k = kontext()
        let ereignisse: SaleEventData[] = [starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')]
        let bon = bonAusEreignissen(ereignisse)
        const ids: string[] = []
        for (const p of positionen) {
          const e = fuegePositionHinzu(bon, k, p, regel)
          ids.push(e.lineId)
          ereignisse = [...ereignisse, e]
          bon = bonAusEreignissen(ereignisse)
        }
        const vorher = gesamtbetrag(bon)
        const ersteId = ids[0] as string
        const summeErste = bonZeilensumme(bon.zeilen[0] as never)

        const storno = stornierePosition(bon, k, ersteId, 'Test')
        bon = bonAusEreignissen([...ereignisse, storno])

        expect(gesamtbetrag(bon)).toBe(vorher - summeErste)
        expect(bon.zeilen).toHaveLength(positionen.length) // Zeile bleibt stehen
      }),
      { numRuns: 200 },
    )
  })

  it('die Bemessungsgrundlage entspricht immer der Summe der aktiven Zeilen', () => {
    fc.assert(
      fc.property(fc.array(position, { minLength: 1, maxLength: 10 }), (positionen) => {
        const k = kontext()
        let ereignisse: SaleEventData[] = [starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')]
        let bon = bonAusEreignissen(ereignisse)
        for (const p of positionen) {
          const e = fuegePositionHinzu(bon, k, p, regel)
          ereignisse = [...ereignisse, e]
          bon = bonAusEreignissen(ereignisse)
        }
        const ausZeilen = aktiveZeilen(bon).reduce((a, z) => a + bonZeilensumme(z), 0)
        const ausBasis = bemessungsgrundlage(bon).reduce((a, z) => a + z.brutto, 0)
        expect(ausBasis).toBe(ausZeilen)
      }),
    )
  })
})

describe('Verzehrart des Bons umschalten', () => {
  function bonMitDreiZeilen(): { bon: Bon; ereignisse: SaleEventData[]; k: Kontext } {
    const k = kontext()
    let ereignisse: SaleEventData[] = [starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')]
    let bon = bonAusEreignissen(ereignisse)
    for (const p of [
      KAESEKUCHEN,
      { ...BROETCHEN, menge: 1 },
      // Diese Zeile wurde ausdruecklich abweichend gesetzt.
      { artikelId: 'KUCHEN', bezeichnung: 'Kuchen to go', menge: 1, einzelpreis: cents(300), verzehrart: 'ausser-haus' as const },
    ]) {
      const e = fuegePositionHinzu(bon, k, p, regel)
      ereignisse = [...ereignisse, e]
      bon = bonAusEreignissen(ereignisse)
    }
    return { bon, ereignisse, k }
  }

  it('schaltet um und rechnet die Steuersaetze neu', () => {
    const { bon, ereignisse, k } = bonMitDreiZeilen()
    expect(bon.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.regel)

    const wechsel = wechsleVerzehrart(bon, k, 'ausser-haus', regel)
    const danach = bonAusEreignissen([...ereignisse, wechsel])

    expect(danach.verzehrart).toBe('ausser-haus')
    expect(danach.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
    expect(danach.zeilen[1]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('reisst Positionen mit eigener Verzehrart NICHT mit', () => {
    const { bon, ereignisse, k } = bonMitDreiZeilen()
    const wechsel = wechsleVerzehrart(bon, k, 'ausser-haus', regel)

    expect(wechsel.unberuehrt).toEqual([bon.zeilen[2]?.lineId])
    expect(wechsel.betroffen.map((b) => b.lineId)).toEqual([
      bon.zeilen[0]?.lineId,
      bon.zeilen[1]?.lineId,
    ])

    const danach = bonAusEreignissen([...ereignisse, wechsel])
    expect(danach.zeilen[2]?.verzehrart).toBe('ausser-haus')
    expect(danach.zeilen[2]?.verzehrartQuelle).toBe('position')
  })

  it('haelt fest, welcher Steuersatz vorher und nachher galt', () => {
    // Bei einer Pruefung ist genau das die Frage: warum 7 %.
    const { bon, k } = bonMitDreiZeilen()
    const wechsel = wechsleVerzehrart(bon, k, 'ausser-haus', regel)

    expect(wechsel.vorher).toBe('im-haus')
    expect(wechsel.nachher).toBe('ausser-haus')
    for (const b of wechsel.betroffen) {
      expect(b.vorherSteuersatzPromille).toBe(STEUERSATZ.regel)
      expect(b.nachherSteuersatzPromille).toBe(STEUERSATZ.ermaessigt)
      expect(b.artikelId).toBeTruthy()
    }
  })

  it('laesst sich mehrfach hin und her schalten', () => {
    const { bon, ereignisse, k } = bonMitDreiZeilen()
    const hin = wechsleVerzehrart(bon, k, 'ausser-haus', regel)
    const zwischen = bonAusEreignissen([...ereignisse, hin])
    const zurueck = wechsleVerzehrart(zwischen, k, 'im-haus', regel)
    const danach = bonAusEreignissen([...ereignisse, hin, zurueck])

    expect(danach.verzehrart).toBe('im-haus')
    expect(danach.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.regel)
    // Die abweichende Zeile blieb beide Male unberuehrt.
    expect(danach.zeilen[2]?.verzehrart).toBe('ausser-haus')
  })

  it('aendert den Gesamtbetrag nicht, nur die Steueraufteilung', () => {
    const { bon, ereignisse, k } = bonMitDreiZeilen()
    const vorher = gesamtbetrag(bon)
    const danach = bonAusEreignissen([...ereignisse, wechsleVerzehrart(bon, k, 'ausser-haus', regel)])

    expect(gesamtbetrag(danach)).toBe(vorher)
    // Die Steuer sinkt, weil mehr auf den ermaessigten Satz faellt.
    expect(steuersumme(bonSteuerausweis(danach))).toBeLessThan(steuersumme(bonSteuerausweis(bon)))
  })

  it('weist einen Wechsel auf dieselbe Verzehrart ab', () => {
    const { bon, k } = bonMitDreiZeilen()
    expect(() => wechsleVerzehrart(bon, k, 'im-haus', regel)).toThrow(/bereits/)
  })

  it('ist nach dem Abschluss nicht mehr moeglich', () => {
    const k = kontext()
    let ereignisse: SaleEventData[] = [starteBon(k, 'BON-1', 'KASSE-01', 'im-haus')]
    let bon = bonAusEreignissen(ereignisse)
    const e = fuegePositionHinzu(bon, k, KAESEKUCHEN, regel)
    ereignisse = [...ereignisse, e, nimmZahlung(bonAusEreignissen([...ereignisse, e]), k, 'bar', cents(390))]
    bon = bonAusEreignissen(ereignisse)
    const ende = schliesseBonAb(bon, k)
    const abgeschlossen = bonAusEreignissen([...ereignisse, ende])

    expect(() => wechsleVerzehrart(abgeschlossen, k, 'ausser-haus', regel)).toThrow(/abgeschlossen/)
  })

  it('laesst stornierte Zeilen aus', () => {
    const { bon, ereignisse, k } = bonMitDreiZeilen()
    const storno = stornierePosition(bon, k, bon.zeilen[0]?.lineId ?? '', 'Irrtum')
    const nachStorno = bonAusEreignissen([...ereignisse, storno])
    const wechsel = wechsleVerzehrart(nachStorno, k, 'ausser-haus', regel)

    expect(wechsel.betroffen.map((b) => b.lineId)).toEqual([bon.zeilen[1]?.lineId])
  })
})

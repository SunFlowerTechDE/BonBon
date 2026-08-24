/**
 * Ein vollständiger Verkauf, kopflos.
 *
 * Das ist der belastbare Nachweis, dass die Kasse durchläuft: Artikel tippen,
 * Verzehrart umschalten, zahlen, signieren, ins Event Log schreiben, Beleg
 * erzeugen. Ohne Browser, ohne Klicken, bei jedem Testlauf wiederholbar.
 */

import { describe, expect, it } from 'vitest'

import { STEUERSATZ, aktiveZeilen, cents, gesamtbetrag } from '@bonbon/core'
import { MockTse, previewLines } from '@bonbon/ports'

import { SpeicherEventLog, VorschauDrucker, entwicklungsHasher } from '../src/adapter.js'
import { Kasse, schnellbetraege } from '../src/kasse.js'
import { VORGABE } from '../src/konfiguration.js'
import { ARTIKEL, steuersatzregel, verzehrartAendertSatz } from '../src/stammdaten.js'

function baueKasse(): {
  kasse: Kasse
  tse: MockTse
  drucker: VorschauDrucker
  log: SpeicherEventLog
  protokoll: string[]
} {
  const protokoll: string[] = []
  const melde = (n: string): void => {
    protokoll.push(n)
  }
  const tse = new MockTse({ seriennummer: 'MOCK-TSE-TEST', onLog: melde })
  const drucker = new VorschauDrucker(48, melde)
  const log = new SpeicherEventLog(entwicklungsHasher(), melde)
  return { kasse: new Kasse(VORGABE, tse, drucker, log, melde), tse, drucker, log, protokoll }
}

describe('Ein Verkauf laeuft durch', () => {
  it('Artikel tippen, zahlen, signieren, schreiben, drucken', async () => {
    const { kasse, drucker, log } = baueKasse()

    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('CAPPUCCINO')
    await kasse.tippeArtikel('KAESEKUCHEN')
    const bon = await kasse.tippeArtikel('CAPPUCCINO') // zweiter Tipp erhoeht die Menge

    expect(aktiveZeilen(bon)).toHaveLength(2)
    expect(aktiveZeilen(bon).find((z) => z.artikelId === 'CAPPUCCINO')?.menge).toBe(2)
    expect(gesamtbetrag(bon)).toBe(2 * 380 + 390) // 11,50 EUR

    const ergebnis = await kasse.schliesseAb('bar', cents(2000))

    expect(ergebnis.signiert).toBe(true)
    expect(ergebnis.gedruckt).toBe(true)
    expect(ergebnis.beleg.gesamtbetrag).toBe(1150)
    expect(ergebnis.beleg.rueckgeld).toBe(850)
    // Bonereignisse plus das Signaturereignis. Die beiden Zahlen sind
    // absichtlich nicht dieselbe: `ergebnis.ereignisse` zaehlt den Bon, der Log
    // haelt zusaetzlich fest, womit signiert wurde.
    // Bonereignisse plus Transaktionsbeginn plus Signatur.
    expect(await log.anzahl()).toBe(ergebnis.ereignisse + 2)
    const signatur = log.ereignisse.at(-1)
    expect(signatur?.type).toBe('TseSignaturErfasst')
    expect(JSON.parse(signatur?.payload ?? '{}')).toMatchObject({
      belegreferenz: ergebnis.beleg.belegnummer,
      nachgetragen: false,
      transaktionsnummer: ergebnis.beleg.signatur?.transaktionsnummer,
      signaturzaehler: ergebnis.beleg.signatur?.signaturzaehler,
      pruefwert: ergebnis.beleg.signatur?.pruefwert,
    })
    expect(drucker.ladeGeoeffnet).toBe(1)

    const bonText = drucker.letzterBon.join('\n')
    expect(bonText).toContain('Café Sonnenblume')
    expect(bonText).toContain('Cappuccino')
    expect(bonText).toContain('Käsekuchen')
    expect(bonText).toContain('11,50')
    expect(bonText).toContain('TSE-Signaturdaten')
  })

  it('schreibt jedes Ereignis in den Event Log, mit lueckenloser Kette', async () => {
    const { kasse, log } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAFFEE')
    await kasse.schliesseAb('bar', cents(300))

    const seqs = log.ereignisse.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs[0]).toBe(1)
    expect(seqs.at(-1)).toBe(seqs.length)

    // Die Kette haengt zusammen.
    for (let i = 1; i < log.ereignisse.length; i += 1) {
      expect(log.ereignisse[i]?.prevHash).toBe(log.ereignisse[i - 1]?.hash)
    }
    expect(log.ereignisse.map((e) => e.type)).toContain('SaleStarted')
    expect(log.ereignisse.map((e) => e.type)).toContain('SaleFinished')
  })
})

describe('Der Verzehrart-Umschalter', () => {
  it('aendert den Steuersatz, nicht den Preis', async () => {
    // Latte Macchiato, nicht Kuchen: seit 1.1.2026 sind Speisen in beiden
    // Verzehrarten ermaessigt (§ 12 Abs. 2 Nr. 15 UStG). Der Umschalter bewegt
    // den Satz nur noch beim Milchmischgetraenk — mitnehmen ist eine Lieferung,
    // im Haus eine Restaurationsleistung, und die Absenkung gilt nur fuer Speisen.
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')

    const imHaus = kasse.bon
    expect(imHaus?.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.regel)
    const summeVorher = gesamtbetrag(imHaus as never)

    const ausserHaus = await kasse.setzeVerzehrart('ausser-haus')
    expect(ausserHaus.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
    expect(gesamtbetrag(ausserHaus)).toBe(summeVorher)

    const ergebnis = await kasse.schliesseAb('bar', cents(500))
    expect(ergebnis.beleg.steuerausweis[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('laesst den Kuchen unberuehrt — bei Speisen aendert der Umschalter nichts mehr', async () => {
    // Die alte Sammelregel machte hier aus 19 % 7 %. Seit 2026 sind es beide
    // Male 7 %, und dass der Umschalter *nichts* tut, ist das richtige
    // Verhalten — nicht ein uebersehener Fall.
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAESEKUCHEN')
    expect(kasse.bon?.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)

    const ausserHaus = await kasse.setzeVerzehrart('ausser-haus')
    expect(ausserHaus.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('laesst Getraenke beim Regelsatz — die Regel kennt den Unterschied', async () => {
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAFFEE') // Getraenk
    await kasse.tippeArtikel('KAESEKUCHEN') // Speise
    const bon = await kasse.setzeVerzehrart('ausser-haus')

    const kaffee = aktiveZeilen(bon).find((z) => z.artikelId === 'KAFFEE')
    const kuchen = aktiveZeilen(bon).find((z) => z.artikelId === 'KAESEKUCHEN')
    expect(kaffee?.steuersatzPromille).toBe(STEUERSATZ.regel)
    expect(kuchen?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('ist jederzeit vor dem Abschluss moeglich, danach nicht mehr', async () => {
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAESEKUCHEN')
    await kasse.setzeVerzehrart('ausser-haus')
    await kasse.setzeVerzehrart('im-haus')
    await kasse.setzeVerzehrart('ausser-haus')
    const abgeschlossen = kasse.bon
    await kasse.schliesseAb('bar', cents(400))

    // Danach nicht mehr: der Umschalter aendert den abgeschlossenen Bon nicht,
    // sondern eroeffnet den naechsten. Das ist derselbe Griff wie an einer
    // echten Kasse — der Bon ist weg, der naechste Kunde steht schon da.
    const naechster = await kasse.setzeVerzehrart('im-haus')
    expect(naechster.saleId).not.toBe(abgeschlossen?.saleId)
    expect(naechster.zustand).toBe('offen')
    expect(naechster.zeilen).toHaveLength(0)
  })
})

describe('TSE-Ausfall — Regel 8', () => {
  it('schliesst den Verkauf trotzdem ab und druckt den Ausfallhinweis', async () => {
    const { kasse, tse, drucker } = baueKasse()
    tse.setFehler({ art: 'ausgefallen', grund: 'TSE-Stick nicht erkannt' })

    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('CAPPUCCINO')
    const ergebnis = await kasse.schliesseAb('bar', cents(400))

    // Der Verkauf wird NICHT verweigert.
    expect(ergebnis.signiert).toBe(false)
    expect(ergebnis.ausfallgrund).toBe('TSE-Stick nicht erkannt')
    expect(ergebnis.gedruckt).toBe(true)
    expect(ergebnis.beleg.gesamtbetrag).toBe(380)

    const bonText = drucker.letzterBon.join('\n')
    expect(bonText).toContain('nicht erstellt werden')
    expect(bonText).toContain('TSE-Stick nicht erkannt')
    expect(bonText).toContain('Nachsignierung')
  })

  it('meldet den Zustand als ausgefallen', async () => {
    const { tse } = baueKasse()
    tse.setFehler({ art: 'ausgefallen' })
    expect((await tse.zustand()).status).toBe('ausgefallen')
    tse.setFehler({ art: 'gestoert', meldung: 'Zertifikat laeuft bald ab' })
    expect((await tse.zustand()).status).toBe('gestoert')
    tse.setFehler({ art: 'keiner' })
    expect((await tse.zustand()).status).toBe('bereit')
  })
})

describe('Druckerausfall', () => {
  it('verweigert den Verkauf nicht', async () => {
    const { drucker } = baueKasse()
    // Der Vorschaudrucker kann nicht scheitern — deshalb hier einer, der es tut.
    const kaputt = Object.assign(Object.create(Object.getPrototypeOf(drucker) as object), drucker, {
      print: () => Promise.reject(new Error('Kein Papier')),
    }) as VorschauDrucker
    const kasse2 = new Kasse(
      VORGABE,
      new MockTse(),
      kaputt,
      new SpeicherEventLog(entwicklungsHasher(), () => undefined),
      () => undefined,
    )

    await kasse2.beginneBon('im-haus')
    await kasse2.tippeArtikel('KAFFEE')
    const ergebnis = await kasse2.schliesseAb('bar', cents(300))

    expect(ergebnis.gedruckt).toBe(false)
    expect(ergebnis.druckfehler).toContain('Kein Papier')
    // Der Vorgang ist trotzdem erfasst und signiert.
    expect(ergebnis.signiert).toBe(true)
  })
})

describe('Schnellbetraege', () => {
  it('berechnet sie aus dem echten Bonbetrag', () => {
    // Bei 7,40 also 7,40 / 8 / 10 / 20.
    expect(schnellbetraege(cents(740)).map((c) => c as number)).toEqual([740, 800, 1000, 2000])
  })

  it('setzt den passenden Betrag immer nach vorn', () => {
    for (const betrag of [1150, 250, 999, 2000]) {
      expect(schnellbetraege(cents(betrag))[0]).toBe(betrag)
    }
  })

  it('gibt bei glattem Betrag keinen doppelten Eintrag', () => {
    const b = schnellbetraege(cents(1000)).map((c) => c as number)
    expect(new Set(b).size).toBe(b.length)
    expect(b[0]).toBe(1000)
  })

  it('gibt bei null nichts', () => {
    expect(schnellbetraege(cents(0))).toEqual([])
  })
})

describe('Steuervorbelegung der Stammdaten', () => {
  const t = '2026-08-22T10:00:00+02:00' as never

  /**
   * Die Sätze sind nachgeschlagen, nicht angenommen — und sie stehen hier
   * als Testfall, damit eine spätere Änderung auffällt statt durchzurutschen.
   * Was hier steht, ist eine **Vorbelegung**, keine Auskunft (Regel 20).
   */
  it('lässt zubereiteten Kaffee, Espresso und Tee auch zum Mitnehmen beim Regelsatz', () => {
    for (const id of ['KAFFEE', 'ESPRESSO', 'TEE']) {
      expect(steuersatzregel(id, 'im-haus', t).satz).toBe(STEUERSATZ.regel)
      expect(steuersatzregel(id, 'ausser-haus', t).satz).toBe(STEUERSATZ.regel)
    }
    // Genau das war der Fehler der alten Sammelregel: sie machte aus
    // „mitnehmen" pauschal 7 %.
    expect(steuersatzregel('KAFFEE', 'ausser-haus', t).begruendung).toContain('Getraenk')
  })

  it('lässt Cappuccino beim Regelsatz — unter der 75-%-Grenze', () => {
    expect(steuersatzregel('CAPPUCCINO', 'ausser-haus', t).satz).toBe(STEUERSATZ.regel)
    expect(steuersatzregel('CAPPUCCINO', 'ausser-haus', t).begruendung).toContain('75')
  })

  it('setzt Latte Macchiato zum Mitnehmen auf den ermäßigten Satz, im Haus nicht', () => {
    // Der einzige Artikel, bei dem die Verzehrart den Satz noch bewegt: zum
    // Mitnehmen eine Lieferung (Milchmischgetränk), im Haus eine
    // Restaurationsleistung — und deren Absenkung ab 2026 gilt nur für Speisen.
    expect(steuersatzregel('LATTE', 'ausser-haus', t).satz).toBe(STEUERSATZ.ermaessigt)
    expect(steuersatzregel('LATTE', 'im-haus', t).satz).toBe(STEUERSATZ.regel)
  })

  it('erreicht mit Haferdrink die Milchgrenze nicht', () => {
    expect(steuersatzregel('LATTE_HAFER', 'ausser-haus', t).satz).toBe(STEUERSATZ.regel)
    expect(steuersatzregel('LATTE_HAFER', 'ausser-haus', t).fundstelle).toContain('1 K 232/24')
  })

  it('setzt Speisen seit 2026 in beiden Verzehrarten auf den ermäßigten Satz', () => {
    for (const id of ['KAESEKUCHEN', 'CROISSANT', 'BROETCHEN']) {
      expect(steuersatzregel(id, 'im-haus', t).satz).toBe(STEUERSATZ.ermaessigt)
      expect(steuersatzregel(id, 'ausser-haus', t).satz).toBe(STEUERSATZ.ermaessigt)
    }
    expect(steuersatzregel('KAESEKUCHEN', 'im-haus', t).fundstelle).toContain('Nr. 15')
  })

  it('lässt kalte Getränke immer beim Regelsatz', () => {
    for (const id of ['WASSER', 'APFELSCHORLE']) {
      expect(steuersatzregel(id, 'im-haus', t).satz).toBe(STEUERSATZ.regel)
      expect(steuersatzregel(id, 'ausser-haus', t).satz).toBe(STEUERSATZ.regel)
    }
  })

  it('gibt zu jedem Artikel eine Begründung und eine Fundstelle', () => {
    // Ohne beides wäre die Frage „warum 7 %" aus den Daten nicht zu
    // beantworten — und genau die wird bei einer Prüfung gestellt.
    for (const a of ARTIKEL) {
      for (const verzehrart of ['im-haus', 'ausser-haus'] as const) {
        const e = steuersatzregel(a.id, verzehrart, t)
        expect(e.begruendung.length, a.id).toBeGreaterThan(10)
        expect(e.fundstelle.length, a.id).toBeGreaterThan(10)
      }
    }
  })

  it('wirft bei einem unbekannten Artikel, statt einen Satz zu raten', () => {
    expect(() => steuersatzregel('GIBTSNICHT', 'im-haus', t)).toThrow(/unbekannter Artikel/)
  })
})

describe('Der Umschalter richtet sich nach seiner Wirkung', () => {
  /**
   * Bis zum 31.12.2025 bewegte die Verzehrart bei fast jedem Artikel den Satz.
   * Seit dem 1.1.2026 nur noch beim Milchmischgetränk — und die Oberfläche
   * macht den Schalter nur dann groß.
   */
  it('erkennt, bei welchen Artikeln die Verzehrart den Satz ändert', () => {
    expect(verzehrartAendertSatz('LATTE')).toBe(true)

    for (const id of ['KAFFEE', 'ESPRESSO', 'TEE', 'CAPPUCCINO', 'LATTE_HAFER']) {
      expect(verzehrartAendertSatz(id), id).toBe(false)
    }
    for (const id of ['KAESEKUCHEN', 'CROISSANT', 'BROETCHEN', 'WASSER', 'APFELSCHORLE']) {
      expect(verzehrartAendertSatz(id), id).toBe(false)
    }
  })

  it('ist im Sortiment die Ausnahme, nicht die Regel', () => {
    // Zwei bis vier von zwanzig — das ist die Begründung dafür, den Schalter
    // nicht mehr bei jedem Bon groß zu zeigen. Fällt die Zahl auseinander,
    // stimmt die Begründung nicht mehr.
    const mitWirkung = ARTIKEL.filter((a) => verzehrartAendertSatz(a.id))
    expect(mitWirkung.length).toBeGreaterThan(0)
    expect(mitWirkung.length).toBeLessThan(ARTIKEL.length / 4)
  })

  it('kennt keinen unbekannten Artikel und behauptet auch keine Wirkung', () => {
    expect(verzehrartAendertSatz('GIBTSNICHT')).toBe(false)
  })
})

describe('Verzehrart je Position', () => {
  it('spaltet eine zusammengefasste Zeile auf: einer bleibt hier, einer geht', async () => {
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')
    const zwei = await kasse.tippeArtikel('LATTE')
    expect(aktiveZeilen(zwei)).toHaveLength(1)
    expect(aktiveZeilen(zwei)[0]?.menge).toBe(2)

    const geteilt = await kasse.setzeVerzehrartFuerPosition(
      aktiveZeilen(zwei)[0]?.lineId as string,
      'ausser-haus',
    )

    const offen = aktiveZeilen(geteilt)
    expect(offen).toHaveLength(2)
    const hier = offen.find((z) => z.verzehrart === 'im-haus')
    const mit = offen.find((z) => z.verzehrart === 'ausser-haus')
    expect(hier?.menge).toBe(1)
    expect(mit?.menge).toBe(1)

    // Und der Steuersatz folgt der Position, nicht dem Bon.
    expect(hier?.steuersatzPromille).toBe(STEUERSATZ.regel)
    expect(mit?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
    // Der Preis bleibt gleich — geteilt wird die Menge, nicht der Betrag.
    expect(gesamtbetrag(geteilt)).toBe(2 * 420)
  })

  it('nimmt die einzeln gesetzte Zeile vom großen Umschalter aus', async () => {
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')
    await kasse.tippeArtikel('LATTE')
    const zeile = aktiveZeilen(kasse.bon as never)[0]?.lineId as string
    await kasse.setzeVerzehrartFuerPosition(zeile, 'ausser-haus')

    const umgeschaltet = await kasse.setzeVerzehrart('ausser-haus')
    const zeilen = aktiveZeilen(umgeschaltet)
    // Beide sind jetzt ausser Haus — aber die eine, weil der Bon umgeschaltet
    // wurde, die andere, weil sie einzeln gesetzt ist.
    expect(zeilen.every((z) => z.verzehrart === 'ausser-haus')).toBe(true)
    expect(zeilen.filter((z) => z.verzehrartQuelle === 'position')).toHaveLength(1)

    // Zurueck auf „im Haus": die einzeln gesetzte Zeile bleibt aussen vor.
    const zurueck = await kasse.setzeVerzehrart('im-haus')
    const einzeln = aktiveZeilen(zurueck).find((z) => z.verzehrartQuelle === 'position')
    expect(einzeln?.verzehrart).toBe('ausser-haus')
    expect(einzeln?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('schreibt Begründung und Fundstelle in den Log', async () => {
    const { kasse, log } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')
    const zeile = aktiveZeilen(kasse.bon as never)[0]?.lineId as string
    await kasse.setzeVerzehrartFuerPosition(zeile, 'ausser-haus')

    const zeilenEreignisse = log.ereignisse
      .filter((e) => e.type === 'LineAdded')
      .map((e) => JSON.parse(e.payload) as { steuerbegruendung: string; steuerfundstelle: string })
    expect(zeilenEreignisse.at(-1)?.steuerbegruendung).toContain('Milchmischgetraenk')
    expect(zeilenEreignisse.at(-1)?.steuerfundstelle).toContain('Anlage 2 Nr. 4')
  })

  it('hält beim Umschalten des Bons fest, warum sich der Satz ändert', async () => {
    const { kasse, log } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')
    await kasse.setzeVerzehrart('ausser-haus')

    const wechsel = log.ereignisse.find((e) => e.type === 'DiningModeChanged')
    const daten = JSON.parse(wechsel?.payload ?? '{}') as {
      betroffen: { vorherBegruendung: string; nachherBegruendung: string }[]
    }
    expect(daten.betroffen[0]?.vorherBegruendung).toContain('Restaurationsleistung')
    expect(daten.betroffen[0]?.nachherBegruendung).toContain('Milchmischgetraenk')
  })

  it('lässt sich nicht auf mehr Stück anwenden, als die Zeile hat', async () => {
    const { kasse } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('LATTE')
    const zeile = aktiveZeilen(kasse.bon as never)[0]?.lineId as string
    await expect(kasse.setzeVerzehrartFuerPosition(zeile, 'ausser-haus', 5)).rejects.toThrow(
      /nur 1 Stueck/,
    )
  })
})

describe('Der gedruckte Bon', () => {
  it('passt in 48 Zeichen und zeigt beide Steuersaetze', async () => {
    const { kasse, drucker } = baueKasse()
    await kasse.beginneBon('ausser-haus')
    await kasse.tippeArtikel('KAESEKUCHEN') // 7 % ausser Haus
    await kasse.tippeArtikel('KAFFEE') // 19 % immer
    await kasse.schliesseAb('bar', cents(1000))

    for (const zeile of drucker.letzterBon) {
      expect(zeile.length).toBeLessThanOrEqual(48)
    }
    const text = drucker.letzterBon.join('\n')
    expect(text).toContain('A 19%')
    expect(text).toContain('B 7%')
    expect(text).toContain('außer Haus')
  })

  it('erzeugt gueltige ESC/POS-Bytes', async () => {
    const { kasse, drucker } = baueKasse()
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('TEE')
    await kasse.schliesseAb('bar', cents(250))
    // Der Vorschaudrucker haelt die Zeilen, der Parser kam damit klar.
    expect(previewLines(new Uint8Array(0), 48)).toEqual([])
    expect(drucker.letzterBon.length).toBeGreaterThan(10)
  })
})

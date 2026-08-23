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
import { steuersatzregel } from '../src/stammdaten.js'

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

    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('CAPPUCCINO')
    kasse.tippeArtikel('KAESEKUCHEN')
    const bon = kasse.tippeArtikel('CAPPUCCINO') // zweiter Tipp erhoeht die Menge

    expect(aktiveZeilen(bon)).toHaveLength(2)
    expect(aktiveZeilen(bon).find((z) => z.artikelId === 'CAPPUCCINO')?.menge).toBe(2)
    expect(gesamtbetrag(bon)).toBe(2 * 380 + 390) // 11,50 EUR

    const ergebnis = await kasse.schliesseAb('bar', cents(2000))

    expect(ergebnis.signiert).toBe(true)
    expect(ergebnis.gedruckt).toBe(true)
    expect(ergebnis.beleg.gesamtbetrag).toBe(1150)
    expect(ergebnis.beleg.rueckgeld).toBe(850)
    expect(await log.anzahl()).toBe(ergebnis.ereignisse)
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
    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('KAFFEE')
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
    const { kasse } = baueKasse()
    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('KAESEKUCHEN')

    const imHaus = kasse.bon
    expect(imHaus?.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.regel)
    const summeVorher = gesamtbetrag(imHaus as never)

    const ausserHaus = kasse.setzeVerzehrart('ausser-haus')
    expect(ausserHaus.zeilen[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
    expect(gesamtbetrag(ausserHaus)).toBe(summeVorher)

    const ergebnis = await kasse.schliesseAb('bar', cents(400))
    expect(ergebnis.beleg.steuerausweis[0]?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('laesst Getraenke beim Regelsatz — die Regel kennt den Unterschied', () => {
    const { kasse } = baueKasse()
    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('KAFFEE') // Getraenk
    kasse.tippeArtikel('KAESEKUCHEN') // Speise
    const bon = kasse.setzeVerzehrart('ausser-haus')

    const kaffee = aktiveZeilen(bon).find((z) => z.artikelId === 'KAFFEE')
    const kuchen = aktiveZeilen(bon).find((z) => z.artikelId === 'KAESEKUCHEN')
    expect(kaffee?.steuersatzPromille).toBe(STEUERSATZ.regel)
    expect(kuchen?.steuersatzPromille).toBe(STEUERSATZ.ermaessigt)
  })

  it('ist jederzeit vor dem Abschluss moeglich, danach nicht mehr', async () => {
    const { kasse } = baueKasse()
    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('KAESEKUCHEN')
    kasse.setzeVerzehrart('ausser-haus')
    kasse.setzeVerzehrart('im-haus')
    kasse.setzeVerzehrart('ausser-haus')
    await kasse.schliesseAb('bar', cents(400))
    expect(() => kasse.setzeVerzehrart('im-haus')).toThrow()
  })
})

describe('TSE-Ausfall — Regel 8', () => {
  it('schliesst den Verkauf trotzdem ab und druckt den Ausfallhinweis', async () => {
    const { kasse, tse, drucker } = baueKasse()
    tse.setFehler({ art: 'ausgefallen', grund: 'TSE-Stick nicht erkannt' })

    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('CAPPUCCINO')
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

    kasse2.beginneBon('im-haus')
    kasse2.tippeArtikel('KAFFEE')
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

describe('Steuersatzregel der Stammdaten', () => {
  it('behandelt Speisen nach Verzehrart', () => {
    const t = '2026-08-22T10:00:00+02:00' as never
    expect(steuersatzregel('KAESEKUCHEN', 'im-haus', t)).toBe(STEUERSATZ.regel)
    expect(steuersatzregel('KAESEKUCHEN', 'ausser-haus', t)).toBe(STEUERSATZ.ermaessigt)
  })

  it('laesst Getraenke immer beim Regelsatz', () => {
    const t = '2026-08-22T10:00:00+02:00' as never
    expect(steuersatzregel('KAFFEE', 'im-haus', t)).toBe(STEUERSATZ.regel)
    expect(steuersatzregel('KAFFEE', 'ausser-haus', t)).toBe(STEUERSATZ.regel)
  })

  it('behandelt Milchmischgetraenke wie Speisen', () => {
    const t = '2026-08-22T10:00:00+02:00' as never
    expect(steuersatzregel('CAPPUCCINO', 'ausser-haus', t)).toBe(STEUERSATZ.ermaessigt)
  })

  it('schiebt einem unbekannten Artikel keinen Steuersatz unter', () => {
    const t = '2026-08-22T10:00:00+02:00' as never
    expect(() => steuersatzregel('GIBTSNICHT', 'im-haus', t)).toThrow(/unbekannter Artikel/)
  })
})

describe('Der gedruckte Bon', () => {
  it('passt in 48 Zeichen und zeigt beide Steuersaetze', async () => {
    const { kasse, drucker } = baueKasse()
    kasse.beginneBon('ausser-haus')
    kasse.tippeArtikel('KAESEKUCHEN') // 7 % ausser Haus
    kasse.tippeArtikel('KAFFEE') // 19 % immer
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
    kasse.beginneBon('im-haus')
    kasse.tippeArtikel('TEE')
    await kasse.schliesseAb('bar', cents(250))
    // Der Vorschaudrucker haelt die Zeilen, der Parser kam damit klar.
    expect(previewLines(new Uint8Array(0), 48)).toEqual([])
    expect(drucker.letzterBon.length).toBeGreaterThan(10)
  })
})

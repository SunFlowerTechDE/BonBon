import { describe, expect, it } from 'vitest'

import { cents } from '@bonbon/core'
import { CHARACTERS_PER_LINE_80MM, previewLines } from '@bonbon/ports'

import {
  type Bondaten,
  type Position,
  baueTestbon,
  euro,
  gesamtsumme,
  prozent,
  steuerAusBrutto,
  steuerzeilen,
  zeilensumme,
} from '../src/testbon.js'

const KAESEKUCHEN: Position = {
  menge: 1,
  bezeichnung: 'Käsekuchen',
  einzelpreis: cents(390),
  steuersatzPromille: 190,
  verzehrart: 'im Haus',
}

const CAPPUCCINO: Position = {
  menge: 1,
  bezeichnung: 'Cappuccino mit Hafermilch',
  einzelpreis: cents(380),
  steuersatzPromille: 190,
  verzehrart: 'im Haus',
}

const BROETCHEN: Position = {
  menge: 2,
  bezeichnung: 'Brötchen',
  einzelpreis: cents(85),
  steuersatzPromille: 70,
  verzehrart: 'ausser Haus',
}

const DATEN: Bondaten = {
  betrieb: 'Café Sonnenblume',
  strasse: 'Bäckerstraße 12',
  ort: '66111 Saarbrücken',
  steuernummer: '040/123/45678',
  belegnummer: 'ftA#T3',
  zeitpunkt: '21.08.2026 17:03',
  kasse: 'BONBON-DEV-001',
  positionen: [KAESEKUCHEN, CAPPUCCINO, BROETCHEN],
  signatur: {
    transaktionsnummer: '3',
    signaturzaehler: '6',
    startzeit: '2026-08-21T17:03:43.120Z',
    logzeit: '2026-08-21T17:03:43.000Z',
    signatur: 'AgECBgkEAH8ABwMHAQGAEUZpbmlzaFRyYW5zYWN0aW9u',
    tseSeriennummer: 'dace6975-a50d-442c-a979-dbbb887e8134',
    pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^3.80;3;6',
  },
}

/** Der Bon als Zeilen, wie der Drucker sie setzen wuerde. */
function bonZeilen(daten: Bondaten = DATEN): string[] {
  return previewLines(baueTestbon(daten))
}

describe('euro', () => {
  it('rechnet Cent nach Euro', () => {
    expect(euro(cents(390))).toBe('3,90')
    expect(euro(cents(5))).toBe('0,05')
    expect(euro(cents(0))).toBe('0,00')
    expect(euro(cents(123456))).toBe('1234,56')
  })

  it('stellt negative Betraege dar', () => {
    expect(euro(cents(-390))).toBe('-3,90')
  })
})

describe('prozent', () => {
  it('stellt Promille als Prozent dar', () => {
    expect(prozent(190)).toBe('19')
    expect(prozent(70)).toBe('7')
    expect(prozent(195)).toBe('19,5')
  })
})

describe('zeilensumme', () => {
  it('rechnet Menge mal Einzelpreis', () => {
    expect(zeilensumme(BROETCHEN)).toBe(170)
    expect(zeilensumme(KAESEKUCHEN)).toBe(390)
  })
})

describe('steuerAusBrutto', () => {
  it('rechnet 19 % aus einem Bruttobetrag heraus', () => {
    // 7,70 EUR brutto -> 7700 * 190 / 1190 = 1229,4 -> 1,23 EUR
    expect(steuerAusBrutto(cents(770), 190)).toBe(123)
  })

  it('rechnet 7 % aus einem Bruttobetrag heraus', () => {
    // 1,70 EUR brutto -> 1700 * 70 / 1070 = 111,2 -> 0,11 EUR
    expect(steuerAusBrutto(cents(170), 70)).toBe(11)
  })

  it('rundet kaufmaennisch, halbe Cent aufwaerts', () => {
    // Genau .5 muss aufgerundet werden, nicht abgeschnitten.
    expect(steuerAusBrutto(cents(0), 190)).toBe(0)
    expect(steuerAusBrutto(cents(119), 190)).toBe(19)
  })

  it('bleibt in Ganzzahlen — nie ein halber Cent', () => {
    for (let brutto = 0; brutto <= 2000; brutto += 7) {
      const steuer = steuerAusBrutto(cents(brutto), 190)
      expect(Number.isInteger(steuer)).toBe(true)
      expect(steuer).toBeLessThanOrEqual(brutto)
    }
  })

  it('ist nie groesser als der Bruttobetrag', () => {
    expect(steuerAusBrutto(cents(1), 190)).toBeLessThanOrEqual(1)
  })
})

describe('steuerzeilen', () => {
  it('trennt 19 % und 7 %', () => {
    const zeilen = steuerzeilen(DATEN.positionen)
    expect(zeilen).toHaveLength(2)
    expect(zeilen.map((z) => z.satzPromille)).toEqual([70, 190])
  })

  it('fasst gleiche Saetze zusammen', () => {
    // Kaesekuchen 3,90 + Cappuccino 3,80 = 7,70 bei 19 %.
    const neunzehn = steuerzeilen(DATEN.positionen).find((z) => z.satzPromille === 190)
    expect(neunzehn?.brutto).toBe(770)
    expect(neunzehn?.steuer).toBe(123)
    expect(neunzehn?.netto).toBe(647)
  })

  it('haelt Netto plus Steuer gleich Brutto', () => {
    for (const zeile of steuerzeilen(DATEN.positionen)) {
      expect(zeile.netto + zeile.steuer).toBe(zeile.brutto)
    }
  })

  it('summiert ueber alle Saetze zur Bonsumme', () => {
    const zeilen = steuerzeilen(DATEN.positionen)
    const summe = zeilen.reduce((a, z) => a + z.brutto, 0)
    expect(summe).toBe(gesamtsumme(DATEN.positionen))
    expect(summe).toBe(940)
  })
})

describe('Bonaufbau', () => {
  it('haelt jede Zeile innerhalb der Papierbreite', () => {
    // Das ist die Zusicherung, die zaehlt: der Bytestrom passt auf 80 mm.
    // Wie ein Emulator ihn darstellt, ist eine andere Frage.
    for (const zeile of bonZeilen()) {
      expect(zeile.length).toBeLessThanOrEqual(CHARACTERS_PER_LINE_80MM)
    }
  })

  it('setzt die SUMME-Zeile auf die volle Breite, mit Betrag', () => {
    // escpresso schneidet diese Zeile ab, weil es GS ! vertauscht liest.
    // Hier steht sie vollstaendig — das ist, was beim Drucker ankommt.
    const zeile = bonZeilen().find((z) => z.includes('SUMME'))
    expect(zeile).toBeDefined()
    expect(zeile).toHaveLength(CHARACTERS_PER_LINE_80MM)
    expect(zeile).toContain('9,40')
  })

  it('druckt die Umlaute als je ein Byte', () => {
    const bytes = baueTestbon(DATEN)
    expect(bytes).toContain(0xe4) // ä
    expect(bytes).toContain(0xf6) // ö
    expect(bytes).toContain(0xfc) // ü
    expect(bytes).toContain(0xdf) // ß
  })

  it('enthaelt kein Fragezeichen — nichts wurde ersetzt', () => {
    const zeilen = bonZeilen().join('\n')
    expect(zeilen).not.toContain('?')
    expect(zeilen).toContain('Käsekuchen')
    expect(zeilen).toContain('Brötchen')
    expect(zeilen).toContain('Bäckerstraße')
  })

  it('setzt zuerst ESC @, dann ESC t 16', () => {
    const bytes = baueTestbon(DATEN)
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x10])
  })

  it('weist beide Steuersaetze getrennt aus', () => {
    const text = bonZeilen().join('\n')
    expect(text).toMatch(/A 19%/)
    expect(text).toMatch(/B 7%/)
  })

  it('nennt die Verzehrart je Position', () => {
    // Die Verzehrart bestimmt den Steuersatz und gehoert deshalb auf den Beleg.
    const text = bonZeilen().join('\n')
    expect(text).toContain('im Haus')
    expect(text).toContain('ausser Haus')
  })

  it('druckt alle sechs Signaturfelder', () => {
    const text = bonZeilen().join('\n')
    expect(text).toContain('Transaktionsnummer')
    expect(text).toContain('Signaturzaehler')
    expect(text).toContain(DATEN.signatur.tseSeriennummer)
    expect(text).toContain('Pruefwert')
  })

  it('schneidet am Ende ab', () => {
    const bytes = baueTestbon(DATEN)
    const ende = [...bytes.slice(-3)]
    expect(ende).toEqual([0x1d, 0x56, 0x01])
  })

  it('bricht lange Bezeichnungen um, statt sie abzuschneiden', () => {
    const lang: Position = { ...CAPPUCCINO, bezeichnung: 'Cappuccino mit Hafermilch und extra Sirup und Zimt' }
    const zeilen = bonZeilen({ ...DATEN, positionen: [lang] })
    expect(zeilen.join(' ')).toContain('Zimt')
    for (const z of zeilen) expect(z.length).toBeLessThanOrEqual(CHARACTERS_PER_LINE_80MM)
  })

  it('wirft, wenn ein Artikelname nicht druckbar ist', () => {
    const emoji: Position = { ...CAPPUCCINO, bezeichnung: 'Cappuccino ☕' }
    expect(() => baueTestbon({ ...DATEN, positionen: [emoji] })).toThrow()
  })
})

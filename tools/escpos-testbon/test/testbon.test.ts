import { describe, expect, it } from 'vitest'

import { type Cents, cents } from '@bonbon/core'
import { CHARACTERS_PER_LINE_80MM, analyseLines, findOverlongLines } from '@bonbon/ports'

import {
  type Betriebsdaten,
  type Position,
  type Signaturdaten,
  SignaturPasstNichtError,
  type Vorgangsdaten,
  abschliessen,
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
  verzehrart: 'außer Haus',
}

const BETRIEB: Betriebsdaten = {
  betrieb: 'Café Sonnenblume',
  strasse: 'Bäckerstraße 12',
  ort: '66111 Saarbrücken',
  steuernummer: '040/123/45678',
}

const VORGANG: Vorgangsdaten = {
  belegnummer: 'ftC#T4',
  zeitpunkt: '21.08.2026 18:58',
  kasse: 'BONBON-DEV-001',
  positionen: [KAESEKUCHEN, CAPPUCCINO, BROETCHEN],
}

/** Echte Signatur aus dem Rundlauf: 19 % 7,70 / 7 % 1,70 / Zahlbetrag 9,40. */
const SIGNATUR: Signaturdaten = {
  transaktionsnummer: '4',
  signaturzaehler: '8',
  startzeit: '2026-08-21T18:58:12.878Z',
  logzeit: '2026-08-21T18:58:13.000Z',
  signatur: 'AgECBgkEAH8ABwMHAQGAEUZpbmlzaFRyYW5zYWN0aW9u',
  tseSeriennummer: 'a0a5ba77-0c80-4095-b915-e1d63e698b2f',
  pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8',
}

/**
 * Erzeugt eine Signatur, die zu diesen Positionen passt.
 *
 * Noetig, weil `abschliessen()` eine fremde Signatur ablehnt — was genau der
 * Sinn der Sache ist. Tests, die den Warenkorb veraendern, brauchen deshalb
 * eine mitgezogene Signatur. Fuer den echten Warenkorb liefert der Helfer
 * denselben Pruefwert wie die aufgezeichnete Signatur.
 */
function signaturFuer(positionen: readonly Position[]): Signaturdaten {
  const nachSatz = new Map(steuerzeilen(positionen).map((z) => [z.satzPromille, z.brutto]))
  const punkt = (betrag: Cents): string => euro(betrag).replace(',', '.')
  const ust19 = punkt(nachSatz.get(190) ?? cents(0))
  const ust7 = punkt(nachSatz.get(70) ?? cents(0))
  const gesamt = punkt(gesamtsumme(positionen))
  return {
    ...SIGNATUR,
    pruefwert:
      'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^' +
      ust19 +
      '_' +
      ust7 +
      '_0.00_0.00_0.00^' +
      gesamt +
      ':Bar;4;8',
  }
}

function bon(
  positionen: readonly Position[] = VORGANG.positionen,
  signatur: Signaturdaten = signaturFuer(positionen),
): Uint8Array {
  return baueTestbon(BETRIEB, abschliessen({ ...VORGANG, positionen }, signatur))
}

/** Der Bon als Zeilen, wie der Drucker sie setzen wuerde. */
function bonZeilen(positionen?: readonly Position[]): string[] {
  return analyseLines(bon(positionen), CHARACTERS_PER_LINE_80MM).map((z) => z.text)
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
    const zeilen = steuerzeilen(VORGANG.positionen)
    expect(zeilen).toHaveLength(2)
    expect(zeilen.map((z) => z.satzPromille)).toEqual([70, 190])
  })

  it('fasst gleiche Saetze zusammen', () => {
    // Kaesekuchen 3,90 + Cappuccino 3,80 = 7,70 bei 19 %.
    const neunzehn = steuerzeilen(VORGANG.positionen).find((z) => z.satzPromille === 190)
    expect(neunzehn?.brutto).toBe(770)
    expect(neunzehn?.steuer).toBe(123)
    expect(neunzehn?.netto).toBe(647)
  })

  it('haelt Netto plus Steuer gleich Brutto', () => {
    for (const zeile of steuerzeilen(VORGANG.positionen)) {
      expect(zeile.netto + zeile.steuer).toBe(zeile.brutto)
    }
  })

  it('summiert ueber alle Saetze zur Bonsumme', () => {
    const zeilen = steuerzeilen(VORGANG.positionen)
    const summe = zeilen.reduce((a, z) => a + z.brutto, 0)
    expect(summe).toBe(gesamtsumme(VORGANG.positionen))
    expect(summe).toBe(940)
  })
})

describe('Bonaufbau', () => {
  it('haelt JEDE Zeile innerhalb der fuer ihren Schriftmodus gueltigen Breite', () => {
    // Der Kern der Zusicherung. Normal 48 Zeichen, doppelte Breite 24.
    // Gegen eine feste 48 zu pruefen war genau der Fehler, durch den der
    // Gesamtbetrag neben dem Papier landete.
    const zuBreit = findOverlongLines(bon(), CHARACTERS_PER_LINE_80MM)
    expect(
      zuBreit.map((z) => z.index + ': ' + JSON.stringify(z.text) + ' (max ' + String(z.maxCharacters) + ')'),
    ).toEqual([])
  })

  it('setzt die Summenzeile in doppelter Breite auf 24 Zeichen, mit Betrag', () => {
    const zeile = analyseLines(bon(), CHARACTERS_PER_LINE_80MM).find((z) => z.text.includes('SUMME'))
    expect(zeile).toBeDefined()
    expect(zeile?.widthMultiplier).toBe(2)
    expect(zeile?.maxCharacters).toBe(24)
    expect(zeile?.text).toHaveLength(24)
    expect(zeile?.text).toContain('9,40')
  })

  it('richtet den Betrag am rechten Papierrand aus, nicht an Spalte 48', () => {
    const zeile = analyseLines(bon(), CHARACTERS_PER_LINE_80MM).find((z) => z.text.includes('SUMME'))
    // Der Betrag steht am Ende der Zeile, also am Papierrand.
    expect(zeile?.text.endsWith('9,40')).toBe(true)
  })

  it('druckt die Umlaute als je ein Byte', () => {
    const bytes = bon()
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
    const bytes = bon()
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
    expect(text).toContain('außer Haus')
  })

  it('druckt alle sechs Signaturfelder', () => {
    const text = bonZeilen().join('\n')
    expect(text).toContain('Transaktionsnummer')
    expect(text).toContain('Signaturzähler')
    expect(text).toContain(SIGNATUR.tseSeriennummer)
    expect(text).toContain('Prüfwert')
  })

  it('schneidet am Ende ab', () => {
    const bytes = bon()
    const ende = [...bytes.slice(-3)]
    expect(ende).toEqual([0x1d, 0x56, 0x01])
  })

  it('bricht lange Bezeichnungen um, statt sie abzuschneiden', () => {
    const lang: Position = { ...CAPPUCCINO, bezeichnung: 'Cappuccino mit Hafermilch und extra Sirup und Zimt' }
    const zeilen = bonZeilen([lang])
    expect(zeilen.join(' ')).toContain('Zimt')
    for (const z of zeilen) expect(z.length).toBeLessThanOrEqual(CHARACTERS_PER_LINE_80MM)
  })

  it('wirft, wenn ein Artikelname nicht druckbar ist', () => {
    const emoji: Position = { ...CAPPUCCINO, bezeichnung: 'Cappuccino ☕' }
    expect(() => bon([emoji])).toThrow()
  })
})

describe('Umlaute in den festen Beschriftungen', () => {
  it('schreibt Rückgeld, außer Haus und für Ihren Besuch mit echten Umlauten', () => {
    const text = bonZeilen().join('\n')
    expect(text).toContain('Rückgeld')
    expect(text).toContain('außer Haus')
    expect(text).toContain('für Ihren Besuch')
    expect(text).toContain('Signaturzähler')
    expect(text).toContain('Prüfwert')
  })

  it('enthaelt keine Behelfsschreibweise mehr', () => {
    const text = bonZeilen().join('\n')
    for (const behelf of ['Rueckgeld', 'ausser Haus', 'fuer Ihren', 'Signaturzaehler', 'Pruefwert']) {
      expect(text).not.toContain(behelf)
    }
  })

  it('kodiert das Eszett auf 0xDF — es liegt woanders als die Umlaute', () => {
    const bytes = bon()
    expect(bytes).toContain(0xdf) // ß in außer Haus und Bäckerstraße
    expect(bytes).toContain(0xe4) // ä
    expect(bytes).toContain(0xf6) // ö
    expect(bytes).toContain(0xfc) // ü
    expect(bytes).toContain(0xe9) // é in Café
    expect(bytes).toContain(0xe0) // à in "à 3,90"
  })

  it('bringt jeden Umlaut unveraendert durch den ganzen Bon', () => {
    const text = bonZeilen().join('\n')
    for (const wort of ['Café', 'Bäckerstraße', 'Saarbrücken', 'Käsekuchen', 'Brötchen']) {
      expect(text).toContain(wort)
    }
  })
})

describe('abschliessen — die Signatur muss zum Vorgang gehoeren (Regel 14)', () => {
  it('nimmt die passende Signatur an', () => {
    expect(() => abschliessen(VORGANG, SIGNATUR)).not.toThrow()
  })

  it('weist die Signatur eines anderen Vorgangs ab', () => {
    // Genau der Fall, der vorher auf dem Bon stand: die Signatur des einzelnen
    // Cappuccinos unter einem Beleg ueber 9,40.
    const fremd: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^3.80_0.00_0.00_0.00_0.00^3.80:Bar;4;8',
    }
    expect(() => abschliessen(VORGANG, fremd)).toThrow(SignaturPasstNichtError)
  })

  it('nennt die Abweichung im Klartext', () => {
    const fremd: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^3.80_0.00_0.00_0.00_0.00^3.80:Bar;4;8',
    }
    try {
      abschliessen(VORGANG, fremd)
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      const e = fehler as SignaturPasstNichtError
      expect(e.message).toContain('Zahlbetrag')
      expect(e.message).toContain('9,40')
      expect(e.message).toContain('3,80')
      expect(e.message).toContain('Regel 14')
    }
  })

  it('merkt, wenn nur ein Steuersatz nicht stimmt', () => {
    const verdreht: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^1.70_7.70_0.00_0.00_0.00^9.40:Bar;4;8',
    }
    expect(() => abschliessen(VORGANG, verdreht)).toThrow(/19 %|7 %/)
  })

  it('merkt eine fremde Kasse', () => {
    const andereKasse: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;ANDERE-KASSE;Kassenbeleg-V1;Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8',
    }
    expect(() => abschliessen(VORGANG, andereKasse)).toThrow(/Kasse/)
  })

  it('merkt einen abweichenden Signaturzaehler', () => {
    const verschoben: Signaturdaten = { ...SIGNATUR, signaturzaehler: '99' }
    expect(() => abschliessen(VORGANG, verschoben)).toThrow(/Signaturzähler/)
  })

  it('weist einen unlesbaren Pruefwert ab, statt ihn durchzuwinken', () => {
    const kaputt: Signaturdaten = { ...SIGNATUR, pruefwert: 'irgendwas' }
    expect(() => abschliessen(VORGANG, kaputt)).toThrow(/nicht lesen/)
  })

  it('weist einen leeren Pruefwert ab', () => {
    const leer: Signaturdaten = { ...SIGNATUR, pruefwert: '' }
    expect(() => abschliessen(VORGANG, leer)).toThrow(SignaturPasstNichtError)
  })
})

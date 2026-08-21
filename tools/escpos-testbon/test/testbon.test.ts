import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { type Cents, cents, steuerAusBrutto } from '@bonbon/core'
import {
  CHARACTERS_PER_LINE_80MM,
  EscPosReceiptRenderer,
  analyseLines,
  euroText,
  findOverlongLines,
  zeitpunktText,
} from '@bonbon/ports'

import {
  type Betriebsdaten,
  type Signaturdaten,
  SignaturPasstNichtError,
  type Vorgangsdaten,
  type Warenkorbposition,
  abschliessen,
  gesamtsumme,
  steuerzeilen,
  zeilensumme,
} from '../src/testbon.js'

const HIER = dirname(fileURLToPath(import.meta.url))

const KAESEKUCHEN: Warenkorbposition = {
  menge: 1,
  bezeichnung: 'Käsekuchen',
  einzelpreis: cents(390),
  steuersatzPromille: 190,
  verzehrart: 'im-haus',
}

const CAPPUCCINO: Warenkorbposition = {
  menge: 1,
  bezeichnung: 'Cappuccino mit Hafermilch',
  einzelpreis: cents(380),
  steuersatzPromille: 190,
  verzehrart: 'im-haus',
}

const BROETCHEN: Warenkorbposition = {
  menge: 2,
  bezeichnung: 'Brötchen',
  einzelpreis: cents(85),
  steuersatzPromille: 70,
  verzehrart: 'ausser-haus',
}

const BETRIEB: Betriebsdaten = {
  name: 'Café Sonnenblume',
  strasse: 'Bäckerstraße 12',
  postleitzahl: '66111',
  ort: 'Saarbrücken',
  steuernummer: '040/123/45678',
}

const VORGANG: Vorgangsdaten = {
  belegnummer: 'ftC#T4',
  zeitpunkt: '2026-08-21T18:58:12+02:00',
  kasse: 'BONBON-DEV-001',
  positionen: [KAESEKUCHEN, CAPPUCCINO, BROETCHEN],
}

/** Echte Signatur aus dem Rundlauf: 19 % 7,70 / 7 % 1,70 / Zahlbetrag 9,40. */
const SIGNATUR: Signaturdaten = {
  transaktionsnummer: '4',
  signaturzaehler: '8',
  startzeit: '2026-08-21T18:58:12.878Z',
  logzeit: '2026-08-21T18:58:13.000Z',
  signatur:
    'AgECBgkEAH8ABwMHAQGAEUZpbmlzaFRyYW5zYWN0aW9ugQ5CT05CT04tREVWLTAwMYInQmVsZWdeNy43MF8xLjcwXzAuMDBfMC4wMF8wLjAwXjkuNDA6QmFygw5LYXNzZW5iZWxlZy1WMYUBAAQgiIgRERFMKIRLhUheNbK2wFzKK2cZJ53Xf4TemZmZmZkwDAYKBAB/AAcBAQQBAwIBCBcNMjYwODIxMTg1ODEyWg==',
  seriennummer: 'a0a5ba77-0c80-4095-b915-e1d63e698b2f',
  pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8',
}

/**
 * Erzeugt eine Signatur, die zu diesen Positionen passt.
 *
 * Noetig, weil `abschliessen()` eine fremde Signatur ablehnt — was genau der
 * Sinn der Sache ist.
 */
function signaturFuer(positionen: readonly Warenkorbposition[]): Signaturdaten {
  const nachSatz = new Map(steuerzeilen(positionen).map((z) => [z.steuersatzPromille, z.brutto]))
  const punkt = (betrag: Cents): string => euroText(betrag).replace(',', '.')
  return {
    ...SIGNATUR,
    pruefwert:
      'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^' +
      punkt(nachSatz.get(190) ?? cents(0)) +
      '_' +
      punkt(nachSatz.get(70) ?? cents(0)) +
      '_0.00_0.00_0.00^' +
      punkt(gesamtsumme(positionen)) +
      ':Bar;4;8',
  }
}

function bon(
  positionen: readonly Warenkorbposition[] = VORGANG.positionen,
  signatur: Signaturdaten = signaturFuer(positionen),
): Uint8Array {
  return new EscPosReceiptRenderer().render(
    abschliessen(BETRIEB, { ...VORGANG, positionen }, signatur),
  )
}

function bonZeilen(positionen?: readonly Warenkorbposition[]): string[] {
  return analyseLines(bon(positionen), CHARACTERS_PER_LINE_80MM).map((z) => z.text)
}

// ---------------------------------------------------------------------------

describe('Der Umbau hat nichts an der Ausgabe geaendert', () => {
  it('erzeugt Byte fuer Byte denselben Bon wie vor der Trennung', () => {
    // Die Referenz wurde vor dem Umbau aufgenommen, als Belegaufbau und
    // Darstellung noch eine Einheit waren. Sie ist der Nachweis, dass die
    // Trennung in Datensatz und Renderer (Regel 16) ein Umbau war und keine
    // Neuentwicklung.
    //
    // Schlaegt dieser Test fehl, wurde die Darstellung geaendert — dann
    // gehoert die Referenz neu aufgenommen, mit einem Satz im Commit, was
    // sich geaendert hat und warum.
    const referenz = new Uint8Array(readFileSync(join(HIER, 'fixtures', 'testbon-referenz.bin')))
    const neu = bon(VORGANG.positionen, SIGNATUR)

    expect(neu.length).toBe(referenz.length)
    expect(createHash('sha256').update(neu).digest('hex')).toBe(
      createHash('sha256').update(referenz).digest('hex'),
    )
  })
})

describe('euroText', () => {
  it('rechnet Cent nach Euro', () => {
    expect(euroText(cents(390))).toBe('3,90')
    expect(euroText(cents(5))).toBe('0,05')
    expect(euroText(cents(0))).toBe('0,00')
    expect(euroText(cents(123456))).toBe('1234,56')
  })

  it('stellt negative Betraege dar', () => {
    expect(euroText(cents(-390))).toBe('-3,90')
  })
})

describe('zeitpunktText', () => {
  it('macht aus ISO 8601 die Anzeige auf dem Beleg', () => {
    expect(zeitpunktText('2026-08-21T18:58:12+02:00')).toBe('21.08.2026 18:58')
  })

  it('rechnet NICHT in die Zeitzone der Maschine um', () => {
    // Mit `new Date(...)` stuende hier je nach Rechner eine andere Uhrzeit.
    // Der Zeitstempel traegt seinen Offset selbst; die Wanduhrzeit steht
    // woertlich drin (Regel 11).
    expect(zeitpunktText('2026-08-21T18:58:12+02:00')).toBe('21.08.2026 18:58')
    expect(zeitpunktText('2026-08-21T18:58:12Z')).toBe('21.08.2026 18:58')
    expect(zeitpunktText('2026-08-21T18:58:12-05:00')).toBe('21.08.2026 18:58')
  })
})

describe('Rechnung', () => {
  it('rechnet Menge mal Einzelpreis', () => {
    expect(zeilensumme(BROETCHEN)).toBe(170)
    expect(zeilensumme(KAESEKUCHEN)).toBe(390)
  })

  it('rechnet 19 % und 7 % aus dem Bruttobetrag heraus', () => {
    expect(steuerAusBrutto(cents(770), 190)).toBe(123)
    expect(steuerAusBrutto(cents(170), 70)).toBe(11)
  })

  it('rundet kaufmaennisch, halbe Cent aufwaerts', () => {
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

  it('trennt 19 % und 7 % und sortiert aufsteigend', () => {
    expect(steuerzeilen(VORGANG.positionen).map((z) => z.steuersatzPromille)).toEqual([70, 190])
  })

  it('haelt Netto plus Steuer gleich Brutto', () => {
    for (const zeile of steuerzeilen(VORGANG.positionen)) {
      expect(zeile.netto + zeile.steuer).toBe(zeile.brutto)
    }
  })

  it('summiert ueber alle Saetze zur Bonsumme', () => {
    const summe = steuerzeilen(VORGANG.positionen).reduce((a, z) => a + z.brutto, 0)
    expect(summe).toBe(gesamtsumme(VORGANG.positionen))
    expect(summe).toBe(940)
  })
})

describe('Der Belegdatensatz enthaelt keine Darstellung (Regel 16)', () => {
  it('haelt Betraege als Cents, nicht als Zeichenkette', () => {
    const beleg = abschliessen(BETRIEB, VORGANG, SIGNATUR)
    expect(typeof beleg.gesamtbetrag).toBe('number')
    expect(beleg.gesamtbetrag).toBe(940)
    for (const p of beleg.positionen) {
      expect(typeof p.einzelpreis).toBe('number')
      expect(typeof p.gesamtpreis).toBe('number')
    }
  })

  it('haelt den Zeitpunkt als ISO 8601 mit Offset, nicht als Anzeige', () => {
    expect(abschliessen(BETRIEB, VORGANG, SIGNATUR).zeitpunkt).toBe('2026-08-21T18:58:12+02:00')
  })

  it('haelt den Steuersatz als Promille-Ganzzahl', () => {
    const beleg = abschliessen(BETRIEB, VORGANG, SIGNATUR)
    expect(beleg.positionen[0]?.steuersatzPromille).toBe(190)
    expect(beleg.steuerausweis[0]?.steuersatzPromille).toBe(70)
  })

  it('enthaelt nirgends einen Zeilenumbruch oder eine Euro-Darstellung', () => {
    // Der Datensatz muss sich 2028 in ein unbekanntes Format giessen lassen.
    // Formatierte Zeichenketten stuenden dem im Weg.
    const alsText = JSON.stringify(abschliessen(BETRIEB, VORGANG, SIGNATUR))
    expect(alsText).not.toContain('\\n')
    expect(alsText).not.toContain('€')
  })

  it('haelt die Verzehrart je Position fest, nicht nur den Steuersatz', () => {
    // Bei einer Pruefung muss nachvollziehbar sein, WARUM 7 % galten (Regel 4).
    const beleg = abschliessen(BETRIEB, VORGANG, SIGNATUR)
    expect(beleg.positionen.map((p) => p.verzehrart)).toEqual(['im-haus', 'im-haus', 'ausser-haus'])
  })
})

describe('Renderer', () => {
  it('nennt sich escpos', () => {
    expect(new EscPosReceiptRenderer().name).toBe('escpos')
  })

  it('haelt jede Zeile innerhalb der fuer ihren Schriftmodus gueltigen Breite', () => {
    expect(findOverlongLines(bon(), CHARACTERS_PER_LINE_80MM)).toEqual([])
  })

  it('setzt die Summenzeile in doppelter Breite auf 24 Zeichen, mit Betrag', () => {
    const zeile = analyseLines(bon(), CHARACTERS_PER_LINE_80MM).find((z) => z.text.includes('SUMME'))
    expect(zeile?.widthMultiplier).toBe(2)
    expect(zeile?.maxCharacters).toBe(24)
    expect(zeile?.text).toHaveLength(24)
    expect(zeile?.text.endsWith('9,40')).toBe(true)
  })

  it('setzt zuerst ESC @, dann ESC t 16', () => {
    expect([...bon().slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x10])
  })

  it('schneidet am Ende ab', () => {
    expect([...bon().slice(-3)]).toEqual([0x1d, 0x56, 0x01])
  })

  it('druckt die Umlaute als je ein Byte', () => {
    const bytes = bon()
    expect(bytes).toContain(0xe4) // ä
    expect(bytes).toContain(0xf6) // ö
    expect(bytes).toContain(0xfc) // ü
    expect(bytes).toContain(0xdf) // ß
    expect(bytes).toContain(0xe9) // é
    expect(bytes).toContain(0xe0) // à
  })

  it('schreibt die festen Beschriftungen mit echten Umlauten', () => {
    const text = bonZeilen().join('\n')
    expect(text).toContain('Rückgeld')
    expect(text).toContain('außer Haus')
    expect(text).toContain('für Ihren Besuch')
    expect(text).toContain('Signaturzähler')
    expect(text).toContain('Prüfwert')
    for (const behelf of ['Rueckgeld', 'ausser Haus', 'fuer Ihren', 'Pruefwert']) {
      expect(text).not.toContain(behelf)
    }
  })

  it('weist beide Steuersaetze getrennt aus', () => {
    const text = bonZeilen().join('\n')
    expect(text).toMatch(/A 19%/)
    expect(text).toMatch(/B 7%/)
  })

  it('druckt alle Signaturfelder', () => {
    const text = bonZeilen().join('\n')
    expect(text).toContain('Transaktionsnummer')
    expect(text).toContain(SIGNATUR.seriennummer)
    expect(text).toContain('Prüfwert')
  })

  it('bricht lange Bezeichnungen um, statt sie abzuschneiden', () => {
    const lang: Warenkorbposition = {
      ...CAPPUCCINO,
      bezeichnung: 'Cappuccino mit Hafermilch und extra Sirup und Zimt',
    }
    expect(bonZeilen([lang]).join(' ')).toContain('Zimt')
    expect(findOverlongLines(bon([lang]), CHARACTERS_PER_LINE_80MM)).toEqual([])
  })

  it('wirft, wenn ein Artikelname nicht druckbar ist', () => {
    expect(() => bon([{ ...CAPPUCCINO, bezeichnung: 'Cappuccino ☕' }])).toThrow()
  })

  it('druckt den Ausfallhinweis, wenn keine Signatur vorliegt', () => {
    // Regel 8: bei TSE-Ausfall wird der Verkauf abgeschlossen, der Beleg sagt
    // es aber ausdruecklich, statt die Zeilen wegzulassen.
    const beleg = abschliessen(BETRIEB, VORGANG, SIGNATUR)
    // Das Feld weglassen statt auf undefined setzen: exactOptionalPropertyTypes
    // unterscheidet "nicht vorhanden" von "vorhanden, aber undefined" — und
    // "nicht vorhanden" ist hier gemeint.
    const { signatur: _ohne, ...rumpf } = beleg
    const ohneSignatur = { ...rumpf, signaturAusfall: 'TSE nicht erreichbar' }
    const text = analyseLines(
      new EscPosReceiptRenderer().render(ohneSignatur),
      CHARACTERS_PER_LINE_80MM,
    )
      .map((z) => z.text)
      .join('\n')
    expect(text).toContain('nicht erstellt werden')
    expect(text).toContain('TSE nicht erreichbar')
    expect(text).toContain('Nachsignierung')
  })
})

describe('abschliessen — die Signatur muss zum Vorgang gehoeren (Regel 14)', () => {
  it('nimmt die passende Signatur an', () => {
    expect(() => abschliessen(BETRIEB, VORGANG, SIGNATUR)).not.toThrow()
  })

  it('weist die Signatur eines anderen Vorgangs ab', () => {
    const fremd: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^3.80_0.00_0.00_0.00_0.00^3.80:Bar;4;8',
    }
    expect(() => abschliessen(BETRIEB, VORGANG, fremd)).toThrow(SignaturPasstNichtError)
  })

  it('nennt die Abweichung im Klartext', () => {
    const fremd: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^3.80_0.00_0.00_0.00_0.00^3.80:Bar;4;8',
    }
    try {
      abschliessen(BETRIEB, VORGANG, fremd)
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      const e = fehler as SignaturPasstNichtError
      expect(e.message).toContain('Zahlbetrag')
      expect(e.message).toContain('9,40')
      expect(e.message).toContain('Regel 14')
    }
  })

  it('merkt, wenn nur ein Steuersatz nicht stimmt', () => {
    const verdreht: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;BONBON-DEV-001;Kassenbeleg-V1;Beleg^1.70_7.70_0.00_0.00_0.00^9.40:Bar;4;8',
    }
    expect(() => abschliessen(BETRIEB, VORGANG, verdreht)).toThrow(/19 %|7 %/)
  })

  it('merkt eine fremde Kasse', () => {
    const andere: Signaturdaten = {
      ...SIGNATUR,
      pruefwert: 'V0;ANDERE-KASSE;Kassenbeleg-V1;Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8',
    }
    expect(() => abschliessen(BETRIEB, VORGANG, andere)).toThrow(/Kasse/)
  })

  it('merkt einen abweichenden Signaturzaehler', () => {
    expect(() => abschliessen(BETRIEB, VORGANG, { ...SIGNATUR, signaturzaehler: '99' })).toThrow(
      /Signaturzähler/,
    )
  })

  it('weist einen unlesbaren Pruefwert ab, statt ihn durchzuwinken', () => {
    expect(() => abschliessen(BETRIEB, VORGANG, { ...SIGNATUR, pruefwert: 'irgendwas' })).toThrow(
      /nicht lesen/,
    )
  })
})

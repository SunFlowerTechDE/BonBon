import { describe, expect, it } from 'vitest'

import {
  CODE_PAGE_WPC1252,
  UnsupportedCharacterError,
  encodeWpc1252,
  isPrintable,
  simplifyForReceipt,
} from '../src/index.js'

/** Bytes lesbar machen, damit ein Fehlschlag sofort zeigt, was passiert ist. */
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

describe('Codepage-Wahl', () => {
  it('ist WPC1252, also n = 16', () => {
    // TM-T20 ESC/POS Quick Reference: 0 = PC437, 16 = WPC1252, 19 = PC858.
    expect(CODE_PAGE_WPC1252).toBe(16)
  })
})

describe('deutsche Umlaute', () => {
  it('kodiert die Kleinbuchstaben auf die richtigen Bytes', () => {
    expect(hex(encodeWpc1252('äöü'))).toBe('E4 F6 FC')
  })

  it('kodiert die Grossbuchstaben auf die richtigen Bytes', () => {
    expect(hex(encodeWpc1252('ÄÖÜ'))).toBe('C4 D6 DC')
  })

  it('kodiert das scharfe S', () => {
    expect(hex(encodeWpc1252('ß'))).toBe('DF')
  })

  it('kodiert Kaesekuchen vollstaendig', () => {
    // Genau das Wort, an dem es am echten Geraet schiefgeht.
    expect(hex(encodeWpc1252('Käsekuchen'))).toBe('4B E4 73 65 6B 75 63 68 65 6E')
  })

  it('macht aus keinem Umlaut ein Fragezeichen', () => {
    const bytes = encodeWpc1252('Käse')
    expect([...bytes]).not.toContain(0x3f) // '?'
  })

  it('bleibt bei Umlauten gleich lang wie der Text', () => {
    // Ein Byte je Zeichen — kein UTF-8, bei dem 'ä' zwei Bytes waere.
    expect(encodeWpc1252('Käse').length).toBe(4)
    expect(new TextEncoder().encode('Käse').length).toBe(5)
  })
})

describe('Eurozeichen', () => {
  it('liegt in WPC1252 auf 0x80', () => {
    expect(hex(encodeWpc1252('€'))).toBe('80')
  })

  it('wird von latin1 falsch kodiert — deshalb der eigene Kodierer', () => {
    // Buffer.from('€', 'latin1') macht daraus 0xAC. Das waere auf dem Beleg
    // ein Nicht-Zeichen. Der Test haelt fest, warum wir latin1 nicht nehmen.
    expect(Buffer.from('€', 'latin1')[0]).toBe(0xac)
    expect(encodeWpc1252('€')[0]).toBe(0x80)
  })
})

describe('ASCII', () => {
  it('bleibt unveraendert', () => {
    expect(hex(encodeWpc1252('Bon 12'))).toBe('42 6F 6E 20 31 32')
  })

  it('laesst den Zeilenvorschub durch', () => {
    expect(hex(encodeWpc1252('a\nb'))).toBe('61 0A 62')
  })
})

describe('nicht darstellbare Zeichen', () => {
  it('wirft, statt still ein Fragezeichen zu drucken', () => {
    expect(() => encodeWpc1252('Bon ☕')).toThrow(UnsupportedCharacterError)
  })

  it('nennt Zeichen, Codepoint und Position', () => {
    try {
      encodeWpc1252('Kaffee ☕ heiss')
      expect.unreachable('haette werfen muessen')
    } catch (fehler) {
      expect(fehler).toBeInstanceOf(UnsupportedCharacterError)
      const e = fehler as UnsupportedCharacterError
      expect(e.character).toBe('☕')
      expect(e.codePoint).toBe(0x2615)
      expect(e.index).toBe(7)
      expect(e.message).toContain('U+2615')
    }
  })

  it('weist auch kyrillische und chinesische Zeichen ab', () => {
    expect(() => encodeWpc1252('Привет')).toThrow(UnsupportedCharacterError)
    expect(() => encodeWpc1252('咖啡')).toThrow(UnsupportedCharacterError)
  })
})

describe('isPrintable', () => {
  it('kennt die deutschen Zeichen', () => {
    for (const z of 'äöüÄÖÜß€') expect(isPrintable(z)).toBe(true)
  })

  it('lehnt ab, was der Drucker nicht kann', () => {
    for (const z of '☕☺→') expect(isPrintable(z)).toBe(false)
  })
})

describe('simplifyForReceipt', () => {
  it('ersetzt typografische Zeichen durch druckbare', () => {
    expect(simplifyForReceipt('„Café“ – Test…')).toBe('"Café" - Test...')
  })

  it('laesst Umlaute in Ruhe', () => {
    expect(simplifyForReceipt('Käsekuchen')).toBe('Käsekuchen')
  })

  it('macht das Ergebnis druckbar', () => {
    expect(() => encodeWpc1252(simplifyForReceipt('„Tagesgericht“ – 5,50 €'))).not.toThrow()
  })
})

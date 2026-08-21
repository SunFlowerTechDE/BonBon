import { describe, expect, it } from 'vitest'

import {
  CHARACTERS_PER_LINE_80MM,
  CODE_PAGE_WPC1252,
  EscPosBuilder,
  MockPrinter,
  beginJob,
  cashDrawerPulse,
  cut,
  initialize,
  selectCodePage,
  textSize,
  wrap,
} from '../src/index.js'

const hex = (bytes: readonly number[] | Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

describe('Papierbreite', () => {
  it('sind 48 Zeichen bei 80 mm', () => {
    // TM-m30III TRG: 48/35 column mode ist die Werkseinstellung, Font A = 48.
    expect(CHARACTERS_PER_LINE_80MM).toBe(48)
  })
})

describe('Einzelbefehle', () => {
  it('ESC @ setzt zurueck', () => {
    expect(hex(initialize())).toBe('1B 40')
  })

  it('ESC t 16 waehlt WPC1252', () => {
    expect(hex(selectCodePage(CODE_PAGE_WPC1252))).toBe('1B 74 10')
  })

  it('GS V 1 schneidet teilweise', () => {
    expect(hex(cut(1))).toBe('1D 56 01')
  })

  it('GS ! setzt die Zeichengroesse nach Epson-Belegung', () => {
    // Epson: obere 4 Bit = Breite, untere 4 Bit = Hoehe.
    expect(hex(textSize(1, 1))).toBe('1D 21 00')
    expect(hex(textSize(2, 2))).toBe('1D 21 11')
    expect(hex(textSize(2, 1))).toBe('1D 21 10') // doppelt breit, einfach hoch
    expect(hex(textSize(1, 2))).toBe('1D 21 01') // einfach breit, doppelt hoch
  })

  it('haelt die Belegung fest, weil escpresso sie vertauscht liest', () => {
    // Der Emulator rechnet width aus den UNTEREN Bits. Dieser Test pinnt die
    // Epson-Belegung fest, damit niemand den Bon "passend zur Vorschau" dreht.
    const hoch = textSize(1, 2)[2] as number
    const breit = textSize(2, 1)[2] as number
    expect(hoch & 0x0f).toBe(1) // Hoehe steckt unten
    expect((hoch >> 4) & 0x0f).toBe(0)
    expect(breit & 0x0f).toBe(0)
    expect((breit >> 4) & 0x0f).toBe(1) // Breite steckt oben
  })
})

describe('Kassenladen-Impuls', () => {
  it('ist ESC p mit Pin 2 und 100 ms', () => {
    // ESC p m t1 t2, Einheiten zu 2 ms -> 50 = 100 ms.
    expect(hex(cashDrawerPulse())).toBe('1B 70 00 32 32')
  })

  it('kann Pin 5 ansteuern', () => {
    expect(hex(cashDrawerPulse(1))).toBe('1B 70 01 32 32')
  })
})

describe('beginJob', () => {
  it('setzt erst zurueck, dann die Codepage', () => {
    // Die Reihenfolge ist entscheidend: ESC @ setzt die Codepage auf PC437
    // zurueck. Umgekehrt waeren alle Umlaute kaputt.
    const bytes = beginJob(new EscPosBuilder()).build()
    expect(hex(bytes)).toBe('1B 40 1B 74 10')
  })

  it('steht am Anfang jedes Auftrags', () => {
    const bytes = beginJob(new EscPosBuilder()).line('Käse').build()
    expect(hex(bytes.slice(0, 5))).toBe('1B 40 1B 74 10')
    expect(hex(bytes.slice(5))).toBe('4B E4 73 65 0A')
  })
})

describe('EscPosBuilder', () => {
  it('setzt zwei Spalten auf die volle Breite', () => {
    const b = new EscPosBuilder(20)
    b.columns('Cappuccino', '3,80')
    const text = Buffer.from(b.build()).toString('latin1')
    expect(text).toBe('Cappuccino      3,80\n')
    // Die Zeile nutzt die volle Breite aus, sonst stuende der Betrag nicht
    // buendig am rechten Rand.
    expect(text.trimEnd().length).toBe(20)
  })

  it('fuellt mit Punkten, wenn gewuenscht', () => {
    const b = new EscPosBuilder(20)
    b.columns('Summe', '9,99', '.')
    expect(Buffer.from(b.build()).toString('latin1')).toBe('Summe...........9,99\n')
  })

  it('schneidet lange Bezeichnungen nicht ab, sondern bricht um', () => {
    // Ein halber Artikelname auf dem Beleg waere Datenverlust.
    const b = new EscPosBuilder(20)
    b.columns('Cappuccino mit Hafermilch extra gross', '4,20')
    const zeilen = Buffer.from(b.build()).toString('latin1').trimEnd().split('\n')
    expect(zeilen.join(' ')).toContain('Hafermilch')
    expect(zeilen.join(' ')).toContain('4,20')
    for (const z of zeilen) expect(z.length).toBeLessThanOrEqual(20)
  })

  it('zieht die Trennlinie ueber die volle Breite', () => {
    const b = new EscPosBuilder(10)
    b.rule()
    expect(Buffer.from(b.build()).toString('latin1')).toBe('----------\n')
  })

  it('wirft bei einem Zeichen, das der Drucker nicht kann', () => {
    expect(() => new EscPosBuilder().line('Espresso ☕')).toThrow()
  })
})

describe('wrap', () => {
  it('bricht an Leerzeichen um', () => {
    expect(wrap('eins zwei drei vier', 10)).toEqual(['eins zwei', 'drei vier'])
  })

  it('trennt zu lange Einzelwoerter hart', () => {
    expect(wrap('Donaudampfschifffahrt', 8)).toEqual(['Donaudam', 'pfschiff', 'fahrt'])
  })

  it('haelt jede Zeile innerhalb der Breite', () => {
    for (const z of wrap('Cappuccino mit Hafermilch und extra Sirup', 12)) {
      expect(z.length).toBeLessThanOrEqual(12)
    }
  })

  it('erhaelt vorhandene Umbrueche', () => {
    expect(wrap('a\nb', 10)).toEqual(['a', 'b'])
  })
})

describe('MockPrinter — er muss kaputtgehen koennen', () => {
  it('nimmt im Normalfall an', async () => {
    const p = new MockPrinter()
    await p.print(Uint8Array.from([1, 2, 3]))
    expect(p.jobs).toHaveLength(1)
  })

  it('weist die Verbindung ab', async () => {
    const p = new MockPrinter({ failure: { kind: 'refused' } })
    await expect(p.print(Uint8Array.from([1]))).rejects.toThrow(/abgewiesen/)
    expect(await p.isReachable()).toBe(false)
  })

  it('laeuft in die Zeitueberschreitung', async () => {
    const p = new MockPrinter({ failure: { kind: 'timeout', afterMs: 3000 } })
    await expect(p.print(Uint8Array.from([1]))).rejects.toThrow(/Zeitueberschreitung/)
  })

  it('meldet fehlendes Papier', async () => {
    const p = new MockPrinter({ failure: { kind: 'outOfPaper' } })
    await expect(p.print(Uint8Array.from([1]))).rejects.toThrow(/Kein Papier/)
  })

  it('bricht mitten im Auftrag ab und behaelt den halben Bon', async () => {
    // Der unangenehmste Fall: der Kunde hat einen halben Beleg in der Hand.
    const p = new MockPrinter({ failure: { kind: 'partialWrite', bytesWritten: 2 } })
    await expect(p.print(Uint8Array.from([1, 2, 3, 4, 5]))).rejects.toThrow(/2 von 5 Bytes/)
    expect(p.jobs[0]).toHaveLength(2)
  })

  it('laesst sich zur Laufzeit umschalten', async () => {
    const p = new MockPrinter()
    await p.print(Uint8Array.from([1]))
    p.setFailure({ kind: 'outOfPaper' })
    await expect(p.print(Uint8Array.from([2]))).rejects.toThrow()
    p.setFailure({ kind: 'none' })
    await p.print(Uint8Array.from([3]))
    expect(p.jobs).toHaveLength(2)
  })

  it('zaehlt die Kassenladen-Impulse', async () => {
    const p = new MockPrinter()
    await p.openCashDrawer()
    await p.openCashDrawer()
    expect(p.drawerOpenCount).toBe(2)
  })

  it('oeffnet die Lade nicht, wenn der Drucker weg ist', async () => {
    const p = new MockPrinter({ failure: { kind: 'refused' } })
    await expect(p.openCashDrawer()).rejects.toThrow()
    expect(p.drawerOpenCount).toBe(0)
  })

  it('gibt den gedruckten Text zum Nachpruefen zurueck', async () => {
    const p = new MockPrinter()
    await p.print(beginJob(new EscPosBuilder()).line('Käsekuchen').build())
    expect(p.decodedJobs()[0]).toContain('Käsekuchen')
  })
})

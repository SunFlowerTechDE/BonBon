import { describe, expect, it } from 'vitest'

import { type Clock, type IdGenerator, type IsoTimestamp, isoTimestamp } from '../src/index.js'

describe('isoTimestamp()', () => {
  it('nimmt ISO 8601 mit numerischem Offset an', () => {
    expect(isoTimestamp('2026-08-21T10:15:00+02:00')).toBe('2026-08-21T10:15:00+02:00')
    expect(isoTimestamp('2026-01-15T09:00:00-05:00')).toBe('2026-01-15T09:00:00-05:00')
  })

  it('nimmt Z als Zonenangabe an', () => {
    expect(isoTimestamp('2026-08-21T08:15:00Z')).toBe('2026-08-21T08:15:00Z')
  })

  it('nimmt Sekundenbruchteile an', () => {
    expect(isoTimestamp('2026-08-21T10:15:00.123+02:00')).toBe('2026-08-21T10:15:00.123+02:00')
  })

  it('weist Ortszeit ohne Offset ab', () => {
    // Der Kern trifft keine Annahme ueber die lokale Zeitzone (Regel 11).
    expect(() => isoTimestamp('2026-08-21T10:15:00')).toThrow(RangeError)
    expect(() => isoTimestamp('2026-08-21T10:15:00')).toThrow(/Regel 11/)
  })

  it('weist ein reines Datum ab', () => {
    expect(() => isoTimestamp('2026-08-21')).toThrow(RangeError)
  })

  it('weist Nicht-ISO-Formate ab', () => {
    expect(() => isoTimestamp('21.08.2026 10:15')).toThrow(RangeError)
    expect(() => isoTimestamp('')).toThrow(RangeError)
    expect(() => isoTimestamp('irgendwas')).toThrow(RangeError)
  })

  it('weist Kalendertage ab, die es nicht gibt, statt sie weiterzurollen', () => {
    // Date.parse akzeptiert das und macht daraus den 2. Maerz.
    expect(() => isoTimestamp('2026-02-30T10:00:00Z')).toThrow(RangeError)
    expect(() => isoTimestamp('2026-04-31T10:00:00Z')).toThrow(RangeError)
    expect(() => isoTimestamp('2026-13-01T10:00:00Z')).toThrow(RangeError)
    expect(() => isoTimestamp('2026-00-10T10:00:00Z')).toThrow(RangeError)
  })

  it('kennt Schaltjahre', () => {
    expect(isoTimestamp('2024-02-29T10:00:00Z')).toBe('2024-02-29T10:00:00Z')
    expect(() => isoTimestamp('2026-02-29T10:00:00Z')).toThrow(RangeError)
    expect(isoTimestamp('2000-02-29T10:00:00Z')).toBe('2000-02-29T10:00:00Z')
    expect(() => isoTimestamp('1900-02-29T10:00:00Z')).toThrow(RangeError)
  })

  it('weist unmoegliche Uhrzeiten ab', () => {
    expect(() => isoTimestamp('2026-08-21T24:00:00Z')).toThrow(RangeError)
    expect(() => isoTimestamp('2026-08-21T10:60:00Z')).toThrow(RangeError)
  })

  it('laesst die Schaltsekunde zu', () => {
    expect(isoTimestamp('2026-12-31T23:59:60Z')).toBe('2026-12-31T23:59:60Z')
  })

  it('haelt fest, dass Date die Schaltsekunde NICHT kennt', () => {
    // Dieser Test dokumentiert eine bekannte Luecke, er deckt sie nicht ab:
    // IsoTimestamp ist absichtlich weiter als Date. 2016-12-31T23:59:60Z war
    // eine echte Schaltsekunde.
    const schaltsekunde = isoTimestamp('2016-12-31T23:59:60Z')
    expect(Number.isNaN(Date.parse(schaltsekunde))).toBe(true)

    // Wer IsoTimestamp nach Date umwandelt, muss den Fall behandeln.
    // Die beiden zulaessigen Wege — ablehnen oder auf :59.999 normalisieren:
    const normalisiert = schaltsekunde.replace(':60', ':59.999')
    expect(Number.isNaN(Date.parse(normalisiert))).toBe(false)
    expect(new Date(Date.parse(normalisiert)).toISOString()).toBe('2016-12-31T23:59:59.999Z')
  })

  it('Sekunden oberhalb der Schaltsekunde bleiben ungueltig', () => {
    expect(() => isoTimestamp('2026-12-31T23:59:61Z')).toThrow(RangeError)
  })

  it('nennt den fehlerhaften Wert in der Meldung', () => {
    expect(() => isoTimestamp('21.08.2026')).toThrow(/21\.08\.2026/)
  })
})

describe('Clock und IdGenerator sind injizierbar', () => {
  it('eine feste Uhr macht den Kern deterministisch testbar', () => {
    const festeUhr: Clock = {
      now: () => isoTimestamp('2026-08-21T10:15:00+02:00'),
    }
    expect(festeUhr.now()).toBe('2026-08-21T10:15:00+02:00')
    expect(festeUhr.now()).toBe(festeUhr.now())
  })

  it('ein abzaehlender Generator ersetzt echte ULIDs im Test', () => {
    let n = 0
    const generator: IdGenerator = {
      next: () => `test-${String(++n)}`,
    }
    expect(generator.next()).toBe('test-1')
    expect(generator.next()).toBe('test-2')
  })

  it('IsoTimestamp bleibt ein String zur Laufzeit', () => {
    const t: IsoTimestamp = isoTimestamp('2026-08-21T10:15:00+02:00')
    expect(typeof t).toBe('string')
  })
})

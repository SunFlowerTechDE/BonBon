import { describe, expect, it } from 'vitest'

import {
  type ChainedEvent,
  GENESIS_HASH,
  type Hasher,
  type SaleEvent,
  chainEvent,
  eventHashInput,
  hashEvent,
  isoTimestamp,
  verifyChain,
} from '../src/index.js'

/**
 * Ein deterministischer Test-Hasher.
 *
 * Kein SHA-256 — der Kern kennt keine Hashfunktion (Regel 11), und fuer die
 * Kettenlogik ist nur wichtig, dass gleiche Eingabe gleiche Ausgabe ergibt und
 * verschiedene Eingaben verschiedene. FNV-1a reicht dafuer und laeuft ohne
 * jede Abhaengigkeit.
 */
const testHasher: Hasher = {
  hash: (input: string): string => {
    let h1 = 0x811c9dc5
    let h2 = 0x01000193
    for (let i = 0; i < input.length; i += 1) {
      h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0
      h2 = Math.imul(h2 + input.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4)
  },
}

function ereignis(seq: number, ueberschreiben: Partial<SaleEvent> = {}): SaleEvent {
  return {
    id: 'EVT-' + String(seq).padStart(4, '0'),
    deviceId: 'KASSE-01',
    seq,
    occurredAt: isoTimestamp('2026-08-21T10:00:00+02:00'),
    type: 'PositionHinzugefuegt',
    payload: JSON.stringify({ artikel: 'Cappuccino', betragCent: 380 }),
    ...ueberschreiben,
  }
}

/** Baut eine gueltige Kette der Laenge n. */
function kette(n: number): ChainedEvent[] {
  const ergebnis: ChainedEvent[] = []
  let vorher = GENESIS_HASH
  for (let i = 1; i <= n; i += 1) {
    const verkettet = chainEvent(vorher, ereignis(i), testHasher)
    ergebnis.push(verkettet)
    vorher = verkettet.hash
  }
  return ergebnis
}

describe('eventHashInput', () => {
  it('ist fuer dieselben Daten immer gleich', () => {
    expect(eventHashInput(GENESIS_HASH, ereignis(1))).toBe(eventHashInput(GENESIS_HASH, ereignis(1)))
  })

  it('aendert sich, wenn sich der Vorgaengerhash aendert', () => {
    expect(eventHashInput(GENESIS_HASH, ereignis(1))).not.toBe(
      eventHashInput('a'.repeat(64), ereignis(1)),
    )
  })

  it('aendert sich bei jedem Feld', () => {
    const basis = eventHashInput(GENESIS_HASH, ereignis(1))
    for (const abweichung of [
      { id: 'ANDERS' },
      { deviceId: 'KASSE-02' },
      { seq: 2 },
      { type: 'BonAbgeschlossen' },
      { payload: '{}' },
    ] as Partial<SaleEvent>[]) {
      expect(eventHashInput(GENESIS_HASH, ereignis(1, abweichung))).not.toBe(basis)
    }
  })

  it('laesst sich nicht durch Verschieben zwischen Feldern austricksen', () => {
    // Ohne Laengenpraefix waere type="a"+payload="bc" dasselbe wie
    // type="ab"+payload="c". Genau das soll die Kodierung verhindern.
    const a = eventHashInput(GENESIS_HASH, ereignis(1, { type: 'a', payload: 'bc' }))
    const b = eventHashInput(GENESIS_HASH, ereignis(1, { type: 'ab', payload: 'c' }))
    expect(a).not.toBe(b)
  })

  it('praefigiert jedes Feld mit seiner Laenge', () => {
    const eingabe = eventHashInput(GENESIS_HASH, ereignis(1, { type: 'ab', payload: 'c' }))
    expect(eingabe).toContain('2:ab')
    expect(eingabe).toContain('1:c')
  })
})

describe('GENESIS_HASH', () => {
  it('hat dieselbe Laenge wie ein SHA-256-Hex', () => {
    // Damit jede Zeile dieselbe Form hat und der Kettenanfang nicht durch ein
    // leeres Feld gekennzeichnet ist, das jemand versehentlich erzeugt.
    expect(GENESIS_HASH).toHaveLength(64)
    expect(GENESIS_HASH).toMatch(/^0+$/)
  })
})

describe('verifyChain — heile Kette', () => {
  it('nimmt eine gueltige Kette an', () => {
    const ergebnis = verifyChain(kette(50), testHasher)
    expect(ergebnis.ok).toBe(true)
    expect(ergebnis.checked).toBe(50)
    expect(ergebnis.problems).toEqual([])
  })

  it('nimmt eine leere Kette an', () => {
    expect(verifyChain([], testHasher).ok).toBe(true)
  })

  it('nimmt ein einzelnes Ereignis an', () => {
    expect(verifyChain(kette(1), testHasher).ok).toBe(true)
  })
})

describe('verifyChain — Manipulationen', () => {
  it('findet ein nachtraeglich veraendertes Ereignis und nennt die Stelle', () => {
    const k = kette(20)
    const veraendert = [...k]
    veraendert[9] = { ...(k[9] as ChainedEvent), payload: JSON.stringify({ betragCent: 1 }) }

    const ergebnis = verifyChain(veraendert, testHasher)
    expect(ergebnis.ok).toBe(false)
    const treffer = ergebnis.problems.find((p) => p.kind === 'hash-mismatch')
    expect(treffer).toBeDefined()
    expect(treffer?.seq).toBe(10)
    expect(treffer?.eventId).toBe('EVT-0010')
    expect(treffer?.detail).toContain('nachtraeglich veraendert')
  })

  it('findet ein entferntes Ereignis', () => {
    const k = kette(20)
    const ohne = [...k.slice(0, 9), ...k.slice(10)]

    const ergebnis = verifyChain(ohne, testHasher)
    expect(ergebnis.ok).toBe(false)
    const luecke = ergebnis.problems.find((p) => p.kind === 'sequence-gap')
    expect(luecke).toBeDefined()
    expect(luecke?.seq).toBe(11)
    expect(luecke?.detail).toContain('es fehlen 1')
  })

  it('meldet beim entfernten Ereignis auch die zerschnittene Kette', () => {
    const k = kette(20)
    const ohne = [...k.slice(0, 9), ...k.slice(10)]
    const arten = verifyChain(ohne, testHasher).problems.map((p) => p.kind)
    expect(arten).toContain('sequence-gap')
    expect(arten).toContain('prev-hash-mismatch')
  })

  it('findet ein doppeltes Ereignis', () => {
    const k = kette(10)
    const doppelt = [...k.slice(0, 5), k[4] as ChainedEvent, ...k.slice(5)]
    const arten = verifyChain(doppelt, testHasher).problems.map((p) => p.kind)
    expect(arten).toContain('sequence-duplicate')
  })

  it('findet ein eingeschobenes Ereignis', () => {
    const k = kette(10)
    const fremd = chainEvent(GENESIS_HASH, ereignis(6, { id: 'EINGESCHOBEN' }), testHasher)
    const manipuliert = [...k.slice(0, 5), fremd, ...k.slice(5)]
    expect(verifyChain(manipuliert, testHasher).ok).toBe(false)
  })

  it('findet eine Kette, die nicht am Anfang beginnt', () => {
    const k = kette(10)
    const abgeschnitten = k.slice(3)
    const ergebnis = verifyChain(abgeschnitten, testHasher)
    expect(ergebnis.ok).toBe(false)
    expect(ergebnis.problems.map((p) => p.kind)).toContain('sequence-gap')
  })

  it('zaehlt alle Fundstellen auf, statt beim ersten aufzuhoeren', () => {
    // Bei einer Kassennachschau ist die Frage nicht nur ob, sondern wo und
    // wie oft.
    const k = kette(30)
    const veraendert = [...k]
    veraendert[4] = { ...(k[4] as ChainedEvent), payload: 'x' }
    veraendert[14] = { ...(k[14] as ChainedEvent), payload: 'y' }
    veraendert[24] = { ...(k[24] as ChainedEvent), payload: 'z' }

    const treffer = verifyChain(veraendert, testHasher).problems.filter(
      (p) => p.kind === 'hash-mismatch',
    )
    expect(treffer.map((p) => p.seq)).toEqual([5, 15, 25])
  })

  it('merkt, wenn jemand Hash UND Inhalt passend faelscht, aber die Kette bricht', () => {
    // Der raffiniertere Angriff: das Ereignis wird veraendert und der Hash neu
    // berechnet. Dann stimmt zwar die Zeile, aber der Nachfolger zeigt noch
    // auf den alten Hash.
    const k = kette(10)
    const gefaelscht = chainEvent(
      k[4]?.prevHash as string,
      ereignis(5, { payload: JSON.stringify({ betragCent: 1 }) }),
      testHasher,
    )
    const manipuliert = [...k.slice(0, 4), gefaelscht, ...k.slice(5)]

    const ergebnis = verifyChain(manipuliert, testHasher)
    expect(ergebnis.ok).toBe(false)
    const bruch = ergebnis.problems.find((p) => p.kind === 'prev-hash-mismatch')
    expect(bruch?.seq).toBe(6)
  })
})

describe('chainEvent', () => {
  it('setzt den Vorgaengerhash und berechnet den eigenen', () => {
    const e = chainEvent(GENESIS_HASH, ereignis(1), testHasher)
    expect(e.prevHash).toBe(GENESIS_HASH)
    expect(e.hash).toBe(hashEvent(GENESIS_HASH, ereignis(1), testHasher))
  })

  it('verknuepft aufeinanderfolgende Ereignisse', () => {
    const k = kette(3)
    expect(k[1]?.prevHash).toBe(k[0]?.hash)
    expect(k[2]?.prevHash).toBe(k[1]?.hash)
  })
})

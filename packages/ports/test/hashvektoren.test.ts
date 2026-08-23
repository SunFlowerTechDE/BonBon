import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { eventHashInput, type SaleEvent } from '@bonbon/core'

/**
 * Gemeinsame Testvektoren mit dem Rust-Teil.
 *
 * Beide Seiten lesen dieselbe Datei. Ein festgeschriebener Wert im Rust-Test
 * haette gehalten, waere aber stillschweigend gedriftet, sobald jemand dem
 * Ereignis ein Feld hinzufuegt — die Rust-Fassung waere gruen geblieben,
 * waehrend die Ketten auseinanderlaufen.
 *
 * **Warum der Test nicht in `@bonbon/core` liegt.** Er muss die Vektordatei
 * lesen und braucht dafuer `node:fs`. In `packages/core` ist jeder
 * `node:`-Import gesperrt, und zwar bewusst auch in Tests: die Aussage „der
 * Kern laeuft in jeder Laufzeit" soll ohne Ausnahme gelten. Die Regel dafuer
 * aufzuweichen waere der teurere Weg gewesen — geprueft wird ohnehin nur
 * `eventHashInput`, und das laesst sich von hier genauso aufrufen.
 */
interface Vektor {
  readonly name: string
  readonly prevHash: string
  readonly ereignis: SaleEvent
  readonly eingabe: string
}

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const datei = JSON.parse(
  readFileSync(join(WURZEL, 'testvektoren', 'hash-eingabe.json'), 'utf8'),
) as { vektoren: Vektor[] }

describe('Hash-Eingabe gegen die gemeinsamen Testvektoren', () => {
  it('hat Vektoren', () => {
    expect(datei.vektoren.length).toBeGreaterThan(0)
  })

  for (const vektor of datei.vektoren) {
    it('stimmt fuer: ' + vektor.name, () => {
      expect(eventHashInput(vektor.prevHash, vektor.ereignis)).toBe(vektor.eingabe)
    })
  }

  it('haelt die Verschiebefalle auseinander', () => {
    const a = datei.vektoren.find((v) => v.name === 'Verschiebefalle a')
    const b = datei.vektoren.find((v) => v.name === 'Verschiebefalle b')
    expect(a?.eingabe).not.toBe(b?.eingabe)
  })
})

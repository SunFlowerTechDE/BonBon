/**
 * Der Einstiegspunkt `@bonbon/ports` muss im Webview laufen.
 *
 * Vorher stand im Kopf von `index.ts` ein Satz, der genau das sagte — und
 * `TcpPrinter` wurde trotzdem von dort exportiert. Der Bundler liest keine
 * Kommentare: er zog `node:net` in das Webview-Buendel, und der Bau der
 * Anwendung brach ab. Gemerkt hat es niemand, bis zum ersten echten Bau.
 *
 * Diese Pruefung ersetzt den Kommentar durch etwas, das fehlschlagen kann.
 * Sie geht die Importe ab `src/index.ts` rekursiv durch und verlangt: keine
 * `node:`-Module, keine fremden Pakete ausser `@bonbon/core`.
 *
 * Der zweite Test ist genauso wichtig: er weist nach, dass die Pruefung
 * ueberhaupt anschlaegt. `src/node.ts` **muss** `node:net` erreichen. Faende
 * die Pruefung dort nichts, waere sie im ersten Test wertlos und wuerde still
 * gruen bleiben.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const QUELLE = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

/** Erlaubt im Webview: der Kern ist selbst frei von Laufzeitabhaengigkeiten. */
const ERLAUBTE_PAKETE = new Set(['@bonbon/core'])

/**
 * Sammelt alle fremden Modulnamen, die von `einstieg` aus erreichbar sind.
 *
 * Bewusst auf der Quelle statt auf `dist`: so schlaegt die Pruefung an, bevor
 * gebaut wird, und braucht keinen vorherigen Bauschritt.
 */
function fremdeModule(einstieg: string): Set<string> {
  const gefunden = new Set<string>()
  const gesehen = new Set<string>()
  const offen = [resolve(QUELLE, einstieg)]

  while (offen.length > 0) {
    const datei = offen.pop()
    if (datei === undefined || gesehen.has(datei)) continue
    gesehen.add(datei)

    const text = readFileSync(datei, 'utf8')
    // `from '...'` deckt Import und Re-Export ab; beide ziehen das Modul mit.
    for (const treffer of text.matchAll(/from\s+'([^']+)'/g)) {
      const ziel = treffer[1]
      if (ziel === undefined) continue
      if (ziel.startsWith('.')) {
        // TypeScript schreibt die Endung `.js`, die Quelle heisst `.ts`.
        offen.push(resolve(dirname(datei), ziel.replace(/\.js$/, '.ts')))
      } else {
        gefunden.add(ziel)
      }
    }
  }
  return gefunden
}

describe('@bonbon/ports als Webview-Einstiegspunkt', () => {
  it('erreicht kein `node:`-Modul', () => {
    const module = [...fremdeModule('index.ts')]
    expect(module.filter((m) => m.startsWith('node:'))).toEqual([])
  })

  it('erreicht ausser dem Kern kein fremdes Paket', () => {
    const module = [...fremdeModule('index.ts')].filter((m) => !ERLAUBTE_PAKETE.has(m))
    expect(module).toEqual([])
  })
})

describe('@bonbon/ports/node', () => {
  it('erreicht `node:net` — sonst koennte die Pruefung oben nichts finden', () => {
    expect([...fremdeModule('node.ts')]).toContain('node:net')
  })
})

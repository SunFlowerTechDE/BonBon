/**
 * Holt Poppins nach `apps/desktop/public/schriften/`.
 *
 * Die Schriftdateien liegen **im Repository**, nicht im Netz. Zwei Gruende:
 * die CSP der Anwendung erlaubt nur `self`, und die Einrichtung im Laden
 * passiert oft ohne verlaessliches WLAN (CLAUDE.md, Umgebung). Eine Kasse,
 * deren Schrift beim ersten Start nachgeladen werden muesste, sieht im Laden
 * anders aus als beim Entwickeln — oder gar nicht.
 *
 * Dieses Werkzeug wird also **nicht** beim Bauen aufgerufen. Es dient dazu,
 * den Stand nachvollziehbar zu erneuern, wenn es einen Grund dafuer gibt.
 * Danach gehoeren die `unicode-range`-Angaben in `stil.css` abgeglichen: sie
 * stammen aus derselben Antwort und muessen zu den geholten Dateien passen.
 *
 * Geholt werden nur `latin` und `latin-ext`. Deutsch liegt vollstaendig in
 * `latin` (auch ä, ö, ü, ß und €); `latin-ext` kommt fuer Namen aus den
 * Nachbarsprachen dazu und kostet 5 kB je Schnitt. Devanagari, das Poppins
 * ebenfalls mitbringt, braucht eine Kasse im Saarland nicht.
 *
 * Lizenz: SIL Open Font License 1.1. `OFL.txt` liegt neben den Dateien und
 * muss dort bleiben — die Lizenz verlangt, dass sie mitgeliefert wird.
 *
 * Aufruf:
 *   node werkzeuge/schriften-holen.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ZIEL = resolve(process.cwd(), 'apps/desktop/public/schriften')
const SCHNITTE = [400, 500, 600, 700]
const SUBSETS = new Set(['latin', 'latin-ext'])

// Google Fonts liefert je nach User-Agent andere Formate aus. Ohne einen
// modernen Agent kommen `ttf`-Verweise statt `woff2` zurueck.
const AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function hole(url) {
  const antwort = await fetch(url, { headers: { 'User-Agent': AGENT } })
  if (!antwort.ok) throw new Error(`${url}: HTTP ${antwort.status}`)
  return antwort
}

async function main() {
  mkdirSync(ZIEL, { recursive: true })

  const css = await (
    await hole(
      `https://fonts.googleapis.com/css2?family=Poppins:wght@${SCHNITTE.join(';')}&display=swap`,
    )
  ).text()

  // Die Antwort ist eine Folge aus Kommentar (das Subset) und @font-face-Regel.
  const geholt = []
  for (const block of css.split('/*').slice(1)) {
    const subset = block.slice(0, block.indexOf('*/')).trim()
    if (!SUBSETS.has(subset)) continue

    const gewicht = /font-weight:\s*(\d+)/.exec(block)?.[1]
    const url = /url\((https:[^)]+)\)/.exec(block)?.[1]
    const bereich = /unicode-range:\s*([^;]+);/.exec(block)?.[1]
    if (!gewicht || !url || !bereich) {
      throw new Error(`Unerwarteter Block fuer Subset ${subset}`)
    }

    const name = `poppins-${gewicht}-${subset}.woff2`
    const daten = Buffer.from(await (await hole(url)).arrayBuffer())
    writeFileSync(resolve(ZIEL, name), daten)
    geholt.push({ name, gewicht: Number(gewicht), subset, bereich: bereich.trim(), bytes: daten.length })
    console.log(`${name.padEnd(30)} ${String(daten.length).padStart(6)} Bytes`)
  }

  const fehlend = SCHNITTE.filter((g) => !geholt.some((x) => x.gewicht === g))
  if (fehlend.length > 0) throw new Error(`Schnitte fehlen: ${fehlend.join(', ')}`)

  // Die Uebersicht haelt fest, welche `unicode-range` zu welcher Datei gehoert
  // — sonst muesste man sie beim naechsten Mal wieder aus der Antwort fischen.
  writeFileSync(resolve(ZIEL, '_uebersicht.json'), JSON.stringify(geholt, null, 2) + '\n')

  const ofl = await (
    await hole('https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/OFL.txt')
  ).text()
  writeFileSync(resolve(ZIEL, 'OFL.txt'), ofl)

  const gesamt = geholt.reduce((s, g) => s + g.bytes, 0)
  console.log(`\n${geholt.length} Dateien, ${gesamt} Bytes, plus OFL.txt`)
  console.log('Jetzt die unicode-range-Angaben in apps/desktop/src/stil.css abgleichen.')
}

await main()

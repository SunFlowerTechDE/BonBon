/**
 * Die Farbwelt, geprüft — gegen das echte Stylesheet.
 *
 * Eine gepflegte Liste von Farbpaaren im Test wäre wertlos: sie sagt, was
 * jemand einmal aufgeschrieben hat, nicht was die Anwendung malt. Wer morgen
 * `background: #f0f0f0` in `stil.css` schreibt, käme daran vorbei.
 *
 * Deshalb liest dieser Test `stil.css` selbst und verlangt dreierlei:
 *
 *   1. Jeder Farbwert im Stylesheet stammt aus der Palette. Kein Wert nebenbei.
 *   2. Jede Regel, die Schrift **und** Grund zugleich setzt, ist als Fläche in
 *      `farben.ts` eingetragen — neue Kombinationen fallen auf, statt sich
 *      einzuschleichen.
 *   3. Jede Fläche erreicht 4,5:1.
 *
 * Und weil eine Prüfung, die nicht fehlschlagen kann, nichts beweist, prüft
 * der letzte Block die Prüfung selbst: weisse Schrift auf Mint **muss**
 * durchfallen.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FLAECHEN,
  MINDESTKONTRAST,
  MINDESTKONTRAST_GRAFIK,
  PALETTE,
  TSE_ANZEIGE,
  type Farbname,
  kontrast,
} from '../src/farben.js'

const STIL = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/stil.css'),
  'utf8',
)

/** `--mint` → `mint`, `--signal-gut` → `signalGut`. */
function alsFarbname(variable: string): string {
  return variable.replace(/^--/, '').replace(/-([a-z])/g, (_, z: string) => z.toUpperCase())
}

/** Die Custom Properties aus dem `:root`-Block, nur die Farbwerte. */
function farbenAusDemStylesheet(): Map<string, string> {
  const wurzel = /:root\s*\{([\s\S]*?)\n\}/.exec(STIL)?.[1] ?? ''
  const gefunden = new Map<string, string>()
  for (const treffer of wurzel.matchAll(/(--[a-z-]+):\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
    gefunden.set(treffer[1] ?? '', (treffer[2] ?? '').toUpperCase())
  }
  return gefunden
}

describe('Palette und Stylesheet bleiben zusammen', () => {
  it('kennt jede Variable aus dem Stylesheet auch in farben.ts', () => {
    const ausCss = farbenAusDemStylesheet()
    expect(ausCss.size).toBeGreaterThan(0)

    const unbekannt: string[] = []
    for (const [variable, wert] of ausCss) {
      const name = alsFarbname(variable)
      const inTs = (PALETTE as Record<string, string | undefined>)[name]
      if (inTs === undefined || inTs.toUpperCase() !== wert) {
        unbekannt.push(`${variable} = ${wert} (farben.ts: ${inTs ?? 'fehlt'})`)
      }
    }
    expect(unbekannt).toEqual([])
  })

  it('enthaelt keinen Farbwert ausserhalb der Palette', () => {
    // Alle Hexwerte im Stylesheet, ohne den `:root`-Block, in dem sie definiert
    // werden. Alles andere muss ueber `var(--…)` laufen.
    const ohneWurzel = STIL.replace(/:root\s*\{[\s\S]*?\n\}/, '')
    const streuner = [...ohneWurzel.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((t) => t[0])
    expect(streuner).toEqual([])
  })
})

describe('Jede Flaeche ist lesbar', () => {
  it.each(FLAECHEN)('$name: $schrift auf $grund', ({ name, grund, schrift }) => {
    const wert = kontrast(PALETTE[grund], PALETTE[schrift])
    expect(
      wert,
      `${name}: ${schrift} auf ${grund} kommt nur auf ${wert.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(MINDESTKONTRAST)
  })

  it('setzt weisse Schrift nur auf Beere', () => {
    const mitWeiss = FLAECHEN.filter((f) => f.schrift === 'weiss').map((f) => f.grund)
    const erlaubt = new Set<Farbname>(['beere', 'signalGut', 'signalWarnung', 'signalFehler'])
    expect(mitWeiss.filter((g) => !erlaubt.has(g))).toEqual([])
  })

  it('haelt Koralle bei Warnung und Loeschen', () => {
    // Koralle ist keine Aktionsfarbe. Steht sie auf einer Flaeche, deren Zweck
    // nichts mit Warnung oder Loeschen zu tun hat, ist die Rolle aufgeweicht.
    const mitKoralle = FLAECHEN.filter((f) => f.grund === 'koralle')
    for (const f of mitKoralle) {
      expect(f.zweck.toLowerCase()).toMatch(/warn|loesch|fehler/)
    }
  })
})

/**
 * Liest alle Regeln, die Grund und Schrift zugleich setzen.
 *
 * **Grenze dieser Auswertung.** Sie sieht nur Paare, die in *derselben* Regel
 * stehen. Setzt eine Regel den Grund und eine andere die Schrift — wie bei
 * `.punkt` und `.punkt.gut` —, findet sie das Paar nicht; die Kaskade laesst
 * sich ohne Browser nicht nachbilden. Diese drei Flaechen stehen deshalb
 * ausdruecklich in `FLAECHEN` und werden im Block „Zustandsanzeige" geprueft.
 */
function paareAusDemStylesheet(): { selektor: string; paar: string }[] {
  const ohneSonder = STIL.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/:root\s*\{[\s\S]*?\n\}/, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/g, '')

  const gefunden: { selektor: string; paar: string }[] = []
  for (const block of ohneSonder.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const koerper = block[2] ?? ''
    const grund = /(?:^|[;\s])background(?:-color)?:\s*var\((--[a-z-]+)\)/.exec(koerper)?.[1]
    const schrift = /(?:^|[;\s])color:\s*var\((--[a-z-]+)\)/.exec(koerper)?.[1]
    if (grund === undefined || schrift === undefined) continue
    gefunden.push({
      selektor: (block[1] ?? '').trim().replace(/\s+/g, ' '),
      paar: `${alsFarbname(grund)}/${alsFarbname(schrift)}`,
    })
  }
  return gefunden
}

describe('Kombinationen im Stylesheet sind angemeldet', () => {
  it('findet ueberhaupt Paare — sonst prueft der Test daneben nichts', () => {
    // Ohne diese Untergrenze bliebe der Test unten gruen, sobald die
    // Auswertung am Stylesheet vorbeiliest. Der Wert liegt bewusst deutlich
    // unter dem heutigen Stand: er soll einen Totalausfall melden, nicht bei
    // jeder Umgestaltung anschlagen.
    expect(paareAusDemStylesheet().length).toBeGreaterThanOrEqual(15)
  })

  it('kennt jedes Paar aus Grund und Schrift als Flaeche', () => {
    const bekannt = new Set(FLAECHEN.map((f) => `${f.grund}/${f.schrift}`))
    const unangemeldet = paareAusDemStylesheet()
      .filter(({ paar }) => !bekannt.has(paar))
      .map(({ selektor, paar }) => `${selektor} → ${paar}`)
    expect(unangemeldet).toEqual([])
  })
})

describe('Zustandsanzeige', () => {
  it('traegt zu jeder Farbe ein Zeichen und ein Wort', () => {
    for (const [status, anzeige] of Object.entries(TSE_ANZEIGE)) {
      expect(anzeige.zeichen, status).not.toBe('')
      expect(anzeige.wort.length, status).toBeGreaterThan(3)
    }
  })

  it('benutzt keine Markenfarbe als Signal', () => {
    // Sonst waeren dieselben Farben gleichzeitig Auswahl und Alarm.
    const marke = new Set<Farbname>(['mint', 'tuerkis', 'koralle', 'pfirsich', 'beere'])
    for (const anzeige of Object.values(TSE_ANZEIGE)) {
      expect(marke.has(anzeige.farbe)).toBe(false)
    }
  })

  it('unterscheidet die Zustaende auch ohne Farbe', () => {
    const zeichen = Object.values(TSE_ANZEIGE).map((a) => a.zeichen)
    const woerter = Object.values(TSE_ANZEIGE).map((a) => a.wort)
    expect(new Set(zeichen).size).toBe(zeichen.length)
    expect(new Set(woerter).size).toBe(woerter.length)
  })

  it('hebt den Punkt vom Kopf ab (3:1 fuer Grafik)', () => {
    // Der Punkt liegt in der Kopfzeile, die Kopfzeile ist Mint.
    for (const anzeige of Object.values(TSE_ANZEIGE)) {
      const wert = kontrast(PALETTE[anzeige.farbe], PALETTE.mint)
      expect(wert, `${anzeige.wort} auf Mint: ${wert.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MINDESTKONTRAST_GRAFIK,
      )
    }
  })
})

describe('Der Umschalter bleibt erreichbar', () => {
  it('wird im kleinen Zustand kleiner, aber nicht unsichtbar', () => {
    // „Klein" heisst klein, nicht weg: die Verzehrart ist aufzuzeichnen, ob
    // sie den Steuersatz bewegt oder nicht. Ein `display: none` waere hier
    // ein fachlicher Fehler, kein Gestaltungsdetail.
    const regel = /\.verzehrart\.klein button \{([^}]*)\}/.exec(STIL)?.[1] ?? ''
    expect(regel).not.toBe('')
    expect(regel).not.toMatch(/display:\s*none/)
    expect(regel).not.toMatch(/visibility:\s*hidden/)
  })

  it('haelt die Zeilenhoehe fest, damit nichts springt', () => {
    // Ohne feste Hoehe ruckt das Artikelraster hoch, sobald die erste Latte
    // im Bon landet — mitten im Tippen.
    const regel = /\.verzehrart \{([^}]*)\}/.exec(STIL)?.[1] ?? ''
    expect(regel).toMatch(/min-height:/)
  })
})

describe('Die Pruefung kann fehlschlagen', () => {
  it('erkennt weisse Schrift auf Mint als unlesbar', () => {
    // 1,40:1. Ohne diesen Test waere nicht gezeigt, dass die Rechnung oben
    // ueberhaupt etwas ablehnt.
    expect(kontrast(PALETTE.mint, PALETTE.weiss)).toBeLessThan(MINDESTKONTRAST)
  })

  it('erkennt Koralle als Schriftfarbe auf Weiss als unlesbar', () => {
    // 2,48:1 — deshalb ist Koralle im Stylesheet Flaeche und nie Schrift.
    expect(kontrast(PALETTE.weiss, PALETTE.koralle)).toBeLessThan(MINDESTKONTRAST)
  })

  it('rechnet dieselben Werte wie die Vorgabe von WCAG', () => {
    // Zwei bekannte Werte: Schwarz auf Weiss ist 21:1, gleiche Farben sind 1:1.
    expect(kontrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(kontrast('#ABE6CF', '#ABE6CF')).toBeCloseTo(1, 10)
  })
})

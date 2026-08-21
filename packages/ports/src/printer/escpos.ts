/**
 * ESC/POS-Befehle und Bonaufbau.
 *
 * Reine Byte-Erzeugung, kein I/O. Dadurch laesst sich jeder Bon im Test Byte
 * fuer Byte pruefen, ohne dass ein Drucker oder ein Socket im Spiel ist.
 *
 * Alle Befehlssequenzen stammen aus der Epson-Dokumentation, die Fundstelle
 * steht jeweils daneben.
 */

import { CODE_PAGE_WPC1252, encodeWpc1252 } from './codepage.js'

// --- Steuerzeichen ---------------------------------------------------------

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/**
 * Zeichen pro Zeile bei 80 mm Papier.
 *
 * Aus dem TM-m30III Technical Reference Guide: "Column Emulation: 48/35 column
 * mode (standard column mode) (initial setting)", und in der Tabelle
 * "The number of characters" fuer 48/35 column mode, Font A: 48.
 *
 * Der Drucker kann per Einstellung auf 42/32 umgeschaltet werden. Wer das tut,
 * muss diese Konstante mitziehen — deshalb steht sie an einer Stelle und wird
 * nirgends als Zahl wiederholt.
 */
export const CHARACTERS_PER_LINE_80MM = 48

/** 58 mm Papier, Font A, Standard-Spaltenmodus. Fuer spaeter. */
export const CHARACTERS_PER_LINE_58MM = 35

// --- Einzelne Befehle ------------------------------------------------------

/** ESC @ — Drucker zuruecksetzen. Setzt auch die Codepage auf die Werkseinstellung. */
export const initialize = (): number[] => [ESC, 0x40]

/**
 * ESC t n — Codepage waehlen.
 * Gilt bis zum naechsten ESC @, Reset oder Ausschalten. Deshalb gehoert dieser
 * Befehl in jeden Druckauftrag, nicht in eine einmalige Einrichtung.
 */
export const selectCodePage = (n: number): number[] => [ESC, 0x74, n]

/** ESC a n — Ausrichtung: 0 links, 1 zentriert, 2 rechts. */
export const align = (n: 0 | 1 | 2): number[] => [ESC, 0x61, n]

/** ESC E n — Fettdruck an/aus. */
export const bold = (on: boolean): number[] => [ESC, 0x45, on ? 1 : 0]

/** ESC - n — Unterstreichen: 0 aus, 1 einfach, 2 doppelt. */
export const underline = (n: 0 | 1 | 2): number[] => [ESC, 0x2d, n]

/**
 * GS ! n — Zeichengroesse.
 *
 * Epson, TM-T20 ESC/POS Quick Reference:
 *   "Upper 4 bits of n: width magnification
 *    Lower 4 bits of n: height magnification"
 *
 * ACHTUNG beim Testen gegen escpresso: Der Emulator liest die beiden Haelften
 * vertauscht (src/main.rs, GS-Zweig `b'!'`: `width_mul = (mode & 0x07) + 1`,
 * `height_mul = ((mode >> 4) & 0x07) + 1`). Ein spec-konformes `textSize(1, 2)`
 * — doppelte Hoehe, einfache Breite, Byte 0x01 — rendert er deshalb als
 * doppelte *Breite*. Aus 48 Spalten werden dabei 24, und alles rechts davon
 * faellt aus dem Bild.
 *
 * Das ist ein Fehler des Emulators, nicht des Bons. Hier gilt die
 * Epson-Dokumentation; auf einem echten TM-m30III aendert doppelte Hoehe die
 * Zeichenbreite nicht, die Zeile bleibt 48 Zeichen breit. Nicht "reparieren",
 * um die Vorschau huebsch zu machen — sonst ist es am Geraet falsch.
 */
export const textSize = (width: 1 | 2, height: 1 | 2): number[] => [
  GS,
  0x21,
  ((width - 1) << 4) | (height - 1),
]

/** ESC d n — n Zeilen vorschieben. */
export const feed = (lines: number): number[] => [ESC, 0x64, lines]

/** GS V m — Papier schneiden. 0 voll, 1 teilweise. */
export const cut = (mode: 0 | 1 = 1): number[] => [GS, 0x56, mode]

/**
 * ESC p m t1 t2 — Impuls an den Kassenladenanschluss.
 *
 * m  = 0 fuer Pin 2, 1 fuer Pin 5 des Anschlusses.
 * t1 = Impulsdauer, t2 = Pause, jeweils in Einheiten zu 2 ms.
 *
 * 50 und 50 ergeben 100 ms Impuls und 100 ms Pause. Das ist der Wert, den
 * Epson in den Beispielen verwendet und den handelsuebliche Laden sicher
 * ausloesen; zu kurze Impulse oeffnen manche Schloesser nicht.
 */
export const cashDrawerPulse = (pin: 0 | 1 = 0, onTime = 50, offTime = 50): number[] => [
  ESC,
  0x70,
  pin,
  onTime,
  offTime,
]

// --- Aufbau ----------------------------------------------------------------

/**
 * Sammelt Befehle und Text zu einem Druckauftrag.
 *
 * Der Text laeuft immer durch `encodeWpc1252`, das bei einem nicht
 * darstellbaren Zeichen wirft. Ein Bon mit `K?sekuchen` entsteht hier also
 * gar nicht erst.
 */
export class EscPosBuilder {
  private readonly bytes: number[] = []

  constructor(readonly charactersPerLine: number = CHARACTERS_PER_LINE_80MM) {}

  raw(command: readonly number[]): this {
    this.bytes.push(...command)
    return this
  }

  /** Text ohne Zeilenumbruch. */
  text(value: string): this {
    this.bytes.push(...encodeWpc1252(value))
    return this
  }

  /** Text mit Zeilenumbruch. */
  line(value = ''): this {
    return this.text(value).raw([LF])
  }

  /** Eine Trennlinie ueber die volle Breite. */
  rule(character = '-'): this {
    return this.line(character.repeat(this.charactersPerLine))
  }

  /**
   * Zwei Spalten: links buendig, rechts buendig, dazwischen Fuellzeichen.
   * Wird die Zeile zu lang, bricht der linke Teil um — abgeschnitten wird
   * nichts, ein halber Artikelname auf dem Beleg waere Datenverlust.
   */
  columns(left: string, right: string, filler = ' '): this {
    const platz = this.charactersPerLine - right.length
    if (left.length <= platz - 1) {
      const luecke = platz - left.length
      return this.line(left + filler.repeat(Math.max(1, luecke)) + right)
    }
    for (const teil of wrap(left, this.charactersPerLine)) this.line(teil)
    return this.line(right.padStart(this.charactersPerLine))
  }

  centered(value: string): this {
    return this.raw(align(1)).line(value).raw(align(0))
  }

  /** Langen Text auf die Zeilenbreite umbrechen. */
  wrapped(value: string): this {
    for (const teil of wrap(value, this.charactersPerLine)) this.line(teil)
    return this
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }

  get length(): number {
    return this.bytes.length
  }
}

/** Bricht an Leerzeichen um; zu lange Einzelwoerter werden hart getrennt. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) throw new RangeError('Zeilenbreite muss positiv sein')
  const zeilen: string[] = []
  for (const absatz of text.split('\n')) {
    let aktuell = ''
    for (const wort of absatz.split(' ')) {
      let rest = wort
      while (rest.length > width) {
        if (aktuell !== '') {
          zeilen.push(aktuell)
          aktuell = ''
        }
        zeilen.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      if (aktuell === '') {
        aktuell = rest
      } else if (aktuell.length + 1 + rest.length <= width) {
        aktuell += ' ' + rest
      } else {
        zeilen.push(aktuell)
        aktuell = rest
      }
    }
    zeilen.push(aktuell)
  }
  return zeilen
}

/**
 * Kopf jedes Druckauftrags: zuruecksetzen, dann Codepage setzen.
 *
 * Die Reihenfolge ist nicht beliebig — ESC @ setzt die Codepage auf die
 * Werkseinstellung PC437 zurueck. Wer erst die Codepage waehlt und dann
 * zuruecksetzt, druckt in PC437 und bekommt kaputte Umlaute.
 */
export function beginJob(builder: EscPosBuilder): EscPosBuilder {
  return builder.raw(initialize()).raw(selectCodePage(CODE_PAGE_WPC1252))
}

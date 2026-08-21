/**
 * Auswertung eines fertigen Druckauftrags.
 *
 * Liest den Bytestrom zurueck und liefert die Zeilen, die der Drucker setzen
 * wuerde — **mitsamt dem Schriftmodus, der fuer jede Zeile gilt**. Das ist der
 * springende Punkt: bei doppelter Breite passen nur halb so viele Zeichen auf
 * die Zeile. Wer gegen eine feste Zahl prueft, uebersieht genau den Fall, in
 * dem der wichtigste Betrag des Bons neben dem Papier landet.
 *
 * Der Parser ist bewusst unabhaengig vom `EscPosBuilder` geschrieben. Er
 * vertraut dessen Buchfuehrung nicht, sondern liest die Wahrheit aus den Bytes.
 * Damit faellt auf, wenn der Builder seinen Zustand falsch mitfuehrt.
 */

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/**
 * Laenge der Befehle, die dieses Paket erzeugt, jeweils inklusive der
 * Einleitung. Ein unbekannter Befehl wird nicht ueberlesen, sondern gemeldet —
 * sonst verschiebt sich der Parser still und die Zeilenpruefung wird wertlos.
 */
const ESC_COMMAND_LENGTH: ReadonlyMap<number, number> = new Map([
  [0x40, 2], // ESC @        zuruecksetzen
  [0x74, 3], // ESC t n      Codepage
  [0x61, 3], // ESC a n      Ausrichtung
  [0x45, 3], // ESC E n      Fettdruck
  [0x2d, 3], // ESC - n      Unterstreichen
  [0x64, 3], // ESC d n      Vorschub
  [0x21, 3], // ESC ! n      Druckmodus (enthaelt auch die Groesse)
  [0x70, 5], // ESC p m t1 t2  Kassenlade
])

const GS_COMMAND_LENGTH: ReadonlyMap<number, number> = new Map([
  [0x21, 3], // GS ! n       Zeichengroesse
  [0x56, 3], // GS V m       Schnitt
])

export class UnknownCommandError extends Error {
  constructor(
    readonly offset: number,
    readonly bytes: readonly number[],
  ) {
    super(
      'Unbekannte ESC/POS-Sequenz an Offset ' +
        String(offset) +
        ': ' +
        bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') +
        '. Der Parser muss sie kennen, sonst verschiebt sich die Zeilenpruefung.',
    )
    this.name = 'UnknownCommandError'
  }
}

export interface AnalysedLine {
  /** Der Text der Zeile, ohne Steuerzeichen. */
  readonly text: string
  /** Breitenfaktor, der beim Setzen dieser Zeile galt. */
  readonly widthMultiplier: number
  /** Hoehenfaktor — beeinflusst die Zeilenbreite nicht. */
  readonly heightMultiplier: number
  /** Wie viele Zeichen bei diesem Modus auf die Zeile passen. */
  readonly maxCharacters: number
  /** Zeilennummer im Auftrag, ab 0. */
  readonly index: number
}

/**
 * Zerlegt den Auftrag in Zeilen und bestimmt fuer jede den geltenden
 * Schriftmodus.
 *
 * `GS ! n`: obere vier Bit Breite, untere vier Bit Hoehe (Epson).
 * `ESC ! n`: Bit 5 doppelte Breite, Bit 4 doppelte Hoehe.
 */
export function analyseLines(job: Uint8Array, baseCharactersPerLine: number): AnalysedLine[] {
  const zeilen: AnalysedLine[] = []
  let text = ''
  let width = 1
  let height = 1
  let i = 0

  const zeileAbschliessen = (): void => {
    zeilen.push({
      text,
      widthMultiplier: width,
      heightMultiplier: height,
      maxCharacters: Math.floor(baseCharactersPerLine / width),
      index: zeilen.length,
    })
    text = ''
  }

  while (i < job.length) {
    const byte = job[i] as number

    if (byte === LF) {
      zeileAbschliessen()
      i += 1
      continue
    }

    if (byte === ESC || byte === GS) {
      const befehl = job[i + 1]
      const laengen = byte === ESC ? ESC_COMMAND_LENGTH : GS_COMMAND_LENGTH
      const laenge = befehl === undefined ? undefined : laengen.get(befehl)
      if (laenge === undefined) {
        throw new UnknownCommandError(i, [...job.slice(i, i + 4)])
      }

      if (byte === GS && befehl === 0x21) {
        const n = job[i + 2] as number
        width = ((n >> 4) & 0x07) + 1
        height = (n & 0x07) + 1
      } else if (byte === ESC && befehl === 0x21) {
        const n = job[i + 2] as number
        width = (n & 0x20) === 0 ? 1 : 2
        height = (n & 0x10) === 0 ? 1 : 2
      } else if (byte === ESC && befehl === 0x40) {
        // ESC @ setzt auch die Zeichengroesse zurueck.
        width = 1
        height = 1
      }

      i += laenge
      continue
    }

    text += String.fromCharCode(byte)
    i += 1
  }

  if (text !== '') zeileAbschliessen()
  return zeilen
}

/** Nur die Texte, ohne Modusangaben. */
export function previewLines(job: Uint8Array, baseCharactersPerLine = 48): string[] {
  return analyseLines(job, baseCharactersPerLine).map((z) => z.text)
}

/** Entfernt die Steuersequenzen und liefert den reinen Text. */
export function stripCommands(job: Uint8Array, baseCharactersPerLine = 48): string {
  return previewLines(job, baseCharactersPerLine).join('\n')
}

/**
 * Zeilen, die fuer ihren Schriftmodus zu breit sind.
 *
 * Leeres Ergebnis heisst: der Auftrag passt aufs Papier. Diese Funktion ist der
 * Kern der Zusicherung — sie kennt den Unterschied zwischen 48 Zeichen normal
 * und 24 Zeichen in doppelter Breite.
 */
export function findOverlongLines(
  job: Uint8Array,
  baseCharactersPerLine: number,
): AnalysedLine[] {
  return analyseLines(job, baseCharactersPerLine).filter((z) => z.text.length > z.maxCharacters)
}

/**
 * Der Bon in einem Rahmen der Papierbreite, fuer die Konsole.
 *
 * Zeilen in doppelter Breite werden mit gesperrtem Text dargestellt, damit man
 * in der Vorschau sieht, dass sie den doppelten Platz brauchen.
 */
export function previewBox(job: Uint8Array, baseCharactersPerLine: number): string {
  const rand = '+' + '-'.repeat(baseCharactersPerLine + 2) + '+'
  const zeilen = analyseLines(job, baseCharactersPerLine).map((z) => {
    const dargestellt = z.widthMultiplier > 1 ? [...z.text].join(' ') : z.text
    const zuBreit = z.text.length > z.maxCharacters
    const inhalt = dargestellt.padEnd(baseCharactersPerLine).slice(0, baseCharactersPerLine)
    return '| ' + inhalt + ' |' + (zuBreit ? '  <-- ZU BREIT' : '')
  })
  return [rand, ...zeilen, rand].join('\n')
}

/** Rohe Bytes als Hexdump mit ASCII-Spalte. */
export function hexdump(job: Uint8Array): string {
  const zeilen: string[] = []
  for (let i = 0; i < job.length; i += 16) {
    const teil = [...job.slice(i, i + 16)]
    const hex = teil.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
    const txt = teil.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
    zeilen.push(i.toString(16).padStart(6, '0') + '  ' + hex.padEnd(47) + '  ' + txt)
  }
  return zeilen.join('\n')
}

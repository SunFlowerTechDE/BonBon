/**
 * Zeichenkodierung fuer ESC/POS-Drucker.
 *
 * ## Warum WPC1252 (Codepage 16)
 *
 * Der Epson TM-m30III startet laut Technical Reference Guide mit
 * "Default Character Code Page: PC437 (U.S.A., Standard Europe)". PC437 hat
 * zwar Umlaute, aber kein Eurozeichen — und vor allem: die Einstellung geht bei
 * `ESC @`, beim Zuruecksetzen und beim Ausschalten verloren. Die Codepage muss
 * deshalb bei jedem Druckauftrag ausdruecklich gesetzt werden.
 *
 * Gewaehlt ist **WPC1252 (n = 16)**, aus drei Gruenden:
 *
 * 1. Sie enthaelt alle deutschen Zeichen (ä ö ü Ä Ö Ü ß) **und** das Eurozeichen.
 *    PC437 und PC850 haben kein Euro.
 *
 * 2. Im Bereich 0xA0–0xFF ist WPC1252 byteweise identisch mit den
 *    Unicode-Codepoints. `ä` ist U+00E4 und Byte 0xE4. Die Umrechnung ist damit
 *    nachpruefbar, statt eine DOS-Positionstabelle nachschlagen zu muessen —
 *    in PC858 stuende `ä` auf 0x84.
 *
 * 3. Der Emulator escpresso bildet die Codepages 2 (CP850), 16 (WPC1252) und
 *    19 (CP858) **alle** auf Windows-1252 ab (src/main.rs, ESC t). Bei n = 19
 *    zeigt der Emulator also etwas anderes als ein echter Drucker. Nur bei
 *    n = 16 stimmen Emulator und Geraet ueberein. Ein Test gegen escpresso ist
 *    sonst wertlos, weil er den Fehler nicht zeigen kann.
 *
 * Quellen:
 * - TM-m30III Technical Reference Guide, "Default Character Code Page"
 * - TM-T20 ESC/POS Quick Reference, ESC t: 0 = PC437, 16 = WPC1252, 19 = PC858
 *
 * ## Warum nicht einfach latin1
 *
 * WPC1252 und Latin-1 sind identisch, **ausser** im Bereich 0x80–0x9F. Dort hat
 * Latin-1 Steuerzeichen, WPC1252 aber druckbare Zeichen — darunter das
 * Eurozeichen auf 0x80. `Buffer.from(text, 'latin1')` wuerde ein `€` deshalb
 * still zu 0xAC verstuemmeln. Die Abweichungen stehen unten ausdruecklich drin.
 */

/** ESC t n — Codepage 16, WPC1252. */
export const CODE_PAGE_WPC1252 = 16

/**
 * Die Stellen, an denen WPC1252 von Latin-1 abweicht (0x80–0x9F).
 * Alles andere ist deckungsgleich mit dem Unicode-Codepoint.
 */
const WPC1252_SPECIAL: ReadonlyMap<string, number> = new Map([
  ['€', 0x80], // €  Eurozeichen
  ['‚', 0x82], // ‚  einfaches Anfuehrungszeichen unten
  ['ƒ', 0x83], // ƒ
  ['„', 0x84], // „  doppeltes Anfuehrungszeichen unten
  ['…', 0x85], // …  Auslassungspunkte
  ['†', 0x86], // †
  ['‡', 0x87], // ‡
  ['ˆ', 0x88], // ˆ
  ['‰', 0x89], // ‰
  ['Š', 0x8a], // Š
  ['‹', 0x8b], // ‹
  ['Œ', 0x8c], // Œ
  ['Ž', 0x8e], // Ž
  ['‘', 0x91], // '  Apostroph links
  ['’', 0x92], // '  Apostroph rechts
  ['“', 0x93], // "
  ['”', 0x94], // "
  ['•', 0x95], // •
  ['–', 0x96], // –  Halbgeviertstrich
  ['—', 0x97], // —  Geviertstrich
  ['˜', 0x98], // ˜
  ['™', 0x99], // ™
  ['š', 0x9a], // š
  ['›', 0x9b], // ›
  ['œ', 0x9c], // œ
  ['ž', 0x9e], // ž
  ['Ÿ', 0x9f], // Ÿ
])

/**
 * Ein Zeichen, das die Codepage nicht kennt.
 *
 * Der Fehler nennt das Zeichen, seinen Codepoint und die Stelle im Text.
 * Er wird bewusst geworfen statt still ein `?` zu drucken: ein Beleg mit
 * `K?sekuchen` faellt im Alltag niemandem auf, und genau so entstehen die
 * Fehler, die man erst am echten Geraet beim Kunden sieht.
 */
export class UnsupportedCharacterError extends Error {
  constructor(
    readonly character: string,
    readonly codePoint: number,
    readonly index: number,
    readonly text: string,
  ) {
    super(
      'Zeichen ' +
        JSON.stringify(character) +
        ' (U+' +
        codePoint.toString(16).toUpperCase().padStart(4, '0') +
        ') an Position ' +
        String(index) +
        ' gibt es in WPC1252 nicht: ' +
        JSON.stringify(text),
    )
    this.name = 'UnsupportedCharacterError'
  }
}

/** Kann dieses Zeichen in WPC1252 gedruckt werden? */
export function isPrintable(character: string): boolean {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) return false
  if (codePoint === 0x0a) return true // Zeilenvorschub
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true // ASCII
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true // Latin-1-Bereich
  return WPC1252_SPECIAL.has(character)
}

/**
 * Wandelt Text nach WPC1252. Wirft bei jedem Zeichen, das die Codepage nicht
 * darstellen kann — nichts wird still ersetzt.
 */
export function encodeWpc1252(text: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    const codePoint = character.codePointAt(0) as number

    const sonderfall = WPC1252_SPECIAL.get(character)
    if (sonderfall !== undefined) {
      bytes.push(sonderfall)
      continue
    }
    if (codePoint === 0x0a) {
      bytes.push(0x0a)
      continue
    }
    if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      bytes.push(codePoint)
      continue
    }
    throw new UnsupportedCharacterError(character, codePoint, index, text)
  }
  return Uint8Array.from(bytes)
}

/**
 * Ersetzt typografische Zeichen durch solche, die jeder Bondrucker kann.
 *
 * Gedacht fuer Texte aus Fremdquellen (Artikelnamen aus einem Import, Namen
 * aus einer Kundendatenbank). Ausdruecklich aufgerufen, nie automatisch —
 * sonst waere es wieder eine stille Ersetzung.
 */
export function simplifyForReceipt(text: string): string {
  return text
    .replace(/[‘’‛‚]/g, "'")
    .replace(/[“”‟„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // Geschuetztes Leerzeichen (U+00A0) als Escape, nicht als unsichtbares
    // Zeichen im Quelltext — sonst sieht es niemand im Review.
    .replace(/\u00A0/g, ' ')
}

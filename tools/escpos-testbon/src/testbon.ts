/**
 * Aufbau des Testbons.
 *
 * Reine Funktion: Bondaten rein, ESC/POS-Bytes raus. Kein Socket, keine Uhr.
 * Dadurch laesst sich der Bon im Test pruefen, ohne dass ein Drucker laeuft.
 *
 * Die Betraege sind Cents aus @bonbon/core. Nach Euro umgerechnet wird
 * ausschliesslich hier, in der Darstellungsschicht (CLAUDE.md, Regel 3).
 */

import {
  type Cents,
  addCents,
  cents,
  multiplyCents,
  subtractCents,
  sumCents,
} from '@bonbon/core'
import {
  CHARACTERS_PER_LINE_80MM,
  EscPosBuilder,
  align,
  beginJob,
  bold,
  cut,
  feed,
  textSize,
} from '@bonbon/ports'

/** Verzehrart entscheidet ueber 7 % oder 19 % (CLAUDE.md, Regel 4). */
export type Verzehrart = 'im Haus' | 'ausser Haus'

export interface Position {
  readonly menge: number
  readonly bezeichnung: string
  readonly einzelpreis: Cents
  /** Steuersatz in Promille, damit auch 19,0 % ganzzahlig bleibt. */
  readonly steuersatzPromille: number
  readonly verzehrart: Verzehrart
}

export interface Signaturdaten {
  readonly transaktionsnummer: string
  readonly signaturzaehler: string
  readonly startzeit: string
  readonly logzeit: string
  readonly signatur: string
  readonly tseSeriennummer: string
  readonly pruefwert: string
}

export interface Bondaten {
  readonly betrieb: string
  readonly strasse: string
  readonly ort: string
  readonly steuernummer: string
  readonly belegnummer: string
  readonly zeitpunkt: string
  readonly kasse: string
  readonly positionen: readonly Position[]
  readonly signatur: Signaturdaten
}

// --- Darstellung -----------------------------------------------------------

/** Cent nach Euro. Die einzige Stelle, an der das passiert. */
export function euro(betrag: Cents): string {
  const wert: number = betrag
  const negativ = wert < 0
  const abs = negativ ? -wert : wert
  const rest = abs % 100
  const ganz = (abs - rest) / 100
  return (negativ ? '-' : '') + String(ganz) + ',' + String(rest).padStart(2, '0')
}

/** Promille nach Prozent, ohne Fliesskomma. */
export function prozent(promille: number): string {
  const rest = promille % 10
  const ganz = (promille - rest) / 10
  return rest === 0 ? String(ganz) : String(ganz) + ',' + String(rest)
}

// --- Rechnung --------------------------------------------------------------

export function zeilensumme(position: Position): Cents {
  return multiplyCents(position.einzelpreis, position.menge)
}

/**
 * Herausrechnen der Umsatzsteuer aus einem Bruttobetrag.
 *
 * Bewusst mit einer benannten Rundungsregel: kaufmaennisch, halbe Cent aufwaerts.
 * Gerechnet wird ausschliesslich in Ganzzahlen.
 *
 *   Steuer = brutto * satz / (1000 + satz)
 *
 * Hinweis fuer M1: Diese Funktion gehoert spaeter nach @bonbon/core, zusammen
 * mit den uebrigen Rundungsregeln und Property-based Tests. Hier steht sie nur,
 * damit der Testbon einen Steuerausweis zeigen kann.
 */
export function steuerAusBrutto(brutto: Cents, satzPromille: number): Cents {
  const zaehler = brutto * satzPromille
  const nenner = 1000 + satzPromille
  const abgerundet = Math.floor(zaehler / nenner)
  const rest = zaehler - abgerundet * nenner
  return cents(rest * 2 >= nenner ? abgerundet + 1 : abgerundet)
}

export interface Steuerzeile {
  readonly satzPromille: number
  readonly brutto: Cents
  readonly steuer: Cents
  readonly netto: Cents
}

/** Fasst die Positionen je Steuersatz zusammen, aufsteigend sortiert. */
export function steuerzeilen(positionen: readonly Position[]): Steuerzeile[] {
  const nachSatz = new Map<number, Cents>()
  for (const position of positionen) {
    const bisher = nachSatz.get(position.steuersatzPromille) ?? cents(0)
    nachSatz.set(position.steuersatzPromille, addCents(bisher, zeilensumme(position)))
  }
  return [...nachSatz.entries()]
    .sort(([a], [b]) => a - b)
    .map(([satzPromille, brutto]) => {
      const steuer = steuerAusBrutto(brutto, satzPromille)
      return { satzPromille, brutto, steuer, netto: subtractCents(brutto, steuer) }
    })
}

export function gesamtsumme(positionen: readonly Position[]): Cents {
  return sumCents(positionen.map(zeilensumme))
}

// --- Bon -------------------------------------------------------------------

export function baueTestbon(
  daten: Bondaten,
  breite: number = CHARACTERS_PER_LINE_80MM,
): Uint8Array {
  const b = beginJob(new EscPosBuilder(breite))

  // --- Kopf ---
  b.raw(align(1)).raw(bold(true)).raw(textSize(2, 2))
  b.line(daten.betrieb)
  b.raw(textSize(1, 1)).raw(bold(false))
  b.line(daten.strasse)
  b.line(daten.ort)
  b.line()
  b.line('Steuernummer: ' + daten.steuernummer)
  b.raw(align(0))
  b.rule('=')

  b.columns('Beleg-Nr.', daten.belegnummer)
  b.columns('Datum/Zeit', daten.zeitpunkt)
  b.columns('Kasse', daten.kasse)
  b.rule('-')

  // --- Positionen ---
  for (const position of daten.positionen) {
    const summe = zeilensumme(position)
    b.columns(
      String(position.menge) + ' x ' + position.bezeichnung,
      euro(summe) + ' ' + steuerKennzeichen(position.steuersatzPromille),
    )
    // Einzelpreis und Verzehrart als Unterzeile. Die Verzehrart steht
    // ausdruecklich auf dem Beleg, weil sie den Steuersatz bestimmt.
    b.line(
      '    a ' +
        euro(position.einzelpreis) +
        '  ' +
        prozent(position.steuersatzPromille) +
        '%  ' +
        position.verzehrart,
    )
  }

  b.rule('-')

  // --- Summe ---
  const gesamt = gesamtsumme(daten.positionen)
  b.raw(bold(true)).raw(textSize(1, 2))
  b.columns('SUMME EUR', euro(gesamt))
  b.raw(textSize(1, 1)).raw(bold(false))
  b.columns('Gegeben bar EUR', euro(gesamt))
  b.columns('Rueckgeld EUR', euro(cents(0)))
  b.line()

  // --- Steuerausweis, je Satz getrennt ---
  b.line('Steuerausweis')
  b.columns('Satz        Netto', 'Steuer      Brutto')
  for (const zeile of steuerzeilen(daten.positionen)) {
    const links =
      steuerKennzeichen(zeile.satzPromille) +
      ' ' +
      (prozent(zeile.satzPromille) + '%').padEnd(6) +
      euro(zeile.netto).padStart(9)
    const rechts = euro(zeile.steuer).padStart(8) + euro(zeile.brutto).padStart(10)
    b.line(links + rechts.padStart(breite - links.length))
  }
  b.rule('-')

  // --- TSE-Signaturdaten ---
  b.line('TSE-Signaturdaten')
  b.columns('Transaktionsnummer', daten.signatur.transaktionsnummer)
  b.columns('Signaturzaehler', daten.signatur.signaturzaehler)
  b.line('Beginn  ' + daten.signatur.startzeit)
  b.line('Logzeit ' + daten.signatur.logzeit)
  b.line('Seriennummer TSE')
  b.wrapped('  ' + daten.signatur.tseSeriennummer)
  b.line('Signatur')
  b.wrapped('  ' + daten.signatur.signatur)
  b.line('Pruefwert')
  b.wrapped('  ' + daten.signatur.pruefwert)

  b.rule('=')
  b.raw(align(1))
  b.line('Vielen Dank fuer Ihren Besuch')
  b.line('Bitte bewahren Sie den Beleg auf')
  b.raw(align(0))

  b.raw(feed(4)).raw(cut(1))
  return b.build()
}

/** DSFinV-K-uebliche Kennzeichnung der Steuersaetze auf dem Beleg. */
function steuerKennzeichen(satzPromille: number): string {
  if (satzPromille === 190) return 'A'
  if (satzPromille === 70) return 'B'
  return '?'
}

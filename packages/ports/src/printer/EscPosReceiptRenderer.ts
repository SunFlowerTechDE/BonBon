/**
 * Renderer: Belegdatensatz -> ESC/POS-Bytes.
 *
 * Einer von mehreren Renderern über demselben `Beleg` (CLAUDE.md, Regel 16).
 * Später kommen einer für HTML mit QR-Code und einer für das Standardformat
 * daneben, das ab 2028 über eine Rechtsverordnung kommt.
 *
 * Hier — und nur hier — entstehen Zeilenumbrüche, Ausrichtung, Papierbreite
 * und die Umrechnung von Cent nach Euro (Regel 3).
 */

import {
  type Beleg,
  type BelegRenderer,
  type Cents,
  type Zahlart,
  steuerKennzeichen,
  steuersatzText,
  verzehrartText,
} from '@bonbon/core'

import {
  CHARACTERS_PER_LINE_80MM,
  EscPosBuilder,
  align,
  beginJob,
  bold,
  cut,
  feed,
} from './escpos.js'

/**
 * Beschriftung der Zahlungszeile.
 *
 * Kleingeschrieben bei „bar", weil „Gegeben bar EUR" die übliche Formulierung
 * auf deutschen Kassenbons ist.
 */
const GEGEBEN_TEXT: Readonly<Record<Zahlart, string>> = {
  bar: 'bar',
  karte: 'Karte',
  gutschein: 'Gutschein',
  sonstiges: 'sonstige',
}

/** Cent nach Euro. Die einzige Stelle im Belegweg, an der das passiert. */
export function euroText(betrag: Cents): string {
  const wert: number = betrag
  const negativ = wert < 0
  const abs = negativ ? -wert : wert
  const rest = abs % 100
  const ganz = (abs - rest) / 100
  return (negativ ? '-' : '') + String(ganz) + ',' + String(rest).padStart(2, '0')
}

/**
 * ISO-Zeitstempel als `TT.MM.JJJJ HH:MM`.
 *
 * Rein textlich zerlegt, ohne `Date`. Das ist kein Selbstzweck: `new Date(…)`
 * würde in die Zeitzone der Maschine umrechnen, und dann stünde auf dem Beleg
 * eine andere Uhrzeit als die, zu der kassiert wurde. Der Zeitstempel trägt
 * seinen Offset schon mit sich (Regel 11) — die Wanduhrzeit steht wörtlich drin.
 */
export function zeitpunktText(isoZeitstempel: string): string {
  const treffer = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoZeitstempel)
  if (treffer === null) return isoZeitstempel
  const [, jahr, monat, tag, stunde, minute] = treffer
  return tag + '.' + monat + '.' + jahr + ' ' + stunde + ':' + minute
}

export interface EscPosReceiptOptions {
  readonly charactersPerLine?: number
}

export class EscPosReceiptRenderer implements BelegRenderer<Uint8Array> {
  readonly name = 'escpos'
  private readonly breite: number

  constructor(options: EscPosReceiptOptions = {}) {
    this.breite = options.charactersPerLine ?? CHARACTERS_PER_LINE_80MM
  }

  render(beleg: Beleg): Uint8Array {
    const b = beginJob(new EscPosBuilder(this.breite))

    this.kopf(b, beleg)
    this.positionen(b, beleg)
    this.summe(b, beleg)
    this.steuerausweis(b, beleg)
    this.signatur(b, beleg)
    this.fuss(b)

    b.raw(feed(4)).raw(cut(1))
    return b.build()
  }

  private kopf(b: EscPosBuilder, beleg: Beleg): void {
    b.raw(align(1)).raw(bold(true)).size(2, 2)
    b.line(beleg.haendler.name)
    b.size(1, 1).raw(bold(false))
    b.line(beleg.haendler.strasse)
    b.line(beleg.haendler.postleitzahl + ' ' + beleg.haendler.ort)
    b.line()
    b.line('Steuernummer: ' + beleg.haendler.steuernummer)
    b.raw(align(0))
    b.rule('=')

    b.columns('Beleg-Nr.', beleg.belegnummer)
    b.columns('Datum/Zeit', zeitpunktText(beleg.zeitpunkt))
    b.columns('Kasse', beleg.kasse)
    b.rule('-')
  }

  private positionen(b: EscPosBuilder, beleg: Beleg): void {
    for (const p of beleg.positionen) {
      b.columns(
        String(p.menge) + ' x ' + p.bezeichnung,
        euroText(p.gesamtpreis) + ' ' + steuerKennzeichen(p.steuersatzPromille),
      )
      // Einzelpreis und Verzehrart als Unterzeile. Die Verzehrart steht
      // ausdruecklich auf dem Beleg, weil sie den Steuersatz bestimmt (Regel 4).
      b.line(
        '    à ' +
          euroText(p.einzelpreis) +
          '  ' +
          steuersatzText(p.steuersatzPromille) +
          '%  ' +
          verzehrartText(p.verzehrart),
      )
    }
    b.rule('-')
  }

  private summe(b: EscPosBuilder, beleg: Beleg): void {
    // Doppelte Breite UND doppelte Hoehe. Die Zeilenbreite halbiert sich
    // dadurch auf 24 Zeichen; der Builder rechnet das selbst aus.
    //
    // Warum beide Faktoren: 0x11 ist in beiden Halbbytes gleich. Damit liest
    // escpresso denselben Modus wie ein echter Drucker, obwohl der Emulator
    // die Halbbytes vertauscht (siehe escpos.ts).
    b.raw(bold(true)).size(2, 2)
    b.columns('SUMME', euroText(beleg.gesamtbetrag))
    b.size(1, 1).raw(bold(false))

    for (const zahlung of beleg.zahlungen) {
      b.columns('Gegeben ' + GEGEBEN_TEXT[zahlung.art] + ' EUR', euroText(zahlung.betrag))
    }
    b.columns('Rückgeld EUR', euroText(beleg.rueckgeld))
    b.line()
  }

  private steuerausweis(b: EscPosBuilder, beleg: Beleg): void {
    b.line('Steuerausweis')
    b.columns('Satz        Netto', 'Steuer      Brutto')
    for (const zeile of beleg.steuerausweis) {
      const links =
        steuerKennzeichen(zeile.steuersatzPromille) +
        ' ' +
        (steuersatzText(zeile.steuersatzPromille) + '%').padEnd(6) +
        euroText(zeile.netto).padStart(9)
      const rechts = euroText(zeile.steuer).padStart(8) + euroText(zeile.brutto).padStart(10)
      b.line(links + rechts.padStart(b.charactersPerLine - links.length))
    }
    b.rule('-')
  }

  private signatur(b: EscPosBuilder, beleg: Beleg): void {
    if (beleg.signatur === undefined) {
      // Der Ausfallpfad aus Regel 8: der Verkauf ist abgeschlossen, die
      // Signatur fehlt. Der Beleg sagt das ausdruecklich, statt die Zeilen
      // einfach wegzulassen.
      b.line('TSE-Signaturdaten')
      b.wrapped('Die Signatur konnte nicht erstellt werden.')
      if (beleg.signaturAusfall !== undefined) b.wrapped('Grund: ' + beleg.signaturAusfall)
      b.wrapped('Sie wird nachgeholt und als Nachsignierung gekennzeichnet.')
      b.rule('-')
      return
    }

    b.line('TSE-Signaturdaten')
    b.columns('Transaktionsnummer', beleg.signatur.transaktionsnummer)
    b.columns('Signaturzähler', beleg.signatur.signaturzaehler)
    b.line('Beginn  ' + beleg.signatur.startzeit)
    b.line('Logzeit ' + beleg.signatur.logzeit)
    b.line('Seriennummer TSE')
    b.wrapped('  ' + beleg.signatur.seriennummer)
    b.line('Signatur')
    b.wrapped('  ' + beleg.signatur.signatur)
    b.line('Prüfwert')
    b.wrapped('  ' + beleg.signatur.pruefwert)
  }

  private fuss(b: EscPosBuilder): void {
    b.rule('=')
    b.raw(align(1))
    b.line('Vielen Dank für Ihren Besuch')
    b.line('Bitte bewahren Sie den Beleg auf')
    b.raw(align(0))
  }
}

/**
 * Aufbau des Testbons.
 *
 * Reine Funktion: Vorgang rein, ESC/POS-Bytes raus. Kein Socket, keine Uhr.
 *
 * Die Betraege sind Cents aus @bonbon/core. Nach Euro umgerechnet wird
 * ausschliesslich hier, in der Darstellungsschicht (CLAUDE.md, Regel 3).
 */

import { type Cents, addCents, cents, multiplyCents, subtractCents, sumCents } from '@bonbon/core'
import {
  CHARACTERS_PER_LINE_80MM,
  EscPosBuilder,
  align,
  beginJob,
  bold,
  cut,
  feed,
} from '@bonbon/ports'

/** Verzehrart entscheidet ueber 7 % oder 19 % (CLAUDE.md, Regel 4). */
export type Verzehrart = 'im Haus' | 'außer Haus'

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

export interface Betriebsdaten {
  readonly betrieb: string
  readonly strasse: string
  readonly ort: string
  readonly steuernummer: string
}

export interface Vorgangsdaten {
  readonly belegnummer: string
  readonly zeitpunkt: string
  readonly kasse: string
  readonly positionen: readonly Position[]
}

// --- Abgeschlossener Vorgang ----------------------------------------------

declare const abgeschlossen: unique symbol

/**
 * Ein Vorgang samt der Signatur, die zu genau diesem Vorgang gehoert
 * (CLAUDE.md, Regel 14).
 *
 * Der Typ ist nur ueber `abschliessen()` zu bekommen. Damit gibt es keinen Weg,
 * dem Belegdruck Positionen des einen und eine Signatur des anderen Vorgangs
 * zu uebergeben — die beiden koennen gar nicht mehr getrennt gereicht werden.
 */
export interface AbgeschlossenerVorgang extends Vorgangsdaten {
  readonly [abgeschlossen]: true
  readonly signatur: Signaturdaten
}

/** Die Signatur passt nicht zu dem Vorgang, der gedruckt werden soll. */
export class SignaturPasstNichtError extends Error {
  constructor(readonly abweichungen: readonly string[]) {
    super(
      'Die Signatur gehoert nicht zu diesem Vorgang:\n  - ' +
        abweichungen.join('\n  - ') +
        '\nEin Beleg mit fremder Signatur darf nicht gedruckt werden (CLAUDE.md, Regel 14).',
    )
    this.name = 'SignaturPasstNichtError'
  }
}

/**
 * Aufbau des Pruefwerts nach KassenSichV, Prozesstyp Kassenbeleg-V1:
 *
 *   V0;<Kassenseriennummer>;<Prozesstyp>;<Prozessdaten>;<TrxNr>;<SigZaehler>;...
 *
 * Die Prozessdaten enthalten die fuenf Umsatzsteuerfelder und die Zahlungen:
 *
 *   Beleg^<19%>_<7%>_<10,7%>_<5,5%>_<0%>^<Betrag>:<Zahlart>|...
 *
 * Aus diesen Feldern laesst sich pruefen, ob die Signatur denselben Vorgang
 * beschreibt wie der Bon.
 */
interface PruefwertInhalt {
  readonly kasse: string
  readonly prozesstyp: string
  readonly ustFelder: readonly Cents[]
  readonly zahlungen: Cents
  readonly transaktionsnummer: string
  readonly signaturzaehler: string
}

/** Dezimalzahl mit Punkt (`3.80`) nach Cents, ohne Fliesskomma. */
function dezimalNachCents(text: string): Cents | undefined {
  const treffer = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (treffer === null) return undefined
  const [, vorzeichen, ganz, bruch = ''] = treffer
  const wert = Number(ganz) * 100 + Number((bruch + '00').slice(0, 2))
  return cents(vorzeichen === '-' ? -wert : wert)
}

function lesePruefwert(pruefwert: string): PruefwertInhalt | undefined {
  const teile = pruefwert.split(';')
  if (teile.length < 6 || teile[0] !== 'V0') return undefined
  const prozessdaten = teile[3] ?? ''
  const abschnitte = prozessdaten.split('^')
  if (abschnitte.length < 3) return undefined

  const ustFelder: Cents[] = []
  for (const feld of (abschnitte[1] ?? '').split('_')) {
    const betrag = dezimalNachCents(feld)
    if (betrag === undefined) return undefined
    ustFelder.push(betrag)
  }

  let zahlungen = cents(0)
  for (const eintrag of (abschnitte[2] ?? '').split('|')) {
    const betrag = dezimalNachCents((eintrag.split(':')[0] ?? '').trim())
    if (betrag === undefined) return undefined
    zahlungen = addCents(zahlungen, betrag)
  }

  return {
    kasse: teile[1] ?? '',
    prozesstyp: abschnitte[0] ?? '',
    ustFelder,
    zahlungen,
    transaktionsnummer: teile[4] ?? '',
    signaturzaehler: teile[5] ?? '',
  }
}

/**
 * Bindet Vorgang und Signatur zu einer Einheit — und prueft dabei, dass sie
 * zusammengehoeren.
 *
 * Geprueft wird gegen den Pruefwert, weil er die Betraege des signierten
 * Vorgangs woertlich enthaelt. Ein reiner Typ waere zu wenig: er verhindert
 * das Vertauschen von Parametern, nicht das Zusammenstellen falscher Daten.
 */
export function abschliessen(
  vorgang: Vorgangsdaten,
  signatur: Signaturdaten,
): AbgeschlossenerVorgang {
  const inhalt = lesePruefwert(signatur.pruefwert)
  const abweichungen: string[] = []

  if (inhalt === undefined) {
    abweichungen.push(
      'Der Pruefwert laesst sich nicht lesen, die Zugehoerigkeit ist also nicht ' +
        'nachweisbar: ' +
        JSON.stringify(signatur.pruefwert),
    )
  } else {
    if (inhalt.kasse !== vorgang.kasse) {
      abweichungen.push(
        'Kasse: Beleg sagt ' + vorgang.kasse + ', Pruefwert sagt ' + inhalt.kasse,
      )
    }
    if (inhalt.transaktionsnummer !== signatur.transaktionsnummer) {
      abweichungen.push(
        'Transaktionsnummer: Signaturfeld ' +
          signatur.transaktionsnummer +
          ', Pruefwert ' +
          inhalt.transaktionsnummer,
      )
    }
    if (inhalt.signaturzaehler !== signatur.signaturzaehler) {
      abweichungen.push(
        'Signaturzähler: Signaturfeld ' +
          signatur.signaturzaehler +
          ', Pruefwert ' +
          inhalt.signaturzaehler,
      )
    }

    const gesamt = gesamtsumme(vorgang.positionen)
    if (inhalt.zahlungen !== gesamt) {
      abweichungen.push(
        'Zahlbetrag: Beleg ' + euro(gesamt) + ', Pruefwert ' + euro(inhalt.zahlungen),
      )
    }

    // Feld 1 = 19 %, Feld 2 = 7 % (Reihenfolge nach DSFinV-K).
    const nachSatz = new Map(steuerzeilen(vorgang.positionen).map((z) => [z.satzPromille, z.brutto]))
    const erwartet: readonly (readonly [number, string, number])[] = [
      [190, '19 %', 0],
      [70, '7 %', 1],
    ]
    for (const [promille, name, feldIndex] of erwartet) {
      const imBeleg = nachSatz.get(promille) ?? cents(0)
      const imPruefwert = inhalt.ustFelder[feldIndex] ?? cents(0)
      if (imBeleg !== imPruefwert) {
        abweichungen.push(
          name + ': Beleg ' + euro(imBeleg) + ', Pruefwert ' + euro(imPruefwert),
        )
      }
    }
  }

  if (abweichungen.length > 0) throw new SignaturPasstNichtError(abweichungen)

  return { ...vorgang, signatur } as AbgeschlossenerVorgang
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
 * Benannte Rundungsregel: kaufmaennisch, halbe Cent aufwaerts. Gerechnet wird
 * ausschliesslich in Ganzzahlen.
 *
 *   Steuer = brutto * satz / (1000 + satz)
 *
 * Hinweis fuer M1: gehoert nach @bonbon/core, zusammen mit den uebrigen
 * Rundungsregeln und Property-based Tests.
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

/**
 * Baut den Beleg.
 *
 * Nimmt **einen** abgeschlossenen Vorgang, nicht Positionen und Signatur
 * getrennt. Ein Beleg, dessen Signatur zu einem anderen Vorgang gehoert, laesst
 * sich damit gar nicht erst zusammenstellen (CLAUDE.md, Regel 14).
 */
export function baueTestbon(
  betrieb: Betriebsdaten,
  vorgang: AbgeschlossenerVorgang,
  breite: number = CHARACTERS_PER_LINE_80MM,
): Uint8Array {
  const b = beginJob(new EscPosBuilder(breite))

  // --- Kopf ---
  b.raw(align(1)).raw(bold(true)).size(2, 2)
  b.line(betrieb.betrieb)
  b.size(1, 1).raw(bold(false))
  b.line(betrieb.strasse)
  b.line(betrieb.ort)
  b.line()
  b.line('Steuernummer: ' + betrieb.steuernummer)
  b.raw(align(0))
  b.rule('=')

  b.columns('Beleg-Nr.', vorgang.belegnummer)
  b.columns('Datum/Zeit', vorgang.zeitpunkt)
  b.columns('Kasse', vorgang.kasse)
  b.rule('-')

  // --- Positionen ---
  for (const position of vorgang.positionen) {
    b.columns(
      String(position.menge) + ' x ' + position.bezeichnung,
      euro(zeilensumme(position)) + ' ' + steuerKennzeichen(position.steuersatzPromille),
    )
    // Einzelpreis und Verzehrart als Unterzeile. Die Verzehrart steht
    // ausdruecklich auf dem Beleg, weil sie den Steuersatz bestimmt.
    b.line(
      '    à ' +
        euro(position.einzelpreis) +
        '  ' +
        prozent(position.steuersatzPromille) +
        '%  ' +
        position.verzehrart,
    )
  }

  b.rule('-')

  // --- Summe ---
  //
  // Doppelte Breite UND doppelte Hoehe. Die Zeilenbreite halbiert sich dadurch
  // auf 24 Zeichen; der Builder rechnet das selbst aus, hier steht keine Zahl.
  //
  // Warum beide Faktoren: 0x11 ist in beiden Halbbytes gleich. Damit liest
  // escpresso denselben Modus wie ein echter Drucker, obwohl der Emulator die
  // Halbbytes vertauscht (siehe escpos.ts). Bei 0x01 oder 0x10 wuerden Vorschau
  // und Geraet auseinanderlaufen.
  const gesamt = gesamtsumme(vorgang.positionen)
  b.raw(bold(true)).size(2, 2)
  b.columns('SUMME', euro(gesamt))
  b.size(1, 1).raw(bold(false))
  b.columns('Gegeben bar EUR', euro(gesamt))
  b.columns('Rückgeld EUR', euro(cents(0)))
  b.line()

  // --- Steuerausweis, je Satz getrennt ---
  b.line('Steuerausweis')
  b.columns('Satz        Netto', 'Steuer      Brutto')
  for (const zeile of steuerzeilen(vorgang.positionen)) {
    const links =
      steuerKennzeichen(zeile.satzPromille) +
      ' ' +
      (prozent(zeile.satzPromille) + '%').padEnd(6) +
      euro(zeile.netto).padStart(9)
    const rechts = euro(zeile.steuer).padStart(8) + euro(zeile.brutto).padStart(10)
    b.line(links + rechts.padStart(b.charactersPerLine - links.length))
  }
  b.rule('-')

  // --- TSE-Signaturdaten ---
  b.line('TSE-Signaturdaten')
  b.columns('Transaktionsnummer', vorgang.signatur.transaktionsnummer)
  b.columns('Signaturzähler', vorgang.signatur.signaturzaehler)
  b.line('Beginn  ' + vorgang.signatur.startzeit)
  b.line('Logzeit ' + vorgang.signatur.logzeit)
  b.line('Seriennummer TSE')
  b.wrapped('  ' + vorgang.signatur.tseSeriennummer)
  b.line('Signatur')
  b.wrapped('  ' + vorgang.signatur.signatur)
  b.line('Prüfwert')
  b.wrapped('  ' + vorgang.signatur.pruefwert)

  b.rule('=')
  b.raw(align(1))
  b.line('Vielen Dank für Ihren Besuch')
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

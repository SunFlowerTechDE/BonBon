/**
 * Baut den Belegdatensatz für den Testbon.
 *
 * Hier entsteht **nur der Datensatz** (CLAUDE.md, Regel 16) — keine Zeilen,
 * keine Ausrichtung, keine Euro-Zeichenketten. Die Darstellung macht ein
 * Renderer; heute `EscPosReceiptRenderer`, später einer für HTML und einer
 * für das Standardformat ab 2028.
 *
 * Die Beträge sind `Cents` aus `@bonbon/core` (Regel 3).
 */

import {
  type Beleg,
  type Belegposition,
  type Cents,
  type Haendlerangaben,
  type TseSignatur,
  type Verzehrart,
  type Zahlung,
  type Steuerzeile,
  addCents,
  cents,
  isoTimestamp,
  multiplyCents,
  steuerausweis,
  sumCents,
} from '@bonbon/core'

/** Eine Position, wie sie die Kasse kennt — vor der Bonberechnung. */
export interface Warenkorbposition {
  readonly menge: number
  readonly bezeichnung: string
  readonly einzelpreis: Cents
  readonly steuersatzPromille: number
  readonly verzehrart: Verzehrart
}

export interface Vorgangsdaten {
  readonly belegnummer: string
  /** ISO 8601 mit Zeitzonen-Offset (Regel 11). */
  readonly zeitpunkt: string
  readonly kasse: string
  readonly positionen: readonly Warenkorbposition[]
}

export type { Haendlerangaben as Betriebsdaten, TseSignatur as Signaturdaten }

// --- Rechnung --------------------------------------------------------------
//
// Die Steuer- und Rundungslogik liegt jetzt in @bonbon/core (Regel 17). Hier
// bleibt nur die Zeilensumme, weil sie zum Warenkorb gehoert und nicht zur
// Steuer.

export function zeilensumme(position: Warenkorbposition): Cents {
  return multiplyCents(position.einzelpreis, position.menge)
}

/** Steuerausweis des Bons — je Steuersatz einmal gerundet (Regel 17). */
export function steuerzeilen(positionen: readonly Warenkorbposition[]): Steuerzeile[] {
  return steuerausweis(
    positionen.map((p) => ({
      brutto: zeilensumme(p),
      steuersatzPromille: p.steuersatzPromille,
    })),
  )
}

export function gesamtsumme(positionen: readonly Warenkorbposition[]): Cents {
  return sumCents(positionen.map(zeilensumme))
}

// --- Abgeschlossener Beleg -------------------------------------------------

declare const abgeschlossen: unique symbol

/**
 * Ein Beleg samt der Signatur, die zu genau diesem Vorgang gehoert
 * (CLAUDE.md, Regel 14).
 *
 * Nur ueber `abschliessen()` zu bekommen. Damit gibt es keinen Weg, dem
 * Belegdruck Positionen des einen und eine Signatur des anderen Vorgangs
 * unterzuschieben.
 */
export interface AbgeschlossenerBeleg extends Beleg {
  readonly [abgeschlossen]: true
}

export class SignaturPasstNichtError extends Error {
  constructor(readonly abweichungen: readonly string[]) {
    super(
      'Die Signatur gehoert nicht zu diesem Vorgang:\n  - ' +
        abweichungen.join('\n  - ') +
        '\nEin Beleg mit fremder Signatur darf nicht ausgegeben werden (CLAUDE.md, Regel 14).',
    )
    this.name = 'SignaturPasstNichtError'
  }
}

/**
 * Aufbau des Pruefwerts nach KassenSichV, Prozesstyp Kassenbeleg-V1:
 *
 *   V0;<Kassenseriennummer>;<Prozesstyp>;<Prozessdaten>;<TrxNr>;<SigZaehler>;...
 *
 * Prozessdaten:
 *   Beleg^<19%>_<7%>_<10,7%>_<5,5%>_<0%>^<Betrag>:<Zahlart>|...
 */
interface PruefwertInhalt {
  readonly kasse: string
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
  const abschnitte = (teile[3] ?? '').split('^')
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
    ustFelder,
    zahlungen,
    transaktionsnummer: teile[4] ?? '',
    signaturzaehler: teile[5] ?? '',
  }
}

/** Cent als Dezimaltext mit Punkt, fuer die Fehlermeldung. */
function euroFuerMeldung(betrag: Cents): string {
  const wert: number = betrag
  const negativ = wert < 0
  const abs = negativ ? -wert : wert
  const rest = abs % 100
  return (negativ ? '-' : '') + String((abs - rest) / 100) + ',' + String(rest).padStart(2, '0')
}

/**
 * Baut den Belegdatensatz und bindet die Signatur daran — mit Pruefung, dass
 * sie zusammengehoeren.
 *
 * Geprueft wird gegen den Pruefwert, weil er die Betraege des signierten
 * Vorgangs woertlich enthaelt. Ein reiner Typ waere zu wenig: er verhindert
 * das Vertauschen von Parametern, nicht das Zusammenstellen falscher Daten.
 */
export function abschliessen(
  haendler: Haendlerangaben,
  vorgang: Vorgangsdaten,
  signatur: TseSignatur,
): AbgeschlossenerBeleg {
  const gesamt = gesamtsumme(vorgang.positionen)
  const ausweis = steuerzeilen(vorgang.positionen)
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
      abweichungen.push('Kasse: Beleg sagt ' + vorgang.kasse + ', Pruefwert sagt ' + inhalt.kasse)
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
    if (inhalt.zahlungen !== gesamt) {
      abweichungen.push(
        'Zahlbetrag: Beleg ' + euroFuerMeldung(gesamt) + ', Pruefwert ' + euroFuerMeldung(inhalt.zahlungen),
      )
    }

    // Feld 1 = 19 %, Feld 2 = 7 % (Reihenfolge nach DSFinV-K).
    const nachSatz = new Map(ausweis.map((z) => [z.steuersatzPromille, z.brutto]))
    for (const [promille, name, feldIndex] of [
      [190, '19 %', 0],
      [70, '7 %', 1],
    ] as readonly (readonly [number, string, number])[]) {
      const imBeleg = nachSatz.get(promille) ?? cents(0)
      const imPruefwert = inhalt.ustFelder[feldIndex] ?? cents(0)
      if (imBeleg !== imPruefwert) {
        abweichungen.push(
          name + ': Beleg ' + euroFuerMeldung(imBeleg) + ', Pruefwert ' + euroFuerMeldung(imPruefwert),
        )
      }
    }
  }

  if (abweichungen.length > 0) throw new SignaturPasstNichtError(abweichungen)

  const positionen: Belegposition[] = vorgang.positionen.map((p, index) => ({
    position: index + 1,
    bezeichnung: p.bezeichnung,
    menge: p.menge,
    einzelpreis: p.einzelpreis,
    gesamtpreis: zeilensumme(p),
    steuersatzPromille: p.steuersatzPromille,
    verzehrart: p.verzehrart,
  }))

  const zahlungen: Zahlung[] = [{ art: 'bar', betrag: gesamt }]

  const beleg: Beleg = {
    haendler,
    belegnummer: vorgang.belegnummer,
    kasse: vorgang.kasse,
    zeitpunkt: isoTimestamp(vorgang.zeitpunkt),
    positionen,
    zahlungen,
    steuerausweis: ausweis,
    gesamtbetrag: gesamt,
    rueckgeld: cents(0),
    signatur,
  }

  return beleg as AbgeschlossenerBeleg
}

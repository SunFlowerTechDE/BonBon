/**
 * Belegdatensatz — strukturiert, ohne jede Darstellung (CLAUDE.md, Regel 16).
 *
 * Hier steht **kein** formatierter Text: keine Zeilenumbrüche, keine
 * Ausrichtung, keine Euro-Zeichenketten, keine Papierbreite. Nur Daten.
 *
 * Der Grund ist nicht Ästhetik. Ab 2028 wird der digitale Beleg zum Standard
 * und Papier zur Ausnahme; das Format dafür kommt erst später über eine
 * Rechtsverordnung. Wer bis dahin nur gerenderte Belege aufbewahrt, kann
 * daraus kein neues Format erzeugen — und ist zehn Jahre aufbewahrungs-
 * pflichtig (§ 147 AO).
 *
 * Darüber liegen Renderer: einer für ESC/POS, später einer für HTML mit
 * QR-Code, später einer für das noch unbekannte Standardformat. Sie lesen
 * diesen Datensatz und erzeugen daraus eine Ausgabe. Umgekehrt geht es nicht.
 */

import type { Cents } from './money.js'
import type { IsoTimestamp } from './time.js'

/** „hier essen" oder „mitnehmen" — entscheidet über 7 % oder 19 % (Regel 4). */
export type Verzehrart = 'im-haus' | 'ausser-haus'

export interface Haendlerangaben {
  readonly name: string
  readonly strasse: string
  readonly postleitzahl: string
  readonly ort: string
  readonly steuernummer: string
  /** Falls vorhanden; für den digitalen Beleg voraussichtlich relevant. */
  readonly umsatzsteuerId?: string
}

export interface Belegposition {
  /** Laufende Nummer auf dem Beleg, beginnend bei 1. */
  readonly position: number
  readonly bezeichnung: string
  /** Ganzzahlige Stückzahl. Gebrochene Mengen brauchen eine Rundungsregel (M1). */
  readonly menge: number
  readonly einzelpreis: Cents
  readonly gesamtpreis: Cents
  /** Steuersatz in Promille — 190 für 19 %, damit ganzzahlig (Regel 3). */
  readonly steuersatzPromille: number
  /**
   * Warum dieser Steuersatz gilt.
   *
   * Steht ausdrücklich im Datensatz, nicht nur das Ergebnis: bei einer Prüfung
   * muss nachvollziehbar sein, *warum* 7 % berechnet wurden (Regel 4).
   */
  readonly verzehrart: Verzehrart
}

export type Zahlart = 'bar' | 'karte' | 'gutschein' | 'sonstiges'

export interface Zahlung {
  readonly art: Zahlart
  readonly betrag: Cents
  /** Belegnummer des Kartenterminals, falls es eine gab. */
  readonly terminalBelegnummer?: string
}

export interface Steuerausweis {
  readonly steuersatzPromille: number
  readonly netto: Cents
  readonly steuer: Cents
  readonly brutto: Cents
}

/**
 * Die Signaturdaten der TSE, so wie sie zurückkamen.
 *
 * Alle Felder als Zeichenkette, weil sie genau so auf den Beleg und in den
 * Export gehören — nicht umgerechnet, nicht neu formatiert.
 */
export interface TseSignatur {
  readonly transaktionsnummer: string
  readonly signaturzaehler: string
  readonly startzeit: string
  readonly logzeit: string
  readonly signatur: string
  readonly seriennummer: string
  /** Der QR-Code-Inhalt nach KassenSichV. */
  readonly pruefwert: string
  /** z. B. "0.4.0.127.0.7.1.1.4.1.3" */
  readonly signaturalgorithmus?: string
  /** z. B. "utcTimeWithSeconds" */
  readonly zeitformat?: string
  readonly oeffentlicherSchluessel?: string
}

/**
 * Ein Beleg, vollständig und strukturiert.
 *
 * Das ist, was im Event Log und im Archiv liegt — nie die gerenderte Form
 * (Regel 16).
 */
export interface Beleg {
  readonly haendler: Haendlerangaben
  /** Belegnummer der Kasse bzw. der Middleware, z. B. "ftC#T4". */
  readonly belegnummer: string
  /** Kassenseriennummer. */
  readonly kasse: string
  /** Zeitpunkt des Bonabschlusses, ISO 8601 mit Offset (Regel 11). */
  readonly zeitpunkt: IsoTimestamp
  readonly positionen: readonly Belegposition[]
  readonly zahlungen: readonly Zahlung[]
  readonly steuerausweis: readonly Steuerausweis[]
  readonly gesamtbetrag: Cents
  readonly rueckgeld: Cents
  /**
   * Fehlt, wenn zum Zeitpunkt der Ausgabe keine Signatur vorlag.
   *
   * Der Fall ist echt: bei TSE-Ausfall wird der Verkauf lokal abgeschlossen
   * und später nachsigniert (Regel 8). Der Beleg trägt dann den
   * Ausfallhinweis statt der Signaturdaten.
   */
  readonly signatur?: TseSignatur
  /** Grund des Ausfalls, wenn keine Signatur vorliegt. */
  readonly signaturAusfall?: string
}

// --- Renderer --------------------------------------------------------------

/**
 * Erzeugt aus einem Beleg eine Ausgabe.
 *
 * `T` ist das Ergebnis: Bytes für ESC/POS, eine Zeichenkette für HTML, später
 * was auch immer die Rechtsverordnung verlangt. Jeder Renderer liest
 * denselben Datensatz.
 */
export interface BelegRenderer<T> {
  /** Kurzname für Protokoll und Konfiguration, z. B. "escpos" oder "html". */
  readonly name: string
  render(beleg: Beleg): T
}

// --- Hilfen auf dem Datensatz ----------------------------------------------

/** Prozentdarstellung eines Promillewerts, ohne Fliesskomma. */
export function steuersatzText(promille: number): string {
  const rest = promille % 10
  const ganz = (promille - rest) / 10
  return rest === 0 ? String(ganz) : String(ganz) + ',' + String(rest)
}

/** Klartext der Verzehrart, wie er auf den Beleg gehört. */
export function verzehrartText(art: Verzehrart): string {
  return art === 'im-haus' ? 'im Haus' : 'außer Haus'
}

export function zahlartText(art: Zahlart): string {
  switch (art) {
    case 'bar':
      return 'Bar'
    case 'karte':
      return 'Karte'
    case 'gutschein':
      return 'Gutschein'
    case 'sonstiges':
      return 'Sonstiges'
  }
}

/**
 * DSFinV-K-übliche Kennzeichnung der Steuersätze auf dem Beleg.
 *
 * A = Regelsteuersatz, B = ermäßigter Satz. Ein unbekannter Satz bekommt
 * kein Kürzel untergeschoben, sondern ein Fragezeichen — er soll auffallen.
 */
export function steuerKennzeichen(promille: number): string {
  if (promille === 190) return 'A'
  if (promille === 70) return 'B'
  return '?'
}

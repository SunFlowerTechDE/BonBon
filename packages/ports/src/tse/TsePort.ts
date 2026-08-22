/**
 * TsePort — die Geraeteschicht fuer die technische Sicherheitseinrichtung.
 *
 * Die Anwendungslogik kennt nur dieses Interface. Dahinter steht heute der
 * `MockTse`, ueber Konfiguration der fiskaltrust Launcher, spaeter fiskaly
 * oder Swissbit (CLAUDE.md, Ports und Adapter).
 */

import type { Cents, TseSignatur } from '@bonbon/core'

/**
 * Zustand der TSE.
 *
 * Drei Stufen, weil die Kasse sie unterschiedlich behandelt:
 *
 * - `bereit` — es wird signiert.
 * - `gestoert` — die TSE antwortet, meldet aber ein Problem (Zertifikat laeuft
 *   ab, Speicher knapp). Es wird weiter signiert, der Betreiber muss sich aber
 *   kuemmern.
 * - `ausgefallen` — es kann nicht signiert werden. Der Verkauf laeuft trotzdem
 *   weiter, der Beleg traegt den Ausfallhinweis, die Signatur geht in die
 *   Warteschlange (Regel 8).
 */
export type TseStatus = 'bereit' | 'gestoert' | 'ausgefallen'

export interface TseZustand {
  readonly status: TseStatus
  /** Klartext fuer die Anzeige an der Kasse. */
  readonly meldung: string
  readonly seriennummer?: string
}

/** Was signiert werden soll. */
export interface Signieranfrage {
  /** Belegreferenz der Kasse — verbindet Vorgang und Signatur (Regel 14). */
  readonly belegreferenz: string
  readonly kassenSeriennummer: string
  /** Bruttosummen je Steuersatz, in der DSFinV-K-Reihenfolge. */
  readonly umsaetze: {
    readonly regel19: Cents
    readonly ermaessigt7: Cents
    readonly durchschnitt107: Cents
    readonly durchschnitt55: Cents
    readonly null0: Cents
  }
  readonly zahlungen: readonly { readonly art: string; readonly betrag: Cents }[]
}

/**
 * Ergebnis einer Signierung.
 *
 * Entweder eine Signatur — oder der ausdrueckliche Befund, dass nicht signiert
 * werden konnte. Es gibt keinen dritten Fall und kein stilles Durchwinken
 * (Regel 12).
 */
export type Signierergebnis =
  | { readonly art: 'signiert'; readonly signatur: TseSignatur }
  | { readonly art: 'ausgefallen'; readonly grund: string }

export interface TsePort {
  readonly info: { readonly target: string }
  zustand(): Promise<TseZustand>
  signiere(anfrage: Signieranfrage): Promise<Signierergebnis>
}

export class TseError extends Error {
  constructor(
    message: string,
    readonly target: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TseError'
  }
}

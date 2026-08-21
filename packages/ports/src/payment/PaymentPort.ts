/**
 * PaymentPort — die Geraeteschicht fuer Kartenterminals.
 *
 * Die Anwendungslogik oeffnet niemals selbst einen Socket. Sie kennt nur dieses
 * Interface; welche Implementierung dahintersteht, entscheidet die
 * Konfiguration (CLAUDE.md, Ports und Adapter). Heute ZVT ueber TCP gegen das
 * Mock-Terminal, spaeter dieselbe Klasse gegen ein CCV Base Next — es
 * unterscheidet sie nur die IP-Adresse.
 */

import type { Cents } from '@bonbon/core'

/**
 * Ausgang einer Kartenzahlung.
 *
 * `unknown` ist kein Randfall, sondern der wichtigste Zustand dieses Ports.
 * Er wird bewusst als eigener Fall gefuehrt und nicht mit `declined`
 * zusammengelegt: „abgelehnt" heisst, der Kunde hat sicher nicht bezahlt.
 * „unbekannt" heisst, wir wissen es nicht — und diese beiden Faelle verlangen
 * entgegengesetztes Verhalten.
 *
 * Eine Kartenzahlung ohne eindeutiges Ergebnis gilt **nie** als erfolgreich
 * (CLAUDE.md, Regel 12 und Regel 15).
 */
export type PaymentOutcome =
  | {
      readonly kind: 'approved'
      readonly amount: Cents
      /** Belegnummer des Terminals, noetig fuer ein spaeteres Storno. */
      readonly receiptNumber?: string
      readonly traceNumber?: string
      readonly cardType?: string
      readonly terminalId?: string
    }
  | {
      readonly kind: 'declined'
      /** ZVT-Ergebniscode aus BMP 27. */
      readonly resultCode: number
      readonly reason: string
    }
  | {
      readonly kind: 'aborted'
      readonly resultCode: number
      readonly reason: string
    }
  | {
      readonly kind: 'unknown'
      readonly reason: string
      /** Belegnummer, soweit bekannt — ohne sie ist ein Storno schwerer. */
      readonly receiptNumber?: string
    }

/** Zwischenstand waehrend der Zahlung, zur Anzeige am Kassenbildschirm. */
export interface PaymentProgress {
  /** ZVT <intermediate-status>, 1 Byte. */
  readonly code: number
  readonly text: string
}

export interface PaymentRequest {
  readonly amount: Cents
  /** ISO-4217 numerisch. 978 = Euro. */
  readonly currencyCode?: number
  readonly onProgress?: (progress: PaymentProgress) => void
}

export interface PaymentTerminalInfo {
  readonly target: string
}

export interface PaymentPort {
  readonly info: PaymentTerminalInfo

  /** Anmeldung am Terminal. Muss vor der ersten Zahlung laufen. */
  register(): Promise<void>

  /** Zahlung ueber den Betrag. Liefert immer einen der vier Ausgaenge. */
  authorize(request: PaymentRequest): Promise<PaymentOutcome>

  /**
   * Storniert eine Zahlung anhand der Belegnummer des Terminals.
   *
   * Der dokumentierte Weg, einen `unknown`-Ausgang aufzuloesen, wenn eine
   * Nachfrage kein Ergebnis bringt: lieber eine womoeglich gar nicht erfolgte
   * Zahlung stornieren, als eine erfolgte zu uebersehen.
   */
  reverse(receiptNumber: string): Promise<PaymentOutcome>

  /**
   * Fragt die Status-Information des zuletzt ausgefuehrten Vorgangs ab.
   *
   * Der fehlende Schritt nach einem `unknown`-Ausgang: die Kasse kennt weder
   * Ergebnis noch Belegnummer und muss beides erst herausfinden, bevor sie
   * ueberhaupt stornieren koennte.
   */
  queryLastTransaction(): Promise<PaymentOutcome>

  /** Kassenschnitt. Schliesst den Terminal-Tag ab. */
  endOfDay(): Promise<PaymentOutcome>

  isReachable(): Promise<boolean>
}

/** Fehler der Geraeteschicht. Traegt das Ziel mit. */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly target: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PaymentError'
  }
}

/**
 * Ein `unknown`-Ausgang wurde behandelt wie ein Ergebnis.
 *
 * Wird geworfen, wenn jemand `assertSettled` auf einen unklaren Ausgang
 * anwendet. Der Fehler existiert, damit dieser Fall im Code sichtbar bleibt
 * und nicht in einem `if (outcome.kind === 'approved')` verschwindet, dessen
 * else-Zweig alles andere als „nicht bezahlt" behandelt.
 */
export class UnresolvedPaymentError extends Error {
  constructor(readonly outcome: Extract<PaymentOutcome, { kind: 'unknown' }>) {
    super(
      'Die Kartenzahlung hat kein eindeutiges Ergebnis: ' +
        outcome.reason +
        (outcome.receiptNumber === undefined
          ? ''
          : ' (Belegnummer ' + outcome.receiptNumber + ')') +
        '. Sie darf weder als bezahlt noch als nicht bezahlt gebucht werden, ' +
        'bevor sie beim Terminal nachgefragt oder storniert wurde.',
    )
    this.name = 'UnresolvedPaymentError'
  }
}

/**
 * Erzwingt, dass ein unklarer Ausgang nicht durchrutscht.
 *
 * Aufrufer, die ein Ergebnis brauchen, laufen ueber diese Funktion. Sie ist
 * das Gegenstueck zu `assertSigned` beim Beleg: nicht auf einen Fehler warten,
 * sondern aktiv pruefen, dass ein Ergebnis da ist.
 */
export function assertSettled(
  outcome: PaymentOutcome,
): Exclude<PaymentOutcome, { kind: 'unknown' }> {
  if (outcome.kind === 'unknown') throw new UnresolvedPaymentError(outcome)
  return outcome
}

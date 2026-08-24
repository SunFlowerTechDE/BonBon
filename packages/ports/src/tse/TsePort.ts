/**
 * TsePort — die Geraeteschicht fuer die technische Sicherheitseinrichtung.
 *
 * Die Anwendungslogik kennt nur dieses Interface. Dahinter steht heute der
 * `MockTse`, ueber Konfiguration der fiskaltrust Launcher, spaeter fiskaly
 * oder Swissbit (CLAUDE.md, Ports und Adapter).
 *
 * ## Warum eine Transaktion einen Anfang hat
 *
 * Die Signatur entsteht nicht am Ende des Bons, sondern spannt sich ueber ihn:
 * beim Oeffnen des Bons beginnt die TSE-Transaktion, beim Abschluss wird sie
 * beendet. Die KassenSichV verlangt die Protokollierung **mit Beginn** des
 * Aufzeichnungsvorgangs, nicht erst mit seinem Ende — sonst waere zwischen der
 * ersten Position und dem Abschluss ein Zeitraum, in dem nichts festgehalten
 * ist.
 *
 * Daraus folgt ein Zustand, den es vorher nicht gab: eine Transaktion, die
 * begonnen wurde und nie endete. Stuerzt die Kasse zwischen Beginn und
 * Abschluss ab, steht sie auf der TSE offen, ohne lokales Gegenstueck. Deshalb
 * gehoeren `offeneTransaktionen()` und `brichTransaktionAb()` zum Port: ohne
 * sie liesse sich der Zustand nicht einmal feststellen, geschweige denn
 * aufloesen.
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

// --- Transaktionsbeginn -----------------------------------------------------

export interface Transaktionsbeginn {
  /** Belegreferenz der Kasse — verbindet Vorgang und Signatur (Regel 14). */
  readonly belegreferenz: string
  readonly kassenSeriennummer: string
}

/**
 * Eine Transaktion, die auf der TSE offen steht.
 *
 * Die Belegreferenz ist bewusst optional: eine Transaktion, die aus einem
 * abgestuerzten Lauf stammt oder von Hand angelegt wurde, hat auf der TSE
 * keine Zuordnung mehr. Sie deswegen zu uebersehen waere der schlechtere Weg —
 * gerade die unzugeordneten sind die, die aufgeloest werden muessen.
 */
export interface OffeneTransaktion {
  readonly transaktionsnummer: string
  readonly belegreferenz?: string
  readonly startzeit?: string
}

export type Transaktionsergebnis =
  | { readonly art: 'begonnen'; readonly transaktion: OffeneTransaktion }
  | { readonly art: 'ausgefallen'; readonly grund: string }

/**
 * Was abgebrochen werden soll.
 *
 * **Mindestens eines von beiden muss gesetzt sein.** Gemessen am laufenden
 * fiskaltrust-Launcher: die Antwort auf `start-transaction` enthaelt genau eine
 * Signatur (`start-transaction-signature`) und **keine Transaktionsnummer** —
 * die Middleware fuehrt die Zuordnung selbst ueber `cbReceiptReference`. Der
 * explizite Fail-Transaction-Beleg braucht deshalb nur die Referenz.
 *
 * Andere Geraete (Swissbit direkt) kennen umgekehrt nur Nummern. Der Port
 * traegt beides und laesst den Adapter entscheiden, was er benutzt.
 */
export interface Abbruchanfrage {
  readonly transaktionsnummer?: string
  readonly belegreferenz?: string
  /** Klartext fuers Protokoll — warum die Transaktion abgebrochen wird. */
  readonly grund: string
}

export type Abbruchergebnis =
  | { readonly art: 'abgebrochen'; readonly transaktionsnummer?: string }
  | { readonly art: 'ausgefallen'; readonly grund: string }

// --- Abschluss --------------------------------------------------------------

/** Was signiert werden soll. */
export interface Signieranfrage {
  /** Belegreferenz der Kasse — verbindet Vorgang und Signatur (Regel 14). */
  readonly belegreferenz: string
  readonly kassenSeriennummer: string
  /**
   * Die Transaktion, die beendet werden soll.
   *
   * Fehlt sie, wurde beim Bonbeginn keine geoeffnet — etwa weil die TSE da
   * gerade ausgefallen war (Regel 8). Dann ist dies ein Einzelbeleg, der
   * Beginn und Abschluss in einem Schritt schreibt. Der Unterschied wird
   * **nicht** verschwiegen: das Ergebnis sagt, welcher Weg gegangen wurde.
   */
  readonly transaktionsnummer?: string
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

// --- Der Port ---------------------------------------------------------------

/**
 * ## Abbildung auf die fiskaltrust Middleware (fuer den Adapter in M3)
 *
 * Nachgeschlagen, nicht geraten:
 *
 * | Hier | fiskaltrust |
 * |---|---|
 * | `beginneTransaktion` | `ftReceiptCase 0x4445000000000008` (Start-Transaction) |
 * | `signiere` | Kassenbeleg, beendet die Transaktion |
 * | `brichTransaktionAb` | `ftReceiptCase 0x444500000000000B` (Fail-Transaction) |
 * | `offeneTransaktionen` | **nicht ueber die POS-Schnittstelle abfragbar** — siehe unten |
 *
 * Zum Abbrechen kennt die Middleware zwei Wege. **Explizit** schliesst genau
 * eine Transaktion, referenziert ueber `cbReceiptReference`. **Implizit**
 * schliesst mehrere: die Nummern gehen als JSON-Feld
 * `ftReceiptCaseData: {"CurrentStartedTransactionNumbers":[1,2,3]}` mit, und
 * `cbReceiptReference` **muss dann leer sein** — sonst wirft die Middleware.
 * Der implizite Weg schliesst auch Transaktionen, die nicht von der Middleware
 * geoeffnet wurden; genau die entstehen bei einem Absturz.
 *
 * ## Was `offeneTransaktionen()` bei fiskaltrust liefern kann — gemessen
 *
 * Die Dokumentation legt nahe, die Antwort des Zero-Receipts trage einen
 * TSE-Status mit `CurrentStartedTransactionNumbers`. **Am laufenden Launcher
 * gemessen stimmt das nicht.** Die Antwort enthaelt 16 Signaturen, von
 * `start-transaction-result` bis `<public-key>`; keine davon fuehrt offene
 * Transaktionen auf. Der Journal-Endpunkt beantwortet jeden versuchten
 * `ftJournalType` mit derselben Versionsauskunft.
 *
 * `CurrentStartedTransactionNumbers` ist ein **ausgehendes** Feld: es geht im
 * `ftReceiptCaseData` eines impliziten Fail-Transaction-Belegs mit, um
 * Transaktionen zu schliessen, die die Middleware nicht kennt. Zum Abfragen
 * ist es nicht da.
 *
 * Folge fuer den Entwurf: **der Event Log ist die Quelle, nicht die TSE.** Die
 * Kasse haelt fest, wann sie eine Transaktion geoeffnet hat, und weiss damit
 * selbst, was offen steht. `offeneTransaktionen()` bleibt als zweite Quelle
 * fuer Reste, die nicht von dieser Kasse stammen — und fuer Geraete, die die
 * Frage beantworten koennen. Wirft die Methode, ist das kein Beinbruch mehr.
 */
export interface TsePort {
  readonly info: { readonly target: string }
  zustand(): Promise<TseZustand>

  /** Oeffnet die Transaktion. Beim Bonbeginn, nicht beim Abschluss. */
  beginneTransaktion(anfrage: Transaktionsbeginn): Promise<Transaktionsergebnis>

  /** Beendet die Transaktion und liefert die Signaturdaten. */
  signiere(anfrage: Signieranfrage): Promise<Signierergebnis>

  /** Beendet eine Transaktion als abgebrochen — ohne Beleg, mit Grund. */
  brichTransaktionAb(anfrage: Abbruchanfrage): Promise<Abbruchergebnis>

  /**
   * Sucht die Signaturdaten zu einer Belegreferenz.
   *
   * Fuer den Fall, dass die Kasse zwischen der Rueckkehr der Signatur und dem
   * Festhalten im Log abgestuerzt ist. Der Abgleich ueber offene Transaktionen
   * findet das **nicht**: die Transaktion ist ja abgeschlossen. Ohne diese
   * Frage waeren die Signaturdaten dauerhaft aus dem Log verschwunden, und
   * niemand haette sie je vermisst.
   *
   * `undefined` heisst „die TSE kennt zu dieser Referenz keine Signatur".
   * Antwortet die TSE gar nicht, wird geworfen — das ist etwas anderes und
   * darf nicht als „gibt es nicht" durchgehen.
   *
   * Bei fiskaltrust (M3): ueber das Journal zur `cbReceiptReference`.
   */
  signaturZu(belegreferenz: string): Promise<TseSignatur | undefined>

  /**
   * Was gerade offen steht.
   *
   * Wird beim Start der Kasse gefragt. Eine Transaktion ohne lokales
   * Gegenstueck ist ein Rest aus einem abgestuerzten Lauf und muss aufgeloest
   * werden — stillschweigend liegenlassen waere die schlechteste Variante.
   */
  offeneTransaktionen(): Promise<readonly OffeneTransaktion[]>
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

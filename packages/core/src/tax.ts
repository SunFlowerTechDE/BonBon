/**
 * Steuer und Rundung (CLAUDE.md, Regeln 3 und 17).
 *
 * Zwei Entscheidungen sind hier festgeschrieben und begründet, weil beide
 * unterschiedliche Ergebnisse liefern und nur eine zur DSFinV-K passt:
 *
 * 1. **Wo gerundet wird** — einmal je Steuersatz auf Belegebene, nicht je
 *    Position.
 * 2. **Wie gerundet wird** — kaufmännisch, halbe Cent vom Nullpunkt weg.
 *
 * Beides steht ausführlich unten und in CLAUDE.md, Regel 17.
 */

import { type Cents, addCents, cents, subtractCents } from './money.js'

/** Steuersatz in Promille — 190 für 19 %, damit ganzzahlig (Regel 3). */
export type SteuersatzPromille = number

export const STEUERSATZ = {
  /** Regelsteuersatz, seit 1.1.2019 19,00 %. DSFinV-K UST_SCHLUESSEL 1. */
  regel: 190,
  /** Ermäßigter Steuersatz, seit 1.1.2019 7,00 %. DSFinV-K UST_SCHLUESSEL 2. */
  ermaessigt: 70,
  /** Steuerfrei. */
  null: 0,
} as const

// --- Rundung ---------------------------------------------------------------

/**
 * Kaufmännische Rundung eines Bruchs, halbe Einheit **vom Nullpunkt weg**.
 *
 * `zaehler` und `nenner` sind Ganzzahlen; gerechnet wird ohne Fliesskomma.
 *
 * ## Warum vom Nullpunkt weg und nicht „aufwärts"
 *
 * Bei positiven Beträgen ist beides dasselbe. Sie unterscheiden sich nur bei
 * negativen: „aufwärts" (Richtung +∞) macht aus −2,5 → −2, „vom Nullpunkt weg"
 * macht −3.
 *
 * Die Kasse braucht die zweite Variante, weil nur sie diese Zusicherung gibt:
 *
 *     steuer(−brutto) === −steuer(brutto)
 *
 * Ein Storno muss den ursprünglichen Vorgang **exakt** aufheben. Rundete die
 * Retoure anders als der Verkauf, bliebe je Storno ein Cent stehen — und der
 * fällt erst auf, wenn der Steuerberater die Summen nicht mehr nachrechnen kann.
 */
export function rundeKaufmaennisch(zaehler: number, nenner: number): number {
  if (!Number.isSafeInteger(zaehler) || !Number.isSafeInteger(nenner)) {
    throw new RangeError(
      'Zaehler und Nenner muessen sichere Ganzzahlen sein: ' +
        String(zaehler) +
        ' / ' +
        String(nenner),
    )
  }
  if (nenner <= 0) throw new RangeError('Nenner muss positiv sein: ' + String(nenner))

  const negativ = zaehler < 0
  const abs = negativ ? -zaehler : zaehler
  const ganz = Math.floor(abs / nenner)
  const rest = abs - ganz * nenner
  // rest/nenner >= 1/2  ohne Division, damit kein Fliesskomma ins Spiel kommt.
  const aufgerundet = rest * 2 >= nenner ? ganz + 1 : ganz
  // Nicht `-aufgerundet` bei 0 — das ergaebe negative Null.
  return negativ && aufgerundet !== 0 ? -aufgerundet : aufgerundet
}

// --- Steuer aus einem Bruttobetrag -----------------------------------------

/**
 * Rechnet die enthaltene Umsatzsteuer aus einem Bruttobetrag heraus.
 *
 *     Steuer = brutto × satz / (1000 + satz)
 *
 * Beispiel: 7,70 € bei 19 % → 770 × 190 / 1190 = 122,94 → **123 Cent**.
 *
 * Der Betrag darf negativ sein (Retoure, Storno). Das Ergebnis ist dann exakt
 * das Negative des positiven Falls.
 */
export function steuerAusBrutto(brutto: Cents, satzPromille: SteuersatzPromille): Cents {
  if (!Number.isSafeInteger(satzPromille) || satzPromille < 0) {
    throw new RangeError(
      'Steuersatz muss eine nicht-negative Ganzzahl in Promille sein: ' + String(satzPromille),
    )
  }
  if (satzPromille === 0) return cents(0)

  const wert: number = brutto
  const zaehler = wert * satzPromille
  if (!Number.isSafeInteger(zaehler)) {
    throw new RangeError(
      'Betrag zu gross fuer eine exakte Steuerberechnung: ' +
        String(wert) +
        ' Cent bei ' +
        String(satzPromille) +
        ' Promille',
    )
  }
  return cents(rundeKaufmaennisch(zaehler, 1000 + satzPromille))
}

/** Nettobetrag zu einem Bruttobetrag. Immer `brutto − steuer`, nie eigen gerundet. */
export function nettoAusBrutto(brutto: Cents, satzPromille: SteuersatzPromille): Cents {
  return subtractCents(brutto, steuerAusBrutto(brutto, satzPromille))
}

// --- Steuerausweis je Satz -------------------------------------------------

export interface SteuerzeileEingabe {
  readonly brutto: Cents
  readonly steuersatzPromille: SteuersatzPromille
}

export interface Steuerzeile {
  readonly steuersatzPromille: SteuersatzPromille
  readonly brutto: Cents
  readonly netto: Cents
  readonly steuer: Cents
}

/**
 * Bildet den Steuerausweis eines Belegs.
 *
 * ## Die Entscheidung: erst summieren, dann einmal runden
 *
 * Zwei Wege wären denkbar:
 *
 *   (a) je Position runden, dann die gerundeten Steuerbeträge summieren
 *   (b) je Steuersatz die Bruttosumme bilden und **einmal** daraus runden
 *
 * Gewählt ist **(b)**. Die DSFinV-K gibt das vor.
 *
 * In der Datei `Bonpos_USt` (lines_vat.csv) haben `POS_BRUTTO`, `POS_NETTO`
 * und `POS_UST` **fünf Dezimalstellen** — auf Positionsebene wird also gar
 * nicht auf Cent gerundet.
 *
 * In der Datei `Bonkopf_USt` (transactions_vat.csv) steht zu `BON_BRUTTO`
 * wörtlich:
 *
 * > „An dieser Stelle ist nicht einfach die Summe aus den betroffenen
 * > Positionen zu bilden. Vielmehr muss der gedruckte Betrag dargestellt
 * > werden (Rechnungsdoppel). Beträge sind mit zwei Dezimalstellen
 * > darzustellen, obwohl das Datenfeld eigentlich auf 5 Dezimalstellen
 * > ausgelegt ist."
 *
 * (DSFinV-K Version 2.4, Anhang D, Datei „Bonkopf_USt")
 *
 * Der auf dem Beleg gedruckte Betrag je Steuersatz ist also der maßgebliche,
 * gerundete Wert — und er entsteht aus der Summe, nicht aus gerundeten
 * Einzelteilen.
 *
 * Weg (a) würde außerdem bei jeder Position einen Rundungsfehler erzeugen, der
 * sich über einen Bon mit vielen Positionen aufaddiert. Bei zwanzig Positionen
 * können das leicht mehrere Cent sein, und der Beleg zeigte dann eine
 * Steuersumme, die zur Bruttosumme nicht passt.
 *
 * Die Zeilen kommen aufsteigend nach Steuersatz zurück, unabhängig von der
 * Reihenfolge der Eingabe.
 */
export function steuerausweis(eintraege: readonly SteuerzeileEingabe[]): Steuerzeile[] {
  const bruttoJeSatz = new Map<SteuersatzPromille, Cents>()
  for (const eintrag of eintraege) {
    const bisher = bruttoJeSatz.get(eintrag.steuersatzPromille) ?? cents(0)
    bruttoJeSatz.set(eintrag.steuersatzPromille, addCents(bisher, eintrag.brutto))
  }

  return [...bruttoJeSatz.entries()]
    .sort(([a], [b]) => a - b)
    .map(([steuersatzPromille, brutto]) => {
      const steuer = steuerAusBrutto(brutto, steuersatzPromille)
      return { steuersatzPromille, brutto, netto: subtractCents(brutto, steuer), steuer }
    })
}

/** Bruttosumme über alle Steuersätze. */
export function bruttosumme(zeilen: readonly Steuerzeile[]): Cents {
  let summe = cents(0)
  for (const zeile of zeilen) summe = addCents(summe, zeile.brutto)
  return summe
}

/** Steuersumme über alle Steuersätze. */
export function steuersumme(zeilen: readonly Steuerzeile[]): Cents {
  let summe = cents(0)
  for (const zeile of zeilen) summe = addCents(summe, zeile.steuer)
  return summe
}

/** Nettosumme über alle Steuersätze. */
export function nettosumme(zeilen: readonly Steuerzeile[]): Cents {
  let summe = cents(0)
  for (const zeile of zeilen) summe = addCents(summe, zeile.netto)
  return summe
}

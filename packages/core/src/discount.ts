/**
 * Rabatte und ihre Verteilung über Steuersätze (CLAUDE.md, Regel 18).
 *
 * ## Wie die DSFinV-K einen Bonrabatt darstellt
 *
 * Nachgeschlagen, nicht geraten. DSFinV-K 2.4, Kapitel 4.2.4 „Preisnachlässe,
 * Rabatte, Entgeltminderungen":
 *
 * > „Einige Entgeltminderungen (z. B. Zwischensummenrabatte) beziehen sich
 * > nicht auf die einzelne Positionszeile, sondern auf den gesamten Bon
 * > (z. B. 3% Preisnachlass bei Kundenkarte) und werden demzufolge auch nicht
 * > bezogen auf den einzelnen Artikel gespeichert. **Diese Rabatte sind als
 * > gesonderte Positionszeile mit negativen Vorzeichen in der Datei Bonpos
 * > darzustellen. Die Aufteilung der Entgeltminderung erfolgt in der Datei
 * > Bonpos_USt.**"
 *
 * Und davor, zur Frage ob überhaupt aufgeteilt werden muss:
 *
 * > „Die erleichterte Trennung der Entgelte ist jedoch bei der Nutzung
 * > elektronischer Kassensysteme nicht möglich. Hier sind die
 * > Entgeltminderungen also **direkt zuzuordnen**."
 *
 * Daraus folgt das Datenmodell:
 *
 * - Ein Bonrabatt ist **eine eigene Position** mit negativem Betrag, nicht
 *   eine Minderung der Positionspreise.
 * - Diese Position trägt **je Steuersatz einen Anteil** — das ist die
 *   Aufteilung, die die DSFinV-K in `Bonpos_USt` erwartet.
 * - `Bonpos_USt` führt fünf Dezimalstellen (siehe Regel 17). Verteilt wird
 *   deshalb in höherer Genauigkeit, gerundet erst dort, wo auch die Steuer
 *   gerundet wird.
 *
 * ## Warum kein Restcent übrig bleibt
 *
 * Nicht durch eine Regel „wer den Rest bekommt", sondern durch die Bauweise.
 *
 * Verteilt wird über die **laufende Summe**: für jeden Steuersatz wird die
 * kumulierte Bemessungsgrundlage exakt gerundet, und der Anteil ist die
 * Differenz zweier gerundeter Kumulierter. Weil sich die Zwischenwerte
 * wegheben, ist die Summe der Anteile **immer** exakt der gerundete
 * Gesamtrabatt — bei jeder Anzahl Steuersätze, bei jedem Verhältnis.
 *
 *     Anteil_k = runde(kumuliert_k) − runde(kumuliert_{k−1})
 *     Summe    = runde(kumuliert_n) − runde(kumuliert_0) = runde(gesamt) − 0
 *
 * Ein Rabatt von 100 % ergibt damit exakt null: die kumulierten Werte sind
 * schon ganzzahlig, das Runden ist die Identität, und jeder Anteil ist genau
 * die Bemessungsgrundlage seines Satzes.
 */

import { type Cents, addCents, cents, negateCents } from './money.js'
import { rundeKaufmaennisch, type SteuersatzPromille } from './tax.js'

/** Auf welchen Teil des Bons sich der Rabatt bezieht. */
export type RabattZiel =
  | { readonly art: 'bon' }
  | { readonly art: 'position'; readonly positionId: string }

/**
 * Der gewährte Rabatt.
 *
 * Der Prozentsatz steht in **Hundertstel Prozent**, damit er ganzzahlig bleibt
 * (Regel 3): `1000` sind 10,00 %, `1050` sind 10,50 %, `10000` sind 100 %.
 */
export type RabattWert =
  | { readonly art: 'betrag'; readonly betrag: Cents }
  | { readonly art: 'prozent'; readonly hundertstelProzent: number }

export const VOLLER_RABATT = 10_000

export interface RabattAnteil {
  readonly steuersatzPromille: SteuersatzPromille
  /** Negativ — der Rabatt mindert. */
  readonly betrag: Cents
}

export interface Rabattverteilung {
  /** Gesamter Rabatt, negativ. */
  readonly gesamt: Cents
  /** Je Steuersatz ein Anteil, aufsteigend sortiert. Summe === `gesamt`. */
  readonly anteile: readonly RabattAnteil[]
}

export interface RabattBasis {
  readonly steuersatzPromille: SteuersatzPromille
  readonly brutto: Cents
}

export class RabattNichtVerteilbarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RabattNichtVerteilbarError'
  }
}

/**
 * Verteilt einen Rabatt über die Steuersätze der Bemessungsgrundlage.
 *
 * Die Bemessungsgrundlage darf negative Beträge enthalten (Retoure, Storno) —
 * siehe die Anmerkung unten.
 */
export function verteileRabatt(
  basis: readonly RabattBasis[],
  wert: RabattWert,
): Rabattverteilung {
  // Je Steuersatz zusammenfassen, aufsteigend sortieren. Die Reihenfolge muss
  // festliegen, sonst haengt die Verteilung von der Eingabereihenfolge ab.
  const jeSatz = new Map<SteuersatzPromille, Cents>()
  for (const eintrag of basis) {
    const bisher = jeSatz.get(eintrag.steuersatzPromille) ?? cents(0)
    jeSatz.set(eintrag.steuersatzPromille, addCents(bisher, eintrag.brutto))
  }
  const saetze = [...jeSatz.entries()].sort(([a], [b]) => a - b)
  const basisGesamt = saetze.reduce((summe, [, brutto]) => summe + brutto, 0)

  // --- Zaehler und Nenner der exakten Verteilung bestimmen ---
  //
  // Der Anteil eines Satzes ist immer  faktorZaehler * basis_k / faktorNenner.
  let faktorZaehler: number
  let faktorNenner: number

  if (wert.art === 'prozent') {
    const bp = wert.hundertstelProzent
    if (!Number.isSafeInteger(bp) || bp < 0 || bp > VOLLER_RABATT) {
      throw new RabattNichtVerteilbarError(
        'Prozentsatz muss zwischen 0 und ' +
          String(VOLLER_RABATT) +
          ' Hundertstel Prozent liegen (0 bis 100 %), ist aber ' +
          String(bp),
      )
    }
    faktorZaehler = bp
    faktorNenner = VOLLER_RABATT
  } else {
    const betrag: number = wert.betrag
    if (betrag < 0) {
      throw new RabattNichtVerteilbarError(
        'Ein Rabattbetrag ist nicht negativ anzugeben — er mindert ohnehin. ' +
          'Erhalten: ' +
          String(betrag) +
          ' Cent.',
      )
    }
    if (betrag === 0) {
      return { gesamt: cents(0), anteile: saetze.map(([s]) => ({ steuersatzPromille: s, betrag: cents(0) })) }
    }
    if (basisGesamt === 0) {
      // Ein Bon, dessen Summe null ist (etwa Verkauf und Retoure heben sich
      // auf), hat keine Bemessungsgrundlage, an der sich ein fester Betrag
      // ausrichten koennte. Alles auf einen Satz zu legen waere eine
      // erfundene Steuerzuordnung — dann lieber laut scheitern.
      throw new RabattNichtVerteilbarError(
        'Ein Rabatt von ' +
          String(betrag) +
          ' Cent laesst sich nicht verteilen: die Bemessungsgrundlage ist null. ' +
          'Ohne Grundlage gaebe es keine nachvollziehbare Zuordnung zu den Steuersaetzen.',
      )
    }
    faktorZaehler = betrag
    faktorNenner = basisGesamt
  }

  // Der Nenner muss positiv sein. Bei negativer Bemessungsgrundlage (reiner
  // Retourenbon) beide Seiten spiegeln — das Verhaeltnis bleibt gleich.
  if (faktorNenner < 0) {
    faktorZaehler = -faktorZaehler
    faktorNenner = -faktorNenner
  }

  // --- Verteilung ueber die laufende Summe ---
  const anteile: RabattAnteil[] = []
  let kumulierteBasis = 0
  let vorherGerundet = 0

  for (const [steuersatzPromille, brutto] of saetze) {
    kumulierteBasis += brutto
    const zaehler = faktorZaehler * kumulierteBasis
    if (!Number.isSafeInteger(zaehler)) {
      throw new RabattNichtVerteilbarError(
        'Betraege zu gross fuer eine exakte Verteilung: ' +
          String(faktorZaehler) +
          ' * ' +
          String(kumulierteBasis),
      )
    }
    const gerundet = rundeKaufmaennisch(zaehler, faktorNenner)
    anteile.push({
      steuersatzPromille,
      betrag: negateCents(cents(gerundet - vorherGerundet)),
    })
    vorherGerundet = gerundet
  }

  return { gesamt: negateCents(cents(vorherGerundet)), anteile }
}

/** Summe der Anteile — muss immer `gesamt` entsprechen. */
export function rabattsumme(verteilung: Rabattverteilung): Cents {
  let summe = cents(0)
  for (const anteil of verteilung.anteile) summe = addCents(summe, anteil.betrag)
  return summe
}

/**
 * Wendet eine Verteilung auf die Bemessungsgrundlage an.
 *
 * Ergebnis ist die geminderte Bruttosumme je Steuersatz — die Grundlage für
 * den Steuerausweis (Regel 17).
 */
export function mindereBasis(
  basis: readonly RabattBasis[],
  verteilung: Rabattverteilung,
): RabattBasis[] {
  const jeSatz = new Map<SteuersatzPromille, Cents>()
  for (const eintrag of basis) {
    const bisher = jeSatz.get(eintrag.steuersatzPromille) ?? cents(0)
    jeSatz.set(eintrag.steuersatzPromille, addCents(bisher, eintrag.brutto))
  }
  for (const anteil of verteilung.anteile) {
    const bisher = jeSatz.get(anteil.steuersatzPromille) ?? cents(0)
    jeSatz.set(anteil.steuersatzPromille, addCents(bisher, anteil.betrag))
  }
  return [...jeSatz.entries()]
    .sort(([a], [b]) => a - b)
    .map(([steuersatzPromille, brutto]) => ({ steuersatzPromille, brutto }))
}

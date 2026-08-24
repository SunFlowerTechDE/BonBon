/**
 * Stammdaten der Kasse — Artikel, Warengruppen, Steuervorbelegung.
 *
 * Fest hinterlegt. Eine Artikelverwaltung ist in M2 ausdrücklich nicht dran;
 * hier steht nur, was für einen Verkauf gebraucht wird.
 *
 * **Preise sind hier vorläufig konstant.** Regel 5 verlangt einen
 * Gültigkeitszeitraum je Preis (`product_prices`), sonst zeigt der
 * DSFinV-K-Export vom März die Preise von heute. Das kommt mit der
 * Artikelverwaltung.
 *
 * ---
 *
 * # BonBon schlägt Steuersätze vor. Es entscheidet sie nicht.
 *
 * Was hier steht, ist eine **Vorbelegung mit Fundstelle** — keine Auskunft.
 * Die Zuordnung eines konkreten Produkts zu einem Steuersatz hängt an
 * Eigenschaften, die diese Software nicht kennt: dem Rezept, der Zubereitung,
 * der Art der Abgabe. Ob ein bestimmter Cappuccino die 75-%-Grenze reißt, weiß
 * der Betrieb, nicht die Kasse.
 *
 * Deshalb: jede Zuordnung ist änderbar, jede trägt ihre Fundstelle, und die
 * Oberfläche weist sichtbar darauf hin, dass sie mit dem Steuerberater zu
 * prüfen ist. Eine Antwort auf „welcher Satz gilt für mein Produkt" wäre
 * unbefugte Hilfeleistung in Steuersachen (§ 5 StBerG) — siehe CLAUDE.md,
 * Regel 20.
 */

import {
  STEUERSATZ,
  type SteuersatzPromille,
  type Steuerentscheidung,
  type Steuersatzregel,
  type Verzehrart,
  cents,
  type Cents,
} from '@bonbon/core'

export type Warengruppe = 'Heißgetränke' | 'Kuchen & Gebäck' | 'Kalte Getränke'

/**
 * Die Steuervorbelegung eines Artikels — je Verzehrart getrennt.
 *
 * Kein pauschales „im Haus 19, mitnehmen 7". Diese Vereinfachung war für einen
 * großen Teil des Sortiments schlicht falsch: zubereiteter Kaffee ist
 * steuerlich ein Getränk und bleibt auch zum Mitnehmen beim Regelsatz.
 */
export interface Steuervorbelegung {
  readonly imHaus: Steuerentscheidung
  readonly ausserHaus: Steuerentscheidung
}

export interface Artikel {
  readonly id: string
  readonly bezeichnung: string
  readonly preis: Cents
  readonly warengruppe: Warengruppe
  readonly steuer: Steuervorbelegung
}

// --- Fundstellen ------------------------------------------------------------
//
// Nachgeschlagen, nicht aus dem Gedaechtnis. Die Liste unten verweist darauf,
// damit jede Zuordnung nachpruefbar ist — von jemandem, der es entscheiden
// darf.

/**
 * § 12 Abs. 2 Nr. 15 UStG, eingefuegt durch das Steueränderungsgesetz 2025
 * (Bundesrat 19.12.2025), in Kraft seit **1. Januar 2026**.
 *
 * Seitdem gilt für die **Abgabe von Speisen** in der Gastronomie dauerhaft der
 * ermäßigte Satz — unabhängig davon, ob im Haus verzehrt oder mitgenommen.
 * Damit entfällt für Speisen die alte Unterscheidung.
 *
 * Für **Getränke** bleibt es beim Regelsatz, auch im Rahmen einer
 * Restaurationsleistung.
 *
 * Quelle: ZDH, „Ermäßigter Umsatzsteuersatz für die Gastronomie ab 1.1.2026",
 * https://www.zdh.de/ueber-uns/fachbereich-steuern-und-finanzen/umsatzsteuer/ermaessigter-umsatzsteuersatz-fuer-die-gastronomie-ab-112026/
 */
const SPEISEN_2026 = '§ 12 Abs. 2 Nr. 15 UStG (SteuerÄndG 2025, seit 1.1.2026)'

/**
 * Getränke unterliegen dem Regelsatz.
 *
 * Anlage 2 zu § 12 Abs. 2 Nr. 1 UStG führt nur wenige Getränke auf; zubereiteter
 * Kaffee und Tee gehören nicht dazu. Die Absenkung für Speisen ab 2026 ändert
 * daran nichts: sie gilt ausdrücklich nur für Speisen.
 */
const GETRAENK = 'Anlage 2 zu § 12 Abs. 2 Nr. 1 UStG (Umkehrschluss) · § 12 Abs. 1 UStG'

/**
 * Milchmischgetränke mit mindestens 75 % Milchanteil.
 *
 * Anlage 2 Nr. 4 zu § 12 Abs. 2 Nr. 1 UStG erfasst Milch und Milcherzeugnisse,
 * darunter Milchmischgetränke mit einem Anteil an Milch von mindestens 75 %
 * des Fertigerzeugnisses.
 *
 * **Der Satz hängt an der Art der Abgabe.** Zum Mitnehmen ist es eine
 * *Lieferung* eines Milchmischgetränks — ermäßigt. Im Haus ist es Teil einer
 * *Restaurationsleistung*, und deren Absenkung ab 2026 gilt nur für Speisen;
 * ein Getränk bleibt dort beim Regelsatz.
 *
 * Quelle: ZDH (siehe oben), Abschnitt zu Milch und Milchmischgetränken.
 */
const MILCHMISCH = 'Anlage 2 Nr. 4 zu § 12 Abs. 2 Nr. 1 UStG (mind. 75 % Milchanteil)'

/**
 * Pflanzliche Milchalternativen sind keine Milch.
 *
 * FG Baden-Württemberg, Urteil vom 14.3.2024, 1 K 232/24: Erzeugnisse aus
 * Soja, Reis oder Hafer sind keine Milch oder Milchmischgetränke im Sinne der
 * Anlage 2 und unterliegen dem Regelsatz.
 */
const MILCHERSATZ = 'FG Baden-Württemberg, Urteil vom 14.3.2024, 1 K 232/24'

/**
 * Trinkwasser in Fertigpackungen.
 *
 * Anlage 2 Nr. 34 zu § 12 Abs. 2 Nr. 1 UStG ermäßigt Wasser, nimmt aber
 * Trinkwasser einschließlich Quell- und Tafelwasser aus, das in Fertigpackungen
 * in den Verkehr gebracht wird. Die Flasche über den Tresen ist damit Regelsatz.
 */
const WASSER_FLASCHE = 'Anlage 2 Nr. 34 zu § 12 Abs. 2 Nr. 1 UStG (Ausnahme: Fertigpackung)'

function entscheidung(
  satz: SteuersatzPromille,
  begruendung: string,
  fundstelle: string,
): Steuerentscheidung {
  return { satz, begruendung, fundstelle }
}

/** Speise: seit 2026 ermäßigt, gleich ob im Haus oder mitgenommen. */
function speise(): Steuervorbelegung {
  const e = entscheidung(
    STEUERSATZ.ermaessigt,
    'Speise — seit 1.1.2026 ermaessigt, unabhaengig von der Verzehrart',
    SPEISEN_2026,
  )
  return { imHaus: e, ausserHaus: e }
}

/** Getränk ohne Sonderfall: durchgehend Regelsatz. */
function getraenk(begruendung: string, fundstelle = GETRAENK): Steuervorbelegung {
  const e = entscheidung(STEUERSATZ.regel, begruendung, fundstelle)
  return { imHaus: e, ausserHaus: e }
}

/**
 * Milchmischgetränk über der 75-%-Grenze — der einzige Artikel, bei dem die
 * Verzehrart den Satz noch bewegt.
 */
function milchmischgetraenk(anteil: string): Steuervorbelegung {
  return {
    imHaus: entscheidung(
      STEUERSATZ.regel,
      'Im Haus Restaurationsleistung; die Absenkung ab 2026 gilt nur fuer Speisen, nicht fuer Getraenke',
      SPEISEN_2026,
    ),
    ausserHaus: entscheidung(
      STEUERSATZ.ermaessigt,
      'Lieferung eines Milchmischgetraenks, Milchanteil ' + anteil,
      MILCHMISCH,
    ),
  }
}

export const ARTIKEL: readonly Artikel[] = [
  // --- Heißgetränke ---
  {
    id: 'KAFFEE',
    bezeichnung: 'Kaffee',
    preis: cents(280),
    warengruppe: 'Heißgetränke',
    steuer: getraenk('Zubereiteter Kaffee ist ein Getraenk und steht nicht in Anlage 2'),
  },
  {
    id: 'ESPRESSO',
    bezeichnung: 'Espresso',
    preis: cents(220),
    warengruppe: 'Heißgetränke',
    steuer: getraenk('Zubereiteter Kaffee ist ein Getraenk und steht nicht in Anlage 2'),
  },
  {
    id: 'CAPPUCCINO',
    bezeichnung: 'Cappuccino',
    preis: cents(380),
    warengruppe: 'Heißgetränke',
    // Rund ein Drittel Espresso, ein Drittel Milch, ein Drittel Milchschaum —
    // gut zwei Drittel Milch und damit unter der Grenze. Wer anders zubereitet,
    // aendert die Vorbelegung; genau dafuer ist sie aenderbar.
    steuer: getraenk(
      'Milchanteil rund zwei Drittel und damit unter 75 % — kein Milchmischgetraenk im Sinne der Anlage 2',
      MILCHMISCH,
    ),
  },
  {
    id: 'LATTE',
    bezeichnung: 'Latte Macchiato',
    preis: cents(420),
    warengruppe: 'Heißgetränke',
    steuer: milchmischgetraenk('ueber 75 %'),
  },
  {
    id: 'LATTE_HAFER',
    bezeichnung: 'Latte Macch. Hafer',
    preis: cents(460),
    warengruppe: 'Heißgetränke',
    steuer: getraenk(
      'Haferdrink ist keine Milch — die 75-%-Grenze wird nicht erreicht, auch nicht zum Mitnehmen',
      MILCHERSATZ,
    ),
  },
  {
    id: 'TEE',
    bezeichnung: 'Tee',
    preis: cents(250),
    warengruppe: 'Heißgetränke',
    steuer: getraenk('Zubereiteter Tee ist ein Getraenk und steht nicht in Anlage 2'),
  },

  // --- Kuchen & Gebäck ---
  { id: 'KAESEKUCHEN', bezeichnung: 'Käsekuchen', preis: cents(390), warengruppe: 'Kuchen & Gebäck', steuer: speise() },
  { id: 'APFELSTRUDEL', bezeichnung: 'Apfelstrudel', preis: cents(360), warengruppe: 'Kuchen & Gebäck', steuer: speise() },
  { id: 'CROISSANT', bezeichnung: 'Croissant', preis: cents(210), warengruppe: 'Kuchen & Gebäck', steuer: speise() },
  { id: 'BROETCHEN', bezeichnung: 'Brötchen', preis: cents(85), warengruppe: 'Kuchen & Gebäck', steuer: speise() },
  { id: 'FRANZBROETCHEN', bezeichnung: 'Franzbrötchen', preis: cents(240), warengruppe: 'Kuchen & Gebäck', steuer: speise() },

  // --- Kalte Getränke ---
  {
    id: 'WASSER',
    bezeichnung: 'Wasser 0,33',
    preis: cents(250),
    warengruppe: 'Kalte Getränke',
    steuer: getraenk('Trinkwasser in einer Fertigpackung — von der Ermaessigung ausgenommen', WASSER_FLASCHE),
  },
  {
    id: 'APFELSCHORLE',
    bezeichnung: 'Apfelschorle',
    preis: cents(290),
    warengruppe: 'Kalte Getränke',
    steuer: getraenk('Fruchtsaftgetraenk — steht nicht in Anlage 2'),
  },
]

export const WARENGRUPPEN: readonly Warengruppe[] = [
  'Heißgetränke',
  'Kuchen & Gebäck',
  'Kalte Getränke',
]

const NACH_ID = new Map(ARTIKEL.map((a) => [a.id, a]))

export function artikel(id: string): Artikel {
  const gefunden = NACH_ID.get(id)
  if (gefunden === undefined) throw new Error('Unbekannter Artikel: ' + id)
  return gefunden
}

/**
 * Der Steuersatz als Funktion aus (Produkt, Verzehrart, Datum) — Regel 4.
 *
 * Die Entscheidung steht **je Produkt** in den Stammdaten, nicht als
 * Sammelregel im Code. Eine Sammelregel („im Haus 19, mitnehmen 7") war für
 * den größeren Teil des Sortiments falsch, und der Fehler war von außen nicht
 * zu sehen: die Kasse rechnete zuverlässig den falschen Satz.
 *
 * ## Was diese Funktion nicht kann
 *
 * - **Zeitliche Änderungen.** `zeitpunkt` steht in der Signatur, wird aber
 *   nicht ausgewertet. Die Vorbelegung bildet den Stand ab 1.1.2026 ab. Ein
 *   Export für einen Zeitraum davor bekäme die heutigen Sätze — das ist der
 *   Grund, warum der Parameter da ist, und die Aufgabe für M4.
 * - **Eigenschaften des Rezepts.** Ob ein konkreter Cappuccino die
 *   75-%-Grenze erreicht, hängt an der Zubereitung. Die Vorbelegung nimmt den
 *   üblichen Fall an und ist deshalb änderbar.
 * - Alkohol, Tabak, Pfand — kommen mit der Artikelverwaltung.
 */
export const steuersatzregel: Steuersatzregel = (artikelId, verzehrart) => {
  const gefunden = NACH_ID.get(artikelId)
  if (gefunden === undefined) {
    // Kein Rateweg: ein unbekannter Artikel bekommt keinen Steuersatz
    // untergeschoben.
    throw new Error(
      'Steuersatz nicht bestimmbar — unbekannter Artikel: ' +
        artikelId +
        '. Ein Artikel ohne Stammsatz darf nicht verkauft werden.',
    )
  }
  return verzehrart === 'im-haus' ? gefunden.steuer.imHaus : gefunden.steuer.ausserHaus
}

/** Welcher Steuersatz gälte bei der anderen Verzehrart? Für die Anzeige. */
export function steuersatzBei(
  artikelId: string,
  verzehrart: Verzehrart,
  zeitpunkt: string,
): Steuerentscheidung {
  return steuersatzregel(artikelId, verzehrart, zeitpunkt as never)
}

/**
 * Der Hinweis, der in der Oberfläche stehen muss.
 *
 * Nicht als Höflichkeit, sondern weil die Vorbelegung sonst wie eine Auskunft
 * wirkt — und eine Auskunft dazu darf diese Software nicht geben
 * (§ 5 StBerG, CLAUDE.md Regel 20).
 */
export const STEUERHINWEIS =
  'Steuersätze sind Vorschläge und mit dem Steuerberater zu prüfen.'

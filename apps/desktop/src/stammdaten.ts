/**
 * Stammdaten der Kasse — Artikel, Warengruppen, Steuersatzregel.
 *
 * Fest hinterlegt. Eine Artikelverwaltung ist in M2 ausdrücklich nicht dran;
 * hier steht nur, was für einen Verkauf gebraucht wird.
 *
 * **Preise sind hier vorläufig konstant.** Regel 5 verlangt einen
 * Gültigkeitszeitraum je Preis (`product_prices`), sonst zeigt der
 * DSFinV-K-Export vom März die Preise von heute. Das kommt mit der
 * Artikelverwaltung; solange es keine Preisänderung gibt, ist der Unterschied
 * nicht sichtbar — er wäre es aber, sobald jemand einen Preis ändert.
 */

import { STEUERSATZ, type Steuersatzregel, type Verzehrart, cents, type Cents } from '@bonbon/core'

export type Warengruppe = 'Heißgetränke' | 'Kuchen & Gebäck' | 'Kalte Getränke'

/**
 * Steuerklasse eines Artikels.
 *
 * Nicht der Steuersatz selbst — der ist eine Funktion aus
 * (Produkt, Verzehrart, Datum) und steht in `steuersatzregel` (Regel 4).
 */
export type Steuerklasse =
  /** Speisen: im Haus Regelsatz, außer Haus ermäßigt. */
  | 'speise'
  /** Getränke: durchgehend Regelsatz. */
  | 'getraenk'
  /** Milchmischgetränk mit über 75 % Milchanteil — wie eine Speise behandelt. */
  | 'milchmischgetraenk'

export interface Artikel {
  readonly id: string
  readonly bezeichnung: string
  readonly preis: Cents
  readonly warengruppe: Warengruppe
  readonly steuerklasse: Steuerklasse
}

export const ARTIKEL: readonly Artikel[] = [
  // --- Heißgetränke ---
  { id: 'KAFFEE', bezeichnung: 'Kaffee', preis: cents(280), warengruppe: 'Heißgetränke', steuerklasse: 'getraenk' },
  { id: 'ESPRESSO', bezeichnung: 'Espresso', preis: cents(220), warengruppe: 'Heißgetränke', steuerklasse: 'getraenk' },
  { id: 'CAPPUCCINO', bezeichnung: 'Cappuccino', preis: cents(380), warengruppe: 'Heißgetränke', steuerklasse: 'milchmischgetraenk' },
  { id: 'LATTE', bezeichnung: 'Latte Macchiato', preis: cents(420), warengruppe: 'Heißgetränke', steuerklasse: 'milchmischgetraenk' },
  { id: 'TEE', bezeichnung: 'Tee', preis: cents(250), warengruppe: 'Heißgetränke', steuerklasse: 'getraenk' },

  // --- Kuchen & Gebäck ---
  { id: 'KAESEKUCHEN', bezeichnung: 'Käsekuchen', preis: cents(390), warengruppe: 'Kuchen & Gebäck', steuerklasse: 'speise' },
  { id: 'APFELSTRUDEL', bezeichnung: 'Apfelstrudel', preis: cents(360), warengruppe: 'Kuchen & Gebäck', steuerklasse: 'speise' },
  { id: 'CROISSANT', bezeichnung: 'Croissant', preis: cents(210), warengruppe: 'Kuchen & Gebäck', steuerklasse: 'speise' },
  { id: 'BROETCHEN', bezeichnung: 'Brötchen', preis: cents(85), warengruppe: 'Kuchen & Gebäck', steuerklasse: 'speise' },
  { id: 'FRANZBROETCHEN', bezeichnung: 'Franzbrötchen', preis: cents(240), warengruppe: 'Kuchen & Gebäck', steuerklasse: 'speise' },

  // --- Kalte Getränke ---
  { id: 'WASSER', bezeichnung: 'Wasser 0,33', preis: cents(250), warengruppe: 'Kalte Getränke', steuerklasse: 'getraenk' },
  { id: 'APFELSCHORLE', bezeichnung: 'Apfelschorle', preis: cents(290), warengruppe: 'Kalte Getränke', steuerklasse: 'getraenk' },
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
 * ## Diese Regel ist vereinfacht
 *
 * Sie bildet den Grundfall ab: Speisen im Haus zum Regelsatz, außer Haus zum
 * ermäßigten Satz; Getränke durchgehend zum Regelsatz; Milchmischgetränke mit
 * über 75 % Milchanteil wie Speisen.
 *
 * Was sie **nicht** abbildet und was in M4 mit den Stammdaten kommen muss:
 *
 * - Die Abgrenzung „über 75 % Milchanteil" ist eine Eigenschaft des Rezepts,
 *   keine des Artikelnamens. Ein Cappuccino kann je nach Zubereitung darunter
 *   liegen.
 * - Zeitliche Änderungen. Der Parameter `zeitpunkt` steht deshalb schon in der
 *   Signatur, wird hier aber noch nicht ausgewertet. Die Gastronomie-Absenkung
 *   2020 bis 2023 ist das bekannte Beispiel dafür, dass er gebraucht wird.
 * - Alkohol, Tabak, Pfand — kommen mit der Artikelverwaltung.
 *
 * Der Kommentar steht hier, weil eine vereinfachte Steuerregel, die man für
 * vollständig hält, teurer ist als eine, deren Grenzen bekannt sind.
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

  switch (gefunden.steuerklasse) {
    case 'speise':
    case 'milchmischgetraenk':
      return verzehrart === 'im-haus' ? STEUERSATZ.regel : STEUERSATZ.ermaessigt
    case 'getraenk':
      return STEUERSATZ.regel
  }
}

/** Welcher Steuersatz gälte bei der anderen Verzehrart? Für die Anzeige. */
export function steuersatzBei(artikelId: string, verzehrart: Verzehrart, zeitpunkt: string): number {
  return steuersatzregel(artikelId, verzehrart, zeitpunkt as never)
}

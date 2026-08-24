/**
 * Die Farbwelt der Kasse — und die einzige Stelle, an der sie steht.
 *
 * Hier liegen nicht nur die Farbwerte, sondern auch die **Flächen**: welche
 * Schrift auf welchem Grund steht. Das ist der Unterschied zwischen einer
 * Farbtabelle und einer prüfbaren Aussage. Eine Farbe für sich ist weder
 * lesbar noch unlesbar; lesbar ist immer nur ein Paar.
 *
 * `stil.css` schreibt die Werte als Custom Properties noch einmal hin — CSS
 * kann keine TypeScript-Datei lesen. Damit die beiden nicht auseinanderlaufen,
 * prüft `test/farben.test.ts` die CSS-Datei gegen diese hier: jeder Farbwert
 * im Stylesheet muss aus der Palette stammen, und jede Fläche, die dort
 * Schrift und Grund zugleich setzt, muss unten eingetragen sein.
 *
 * Der Kontrast wird gegen **4,5:1** geprüft (WCAG 2.2, Stufe AA für Fließtext).
 * Eine Kasse steht in wechselndem Licht, oft mit Sonne im Fenster, und wird
 * von Menschen jeden Alters bedient. Die Schwelle ist hier kein Abzeichen,
 * sondern Betriebsbedingung.
 */

/** Die Markenfarben. Mehr gibt es nicht. */
export const PALETTE = {
  mint: '#ABE6CF',
  tuerkis: '#5DD5D6',
  koralle: '#FF7D7D',
  pfirsich: '#FFC69E',
  beere: '#B03A6A',
  neutral: '#F4F6F8',
  text: '#1F2937',
  weiss: '#FFFFFF',

  /**
   * Signalfarben — bewusst **keine** Markenfarben.
   *
   * Der TSE-Zustand ist kein Gestaltungselement, sondern eine Meldung über den
   * Betrieb. Würde er Türkis für „bereit" und Koralle für „ausgefallen"
   * benutzen, wären dieselben Farben gleichzeitig Auswahl und Alarm — und
   * niemand könnte am Farbton mehr ablesen, ob etwas hübsch oder kaputt ist.
   *
   * Diese drei sind dunkel genug, dass weisse Schrift auf ihnen liegen kann,
   * und unterscheiden sich auch in der Helligkeit, nicht nur im Farbton: rund
   * 8 % der Männer sehen Rot und Grün schlecht auseinander. Deshalb kommt zur
   * Farbe immer ein Zeichen und ein ausgeschriebenes Wort (siehe `TSE_ANZEIGE`).
   */
  signalGut: '#1B7A4B',
  signalWarnung: '#8A5A00',
  signalFehler: '#B02A2A',
} as const

export type Farbname = keyof typeof PALETTE

/**
 * Eine Fläche: ein Grund und die Schrift darauf.
 *
 * `zweck` steht dabei, weil eine Farbrolle ohne Zweck nach kurzer Zeit
 * aufgeweicht wird — Koralle ist für Warnung und Löschen reserviert, nicht
 * für „das rote da".
 */
export interface Flaeche {
  readonly name: string
  readonly grund: Farbname
  readonly schrift: Farbname
  readonly zweck: string
}

/**
 * Jede Fläche, die die Oberfläche malt.
 *
 * Weisse Schrift steht **nur** auf Beere. Auf Mint, Türkis, Koralle und
 * Pfirsich liegt sie bei 1,40:1 bis 2,48:1 — das ist nicht knapp, das ist
 * unlesbar. Dort steht dunkle Schrift, und die kommt auf 5,93:1 bis 10,45:1.
 */
export const FLAECHEN: readonly Flaeche[] = [
  { name: 'Anwendung', grund: 'neutral', schrift: 'text', zweck: 'Hintergrund der ganzen Kasse' },
  { name: 'Karte', grund: 'weiss', schrift: 'text', zweck: 'Bon, Dialoge, abgesetzte Bereiche' },
  { name: 'Artikelkachel', grund: 'weiss', schrift: 'text', zweck: 'Artikel im Raster' },
  { name: 'Warengruppe', grund: 'neutral', schrift: 'text', zweck: 'Gruppe, nicht gewaehlt' },
  { name: 'Warengruppe aktiv', grund: 'tuerkis', schrift: 'text', zweck: 'Gruppe, gewaehlt' },
  { name: 'Verzehrart gewaehlt', grund: 'tuerkis', schrift: 'text', zweck: 'Hier essen / Mitnehmen, aktiv' },
  { name: 'Kopfzeile', grund: 'mint', schrift: 'text', zweck: 'Kopf der Anwendung' },
  { name: 'Summenzeile', grund: 'mint', schrift: 'text', zweck: 'Gesamtbetrag im Bon' },
  { name: 'Hinweis', grund: 'pfirsich', schrift: 'text', zweck: 'Hervorhebung, Rueckgeld' },
  { name: 'Primaeraktion', grund: 'beere', schrift: 'weiss', zweck: 'Zahlen, Bar abschliessen' },
  { name: 'Warnung', grund: 'koralle', schrift: 'text', zweck: 'Fehlermeldung, Position loeschen' },
  { name: 'TSE bereit', grund: 'signalGut', schrift: 'weiss', zweck: 'Zustandsanzeige' },
  { name: 'TSE gestoert', grund: 'signalWarnung', schrift: 'weiss', zweck: 'Zustandsanzeige' },
  { name: 'TSE ausgefallen', grund: 'signalFehler', schrift: 'weiss', zweck: 'Zustandsanzeige' },
]

// --- Kontrast ---------------------------------------------------------------

/** Relative Leuchtdichte nach WCAG 2.2, 1.4.3. */
export function leuchtdichte(hex: string): number {
  const kanal = (roh: number): number => {
    const c = roh / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const zahl = Number.parseInt(hex.slice(1), 16)
  return (
    0.2126 * kanal((zahl >> 16) & 0xff) +
    0.7152 * kanal((zahl >> 8) & 0xff) +
    0.0722 * kanal(zahl & 0xff)
  )
}

/** Kontrastverhaeltnis zweier Farben, immer >= 1. */
export function kontrast(a: string, b: string): number {
  const la = leuchtdichte(a)
  const lb = leuchtdichte(b)
  const [hell, dunkel] = la > lb ? [la, lb] : [lb, la]
  return (hell + 0.05) / (dunkel + 0.05)
}

/** WCAG 2.2 AA fuer Fliesstext. */
export const MINDESTKONTRAST = 4.5

/**
 * WCAG 2.2 AA fuer grafische Elemente und Bedienelement-Grenzen (1.4.11).
 *
 * Gilt fuer den Punkt der Zustandsanzeige gegen seinen Grund und fuer Raender,
 * die eine Kachel abgrenzen — nicht fuer Schrift.
 */
export const MINDESTKONTRAST_GRAFIK = 3

// --- Zustandsanzeige --------------------------------------------------------

export type TseAnzeigeStatus = 'bereit' | 'gestoert' | 'ausgefallen' | 'unbekannt'

/**
 * Farbe **und** Zeichen **und** Wort.
 *
 * Regel 15 verlangt, dass ein unklarer Zustand nicht als klarer durchgeht. Das
 * gilt auch fuer die Anzeige: wer Rot und Gruen schlecht unterscheidet, sieht
 * bei reiner Farbcodierung keinen Unterschied zwischen „bereit" und
 * „ausgefallen". Deshalb traegt jeder Zustand zusaetzlich ein Zeichen und ein
 * ausgeschriebenes Wort. Die Farbe ist die schnellste, aber nicht die einzige
 * Information.
 */
export const TSE_ANZEIGE: Readonly<
  Record<TseAnzeigeStatus, { readonly farbe: Farbname; readonly zeichen: string; readonly wort: string }>
> = {
  bereit: { farbe: 'signalGut', zeichen: '✓', wort: 'TSE bereit' },
  gestoert: { farbe: 'signalWarnung', zeichen: '!', wort: 'TSE gestört' },
  ausgefallen: { farbe: 'signalFehler', zeichen: '✕', wort: 'TSE ausgefallen' },
  unbekannt: { farbe: 'signalWarnung', zeichen: '?', wort: 'TSE unbekannt' },
}

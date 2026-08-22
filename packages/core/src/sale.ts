/**
 * Der Bon — Positionen, Verzehrart, Rabatte, Abschluss.
 *
 * Der Bon ist die Faltung seiner Ereignisse, nicht ein veränderbares Objekt.
 * Das ist keine Stilfrage: der Event Log ist append-only (Regel 2), und jede
 * Änderung muss als eigenes Ereignis sichtbar bleiben (Regel 1).
 *
 * Plattformfrei und deterministisch — Zeit und IDs kommen von außen
 * (Regel 11).
 */

import {
  type Rabattverteilung,
  type RabattWert,
  type RabattZiel,
  mindereBasis,
  verteileRabatt,
} from './discount.js'
import { type Cents, addCents, cents, multiplyCents, negateCents } from './money.js'
import { type Verzehrart } from './receipt.js'
import { type Steuerzeile, type SteuersatzPromille, steuerausweis } from './tax.js'
import type { IsoTimestamp } from './time.js'

// --- Ereignisse ------------------------------------------------------------

/**
 * Woher die Verzehrart einer Position stammt.
 *
 * Wird mitgeschrieben, weil bei einer Prüfung nachvollziehbar sein muss,
 * *warum* ein Steuersatz galt — nicht nur, dass er galt (Regel 4).
 */
export type VerzehrartQuelle = 'bon' | 'position'

/**
 * Der Steuersatz als **Funktion** aus (Produkt, Verzehrart, Datum) — nicht als
 * Feld am Produkt (CLAUDE.md, Regel 4).
 *
 * Der Kern kennt die Regel nicht selbst; sie kommt von aussen, weil sie sich
 * mit dem Datum aendert (die Gastronomie-Absenkung von 2020 ist das bekannte
 * Beispiel) und aus den Stammdaten stammt.
 */
export type Steuersatzregel = (
  artikelId: string,
  verzehrart: Verzehrart,
  zeitpunkt: IsoTimestamp,
) => SteuersatzPromille

export interface SaleStarted {
  readonly type: 'SaleStarted'
  readonly saleId: string
  readonly deviceId: string
  readonly occurredAt: IsoTimestamp
  /** Verzehrart des Bons. Einzelne Positionen dürfen davon abweichen. */
  readonly verzehrart: Verzehrart
}

export interface LineAdded {
  readonly type: 'LineAdded'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly lineId: string
  /** Verweis auf den Artikel — noetig, um den Steuersatz neu zu bestimmen. */
  readonly artikelId: string
  readonly bezeichnung: string
  /** Darf negativ sein — Warenrücknahme oder Positionsstorno (DSFinV-K 4.2.5). */
  readonly menge: number
  readonly einzelpreis: Cents
  readonly steuersatzPromille: SteuersatzPromille
  readonly verzehrart: Verzehrart
  /** `'position'`, wenn die Verzehrart von der des Bons abweicht. */
  readonly verzehrartQuelle: VerzehrartQuelle
  /** Gesetzt, wenn diese Zeile eine vorherige ersetzt (Mengenänderung). */
  readonly ersetzt?: string
}

export interface LineVoided {
  readonly type: 'LineVoided'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly lineId: string
  /** Warum storniert wurde. Ein Storno ohne Grund ist kein Storno (Regel 1). */
  readonly grund: string
}

export interface DiscountApplied {
  readonly type: 'DiscountApplied'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly discountId: string
  readonly bezeichnung: string
  readonly ziel: RabattZiel
  /** Was gewährt wurde — die Entscheidung, nicht nur ihr Ergebnis. */
  readonly wert: RabattWert
  /** Was daraus wurde. Beides wird festgehalten (Regel 1). */
  readonly verteilung: Rabattverteilung
}

/**
 * Die Verzehrart des Bons wurde umgeschaltet.
 *
 * Regel 1 verbietet die **stille** Aenderung, nicht die Aenderung — ein
 * eigenes Ereignis ist der vorgesehene Weg. Es haelt fest, welche Zeilen
 * betroffen waren und welcher Steuersatz vorher und nachher galt. Bei einer
 * Pruefung ist genau das die Frage: warum 7 %.
 */
export interface DiningModeChanged {
  readonly type: 'DiningModeChanged'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly vorher: Verzehrart
  readonly nachher: Verzehrart
  readonly betroffen: readonly {
    readonly lineId: string
    readonly artikelId: string
    readonly vorherSteuersatzPromille: SteuersatzPromille
    readonly nachherSteuersatzPromille: SteuersatzPromille
  }[]
  /**
   * Zeilen, deren Verzehrart einzeln gesetzt wurde und die deshalb
   * unveraendert bleiben. Auch das gehoert festgehalten — sonst sieht es bei
   * einer Pruefung nach einem uebersehenen Fall aus.
   */
  readonly unberuehrt: readonly string[]
}

export interface PaymentTaken {
  readonly type: 'PaymentTaken'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly zahlart: 'bar' | 'karte' | 'gutschein' | 'sonstiges'
  readonly betrag: Cents
  readonly terminalBelegnummer?: string
}

export interface SaleFinished {
  readonly type: 'SaleFinished'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly gesamtbetrag: Cents
  readonly rueckgeld: Cents
}

export interface SaleCancelled {
  readonly type: 'SaleCancelled'
  readonly saleId: string
  readonly occurredAt: IsoTimestamp
  readonly grund: string
}

export type SaleEventData =
  | SaleStarted
  | LineAdded
  | LineVoided
  | DiningModeChanged
  | DiscountApplied
  | PaymentTaken
  | SaleFinished
  | SaleCancelled

// --- Zustand ---------------------------------------------------------------

export interface Bonzeile {
  readonly lineId: string
  readonly artikelId: string
  readonly bezeichnung: string
  readonly menge: number
  readonly einzelpreis: Cents
  readonly steuersatzPromille: SteuersatzPromille
  readonly verzehrart: Verzehrart
  readonly verzehrartQuelle: VerzehrartQuelle
  /** Storniert. Die Zeile bleibt stehen, sie wird nur nicht mehr gerechnet. */
  readonly storniert: boolean
  readonly stornogrund?: string
  readonly ersetzt?: string
}

export type Bonzustand = 'offen' | 'abgeschlossen' | 'abgebrochen'

export interface Bon {
  readonly saleId: string
  readonly deviceId: string
  readonly zustand: Bonzustand
  readonly verzehrart: Verzehrart
  readonly zeilen: readonly Bonzeile[]
  readonly rabatte: readonly DiscountApplied[]
  readonly zahlungen: readonly PaymentTaken[]
}

export class BonFehler extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BonFehler'
  }
}

/**
 * Zeilensumme einer Position — Menge mal Einzelpreis.
 *
 * `multiplyCents` verlangt eine nicht-negative Menge; hier ist sie auch
 * negativ zulaessig (Warenruecknahme, Positionsstorno — DSFinV-K 4.2.5).
 * Deshalb wird das Vorzeichen getrennt behandelt, statt die Regel im Kern
 * aufzuweichen.
 */
export function zeilensumme(zeile: Bonzeile): Cents {
  const betrag = multiplyCents(zeile.einzelpreis, Math.abs(zeile.menge))
  return zeile.menge < 0 ? negateCents(betrag) : betrag
}

/** Die Zeilen, die in die Rechnung eingehen — stornierte zählen nicht mit. */
export function aktiveZeilen(bon: Bon): Bonzeile[] {
  return bon.zeilen.filter((z) => !z.storniert)
}

/** Bemessungsgrundlage je Steuersatz, vor Rabatten. */
export function bemessungsgrundlage(bon: Bon): { steuersatzPromille: number; brutto: Cents }[] {
  const jeSatz = new Map<number, Cents>()
  for (const zeile of aktiveZeilen(bon)) {
    const bisher = jeSatz.get(zeile.steuersatzPromille) ?? cents(0)
    jeSatz.set(zeile.steuersatzPromille, addCents(bisher, zeilensumme(zeile)))
  }
  return [...jeSatz.entries()]
    .sort(([a], [b]) => a - b)
    .map(([steuersatzPromille, brutto]) => ({ steuersatzPromille, brutto }))
}

/** Bemessungsgrundlage je Steuersatz **nach** allen Rabatten. */
export function gemindeteBasis(bon: Bon): { steuersatzPromille: number; brutto: Cents }[] {
  let basis = bemessungsgrundlage(bon)
  for (const rabatt of bon.rabatte) basis = mindereBasis(basis, rabatt.verteilung)
  return basis
}

/** Steuerausweis des Bons — je Steuersatz einmal gerundet (Regel 17). */
export function bonSteuerausweis(bon: Bon): Steuerzeile[] {
  return steuerausweis(gemindeteBasis(bon))
}

/** Zu zahlender Gesamtbetrag. */
export function gesamtbetrag(bon: Bon): Cents {
  let summe = cents(0)
  for (const zeile of gemindeteBasis(bon)) summe = addCents(summe, zeile.brutto)
  return summe
}

/** Bereits gezahlt. */
export function gezahlt(bon: Bon): Cents {
  let summe = cents(0)
  for (const zahlung of bon.zahlungen) summe = addCents(summe, zahlung.betrag)
  return summe
}

// --- Faltung ---------------------------------------------------------------

/**
 * Baut den Bon aus seinen Ereignissen.
 *
 * Kein Ereignis verändert je ein früheres. Ein Storno setzt ein Kennzeichen,
 * die Zeile bleibt stehen — sonst wäre es eine stille Änderung (Regel 1).
 */
export function bonAusEreignissen(ereignisse: readonly SaleEventData[]): Bon {
  const erstes = ereignisse[0]
  if (erstes === undefined || erstes.type !== 'SaleStarted') {
    throw new BonFehler('Ein Bon beginnt mit SaleStarted, nicht mit ' + (erstes?.type ?? 'nichts'))
  }

  let bon: Bon = {
    saleId: erstes.saleId,
    deviceId: erstes.deviceId,
    zustand: 'offen',
    verzehrart: erstes.verzehrart,
    zeilen: [],
    rabatte: [],
    zahlungen: [],
  }

  for (const ereignis of ereignisse.slice(1)) {
    if (ereignis.saleId !== bon.saleId) {
      throw new BonFehler(
        'Ereignis gehoert zu einem anderen Bon: ' + ereignis.saleId + ' statt ' + bon.saleId,
      )
    }
    if (bon.zustand !== 'offen' && ereignis.type !== 'SaleCancelled') {
      throw new BonFehler(
        'Der Bon ist ' + bon.zustand + '; ' + ereignis.type + ' ist nicht mehr moeglich.',
      )
    }

    switch (ereignis.type) {
      case 'SaleStarted':
        throw new BonFehler('SaleStarted darf nur einmal vorkommen')

      case 'LineAdded': {
        if (bon.zeilen.some((z) => z.lineId === ereignis.lineId)) {
          throw new BonFehler('Positionsnummer schon vergeben: ' + ereignis.lineId)
        }
        const zeile: Bonzeile = {
          lineId: ereignis.lineId,
          artikelId: ereignis.artikelId,
          bezeichnung: ereignis.bezeichnung,
          menge: ereignis.menge,
          einzelpreis: ereignis.einzelpreis,
          steuersatzPromille: ereignis.steuersatzPromille,
          verzehrart: ereignis.verzehrart,
          verzehrartQuelle: ereignis.verzehrartQuelle,
          storniert: false,
          ...(ereignis.ersetzt === undefined ? {} : { ersetzt: ereignis.ersetzt }),
        }
        bon = { ...bon, zeilen: [...bon.zeilen, zeile] }
        break
      }

      case 'LineVoided': {
        const vorhanden = bon.zeilen.find((z) => z.lineId === ereignis.lineId)
        if (vorhanden === undefined) {
          throw new BonFehler('Unbekannte Position: ' + ereignis.lineId)
        }
        if (vorhanden.storniert) {
          throw new BonFehler('Position ist bereits storniert: ' + ereignis.lineId)
        }
        bon = {
          ...bon,
          zeilen: bon.zeilen.map((z) =>
            z.lineId === ereignis.lineId
              ? { ...z, storniert: true, stornogrund: ereignis.grund }
              : z,
          ),
        }
        break
      }

      case 'DiningModeChanged': {
        const betroffen = new Map(ereignis.betroffen.map((b) => [b.lineId, b]))
        bon = {
          ...bon,
          verzehrart: ereignis.nachher,
          zeilen: bon.zeilen.map((z) => {
            const aenderung = betroffen.get(z.lineId)
            return aenderung === undefined
              ? z
              : {
                  ...z,
                  verzehrart: ereignis.nachher,
                  steuersatzPromille: aenderung.nachherSteuersatzPromille,
                }
          }),
        }
        break
      }

      case 'DiscountApplied':
        bon = { ...bon, rabatte: [...bon.rabatte, ereignis] }
        break

      case 'PaymentTaken':
        bon = { ...bon, zahlungen: [...bon.zahlungen, ereignis] }
        break

      case 'SaleFinished':
        bon = { ...bon, zustand: 'abgeschlossen' }
        break

      case 'SaleCancelled':
        bon = { ...bon, zustand: 'abgebrochen' }
        break
    }
  }

  return bon
}

// --- Ereignisse erzeugen ---------------------------------------------------

/**
 * Die Kasse ruft diese Funktionen auf. Sie erzeugen Ereignisse, sie verändern
 * nichts — der neue Zustand entsteht durch erneutes Falten.
 *
 * `occurredAt` und die IDs kommen von außen (Regel 11).
 */
export interface Kontext {
  readonly occurredAt: IsoTimestamp
  readonly naechsteId: () => string
}

export function starteBon(
  kontext: Kontext,
  saleId: string,
  deviceId: string,
  verzehrart: Verzehrart,
): SaleStarted {
  return { type: 'SaleStarted', saleId, deviceId, occurredAt: kontext.occurredAt, verzehrart }
}

export interface PositionEingabe {
  readonly artikelId: string
  readonly bezeichnung: string
  readonly menge: number
  readonly einzelpreis: Cents
  /** Nur setzen, wenn die Position von der Verzehrart des Bons abweicht. */
  readonly verzehrart?: Verzehrart
}

export function fuegePositionHinzu(
  bon: Bon,
  kontext: Kontext,
  eingabe: PositionEingabe,
  regel: Steuersatzregel,
): LineAdded {
  if (eingabe.menge === 0) throw new BonFehler('Eine Position mit Menge null ergibt keinen Sinn')
  if (!Number.isSafeInteger(eingabe.menge)) {
    throw new BonFehler('Menge muss eine Ganzzahl sein: ' + String(eingabe.menge))
  }
  const abweichend = eingabe.verzehrart !== undefined && eingabe.verzehrart !== bon.verzehrart
  const verzehrart = eingabe.verzehrart ?? bon.verzehrart
  return {
    type: 'LineAdded',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    lineId: kontext.naechsteId(),
    artikelId: eingabe.artikelId,
    bezeichnung: eingabe.bezeichnung,
    menge: eingabe.menge,
    einzelpreis: eingabe.einzelpreis,
    // Der Steuersatz wird aus der Regel bestimmt, nicht uebergeben (Regel 4).
    steuersatzPromille: regel(eingabe.artikelId, verzehrart, kontext.occurredAt),
    verzehrart,
    verzehrartQuelle: abweichend ? 'position' : 'bon',
  }
}

/**
 * Schaltet die Verzehrart des ganzen Bons um.
 *
 * Drei Bedingungen:
 *
 * 1. Positionen mit eigener Verzehrart (Herkunft `'position'`) bleiben
 *    **unberuehrt**. Wer eine Zeile ausdruecklich abweichend gesetzt hat, will
 *    sie nicht vom Bon-Umschalter mitgerissen bekommen.
 * 2. Das Ereignis haelt fest, welche Zeilen betroffen waren und welcher
 *    Steuersatz vorher und nachher galt.
 * 3. Nur vor `SaleFinished` zulaessig.
 */
export function wechsleVerzehrart(
  bon: Bon,
  kontext: Kontext,
  nachher: Verzehrart,
  regel: Steuersatzregel,
): DiningModeChanged {
  if (bon.zustand !== 'offen') {
    throw new BonFehler(
      'Die Verzehrart laesst sich nur an einem offenen Bon aendern, dieser ist ' +
        bon.zustand +
        '.',
    )
  }
  if (nachher === bon.verzehrart) {
    throw new BonFehler('Die Verzehrart ist bereits ' + nachher)
  }

  const betroffen: DiningModeChanged['betroffen'][number][] = []
  const unberuehrt: string[] = []

  for (const zeile of bon.zeilen) {
    if (zeile.storniert) continue
    if (zeile.verzehrartQuelle === 'position') {
      unberuehrt.push(zeile.lineId)
      continue
    }
    betroffen.push({
      lineId: zeile.lineId,
      artikelId: zeile.artikelId,
      vorherSteuersatzPromille: zeile.steuersatzPromille,
      nachherSteuersatzPromille: regel(zeile.artikelId, nachher, kontext.occurredAt),
    })
  }

  return {
    type: 'DiningModeChanged',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    vorher: bon.verzehrart,
    nachher,
    betroffen,
    unberuehrt,
  }
}

export function stornierePosition(
  bon: Bon,
  kontext: Kontext,
  lineId: string,
  grund: string,
): LineVoided {
  if (grund.trim() === '') throw new BonFehler('Ein Storno braucht einen Grund (Regel 1)')
  const zeile = bon.zeilen.find((z) => z.lineId === lineId)
  if (zeile === undefined) throw new BonFehler('Unbekannte Position: ' + lineId)
  return { type: 'LineVoided', saleId: bon.saleId, occurredAt: kontext.occurredAt, lineId, grund }
}

/**
 * Ändert die Menge einer Position.
 *
 * Erzeugt **zwei** Ereignisse: die alte Zeile wird storniert, eine neue tritt
 * an ihre Stelle und verweist über `ersetzt` auf sie.
 *
 * Es gibt bewusst kein eigenes Ereignis „Menge geändert". Der Log ist
 * append-only, und die Historie soll zeigen, was tatsächlich passiert ist:
 * eine Position wurde zurückgenommen und eine andere erfasst. Bei einer
 * Prüfung ist das der aussagekräftigere Verlauf.
 */
export function aendereMenge(
  bon: Bon,
  kontext: Kontext,
  lineId: string,
  neueMenge: number,
): [LineVoided, LineAdded] {
  const zeile = bon.zeilen.find((z) => z.lineId === lineId)
  if (zeile === undefined) throw new BonFehler('Unbekannte Position: ' + lineId)
  if (zeile.storniert) throw new BonFehler('Position ist storniert: ' + lineId)
  if (neueMenge === 0) throw new BonFehler('Menge null — dann gehoert die Position storniert')

  const storno = stornierePosition(bon, kontext, lineId, 'Mengenaenderung')
  const neu: LineAdded = {
    type: 'LineAdded',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    lineId: kontext.naechsteId(),
    artikelId: zeile.artikelId,
    bezeichnung: zeile.bezeichnung,
    menge: neueMenge,
    einzelpreis: zeile.einzelpreis,
    steuersatzPromille: zeile.steuersatzPromille,
    verzehrart: zeile.verzehrart,
    verzehrartQuelle: zeile.verzehrartQuelle,
    ersetzt: lineId,
  }
  return [storno, neu]
}

/**
 * Gewährt einen Rabatt.
 *
 * Bei `ziel.art === 'bon'` wird über alle Steuersätze verteilt, bei
 * `'position'` liegt der ganze Rabatt auf dem Satz dieser Position.
 */
export function gewaehreRabatt(
  bon: Bon,
  kontext: Kontext,
  bezeichnung: string,
  ziel: RabattZiel,
  wert: RabattWert,
): DiscountApplied {
  const basis =
    ziel.art === 'bon'
      ? gemindeteBasis(bon)
      : (() => {
          const zeile = aktiveZeilen(bon).find((z) => z.lineId === ziel.positionId)
          if (zeile === undefined) {
            throw new BonFehler('Unbekannte oder stornierte Position: ' + ziel.positionId)
          }
          return [{ steuersatzPromille: zeile.steuersatzPromille, brutto: zeilensumme(zeile) }]
        })()

  return {
    type: 'DiscountApplied',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    discountId: kontext.naechsteId(),
    bezeichnung,
    ziel,
    wert,
    verteilung: verteileRabatt(basis, wert),
  }
}

export function nimmZahlung(
  bon: Bon,
  kontext: Kontext,
  zahlart: PaymentTaken['zahlart'],
  betrag: Cents,
  terminalBelegnummer?: string,
): PaymentTaken {
  return {
    type: 'PaymentTaken',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    zahlart,
    betrag,
    ...(terminalBelegnummer === undefined ? {} : { terminalBelegnummer }),
  }
}

export function schliesseBonAb(bon: Bon, kontext: Kontext): SaleFinished {
  const zuZahlen = gesamtbetrag(bon)
  const bezahlt = gezahlt(bon)
  if (bezahlt < zuZahlen) {
    throw new BonFehler(
      'Der Bon ist noch nicht bezahlt: ' + String(bezahlt) + ' von ' + String(zuZahlen) + ' Cent',
    )
  }
  return {
    type: 'SaleFinished',
    saleId: bon.saleId,
    occurredAt: kontext.occurredAt,
    gesamtbetrag: zuZahlen,
    rueckgeld: cents(bezahlt - zuZahlen),
  }
}

export function brichBonAb(bon: Bon, kontext: Kontext, grund: string): SaleCancelled {
  if (grund.trim() === '') throw new BonFehler('Ein Abbruch braucht einen Grund (Regel 1)')
  return { type: 'SaleCancelled', saleId: bon.saleId, occurredAt: kontext.occurredAt, grund }
}

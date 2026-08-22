/**
 * Der Verkaufsablauf — von der ersten Position bis zum gedruckten Beleg.
 *
 * ## Regel 6 gilt hier
 *
 * Zwischen `beginneBon()` und `schliesseAb()` liegt **keine** Entitlement-,
 * Abo- oder Netzwerkprüfung. Die einzigen Netzaufrufe auf diesem Weg gehen an
 * die TSE und an den Drucker — beides Geräte, keine Lizenzserver. Wer hier
 * etwas einbaut, das eine Freischaltung prüft, verstößt gegen Regel 6.
 *
 * ## Regel 8 gilt auch
 *
 * Fällt die TSE aus, wird der Verkauf trotzdem abgeschlossen. Der Beleg trägt
 * den Ausfallhinweis, die Signatur geht in die Warteschlange. Der Bon wird
 * **nicht** verweigert.
 */

import {
  type Beleg,
  type Belegposition,
  type Bon,
  type Cents,
  type SaleEventData,
  type Steuerzeile,
  type TseSignatur,
  type Verzehrart,
  type Zahlung,
  aktiveZeilen,
  bonAusEreignissen,
  bonSteuerausweis,
  bonZeilensumme,
  cents,
  fuegePositionHinzu,
  gemindeteBasis,
  gesamtbetrag,
  isoTimestamp,
  nimmZahlung,
  schliesseBonAb,
  starteBon,
  stornierePosition,
  STEUERSATZ,
  wechsleVerzehrart,
  type Kontext,
} from '@bonbon/core'
import { EscPosReceiptRenderer, type PrinterPort, type TsePort } from '@bonbon/ports'

import type { EventLogPort } from './adapter.js'
import type { Konfiguration } from './konfiguration.js'
import { artikel, steuersatzregel } from './stammdaten.js'

export interface Abschlussergebnis {
  readonly beleg: Beleg
  readonly signiert: boolean
  readonly ausfallgrund?: string
  readonly gedruckt: boolean
  readonly druckfehler?: string
  readonly ereignisse: number
}

export class Kasse {
  private ereignisse: SaleEventData[] = []
  private bonNummer = 0
  private idZaehler = 0

  constructor(
    private readonly konfiguration: Konfiguration,
    private readonly tse: TsePort,
    private readonly drucker: PrinterPort,
    private readonly eventLog: EventLogPort,
    private readonly onLog: (nachricht: string) => void,
  ) {}

  /** Zeit und IDs kommen von aussen in den Kern (Regel 11). */
  private kontext(): Kontext {
    return {
      occurredAt: isoTimestamp(jetztMitOffset()),
      naechsteId: () => {
        this.idZaehler += 1
        return 'L' + String(this.idZaehler).padStart(5, '0')
      },
    }
  }

  get bon(): Bon | undefined {
    return this.ereignisse.length === 0 ? undefined : bonAusEreignissen(this.ereignisse)
  }

  get offen(): boolean {
    return this.bon?.zustand === 'offen'
  }

  beginneBon(verzehrart: Verzehrart): Bon {
    this.bonNummer += 1
    this.idZaehler = 0
    const saleId = this.konfiguration.kasse.seriennummer + '-' + String(this.bonNummer).padStart(5, '0')
    this.ereignisse = [
      starteBon(this.kontext(), saleId, this.konfiguration.kasse.deviceId, verzehrart),
    ]
    return bonAusEreignissen(this.ereignisse)
  }

  /**
   * Legt eine Position an oder erhöht die Menge einer vorhandenen.
   *
   * Ein weiterer Tipp auf denselben Artikel erhöht die Menge — das erwartet
   * jeder, der schon einmal an einer Kasse stand. Umgesetzt als Storno plus
   * neue Zeile, weil der Log append-only ist (Regel 2).
   */
  tippeArtikel(artikelId: string): Bon {
    const bon = this.verlangeOffenenBon()
    const a = artikel(artikelId)
    const k = this.kontext()

    const vorhanden = aktiveZeilen(bon).find(
      (z) => z.artikelId === artikelId && z.verzehrartQuelle === 'bon' && z.menge > 0,
    )

    if (vorhanden === undefined) {
      this.ereignisse = [
        ...this.ereignisse,
        fuegePositionHinzu(
          bon,
          k,
          { artikelId: a.id, bezeichnung: a.bezeichnung, menge: 1, einzelpreis: a.preis },
          steuersatzregel,
        ),
      ]
    } else {
      const storno = stornierePosition(bon, k, vorhanden.lineId, 'Mengenaenderung')
      const nachStorno = bonAusEreignissen([...this.ereignisse, storno])
      const neu = fuegePositionHinzu(
        nachStorno,
        k,
        {
          artikelId: a.id,
          bezeichnung: a.bezeichnung,
          menge: vorhanden.menge + 1,
          einzelpreis: a.preis,
        },
        steuersatzregel,
      )
      this.ereignisse = [...this.ereignisse, storno, neu]
    }
    return bonAusEreignissen(this.ereignisse)
  }

  entfernePosition(lineId: string, grund = 'Vom Kassierer entfernt'): Bon {
    const bon = this.verlangeOffenenBon()
    this.ereignisse = [...this.ereignisse, stornierePosition(bon, this.kontext(), lineId, grund)]
    return bonAusEreignissen(this.ereignisse)
  }

  /** Der grosse Umschalter. Jederzeit vor dem Abschluss. */
  setzeVerzehrart(neu: Verzehrart): Bon {
    const bon = this.verlangeOffenenBon()
    if (bon.verzehrart === neu) return bon
    this.ereignisse = [
      ...this.ereignisse,
      wechsleVerzehrart(bon, this.kontext(), neu, steuersatzregel),
    ]
    return bonAusEreignissen(this.ereignisse)
  }

  /**
   * Schliesst den Bon ab: Zahlung, TSE-Signatur, Event Log, Bondruck.
   *
   * Alles über die vorhandenen Ports. Kein Schritt darf den Verkauf
   * verweigern — auch nicht der TSE-Ausfall (Regel 8).
   */
  async schliesseAb(
    zahlart: Zahlung['art'],
    gegeben: Cents,
    terminalBelegnummer?: string,
  ): Promise<Abschlussergebnis> {
    let bon = this.verlangeOffenenBon()
    if (aktiveZeilen(bon).length === 0) {
      throw new Error('Ein leerer Bon laesst sich nicht abschliessen')
    }

    const k = this.kontext()
    this.ereignisse = [
      ...this.ereignisse,
      nimmZahlung(bon, k, zahlart, gegeben, terminalBelegnummer),
    ]
    bon = bonAusEreignissen(this.ereignisse)

    const ende = schliesseBonAb(bon, k)
    this.ereignisse = [...this.ereignisse, ende]
    bon = bonAusEreignissen(this.ereignisse)

    // --- TSE ---
    const ausweis = bonSteuerausweis(bon)
    const ergebnis = await this.tse.signiere({
      belegreferenz: bon.saleId,
      kassenSeriennummer: this.konfiguration.kasse.seriennummer,
      umsaetze: {
        regel19: bruttoBei(ausweis, STEUERSATZ.regel),
        ermaessigt7: bruttoBei(ausweis, STEUERSATZ.ermaessigt),
        durchschnitt107: cents(0),
        durchschnitt55: cents(0),
        null0: bruttoBei(ausweis, STEUERSATZ.null),
      },
      zahlungen: [{ art: zahlart === 'bar' ? 'Bar' : 'Unbar', betrag: ende.gesamtbetrag }],
    })

    const signatur: TseSignatur | undefined =
      ergebnis.art === 'signiert' ? ergebnis.signatur : undefined
    if (ergebnis.art === 'ausgefallen') {
      // Regel 8: der Verkauf laeuft weiter, der Ausfall wird protokolliert.
      this.onLog('TSE ausgefallen — Beleg traegt den Hinweis, Signatur wird nachgeholt.')
    }

    // --- Event Log ---
    for (const ereignis of this.ereignisse) {
      await this.eventLog.anhaengen(
        this.konfiguration.kasse.deviceId,
        ereignis.type,
        JSON.stringify(ereignis),
        ereignis.occurredAt,
        bon.saleId + '-' + String(this.ereignisse.indexOf(ereignis)).padStart(3, '0'),
      )
    }

    // --- Beleg ---
    const beleg = this.baueBeleg(bon, ende.gesamtbetrag, ende.rueckgeld, zahlart, signatur, ergebnis.art === 'ausgefallen' ? ergebnis.grund : undefined, terminalBelegnummer)

    let gedruckt = false
    let druckfehler: string | undefined
    try {
      const bytes = new EscPosReceiptRenderer({
        charactersPerLine: this.drucker.info.charactersPerLine,
      }).render(beleg)
      await this.drucker.print(bytes)
      if (zahlart === 'bar' && this.konfiguration.drucker.kassenlade === true) {
        await this.drucker.openCashDrawer()
      }
      gedruckt = true
    } catch (fehler) {
      // Auch ein Druckfehler verweigert den Verkauf nicht — der Vorgang ist
      // erfasst und signiert. Der Beleg laesst sich nachdrucken.
      druckfehler = fehler instanceof Error ? fehler.message : String(fehler)
      this.onLog('Bondruck fehlgeschlagen: ' + druckfehler)
    }

    return {
      beleg,
      signiert: signatur !== undefined,
      ...(ergebnis.art === 'ausgefallen' ? { ausfallgrund: ergebnis.grund } : {}),
      gedruckt,
      ...(druckfehler === undefined ? {} : { druckfehler }),
      ereignisse: this.ereignisse.length,
    }
  }

  private baueBeleg(
    bon: Bon,
    gesamt: Cents,
    rueckgeld: Cents,
    zahlart: Zahlung['art'],
    signatur: TseSignatur | undefined,
    ausfallgrund: string | undefined,
    terminalBelegnummer: string | undefined,
  ): Beleg {
    const positionen: Belegposition[] = aktiveZeilen(bon).map((zeile, index) => ({
      position: index + 1,
      bezeichnung: zeile.bezeichnung,
      menge: zeile.menge,
      einzelpreis: zeile.einzelpreis,
      gesamtpreis: bonZeilensumme(zeile),
      steuersatzPromille: zeile.steuersatzPromille,
      verzehrart: zeile.verzehrart,
    }))

    return {
      haendler: this.konfiguration.haendler,
      belegnummer: bon.saleId,
      kasse: this.konfiguration.kasse.seriennummer,
      zeitpunkt: isoTimestamp(jetztMitOffset()),
      positionen,
      zahlungen: [
        {
          art: zahlart,
          betrag: gesamt,
          ...(terminalBelegnummer === undefined ? {} : { terminalBelegnummer }),
        },
      ],
      steuerausweis: bonSteuerausweis(bon),
      gesamtbetrag: gesamt,
      rueckgeld,
      ...(signatur === undefined ? {} : { signatur }),
      ...(ausfallgrund === undefined ? {} : { signaturAusfall: ausfallgrund }),
    }
  }

  private verlangeOffenenBon(): Bon {
    const bon = this.bon
    if (bon === undefined) throw new Error('Es ist kein Bon begonnen')
    if (bon.zustand !== 'offen') throw new Error('Der Bon ist ' + bon.zustand)
    return bon
  }
}

function bruttoBei(zeilen: readonly Steuerzeile[], satz: number): Cents {
  return zeilen.find((z) => z.steuersatzPromille === satz)?.brutto ?? cents(0)
}

/** ISO 8601 mit dem Offset der Maschine — nie ohne (Regel 11). */
export function jetztMitOffset(): string {
  const jetzt = new Date()
  const versatz = -jetzt.getTimezoneOffset()
  const vorzeichen = versatz >= 0 ? '+' : '-'
  const abs = Math.abs(versatz)
  const zwei = (n: number): string => String(n).padStart(2, '0')
  return (
    String(jetzt.getFullYear()) +
    '-' + zwei(jetzt.getMonth() + 1) +
    '-' + zwei(jetzt.getDate()) +
    'T' + zwei(jetzt.getHours()) +
    ':' + zwei(jetzt.getMinutes()) +
    ':' + zwei(jetzt.getSeconds()) +
    vorzeichen + zwei(Math.floor(abs / 60)) + ':' + zwei(abs % 60)
  )
}

/**
 * Schnellbeträge für die Barzahlung, aus dem echten Bonbetrag berechnet.
 *
 * Bei 7,40 € also: 7,40 (passend) / 8 / 10 / 20. Keine festen Stufen — der
 * passende Betrag steht immer vorn, weil er am häufigsten gebraucht wird.
 */
export function schnellbetraege(gesamt: Cents): Cents[] {
  const wert: number = gesamt
  if (wert <= 0) return []
  const betraege = new Set<number>([wert])
  // Auf den nächsten vollen Euro, dann die üblichen Scheine darüber.
  const naechsterEuro = Math.ceil(wert / 100) * 100
  if (naechsterEuro !== wert) betraege.add(naechsterEuro)
  for (const schein of [500, 1000, 2000, 5000, 10_000]) {
    if (schein > wert) betraege.add(schein)
    if (betraege.size >= 4) break
  }
  return [...betraege].sort((a, b) => a - b).slice(0, 4).map((n) => cents(n))
}

export { gemindeteBasis, gesamtbetrag }

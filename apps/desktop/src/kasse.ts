/**
 * Der Verkaufsablauf — von der ersten Position bis zum gedruckten Beleg.
 *
 * ## Der Bon lebt im Log, von Anfang an
 *
 * Jedes Ereignis wird geschrieben, **wenn es passiert** — nicht beim
 * Abschluss. Ein Log, der erst am Ende schreibt, ist kein append-only-Log: bis
 * dahin liegt der ganze Vorgang nur im Arbeitsspeicher, und ein Absturz nimmt
 * ihn spurlos mit. Der Messwert aus dem M0-Lasttest traegt das: einzeln
 * geschriebene Ereignisse kosteten unter Stosslast p99 1,4 ms.
 *
 * Daraus folgt, dass die schreibenden Methoden asynchron sind. Das ist keine
 * Unbequemlichkeit, sondern die ehrliche Form: ein Ereignis ist erst erfasst,
 * wenn es auf dem Datentraeger steht.
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
 * **nicht** verweigert. Das gilt schon beim Bonbeginn: laesst sich die
 * TSE-Transaktion nicht oeffnen, laeuft der Bon weiter.
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
  brichBonAb,
  cents,
  fuegePositionHinzu,
  gemindeteBasis,
  gesamtbetrag,
  isoTimestamp,
  nimmZahlung,
  schliesseBonAb,
  setzeVerzehrartFuerPosition,
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

/** Ereignistypen, die einen Bon bilden. Alles andere im Log ist Technik. */
const BON_EREIGNISTYPEN = new Set<string>([
  'SaleStarted',
  'LineAdded',
  'LineVoided',
  'DiscountApplied',
  'DiningModeChanged',
  'PaymentTaken',
  'SaleFinished',
  'SaleCancelled',
])

/**
 * Ein technisches Ereignis, kein Bonereignis.
 *
 * Der Log haelt auch fest, was die Kasse beim Start aufgeloest hat. Regel 1
 * verbietet die stille Aenderung — eine offene TSE-Transaktion klammheimlich
 * zu schliessen waere genau das. `bonAusEreignissen` bekommt diese Ereignisse
 * nicht zu sehen: beim Zurueckholen eines Bons werden sie herausgefiltert.
 */
export const TSE_AUFGELOEST = 'TseTransaktionAufgeloest'

/**
 * Die Signaturdaten eines Vorgangs — als eigenes Ereignis im Log.
 *
 * Ohne dieses Ereignis waeren sie nur auf dem Papier und in der TSE. Stuerzt
 * die Kasse zwischen der Rueckkehr der Signatur und dem Festhalten ab, findet
 * der Abgleich ueber offene Transaktionen **nichts**: die Transaktion ist ja
 * abgeschlossen. Die Daten waeren dauerhaft aus dem Log verschwunden — und
 * niemand haette sie vermisst, weil nichts auf ihr Fehlen hinweist.
 */
export const TSE_SIGNATUR = 'TseSignaturErfasst'

/**
 * Die Kasse hat eine TSE-Transaktion geoeffnet.
 *
 * Am laufenden fiskaltrust-Launcher gemessen: die Antwort auf
 * `start-transaction` enthaelt keine Transaktionsnummer, und die TSE laesst
 * sich ueber die POS-Schnittstelle nicht fragen, was offen steht. Also merkt
 * die Kasse es sich selbst — sonst wuesste nach einem Absturz niemand, dass da
 * etwas offen ist.
 */
export const TSE_TRANSAKTION_BEGONNEN = 'TseTransaktionBegonnen'

/**
 * Der Gegenpart: es wurde signiert werden **sollen**, aber es ging nicht.
 *
 * Erst dieses Ereignis macht die Luecke unterscheidbar. Ein abgeschlossener Bon
 * ohne Signaturereignis ist sonst zweideutig — entweder ein dokumentierter
 * TSE-Ausfall (Regel 8, Nachsignierung faellig) oder ein Absturz zur
 * Unzeit. Das eine ist ein Zustand, das andere ein Datenverlust.
 */
export const TSE_SIGNATUR_AUSGEFALLEN = 'TseSignaturAusgefallen'

/** Ereignistypen, die einen Signaturnachweis darstellen — erfolgreich oder nicht. */
const SIGNATURNACHWEIS = [TSE_SIGNATUR, TSE_SIGNATUR_AUSGEFALLEN]

/** Ereignistypen, die einen Bon beenden. */
const BON_ABSCHLUSS = ['SaleFinished', 'SaleCancelled']

export class Kasse {
  private ereignisse: SaleEventData[] = []
  private bonNummer = 0
  private idZaehler = 0
  /** Die TSE-Transaktion des laufenden Bons, sofern eine geoeffnet wurde. */
  private tseTransaktion: string | undefined
  /** Warum keine geoeffnet werden konnte — geht auf den Beleg (Regel 8). */
  private tseBeginnAusfall: string | undefined

  constructor(
    private readonly konfiguration: Konfiguration,
    private readonly tse: TsePort,
    private readonly drucker: PrinterPort,
    private readonly eventLog: EventLogPort,
    private readonly onLog: (nachricht: string) => void,
  ) {}

  /**
   * Die Warteschlange, die Vorgaenge nacheinander abarbeitet.
   *
   * Seit die schreibenden Methoden asynchron sind, koennen zwei schnelle
   * Tipps sich ueberholen: beide lesen denselben Bon, beide rechnen die
   * naechste Ereignis-Id aus derselben Laenge aus, und der zweite Schreibvorgang
   * faellt ueber den Primaerschluessel. Gefunden im Beweislauf durch die
   * gebaute Anwendung — zwei Klicks auf denselben Artikel im Abstand von
   * 120 ms ergaben statt zwei Cappuccino nur einen, und der Bon stand auf
   * 7,70 statt 11,50 Euro.
   *
   * Die Reihenfolge gehoert deshalb hierher und nicht in die Oberflaeche: eine
   * Kasse mit einem Touchscreen bekommt Doppeltipps, ob sie will oder nicht.
   */
  private kette: Promise<unknown> = Promise.resolve()

  /**
   * Fuehrt Arbeit aus, sobald der vorherige Vorgang fertig ist.
   *
   * Auch nach einem Fehler geht es weiter — ein misslungener Tipp darf die
   * Kasse nicht fuer den Rest des Tages blockieren.
   */
  private reihum<T>(arbeit: () => Promise<T>): Promise<T> {
    const naechste = this.kette.then(arbeit, arbeit)
    this.kette = naechste.catch(() => undefined)
    return naechste
  }

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

  /** Die TSE-Transaktion des laufenden Bons — fuer Tests und Anzeige. */
  get laufendeTransaktion(): string | undefined {
    return this.tseTransaktion
  }

  // --- Schreiben -------------------------------------------------------------

  /**
   * Haengt Ereignisse an den Log und uebernimmt sie erst dann in den Bon.
   *
   * **Erst schreiben, dann uebernehmen.** Scheitert das Schreiben, hat auch
   * der Bon das Ereignis nicht — sonst liefen Anzeige und Aufzeichnung
   * auseinander, und die Kasse zeigte eine Position, die nirgends steht.
   */
  private async schreibe(...neue: SaleEventData[]): Promise<Bon> {
    let laufend = this.ereignisse.length
    for (const ereignis of neue) {
      await this.eventLog.anhaengen(
        this.konfiguration.kasse.deviceId,
        ereignis.type,
        JSON.stringify(ereignis),
        ereignis.occurredAt,
        ereignis.saleId + '-' + String(laufend).padStart(3, '0'),
        ereignis.saleId,
      )
      laufend += 1
    }
    this.ereignisse = [...this.ereignisse, ...neue]
    return bonAusEreignissen(this.ereignisse)
  }

  /**
   * Ein technisches Ereignis in den Log, ohne den Bon zu beruehren.
   *
   * Es traegt trotzdem die Belegnummer: nur so findet der Abgleich beim Start
   * heraus, ob zu einem abgeschlossenen Bon ein Signaturnachweis vorliegt.
   */
  private async schreibeTechnisch(
    type: string,
    nutzlast: object,
    id: string,
    saleId: string | undefined,
  ): Promise<void> {
    await this.eventLog.anhaengen(
      this.konfiguration.kasse.deviceId,
      type,
      JSON.stringify(nutzlast),
      isoTimestamp(jetztMitOffset()),
      id,
      saleId,
    )
  }

  /**
   * Haelt die Signaturdaten fest — sofort nach Rueckkehr der Signatur.
   *
   * Scheitert das Schreiben, wird der Verkauf **nicht** abgebrochen. Der
   * Vorgang ist signiert und der Kunde hat bezahlt; den Beleg deswegen nicht
   * auszugeben waere der groessere Schaden. Die Luecke wird gemeldet und beim
   * naechsten Start nachgetragen.
   */
  private async haltefestSignatur(
    saleId: string,
    signatur: TseSignatur,
    nachgetragen = false,
  ): Promise<void> {
    await this.schreibeTechnisch(
      TSE_SIGNATUR,
      { belegreferenz: saleId, nachgetragen, ...signatur },
      saleId + '-signatur' + (nachgetragen ? '-nachgetragen' : ''),
      saleId,
    )
  }

  private async haltefestAusfall(saleId: string, grund: string): Promise<void> {
    await this.schreibeTechnisch(
      TSE_SIGNATUR_AUSGEFALLEN,
      { belegreferenz: saleId, grund, zeitpunkt: isoTimestamp(jetztMitOffset()) },
      saleId + '-signatur-ausgefallen',
      saleId,
    )
  }

  // --- Einrichtung beim Start ------------------------------------------------

  /**
   * Holt die Kasse in einen brauchbaren Zustand — vor dem ersten Bon.
   *
   * Drei Dinge, die alle denselben Grund haben: die Kasse kann jederzeit
   * abgestuerzt sein, und der Zustand danach ist nicht leer.
   *
   * 1. Die Belegnummer kommt aus dem Log, nicht aus einer Zaehlung.
   * 2. Ein Bon, der begonnen und nie beendet wurde, bekommt sein
   *    `SaleCancelled`. Ein Vorgang, der spurlos verschwindet, ist die stille
   *    Aenderung aus Regel 1 — und die DSFinV-K will den Abbruch sehen.
   * 3. Offene TSE-Transaktionen werden gegen den Log abgeglichen.
   */
  async richteEin(): Promise<void> {
    await this.uebernimmBelegnummer()
    await this.loeseUnbeendeteBonsAuf()
    await this.gleicheOffeneTransaktionenAb()
    await this.trageFehlendeSignaturenNach()
  }

  /**
   * Die zuletzt vergebene Belegnummer, aus dem Log.
   *
   * Aus dem letzten `SaleStarted`, nicht aus einer Zaehlung: die Zaehlung
   * stimmte nur, solange jeder begonnene Bon auch abgeschlossen wurde. Sobald
   * ein Bon verworfen oder geparkt wird, vergaebe sie dieselbe Nummer zweimal.
   * Jetzt traegt jeder begonnene Bon seine Nummer im Log — auch der
   * verworfene.
   */
  private async uebernimmBelegnummer(): Promise<void> {
    const letztes = await this.eventLog.letztesEreignis(
      this.konfiguration.kasse.deviceId,
      'SaleStarted',
    )
    if (letztes === undefined) {
      this.bonNummer = 0
      return
    }
    const saleId = (JSON.parse(letztes.payload) as { saleId?: string }).saleId
    const nummer = saleId === undefined ? undefined : /(\d+)$/.exec(saleId)?.[1]
    if (nummer === undefined) {
      // Lieber laut scheitern als eine Nummer erfinden: dieselbe Belegnummer
      // ein zweites Mal zu vergeben ist nachtraeglich nicht zu reparieren.
      throw new Error(
        'Aus dem letzten SaleStarted laesst sich keine Belegnummer lesen: ' + letztes.payload,
      )
    }
    this.bonNummer = Number(nummer)
    this.onLog(
      'Zuletzt vergebene Belegnummer: ' +
        String(this.bonNummer) +
        ' — die naechste ist ' +
        String(this.bonNummer + 1) +
        '.',
    )
  }

  /** Die Bonereignisse eines Belegs, ohne die technischen. */
  private async bonAusLog(saleId: string): Promise<Bon | undefined> {
    const roh = await this.eventLog.ereignisseZuBeleg(this.konfiguration.kasse.deviceId, saleId)
    const bonereignisse = roh
      .filter((e) => BON_EREIGNISTYPEN.has(e.type))
      .map((e) => JSON.parse(e.payload) as SaleEventData)
    return bonereignisse.length === 0 ? undefined : bonAusEreignissen(bonereignisse)
  }

  /**
   * Jeder Bon, der begonnen und nie beendet wurde, wird als abgebrochen
   * festgehalten.
   *
   * **Alle**, nicht nur der letzte. Sonst bliebe ein aelterer Rest — etwa aus
   * einem Lauf, in dem der Abgleich selbst gescheitert ist — auf Dauer offen.
   *
   * Fortgesetzt wird keiner: was zwischen dem letzten geschriebenen Ereignis
   * und dem Absturz noch getippt wurde, weiss niemand, und ein halb
   * wiederhergestellter Bon waere schlechter als ein sauber abgebrochener.
   */
  private async loeseUnbeendeteBonsAuf(): Promise<void> {
    const offene = await this.eventLog.belege(
      this.konfiguration.kasse.deviceId,
      ['SaleStarted'],
      BON_ABSCHLUSS,
    )
    for (const saleId of offene) {
      const bon = await this.bonAusLog(saleId)
      if (bon === undefined || bon.zustand !== 'offen') continue

      const grund = 'Beim Start vorgefunden: begonnen und nie beendet'
      this.onLog('Unbeendeter Bon ' + saleId + ' gefunden — wird als abgebrochen festgehalten.')
      const abbruch = brichBonAb(bon, this.kontext(), grund)
      await this.eventLog.anhaengen(
        this.konfiguration.kasse.deviceId,
        abbruch.type,
        JSON.stringify(abbruch),
        abbruch.occurredAt,
        saleId + '-abbruch',
        saleId,
      )
    }
  }

  /**
   * Offene TSE-Transaktionen auflösen.
   *
   * **Der Log ist die Quelle, nicht die TSE.** Am laufenden fiskaltrust-Launcher
   * gemessen (`tools/tse-spike/src/tse-info-probe.ts`): die Antwort auf
   * `start-transaction` enthält genau eine Signatur und keine
   * Transaktionsnummer, und die Antwort des Zero-Receipts führt keine offenen
   * Transaktionen auf — anders als eine Runde lang angenommen. Die Middleware ordnet über `cbReceiptReference`
   * zu. Eine Kasse, die sich auf `offeneTransaktionen()` verlässt, hätte an
   * diesem Gerät gar keine Antwort bekommen.
   *
   * Also hält die Kasse selbst fest, wann sie eine Transaktion geöffnet hat
   * (`TseTransaktionBegonnen`), und weiß daraus, was offen steht: jeder Beleg
   * mit Transaktionsbeginn, aber ohne Signatur und ohne Auflösung.
   *
   * `offeneTransaktionen()` bleibt als **zweite** Quelle — für Reste, die nicht
   * von dieser Kasse stammen, und für Geräte, die die Frage beantworten können.
   * Antwortet sie nicht, ist das kein Beinbruch mehr; der Log weiß es ohnehin.
   *
   * Zwei Ausgänge, je nachdem, was der Log **zu genau diesem Beleg** sagt:
   *
   * - Bon **vollständig** (`SaleFinished` steht drin): der Absturz lag zwischen
   *   dem Schreiben und der Signatur. Die Transaktion wird abgeschlossen — der
   *   Vorgang hat stattgefunden.
   * - Sonst: die Transaktion wird als abgebrochen beendet.
   *
   * Nachgeschlagen wird über die Belegreferenz, nicht über „der zuletzt
   * begonnene Bon". Der Unterschied ist nicht kosmetisch: ein tatsächlich
   * stattgefundener Verkauf stünde sonst in der TSE als abgebrochen — eine
   * falsche Aufzeichnung.
   */
  private async gleicheOffeneTransaktionenAb(): Promise<void> {
    const geraet = this.konfiguration.kasse.deviceId

    // Was der Log weiss.
    const ausDemLog = await this.eventLog.belege(
      geraet,
      [TSE_TRANSAKTION_BEGONNEN],
      [TSE_SIGNATUR, TSE_AUFGELOEST],
    )

    // Was die TSE zusaetzlich weiss — falls sie die Frage beantworten kann.
    let ausDerTse: readonly { transaktionsnummer: string; belegreferenz?: string }[] = []
    try {
      ausDerTse = await this.tse.offeneTransaktionen()
    } catch (fehler) {
      this.onLog(
        'Die TSE beantwortet die Frage nach offenen Transaktionen nicht (' +
          (fehler instanceof Error ? fehler.message : String(fehler)) +
          ') — der Log wird trotzdem abgeglichen.',
      )
    }

    // Zusammenfuehren: erst die eigenen Belege, dann Fremdes ohne Zuordnung.
    const aufgaben: { belegreferenz?: string; transaktionsnummer?: string }[] = []
    for (const saleId of ausDemLog) {
      aufgaben.push({
        belegreferenz: saleId,
        ...(await this.transaktionsnummerZu(saleId)),
      })
    }
    for (const fremd of ausDerTse) {
      if (fremd.belegreferenz !== undefined && ausDemLog.includes(fremd.belegreferenz)) continue
      aufgaben.push({
        ...(fremd.belegreferenz === undefined ? {} : { belegreferenz: fremd.belegreferenz }),
        transaktionsnummer: fremd.transaktionsnummer,
      })
    }
    if (aufgaben.length === 0) return

    this.onLog(
      (aufgaben.length === 1
        ? 'Eine TSE-Transaktion steht offen'
        : String(aufgaben.length) + ' TSE-Transaktionen stehen offen') + ' und wird aufgeloest.',
    )

    for (const aufgabe of aufgaben) {
      const bon =
        aufgabe.belegreferenz === undefined
          ? undefined
          : await this.bonAusLog(aufgabe.belegreferenz)
      const vollstaendig = bon?.zustand === 'abgeschlossen' ? bon : undefined

      const ausgang =
        vollstaendig === undefined
          ? await this.brichVerwaisteTransaktionAb(aufgabe)
          : await this.beendeVerwaisteTransaktion(aufgabe, vollstaendig)

      // **Nur bei Erfolg festhalten.** Das Ereignis bedeutet „aufgeloest", nicht
      // „versucht". Wuerde ein gescheiterter Versuch mitgeschrieben, gaelte die
      // Transaktion beim naechsten Start als erledigt — und bliebe fuer immer
      // offen. Gefunden, als zwei Abstuerze hintereinander nachgestellt wurden.
      if (ausgang.ausgang === 'gescheitert') {
        this.onLog(
          'TSE-Transaktion ' +
            (aufgabe.transaktionsnummer ?? aufgabe.belegreferenz ?? '(ohne Angabe)') +
            ' nicht aufgeloest: ' +
            ausgang.meldung +
            ' — wird beim naechsten Start erneut versucht.',
        )
        continue
      }

      await this.schreibeTechnisch(
        TSE_AUFGELOEST,
        {
          transaktionsnummer: aufgabe.transaktionsnummer ?? null,
          belegreferenz: aufgabe.belegreferenz ?? null,
          ausgang: ausgang.ausgang,
          meldung: ausgang.meldung,
        },
        (aufgabe.belegreferenz ?? 'tse-' + (aufgabe.transaktionsnummer ?? 'unbekannt')) +
          '-tse-aufgeloest',
        aufgabe.belegreferenz,
      )
      this.onLog(
        'TSE-Transaktion ' +
          (aufgabe.transaktionsnummer ?? aufgabe.belegreferenz ?? '(ohne Angabe)') +
          ': ' +
          ausgang.ausgang +
          ' (' +
          ausgang.meldung +
          ')',
      )
    }
  }

  /** Die Transaktionsnummer aus dem Beginn-Ereignis, falls die TSE eine nannte. */
  private async transaktionsnummerZu(
    saleId: string,
  ): Promise<{ transaktionsnummer?: string }> {
    const roh = await this.eventLog.ereignisseZuBeleg(this.konfiguration.kasse.deviceId, saleId)
    const beginn = roh.find((e) => e.type === TSE_TRANSAKTION_BEGONNEN)
    if (beginn === undefined) return {}
    const nummer = (JSON.parse(beginn.payload) as { transaktionsnummer?: string })
      .transaktionsnummer
    return nummer === undefined ? {} : { transaktionsnummer: nummer }
  }

  /**
   * Abgeschlossene Bons ohne Signaturnachweis nachtragen.
   *
   * Der Fall, den der Transaktionsabgleich **nicht** sieht: die Kasse ist
   * zwischen der Rückkehr der Signatur und dem Festhalten abgestürzt. Die
   * Transaktion auf der TSE ist beendet, steht also nirgends offen — ohne
   * diesen Schritt wären die Signaturdaten dauerhaft weg, und nichts wiese auf
   * ihr Fehlen hin.
   *
   * Gefragt wird die TSE. Was sie liefert, wird als nachgetragen gekennzeichnet;
   * was sie nicht kennt, wird als Lücke vermerkt statt weggelassen. Antwortet
   * sie gar nicht, wird nichts geschrieben und beim nächsten Start erneut
   * versucht — „ich weiß es nicht" darf nicht zu „gibt es nicht" werden.
   */
  private async trageFehlendeSignaturenNach(): Promise<void> {
    const ohneNachweis = await this.eventLog.belege(
      this.konfiguration.kasse.deviceId,
      ['SaleFinished'],
      SIGNATURNACHWEIS,
    )
    if (ohneNachweis.length === 0) return

    this.onLog(
      String(ohneNachweis.length) +
        ' abgeschlossene(r) Bon(s) ohne Signaturnachweis — es wird bei der TSE nachgefragt.',
    )

    for (const saleId of ohneNachweis) {
      let signatur: TseSignatur | undefined
      try {
        signatur = await this.tse.signaturZu(saleId)
      } catch (fehler) {
        this.onLog(
          'Signatur zu ' +
            saleId +
            ' nicht erfragbar: ' +
            (fehler instanceof Error ? fehler.message : String(fehler)) +
            ' — wird beim naechsten Start nachgeholt.',
        )
        return
      }

      if (signatur === undefined) {
        await this.haltefestAusfall(
          saleId,
          'Beim Start nachgefragt: die TSE kennt zu diesem Beleg keine Signatur',
        )
        this.onLog('Zu ' + saleId + ' gibt es keine Signatur — die Luecke ist vermerkt.')
      } else {
        await this.haltefestSignatur(saleId, signatur, true)
        this.onLog(
          'Signatur zu ' +
            saleId +
            ' nachgetragen (Transaktion ' +
            signatur.transaktionsnummer +
            ').',
        )
      }
    }
  }

  private async beendeVerwaisteTransaktion(
    aufgabe: { transaktionsnummer?: string },
    bon: Bon,
  ): Promise<{ ausgang: string; meldung: string }> {
    const ergebnis = await this.tse.signiere({
      belegreferenz: bon.saleId,
      kassenSeriennummer: this.konfiguration.kasse.seriennummer,
      ...(aufgabe.transaktionsnummer === undefined
        ? {}
        : { transaktionsnummer: aufgabe.transaktionsnummer }),
      umsaetze: umsaetzeAus(bonSteuerausweis(bon)),
      zahlungen: [{ art: 'Bar', betrag: gesamtbetrag(bon) }],
    })
    if (ergebnis.art !== 'signiert') {
      return { ausgang: 'gescheitert', meldung: ergebnis.grund }
    }
    // Sofort festhalten — sonst wäre derselbe Verlust möglich, den dieser
    // Abgleich gerade repariert.
    await this.haltefestSignatur(bon.saleId, ergebnis.signatur, true)
    return { ausgang: 'abgeschlossen', meldung: 'Der Bon war im Log vollstaendig' }
  }

  private async brichVerwaisteTransaktionAb(aufgabe: {
    transaktionsnummer?: string
    belegreferenz?: string
  }): Promise<{ ausgang: string; meldung: string }> {
    const ergebnis = await this.tse.brichTransaktionAb({
      ...(aufgabe.transaktionsnummer === undefined
        ? {}
        : { transaktionsnummer: aufgabe.transaktionsnummer }),
      ...(aufgabe.belegreferenz === undefined ? {} : { belegreferenz: aufgabe.belegreferenz }),
      grund: 'Beim Start vorgefunden: kein abgeschlossener Bon im Log',
    })
    return ergebnis.art === 'abgebrochen'
      ? { ausgang: 'abgebrochen', meldung: 'Kein abgeschlossener Bon im Log' }
      : { ausgang: 'gescheitert', meldung: ergebnis.grund }
  }

  // --- Der Bon ---------------------------------------------------------------

  /**
   * Oeffnet einen Bon: Belegnummer, `SaleStarted` in den Log, TSE-Transaktion.
   *
   * **Erst der Log, dann die TSE.** Andersherum entstuende bei einem Fehler
   * beim Schreiben sofort eine Transaktion ohne lokales Gegenstueck — genau
   * der Rest, den der Abgleich beim Start muehsam aufloesen muss.
   *
   * Faellt die TSE beim Oeffnen aus, laeuft der Bon trotzdem (Regel 8). Der
   * Grund wird festgehalten und geht auf den Beleg.
   */
  async beginneBon(verzehrart: Verzehrart): Promise<Bon> {
    return this.reihum(() => this.beginneBonIntern(verzehrart))
  }

  private async beginneBonIntern(verzehrart: Verzehrart): Promise<Bon> {
    this.bonNummer += 1
    this.idZaehler = 0
    this.ereignisse = []
    this.tseTransaktion = undefined
    this.tseBeginnAusfall = undefined

    const saleId =
      this.konfiguration.kasse.seriennummer + '-' + String(this.bonNummer).padStart(5, '0')
    const bon = await this.schreibe(
      starteBon(this.kontext(), saleId, this.konfiguration.kasse.deviceId, verzehrart),
    )

    const begonnen = await this.tse.beginneTransaktion({
      belegreferenz: saleId,
      kassenSeriennummer: this.konfiguration.kasse.seriennummer,
    })
    if (begonnen.art === 'begonnen') {
      this.tseTransaktion = begonnen.transaktion.transaktionsnummer
      // Sofort festhalten: ab hier steht auf der TSE etwas offen, und nur der
      // Log weiss davon.
      await this.schreibeTechnisch(
        TSE_TRANSAKTION_BEGONNEN,
        {
          belegreferenz: saleId,
          transaktionsnummer: begonnen.transaktion.transaktionsnummer,
          startzeit: begonnen.transaktion.startzeit ?? null,
        },
        saleId + '-transaktionsbeginn',
        saleId,
      )
    } else {
      this.tseBeginnAusfall = begonnen.grund
      this.onLog('TSE-Transaktion nicht geoeffnet: ' + begonnen.grund + ' — der Bon laeuft weiter.')
    }
    return bon
  }

  /**
   * Verwirft den laufenden Bon.
   *
   * Er verschwindet nicht: `SaleCancelled` mit Grund geht in den Log, und die
   * TSE-Transaktion wird als abgebrochen beendet. Die Belegnummer ist damit
   * verbraucht und wird nicht neu vergeben — sonst gaebe es sie zweimal.
   */
  async brichAb(grund: string): Promise<Bon> {
    return this.reihum(() => this.brichAbIntern(grund))
  }

  private async brichAbIntern(grund: string): Promise<Bon> {
    const bon = this.verlangeOffenenBon()
    const abgebrochen = await this.schreibe(brichBonAb(bon, this.kontext(), grund))

    if (this.tseTransaktion !== undefined) {
      const ergebnis = await this.tse.brichTransaktionAb({
        transaktionsnummer: this.tseTransaktion,
        belegreferenz: bon.saleId,
        grund,
      })
      // Der geordnete Abbruch gehoert in den Log — sonst sucht der Abgleich
      // beim naechsten Start eine Transaktion, die es nicht mehr gibt. Aber
      // nur, wenn er auch gelungen ist: sonst bliebe sie offen und niemand
      // versuchte es noch einmal.
      if (ergebnis.art === 'abgebrochen') {
        await this.schreibeTechnisch(
          TSE_AUFGELOEST,
          {
            transaktionsnummer: this.tseTransaktion,
            belegreferenz: bon.saleId,
            ausgang: 'abgebrochen',
            meldung: grund,
          },
          bon.saleId + '-tse-aufgeloest',
          bon.saleId,
        )
      }
      if (ergebnis.art === 'ausgefallen') {
        this.onLog(
          'TSE-Transaktion ' +
            this.tseTransaktion +
            ' nicht abgebrochen: ' +
            ergebnis.grund +
            ' — sie wird beim naechsten Start aufgeloest.',
        )
      }
      this.tseTransaktion = undefined
    }
    return abgebrochen
  }

  /**
   * Legt eine Position an oder erhöht die Menge einer vorhandenen.
   *
   * Ein weiterer Tipp auf denselben Artikel erhöht die Menge — das erwartet
   * jeder, der schon einmal an einer Kasse stand. Umgesetzt als Storno plus
   * neue Zeile, weil der Log append-only ist (Regel 2).
   */
  async tippeArtikel(artikelId: string, vorgabe: Verzehrart = 'im-haus'): Promise<Bon> {
    return this.reihum(async () => {
      // Der Bon wird hier geoeffnet, nicht in der Oberflaeche. Sonst pruefen
      // zwei ueberlappende Tipps beide „ist ein Bon offen?" mit Nein und
      // eroeffnen zwei.
      if (this.bon === undefined || !this.offen) await this.beginneBonIntern(vorgabe)
      return this.tippeArtikelIntern(artikelId)
    })
  }

  private async tippeArtikelIntern(artikelId: string): Promise<Bon> {
    const bon = this.verlangeOffenenBon()
    const a = artikel(artikelId)
    const k = this.kontext()

    const vorhanden = aktiveZeilen(bon).find(
      (z) => z.artikelId === artikelId && z.verzehrartQuelle === 'bon' && z.menge > 0,
    )

    if (vorhanden === undefined) {
      return this.schreibe(
        fuegePositionHinzu(
          bon,
          k,
          { artikelId: a.id, bezeichnung: a.bezeichnung, menge: 1, einzelpreis: a.preis },
          steuersatzregel,
        ),
      )
    }

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
    return this.schreibe(storno, neu)
  }

  /**
   * Setzt die Verzehrart **einer Position** und spaltet die Zeile dafuer auf.
   *
   * Der alltaegliche Fall im Cafe: zwei Cappuccino, einer bleibt hier, einer
   * geht. Ohne Aufspaltung teilen sich zusammengefasste Zeilen eine Verzehrart,
   * und Regel 4 („pro Position ueberschreibbar") waere zwar aufgeschrieben,
   * aber nicht erreichbar.
   *
   * `menge` ist die Stueckzahl, die abgespalten wird — vorgabegemaess eine.
   * Ein Tipp auf den kleinen Umschalter bewegt also **ein** Stueck, und wer
   * beide bewegen will, tippt zweimal. Das ist berechenbarer als eine
   * Mengenabfrage, die bei zwei Stueck niemand ausfuellen will.
   */
  async setzeVerzehrartFuerPosition(
    lineId: string,
    verzehrart: Verzehrart,
    menge = 1,
  ): Promise<Bon> {
    return this.reihum(async () => {
      const bon = this.verlangeOffenenBon()
      return this.schreibe(
        ...setzeVerzehrartFuerPosition(bon, this.kontext(), lineId, menge, verzehrart, steuersatzregel),
      )
    })
  }

  async entfernePosition(lineId: string, grund = 'Vom Kassierer entfernt'): Promise<Bon> {
    return this.reihum(async () => {
      const bon = this.verlangeOffenenBon()
      return this.schreibe(stornierePosition(bon, this.kontext(), lineId, grund))
    })
  }

  /** Der grosse Umschalter. Jederzeit vor dem Abschluss. */
  async setzeVerzehrart(neu: Verzehrart): Promise<Bon> {
    return this.reihum(async () => {
      // Kein offener Bon: der Umschalter eroeffnet einen mit dieser Verzehrart.
      if (this.bon === undefined || !this.offen) return this.beginneBonIntern(neu)
      const bon = this.verlangeOffenenBon()
      if (bon.verzehrart === neu) return bon
      return this.schreibe(wechsleVerzehrart(bon, this.kontext(), neu, steuersatzregel))
    })
  }

  /**
   * Schliesst den Bon ab: Zahlung, Log, TSE-Signatur, Bondruck.
   *
   * **Der Log kommt vor der Signatur.** Stuerzt die Kasse dazwischen ab, sagt
   * der Log „abgeschlossen", waehrend die TSE-Transaktion noch offen steht —
   * und der Abgleich beim naechsten Start kann sie abschliessen. Andersherum
   * herum stuende ein signierter, ausgegebener Vorgang im Log als abgebrochen.
   * Von den beiden Fehlern ist der erste reparierbar, der zweite nicht.
   *
   * Kein Schritt darf den Verkauf verweigern — auch nicht der TSE-Ausfall
   * (Regel 8).
   */
  async schliesseAb(
    zahlart: Zahlung['art'],
    gegeben: Cents,
    terminalBelegnummer?: string,
  ): Promise<Abschlussergebnis> {
    return this.reihum(() => this.schliesseAbIntern(zahlart, gegeben, terminalBelegnummer))
  }

  private async schliesseAbIntern(
    zahlart: Zahlung['art'],
    gegeben: Cents,
    terminalBelegnummer?: string,
  ): Promise<Abschlussergebnis> {
    let bon = this.verlangeOffenenBon()
    if (aktiveZeilen(bon).length === 0) {
      throw new Error('Ein leerer Bon laesst sich nicht abschliessen')
    }

    const k = this.kontext()
    bon = await this.schreibe(nimmZahlung(bon, k, zahlart, gegeben, terminalBelegnummer))

    const ende = schliesseBonAb(bon, k)
    bon = await this.schreibe(ende)

    // --- TSE ---
    const ergebnis = await this.tse.signiere({
      belegreferenz: bon.saleId,
      kassenSeriennummer: this.konfiguration.kasse.seriennummer,
      ...(this.tseTransaktion === undefined ? {} : { transaktionsnummer: this.tseTransaktion }),
      umsaetze: umsaetzeAus(bonSteuerausweis(bon)),
      zahlungen: [{ art: zahlart === 'bar' ? 'Bar' : 'Unbar', betrag: ende.gesamtbetrag }],
    })
    this.tseTransaktion = undefined

    const signatur: TseSignatur | undefined =
      ergebnis.art === 'signiert' ? ergebnis.signatur : undefined
    const ausfallgrund =
      ergebnis.art === 'ausgefallen' ? ergebnis.grund : this.tseBeginnAusfall
    if (ergebnis.art === 'ausgefallen') {
      // Regel 8: der Verkauf laeuft weiter, der Ausfall wird protokolliert.
      this.onLog('TSE ausgefallen — Beleg traegt den Hinweis, Signatur wird nachgeholt.')
    }

    // --- Signaturdaten in den Log, sofort ---
    //
    // Hier ist der Absturzpunkt, den sonst niemand faende: die Transaktion ist
    // beendet, steht also nirgends mehr offen. Ohne dieses Ereignis waeren die
    // Signaturdaten dauerhaft aus dem Log verschwunden.
    //
    // Scheitert das Schreiben, wird der Verkauf **nicht** abgebrochen: der
    // Vorgang ist signiert, der Kunde hat bezahlt, und den Beleg deswegen nicht
    // auszugeben waere der groessere Schaden. Die Luecke wird gemeldet und beim
    // naechsten Start nachgetragen.
    try {
      if (signatur !== undefined) {
        await this.haltefestSignatur(bon.saleId, signatur)
      } else {
        await this.haltefestAusfall(bon.saleId, ausfallgrund ?? 'Keine Signatur')
      }
    } catch (fehler) {
      this.onLog(
        'Signaturdaten nicht in den Log geschrieben: ' +
          (fehler instanceof Error ? fehler.message : String(fehler)) +
          ' — sie werden beim naechsten Start nachgetragen.',
      )
    }

    // --- Beleg ---
    const beleg = this.baueBeleg(
      bon,
      ende.gesamtbetrag,
      ende.rueckgeld,
      zahlart,
      signatur,
      signatur === undefined ? (ausfallgrund ?? 'Keine Signatur') : undefined,
      terminalBelegnummer,
    )

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
      ...(signatur === undefined && ausfallgrund !== undefined ? { ausfallgrund } : {}),
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

/** Die Bruttosummen je Steuersatz in der Reihenfolge der DSFinV-K. */
function umsaetzeAus(ausweis: readonly Steuerzeile[]): {
  regel19: Cents
  ermaessigt7: Cents
  durchschnitt107: Cents
  durchschnitt55: Cents
  null0: Cents
} {
  return {
    regel19: bruttoBei(ausweis, STEUERSATZ.regel),
    ermaessigt7: bruttoBei(ausweis, STEUERSATZ.ermaessigt),
    durchschnitt107: cents(0),
    durchschnitt55: cents(0),
    null0: bruttoBei(ausweis, STEUERSATZ.null),
  }
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

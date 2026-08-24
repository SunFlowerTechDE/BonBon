/**
 * TsePort als Mock — lokale Fantasiesignaturen, Ausfall auf Knopfdruck.
 *
 * Er muss kaputtgehen koennen. Ein Mock, der immer funktioniert, testet nur den
 * Schoenwetterfall — und der Ausfallpfad ist bei einer Kasse der rechtlich
 * heikelste Teil (CLAUDE.md, Ports und Adapter).
 *
 * Die erzeugten Signaturen sind **keine** echten Signaturen. Sie haben das
 * Format des Pruefwerts nach KassenSichV, damit der Belegdruck und die
 * Zugehoerigkeitspruefung (Regel 14) damit arbeiten koennen — aber sie sind
 * kryptographisch wertlos und als solche gekennzeichnet.
 *
 * ## Warum der Mock sich etwas merkt
 *
 * Transaktionsnummer und Signaturzaehler laufen ueber Neustarts hinweg weiter,
 * und offene Transaktionen ueberdauern einen Absturz. Eine echte TSE tut das —
 * sie ist ein Geraet, kein Prozess. Ein Mock, der bei 1 wieder anfaengt und
 * seine offenen Transaktionen vergisst, verdeckt genau die Fehler, die im
 * Laden auffallen: eine wiederverwendete Transaktionsnummer und ein Vorgang,
 * der auf der TSE offen stehenbleibt.
 *
 * Ohne `speicher` verhaelt er sich wie bisher, also fluechtig — das ist der
 * richtige Vorgabefall fuer einen einzelnen Test.
 */

import type { Cents, TseSignatur } from '@bonbon/core'

import {
  type Abbruchanfrage,
  type Abbruchergebnis,
  type OffeneTransaktion,
  type Signieranfrage,
  type Signierergebnis,
  type Transaktionsbeginn,
  type Transaktionsergebnis,
  type TsePort,
  type TseStatus,
  type TseZustand,
} from './TsePort.js'

export type MockTseFehler =
  | { readonly art: 'keiner' }
  /** Die TSE antwortet nicht — Kabel raus, Stick defekt. */
  | { readonly art: 'ausgefallen'; readonly grund?: string }
  /** Sie antwortet, meldet aber ein Problem. Es wird weiter signiert. */
  | { readonly art: 'gestoert'; readonly meldung?: string }
  /** Sie braucht lange — die Kasse muss das aushalten. */
  | { readonly art: 'langsam'; readonly verzoegerungMs: number }

/** Was die TSE ueber einen Neustart hinweg behaelt. */
export interface MockTseGespeichert {
  readonly transaktionsnummer: number
  readonly signaturzaehler: number
  readonly offene: readonly {
    readonly transaktionsnummer: number
    readonly belegreferenz: string
    readonly startzeit: string
  }[]
  /**
   * Die erteilten Signaturen, nach Belegreferenz.
   *
   * Eine echte TSE fuehrt dafuer ihr Journal. Der Mock haelt sie im Zustand,
   * damit `signaturZu` nach einem Neustart noch antworten kann — sonst liesse
   * sich der Fall „abgestuerzt zwischen Signatur und Log" nicht nachstellen,
   * und der Test dafuer waere wertlos.
   */
  readonly signaturen?: Readonly<Record<string, TseSignatur>>
}

/**
 * Wo der Mock seinen Zustand ablegt.
 *
 * Ein eigener kleiner Port, damit der Mock nichts ueber Dateien wissen muss —
 * `@bonbon/ports` laeuft auch im Webview.
 */
export interface MockTseSpeicher {
  laden(): Promise<MockTseGespeichert | undefined>
  sichern(zustand: MockTseGespeichert): Promise<void>
}

/** Speicher im Arbeitsspeicher — fuer Tests, die einen Neustart nachstellen. */
export class MockTseSpeicherImRam implements MockTseSpeicher {
  private zustand: MockTseGespeichert | undefined

  async laden(): Promise<MockTseGespeichert | undefined> {
    return Promise.resolve(this.zustand)
  }

  async sichern(zustand: MockTseGespeichert): Promise<void> {
    this.zustand = zustand
    return Promise.resolve()
  }
}

export interface MockTseOptions {
  readonly seriennummer?: string
  readonly fehler?: MockTseFehler
  /**
   * Zeitquelle. Kommt von aussen, damit der Mock deterministisch testbar ist
   * (dieselbe Ueberlegung wie Regel 11, auch wenn sie nur fuer den Kern gilt).
   */
  readonly jetzt?: () => string
  readonly speicher?: MockTseSpeicher
  readonly onLog?: (message: string) => void
}

const schlafen = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Cent als Dezimaltext mit Punkt, wie im Pruefwert. */
function dezimal(betrag: Cents): string {
  const wert: number = betrag
  const negativ = wert < 0
  const abs = negativ ? -wert : wert
  const rest = abs % 100
  return (negativ ? '-' : '') + String((abs - rest) / 100) + '.' + String(rest).padStart(2, '0')
}

interface OffeneMockTransaktion {
  transaktionsnummer: number
  belegreferenz: string
  startzeit: string
}

export class MockTse implements TsePort {
  readonly info: { readonly target: string }
  private fehler: MockTseFehler
  private readonly seriennummer: string
  private readonly jetzt: () => string
  private readonly speicher: MockTseSpeicher | undefined
  private readonly onLog: (message: string) => void

  private transaktionsnummer = 0
  private signaturzaehler = 0
  private offene: OffeneMockTransaktion[] = []
  private signaturen = new Map<string, TseSignatur>()

  /** Vorgaenge, die signiert wurden — fuer Tests und die Anzeige. */
  readonly signierteVorgaenge: { belegreferenz: string; transaktionsnummer: number }[] = []
  /** Vorgaenge, die abgebrochen wurden. */
  readonly abgebrocheneVorgaenge: { transaktionsnummer: number; grund: string }[] = []

  constructor(options: MockTseOptions = {}) {
    this.fehler = options.fehler ?? { art: 'keiner' }
    this.seriennummer = options.seriennummer ?? 'MOCK-TSE-0000000000000000'
    this.jetzt = options.jetzt ?? ((): string => new Date().toISOString())
    this.speicher = options.speicher
    this.onLog = options.onLog ?? ((): void => undefined)
    this.info = { target: 'mock://tse' }
  }

  /**
   * Holt den gespeicherten Zustand zurueck.
   *
   * Muss vor der ersten Transaktion aufgerufen werden — ein Konstruktor kann
   * nicht warten. Ohne Speicher tut die Methode nichts.
   */
  async ladeZustand(): Promise<void> {
    const gespeichert = await this.speicher?.laden()
    if (gespeichert === undefined) return
    this.transaktionsnummer = gespeichert.transaktionsnummer
    this.signaturzaehler = gespeichert.signaturzaehler
    this.offene = gespeichert.offene.map((o) => ({ ...o }))
    this.signaturen = new Map(Object.entries(gespeichert.signaturen ?? {}))
    this.onLog(
      'TSE-Zustand uebernommen: Transaktion ' +
        String(this.transaktionsnummer) +
        ', Signaturzaehler ' +
        String(this.signaturzaehler) +
        ', offen: ' +
        (this.offene.length === 0
          ? 'keine'
          : this.offene.map((o) => o.transaktionsnummer).join(', ')),
    )
  }

  private async sichere(): Promise<void> {
    await this.speicher?.sichern({
      transaktionsnummer: this.transaktionsnummer,
      signaturzaehler: this.signaturzaehler,
      offene: this.offene.map((o) => ({ ...o })),
      signaturen: Object.fromEntries(this.signaturen),
    })
  }

  /** Fehlerbild zur Laufzeit umschalten — der Knopf aus CLAUDE.md. */
  setFehler(fehler: MockTseFehler): void {
    this.fehler = fehler
    this.onLog('TSE-Fehlerbild: ' + fehler.art)
  }

  get aktuellerFehler(): MockTseFehler {
    return this.fehler
  }

  async zustand(): Promise<TseZustand> {
    const status: TseStatus =
      this.fehler.art === 'ausgefallen'
        ? 'ausgefallen'
        : this.fehler.art === 'gestoert'
          ? 'gestoert'
          : 'bereit'

    const meldung =
      this.fehler.art === 'ausgefallen'
        ? (this.fehler.grund ?? 'TSE nicht erreichbar')
        : this.fehler.art === 'gestoert'
          ? (this.fehler.meldung ?? 'TSE meldet ein Problem')
          : 'TSE bereit (Mock — keine echte Signatur)'

    return Promise.resolve({ status, meldung, seriennummer: this.seriennummer })
  }

  async offeneTransaktionen(): Promise<readonly OffeneTransaktion[]> {
    if (this.fehler.art === 'ausgefallen') {
      // Eine ausgefallene TSE kann auch nicht Auskunft geben. Eine leere Liste
      // zurueckzugeben waere die gefaehrlichere Antwort: sie hiesse „nichts
      // offen", und die Kasse liesse einen Rest liegen.
      throw new Error(this.fehler.grund ?? 'TSE nicht erreichbar')
    }
    return Promise.resolve(
      this.offene.map((o) => ({
        transaktionsnummer: String(o.transaktionsnummer),
        belegreferenz: o.belegreferenz,
        startzeit: o.startzeit,
      })),
    )
  }

  async signaturZu(belegreferenz: string): Promise<TseSignatur | undefined> {
    if (this.fehler.art === 'ausgefallen') {
      // Nicht `undefined`: „ich weiss es nicht" ist etwas anderes als „gibt es
      // nicht", und nur der zweite Fall rechtfertigt es, eine Luecke als
      // endgueltig zu vermerken.
      throw new Error(this.fehler.grund ?? 'TSE nicht erreichbar')
    }
    return Promise.resolve(this.signaturen.get(belegreferenz))
  }

  async beginneTransaktion(anfrage: Transaktionsbeginn): Promise<Transaktionsergebnis> {
    if (this.fehler.art === 'langsam') await schlafen(this.fehler.verzoegerungMs)
    if (this.fehler.art === 'ausgefallen') {
      const grund = this.fehler.grund ?? 'TSE nicht erreichbar'
      this.onLog('Transaktionsbeginn fehlgeschlagen: ' + grund)
      return { art: 'ausgefallen', grund }
    }

    this.transaktionsnummer += 1
    this.signaturzaehler += 1
    const eintrag: OffeneMockTransaktion = {
      transaktionsnummer: this.transaktionsnummer,
      belegreferenz: anfrage.belegreferenz,
      startzeit: this.jetzt(),
    }
    this.offene.push(eintrag)
    await this.sichere()

    this.onLog(
      'Transaktion ' + String(eintrag.transaktionsnummer) + ' begonnen: ' + anfrage.belegreferenz,
    )
    return {
      art: 'begonnen',
      transaktion: {
        transaktionsnummer: String(eintrag.transaktionsnummer),
        belegreferenz: eintrag.belegreferenz,
        startzeit: eintrag.startzeit,
      },
    }
  }

  async brichTransaktionAb(anfrage: Abbruchanfrage): Promise<Abbruchergebnis> {
    if (this.fehler.art === 'langsam') await schlafen(this.fehler.verzoegerungMs)
    if (this.fehler.art === 'ausgefallen') {
      const grund = this.fehler.grund ?? 'TSE nicht erreichbar'
      return { art: 'ausgefallen', grund }
    }

    // Ueber die Nummer, sonst ueber die Belegreferenz — der fiskaltrust-Weg.
    const index =
      anfrage.transaktionsnummer !== undefined
        ? this.offene.findIndex((o) => o.transaktionsnummer === Number(anfrage.transaktionsnummer))
        : this.offene.findIndex((o) => o.belegreferenz === anfrage.belegreferenz)
    if (index === -1) {
      // Nicht offen — das ist kein Erfolg, und es wird auch nicht so gemeldet.
      return {
        art: 'ausgefallen',
        grund:
          'Nicht offen: ' +
          (anfrage.transaktionsnummer ?? anfrage.belegreferenz ?? '(ohne Angabe)'),
      }
    }
    const nummer = this.offene[index]?.transaktionsnummer ?? 0

    this.offene.splice(index, 1)
    this.signaturzaehler += 1
    this.abgebrocheneVorgaenge.push({ transaktionsnummer: nummer, grund: anfrage.grund })
    await this.sichere()

    this.onLog('Transaktion ' + String(nummer) + ' abgebrochen: ' + anfrage.grund)
    return { art: 'abgebrochen', transaktionsnummer: String(nummer) }
  }

  async signiere(anfrage: Signieranfrage): Promise<Signierergebnis> {
    if (this.fehler.art === 'langsam') await schlafen(this.fehler.verzoegerungMs)

    if (this.fehler.art === 'ausgefallen') {
      const grund = this.fehler.grund ?? 'TSE nicht erreichbar'
      this.onLog('Signierung fehlgeschlagen: ' + grund)
      return { art: 'ausgefallen', grund }
    }

    let nummer: number
    if (anfrage.transaktionsnummer === undefined) {
      // Kein Beginn vorausgegangen — Einzelbeleg, Beginn und Abschluss in
      // einem Schritt. Zwei Signaturen, wie bei einer echten TSE.
      this.transaktionsnummer += 1
      this.signaturzaehler += 2
      nummer = this.transaktionsnummer
    } else {
      nummer = Number(anfrage.transaktionsnummer)
      const index = this.offene.findIndex((o) => o.transaktionsnummer === nummer)
      if (index === -1) {
        // Die Transaktion, die beendet werden soll, steht nicht offen. Das
        // stillschweigend als Erfolg zu melden waere Regel 12: eine Signatur
        // ohne Vorgang.
        return {
          art: 'ausgefallen',
          grund: 'Transaktion ' + anfrage.transaktionsnummer + ' ist nicht offen',
        }
      }
      this.offene.splice(index, 1)
      this.signaturzaehler += 1
    }

    const zeitpunkt = this.jetzt()
    const u = anfrage.umsaetze
    const prozessdaten =
      'Beleg^' +
      [u.regel19, u.ermaessigt7, u.durchschnitt107, u.durchschnitt55, u.null0]
        .map(dezimal)
        .join('_') +
      '^' +
      anfrage.zahlungen.map((z) => dezimal(z.betrag) + ':' + z.art).join('|')

    const pruefwert = [
      'V0',
      anfrage.kassenSeriennummer,
      'Kassenbeleg-V1',
      prozessdaten,
      String(nummer),
      String(this.signaturzaehler),
    ].join(';')

    const signatur: TseSignatur = {
      transaktionsnummer: String(nummer),
      signaturzaehler: String(this.signaturzaehler),
      startzeit: zeitpunkt,
      logzeit: zeitpunkt,
      // Als Mock erkennbar. Eine Zeichenkette, die wie Base64 aussieht, aber
      // ausdruecklich sagt, was sie ist — damit sie niemand fuer eine echte
      // Signatur haelt (Regel 9: keine Konformitaetsversprechen).
      signatur: 'MOCK-KEINE-ECHTE-SIGNATUR-' + String(nummer).padStart(6, '0'),
      seriennummer: this.seriennummer,
      pruefwert,
      signaturalgorithmus: 'mock',
      zeitformat: 'utcTimeWithSeconds',
    }

    this.signaturen.set(anfrage.belegreferenz, signatur)
    await this.sichere()
    this.signierteVorgaenge.push({
      belegreferenz: anfrage.belegreferenz,
      transaktionsnummer: nummer,
    })
    this.onLog('signiert: ' + anfrage.belegreferenz + ' -> Transaktion ' + String(nummer))
    return { art: 'signiert', signatur }
  }

  reset(): void {
    this.transaktionsnummer = 0
    this.signaturzaehler = 0
    this.offene = []
    this.signaturen.clear()
    this.signierteVorgaenge.length = 0
    this.abgebrocheneVorgaenge.length = 0
    this.fehler = { art: 'keiner' }
  }
}

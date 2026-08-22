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
 */

import type { Cents, TseSignatur } from '@bonbon/core'

import {
  type Signieranfrage,
  type Signierergebnis,
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

export interface MockTseOptions {
  readonly seriennummer?: string
  readonly fehler?: MockTseFehler
  /**
   * Zeitquelle. Kommt von aussen, damit der Mock deterministisch testbar ist
   * (dieselbe Ueberlegung wie Regel 11, auch wenn sie nur fuer den Kern gilt).
   */
  readonly jetzt?: () => string
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

export class MockTse implements TsePort {
  readonly info: { readonly target: string }
  private fehler: MockTseFehler
  private readonly seriennummer: string
  private readonly jetzt: () => string
  private readonly onLog: (message: string) => void

  private transaktionsnummer = 0
  private signaturzaehler = 0

  /** Vorgaenge, die signiert wurden — fuer Tests und die Anzeige. */
  readonly signierteVorgaenge: { belegreferenz: string; transaktionsnummer: number }[] = []

  constructor(options: MockTseOptions = {}) {
    this.fehler = options.fehler ?? { art: 'keiner' }
    this.seriennummer = options.seriennummer ?? 'MOCK-TSE-0000000000000000'
    this.jetzt = options.jetzt ?? ((): string => new Date().toISOString())
    this.onLog = options.onLog ?? ((): void => undefined)
    this.info = { target: 'mock://tse' }
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

  async signiere(anfrage: Signieranfrage): Promise<Signierergebnis> {
    if (this.fehler.art === 'langsam') await schlafen(this.fehler.verzoegerungMs)

    if (this.fehler.art === 'ausgefallen') {
      const grund = this.fehler.grund ?? 'TSE nicht erreichbar'
      this.onLog('Signierung fehlgeschlagen: ' + grund)
      return { art: 'ausgefallen', grund }
    }

    this.transaktionsnummer += 1
    this.signaturzaehler += 2 // Start- und Abschlusssignatur, wie bei einer echten TSE

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
      String(this.transaktionsnummer),
      String(this.signaturzaehler),
    ].join(';')

    const signatur: TseSignatur = {
      transaktionsnummer: String(this.transaktionsnummer),
      signaturzaehler: String(this.signaturzaehler),
      startzeit: zeitpunkt,
      logzeit: zeitpunkt,
      // Als Mock erkennbar. Eine Zeichenkette, die wie Base64 aussieht, aber
      // ausdruecklich sagt, was sie ist — damit sie niemand fuer eine echte
      // Signatur haelt (Regel 9: keine Konformitaetsversprechen).
      signatur: 'MOCK-KEINE-ECHTE-SIGNATUR-' + String(this.transaktionsnummer).padStart(6, '0'),
      seriennummer: this.seriennummer,
      pruefwert,
      signaturalgorithmus: 'mock',
      zeitformat: 'utcTimeWithSeconds',
    }

    this.signierteVorgaenge.push({
      belegreferenz: anfrage.belegreferenz,
      transaktionsnummer: this.transaktionsnummer,
    })
    this.onLog(
      'signiert: ' + anfrage.belegreferenz + ' -> Transaktion ' + String(this.transaktionsnummer),
    )
    return { art: 'signiert', signatur }
  }

  reset(): void {
    this.transaktionsnummer = 0
    this.signaturzaehler = 0
    this.signierteVorgaenge.length = 0
    this.fehler = { art: 'keiner' }
  }
}

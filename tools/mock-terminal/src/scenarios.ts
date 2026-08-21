/**
 * Fehlerbilder des Mock-Terminals.
 *
 * Ein Mock, der immer funktioniert, testet nur den Schoenwetterfall — und der
 * Ausfallpfad ist bei einer Kasse der rechtlich heikelste Teil (CLAUDE.md,
 * Ports und Adapter). Deshalb ist jedes Fehlerbild einzeln anwaehlbar und zur
 * Laufzeit umschaltbar, ohne Neustart.
 */

import { RESULT_CODE } from '@bonbon/ports'

export type ScenarioName =
  | 'erfolg'
  | 'ablehnung-deckung'
  | 'ablehnung-gesperrt'
  | 'timeout'
  | 'kundenabbruch'
  | 'abriss-nach-autorisierung'

export interface Scenario {
  readonly name: ScenarioName
  readonly beschreibung: string
  /** Ergebniscode in BMP 27 der Status-Information. */
  readonly resultCode: number
  /** Nach den Zwischenstaenden gar nicht mehr antworten. */
  readonly stallAfterIntermediates?: boolean
  /**
   * Verbindung kappen, nachdem intern autorisiert wurde, aber bevor die
   * Status-Information rausgeht.
   */
  readonly dropAfterAuthorisation?: boolean
  /** Zwischenstaende, die vor dem Ergebnis gesendet werden. */
  readonly intermediates: readonly number[]
}

const KARTE_UND_PIN = [0x0a, 0x01, 0x6d, 0x17] as const // einstecken, PIN-Pad, PIN eingegeben, Zahlung laeuft

export const SCENARIOS: Readonly<Record<ScenarioName, Scenario>> = {
  erfolg: {
    name: 'erfolg',
    beschreibung: 'Zahlung wird angenommen',
    resultCode: RESULT_CODE.noError,
    intermediates: [...KARTE_UND_PIN, 0xf2, 0x0b],
  },
  'ablehnung-deckung': {
    name: 'ablehnung-deckung',
    beschreibung: 'Karte lehnt ab — Guthaben nicht ausreichend',
    resultCode: RESULT_CODE.creditNotSufficient,
    intermediates: [...KARTE_UND_PIN, 0xf2, 0x0b],
  },
  'ablehnung-gesperrt': {
    name: 'ablehnung-gesperrt',
    beschreibung: 'Karte lehnt ab — Karte in Sperrliste',
    resultCode: RESULT_CODE.cardInBlockedList,
    intermediates: [0x0a, 0x01, 0x0b],
  },
  timeout: {
    name: 'timeout',
    beschreibung: 'Terminal antwortet nach den Zwischenstaenden nicht mehr',
    resultCode: RESULT_CODE.processingError,
    stallAfterIntermediates: true,
    intermediates: [0x0a, 0x01],
  },
  kundenabbruch: {
    name: 'kundenabbruch',
    beschreibung: 'Kunde bricht mitten in der Zahlung ab (Abbruchtaste)',
    resultCode: RESULT_CODE.abortViaTimeoutOrAbortKey,
    intermediates: [0x0a, 0x01, 0x0d],
  },
  'abriss-nach-autorisierung': {
    name: 'abriss-nach-autorisierung',
    beschreibung:
      'AUTORISIERT, dann Verbindungsabriss VOR der Antwort — die Kasse erfaehrt das Ergebnis nie',
    resultCode: RESULT_CODE.noError,
    dropAfterAuthorisation: true,
    intermediates: [...KARTE_UND_PIN, 0xf2],
  },
}

export function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(SCENARIOS, value)
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[]

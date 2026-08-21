/**
 * ZVT — Befehle, Ergebniscodes und Zwischenstatus.
 *
 * Alle Werte aus PA00P015_13.09_final_en.pdf (VdTH), Kapitel 14 "Summary of
 * Commands", Kapitel 10 "Error-Messages" und Tabelle 17 "Definition of
 * <intermediate-status>".
 *
 * ## Warum die Texte gegengeprueft wurden
 *
 * Die Tabellen im PDF sind mehrspaltig (hex / dezimal / englisch / deutsch).
 * Beim Extrahieren verrutscht die **englische** Spalte um eine Zeile, die
 * deutsche nicht: bei 0A steht englisch "Expired card", deutsch aber "Karte
 * einstecken". Massgeblich ist die deutsche Spalte — sie stimmt mit der
 * Umsetzung von Portalum.Zvt ueberein, die gegen echte Terminals entwickelt
 * wurde. Wer die Werte aendert, prueft bitte beide Quellen.
 */

// --- Steuerfelder ----------------------------------------------------------

/** Befehle der Kasse an das Terminal (ECR -> PT). */
export const ECR_COMMAND = {
  /** 06 00 Registration */
  registration: [0x06, 0x00],
  /** 06 01 Authorisation */
  authorisation: [0x06, 0x01],
  /** 06 02 Log-Off */
  logOff: [0x06, 0x02],
  /** 06 30 Reversal — Storno, braucht 87<receipt-no> */
  reversal: [0x06, 0x30],
  /** 06 50 End-of-Day — Kassenschnitt */
  endOfDay: [0x06, 0x50],
  /** 06 B0 Abort — Abbruch durch die Kasse */
  abort: [0x06, 0xb0],
  /** 05 01 Status-Enquiry */
  statusEnquiry: [0x05, 0x01],
} as const

/** Befehle des Terminals an die Kasse (PT -> ECR). */
export const PT_COMMAND = {
  /** 04 0F Status-Information — traegt das Ergebnis in BMP 27 */
  statusInformation: [0x04, 0x0f],
  /** 04 FF Intermediate Status-Information */
  intermediateStatus: [0x04, 0xff],
  /** 06 0F Completion — Vorgang abgeschlossen */
  completion: [0x06, 0x0f],
  /** 06 1E Abort — Vorgang abgebrochen, traegt <result-code> */
  abort: [0x06, 0x1e],
  /** 06 D1 Print Line */
  printLine: [0x06, 0xd1],
} as const

/**
 * Quittungen der Transportschicht.
 *
 * "80 00 Positive Acknowledgement / 84 00 Positive Acknowledgement /
 *  84 xx Negative Acknowledgement / 84 9C Repeat Statusinfo"
 */
export const ACK = {
  positive: [0x80, 0x00],
  positiveAlt: [0x84, 0x00],
  negative: [0x84, 0x66],
  /**
   * 84 9C — Repeat Statusinfo.
   *
   * Der dokumentierte Weg der Kasse, eine verlorene Status-Information erneut
   * anzufordern. Genau das Werkzeug fuer den Fall "autorisiert, aber Antwort
   * nie angekommen".
   */
  repeatStatusInformation: [0x84, 0x9c],
} as const

export function isPositiveAck(controlClass: number, controlInstruction: number): boolean {
  return (
    (controlClass === 0x80 && controlInstruction === 0x00) ||
    (controlClass === 0x84 && controlInstruction === 0x00)
  )
}

// --- Ergebniscodes (BMP 27) ------------------------------------------------

/**
 * Kapitel 10 "Error-Messages". Nur die Codes, die dieser Spike erzeugt oder
 * auswertet; die Tabelle hat 89 Eintraege.
 */
export const RESULT_CODE = {
  noError: 0x00,
  cardNotReadable: 0x64,
  cardDataMissing: 0x65,
  processingError: 0x66,
  functionNotPermittedEcMaestro: 0x67,
  functionNotPermittedCredit: 0x6a,
  turnoverFileFull: 0x6b,
  /** "abort via timeout or abort-key" — auch der Abbruch durch den Kunden. */
  abortViaTimeoutOrAbortKey: 0x6c,
  cardInBlockedList: 0x6e,
  wrongCurrency: 0x6f,
  creditNotSufficient: 0x71,
  chipError: 0x72,
  cardDataIncorrect: 0x73,
  cardExpired: 0x78,
  cardNotYetValid: 0x79,
  cardUnknown: 0x7a,
  communicationError: 0x83,
  functionNotPossible: 0x85,
  reversalNotPossible: 0x9b,
  alreadyReversed: 0x9c,
} as const

export const RESULT_TEXT: ReadonlyMap<number, string> = new Map([
  [0x00, 'kein Fehler'],
  [0x64, 'Karte nicht lesbar (LRC-/Parity-Fehler)'],
  [0x65, 'Kartendaten nicht vorhanden'],
  [0x66, 'Verarbeitungsfehler'],
  [0x67, 'Funktion fuer ec- und Maestro-Karten nicht erlaubt'],
  [0x6a, 'Funktion fuer Kredit- und Tankkarten nicht erlaubt'],
  [0x6b, 'Umsatzdatei voll'],
  [0x6c, 'Abbruch durch Zeitablauf oder Abbruchtaste'],
  [0x6e, 'Karte in Sperrliste'],
  [0x6f, 'falsche Waehrung'],
  [0x71, 'Guthaben nicht ausreichend'],
  [0x72, 'Chipfehler'],
  [0x73, 'Kartendaten fehlerhaft'],
  [0x78, 'Karte verfallen'],
  [0x79, 'Karte noch nicht gueltig'],
  [0x7a, 'Karte unbekannt'],
  [0x83, 'Kommunikationsfehler'],
  [0x85, 'Funktion nicht moeglich'],
  [0x9b, 'Storno nicht moeglich'],
  [0x9c, 'bereits storniert'],
])

export function resultText(code: number): string {
  return (
    RESULT_TEXT.get(code) ??
    'unbekannter ZVT-Ergebniscode 0x' + code.toString(16).toUpperCase().padStart(2, '0')
  )
}

/**
 * Gilt dieser Ergebniscode als Abbruch statt als Ablehnung?
 *
 * Die Unterscheidung ist fachlich: bei einem Abbruch hat der Kunde die Zahlung
 * beendet, bei einer Ablehnung hat die Karte oder der Netzbetreiber
 * widersprochen. Fuer die Kasse laeuft beides auf "nicht bezahlt" hinaus, fuer
 * die Anzeige am Tresen nicht.
 */
export function isAbort(code: number): boolean {
  return code === RESULT_CODE.abortViaTimeoutOrAbortKey
}

// --- Zwischenstatus (04 FF) ------------------------------------------------

/** Tabelle 17, "Definition of <intermediate-status>". */
export const INTERMEDIATE_STATUS = {
  waitingForAmountConfirmation: 0x00,
  watchPinPad: 0x01,
  notAccepted: 0x03,
  waitingForFep: 0x04,
  sendingAutoReversal: 0x05,
  cardNotAdmitted: 0x07,
  cardUnknown: 0x08,
  expiredCard: 0x09,
  insertCard: 0x0a,
  removeCard: 0x0b,
  cardNotReadable: 0x0c,
  processingError: 0x0d,
  pleaseWait: 0x0e,
  pinEntered: 0x6d,
  approved: 0x17,
  offline: 0xf1,
  online: 0xf2,
} as const

export const INTERMEDIATE_TEXT: ReadonlyMap<number, string> = new Map([
  [0x00, 'Bitte Betrag bestaetigen'],
  [0x01, 'Bitte Anzeige auf dem PIN-Pad beachten'],
  [0x02, 'Bitte Anzeige auf dem PIN-Pad beachten'],
  [0x03, 'Vorgang nicht moeglich'],
  [0x04, 'Warte auf Antwort vom Netzbetreiber'],
  [0x05, 'Terminal sendet Autostorno'],
  [0x06, 'Terminal sendet Nachbuchungen'],
  [0x07, 'Karte nicht zugelassen'],
  [0x08, 'Karte unbekannt'],
  [0x09, 'Karte verfallen'],
  [0x0a, 'Karte einstecken'],
  [0x0b, 'Bitte Karte entnehmen'],
  [0x0c, 'Karte nicht lesbar'],
  [0x0d, 'Vorgang abgebrochen'],
  [0x0e, 'Vorgang wird bearbeitet, bitte warten'],
  [0x17, 'Zahlung laeuft'],
  [0x6d, 'PIN eingegeben'],
  [0xf1, 'Offline'],
  [0xf2, 'Online'],
])

export function intermediateText(code: number): string {
  return (
    INTERMEDIATE_TEXT.get(code) ??
    'Zwischenstatus 0x' + code.toString(16).toUpperCase().padStart(2, '0')
  )
}

// --- Sonstiges -------------------------------------------------------------

/** ISO 4217 numerisch. */
export const CURRENCY_EUR = 978

/** Vorgabepasswort vieler Terminals im Testbetrieb. */
export const DEFAULT_PASSWORD = 0

/**
 * Config-byte der Registrierung (Tabelle 1).
 *
 * Bit 1 gesetzt heisst: "ECR requests Intermediate Status-Information" — ohne
 * dieses Bit sendet das Terminal keine Zwischenstaende, und der Kassierer
 * sieht am Bildschirm nichts, waehrend der Kunde am Terminal steht.
 */
export const CONFIG_BYTE_WITH_INTERMEDIATE_STATUS = 0b1001_0110

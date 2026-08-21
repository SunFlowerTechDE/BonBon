/**
 * PrinterPort — die Geraeteschicht fuer Bondrucker.
 *
 * Die Anwendungslogik oeffnet niemals selbst einen Socket. Sie kennt nur dieses
 * Interface; welche Implementierung dahintersteht, entscheidet die Konfiguration
 * (CLAUDE.md, Ports und Adapter). Heute gibt es TCP und einen Mock, spaeter
 * kommt USB dazu, ohne dass sich am Aufrufer etwas aendert.
 */

/** Ein fertig kodierter Druckauftrag: rohe ESC/POS-Bytes. */
export type PrintJob = Uint8Array

export interface PrinterInfo {
  /** Woher die Bytes gehen, fuer Protokoll und Fehlermeldung. */
  readonly target: string
  /** Zeichen pro Zeile bei der eingestellten Papierbreite. */
  readonly charactersPerLine: number
}

export interface PrinterPort {
  readonly info: PrinterInfo

  /**
   * Sendet einen Druckauftrag. Loest bei Erfolg auf, wirft sonst — ein
   * verschluckter Druckfehler heisst, dass der Kunde keinen Beleg bekommt,
   * ohne dass es jemand merkt.
   */
  print(job: PrintJob): Promise<void>

  /**
   * Oeffnet die Kassenlade. Getrennt von `print`, weil die Lade auch ohne
   * Beleg aufgehen muss — etwa beim Kassensturz.
   */
  openCashDrawer(): Promise<void>

  /** Erreichbarkeit pruefen, ohne zu drucken. */
  isReachable(): Promise<boolean>
}

/**
 * Fehler der Geraeteschicht. Traegt das Ziel mit, damit in der Meldung steht,
 * welcher Drucker gemeint war.
 */
export class PrinterError extends Error {
  constructor(
    message: string,
    readonly target: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PrinterError'
  }
}

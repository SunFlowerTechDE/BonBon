/**
 * PrinterPort als Mock.
 *
 * Er muss kaputtgehen koennen. Ein Mock, der immer funktioniert, testet nur den
 * Schoenwetterfall — und der Ausfallpfad ist bei einer Kasse der rechtlich
 * heikelste Teil (CLAUDE.md, Ports und Adapter). Deshalb hat er Schalter fuer
 * Zeitueberschreitung, Ablehnung und Totalausfall.
 *
 * Das hier ist Produktionscode, kein Wegwerfzeug: er bleibt dauerhaft in der
 * Testsuite. Er benutzt weder Netzwerk noch Uhr und ist damit deterministisch.
 */

import { CHARACTERS_PER_LINE_80MM, cashDrawerPulse } from './escpos.js'
import { PrinterError, type PrinterInfo, type PrinterPort, type PrintJob } from './PrinterPort.js'

export type MockFailure =
  /** Alles laeuft. */
  | { readonly kind: 'none' }
  /** Verbindung wird abgewiesen — Drucker aus, falsche IP. */
  | { readonly kind: 'refused' }
  /** Verbindung steht, es kommt nichts zurueck — Drucker haengt. */
  | { readonly kind: 'timeout'; readonly afterMs?: number }
  /** Papier alle, Deckel offen, Schneidmesser blockiert. */
  | { readonly kind: 'outOfPaper' }
  /** Der Auftrag geht nur zum Teil raus — halber Bon. */
  | { readonly kind: 'partialWrite'; readonly bytesWritten: number }

export interface MockPrinterOptions {
  readonly charactersPerLine?: number
  readonly failure?: MockFailure
  readonly onLog?: (message: string) => void
}

export class MockPrinter implements PrinterPort {
  readonly info: PrinterInfo

  /** Alles, was gedruckt wurde — zum Nachprüfen im Test. */
  readonly jobs: Uint8Array[] = []
  /** Wie oft die Lade geoeffnet wurde. */
  drawerOpenCount = 0

  private failure: MockFailure

  constructor(options: MockPrinterOptions = {}) {
    this.failure = options.failure ?? { kind: 'none' }
    this.onLog = options.onLog ?? ((): void => undefined)
    this.info = {
      target: 'mock://printer',
      charactersPerLine: options.charactersPerLine ?? CHARACTERS_PER_LINE_80MM,
    }
  }

  private readonly onLog: (message: string) => void

  /** Fehlerbild zur Laufzeit umschalten — etwa mitten in einer Testfolge. */
  setFailure(failure: MockFailure): void {
    this.failure = failure
  }

  async print(job: PrintJob): Promise<void> {
    switch (this.failure.kind) {
      case 'refused':
        throw new PrinterError('Verbindung abgewiesen (Mock)', this.info.target, {
          cause: new Error('ECONNREFUSED'),
        })
      case 'timeout':
        throw new PrinterError(
          'Zeitueberschreitung nach ' + String(this.failure.afterMs ?? 5000) + ' ms (Mock)',
          this.info.target,
        )
      case 'outOfPaper':
        throw new PrinterError('Kein Papier (Mock)', this.info.target)
      case 'partialWrite': {
        const teil = job.slice(0, this.failure.bytesWritten)
        this.jobs.push(teil)
        this.onLog(
          'nur ' + String(teil.length) + ' von ' + String(job.length) + ' Bytes geschrieben (Mock)',
        )
        throw new PrinterError(
          'Verbindung mitten im Auftrag abgebrochen: ' +
            String(teil.length) +
            ' von ' +
            String(job.length) +
            ' Bytes (Mock)',
          this.info.target,
        )
      }
      case 'none':
        this.jobs.push(job)
        this.onLog(String(job.length) + ' Bytes an ' + this.info.target)
        return Promise.resolve()
    }
  }

  async openCashDrawer(): Promise<void> {
    if (this.failure.kind === 'refused' || this.failure.kind === 'timeout') {
      throw new PrinterError('Kassenlade nicht erreichbar (Mock)', this.info.target)
    }
    this.drawerOpenCount += 1
    this.onLog(
      'Kassenladen-Impuls ESC p (Mock) — ' +
        cashDrawerPulse()
          .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
          .join(' '),
    )
    return Promise.resolve()
  }

  async isReachable(): Promise<boolean> {
    return Promise.resolve(this.failure.kind !== 'refused' && this.failure.kind !== 'timeout')
  }

  /** Alle Auftraege als Text, wie sie ein Drucker in WPC1252 lesen wuerde. */
  decodedJobs(): string[] {
    return this.jobs.map((job) => Buffer.from(job).toString('latin1'))
  }

  reset(): void {
    this.jobs.length = 0
    this.drawerOpenCount = 0
    this.failure = { kind: 'none' }
  }
}

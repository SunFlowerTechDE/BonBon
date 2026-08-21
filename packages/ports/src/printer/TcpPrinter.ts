/**
 * PrinterPort ueber TCP, Port 9100 (RAW/JetDirect).
 *
 * Diese Implementierung braucht `node:net` und laeuft damit im Backend, in
 * Werkzeugen und im Rust-Teil der Tauri-App — **nicht** im Webview. Die
 * Anwendungslogik sieht davon nichts, sie kennt nur `PrinterPort`.
 *
 * Dieselbe Klasse bedient den Emulator escpresso und einen echten
 * Epson TM-m30III; es unterscheidet sie nur die IP-Adresse.
 */

import { Socket } from 'node:net'

import { CHARACTERS_PER_LINE_80MM, cashDrawerPulse } from './escpos.js'
import { PrinterError, type PrinterInfo, type PrinterPort, type PrintJob } from './PrinterPort.js'

export interface TcpPrinterOptions {
  readonly host: string
  /** RAW-Druckport. 9100 ist der Standard und die Vorgabe. */
  readonly port?: number
  readonly timeoutMs?: number
  readonly charactersPerLine?: number
  /** Wird fuer jeden gesendeten Auftrag aufgerufen — fuer das Protokoll. */
  readonly onLog?: (message: string) => void
}

export class TcpPrinter implements PrinterPort {
  readonly info: PrinterInfo
  private readonly port: number
  private readonly timeoutMs: number
  private readonly onLog: (message: string) => void

  constructor(private readonly options: TcpPrinterOptions) {
    this.port = options.port ?? 9100
    this.timeoutMs = options.timeoutMs ?? 5000
    this.onLog = options.onLog ?? ((): void => undefined)
    this.info = {
      target: 'tcp://' + options.host + ':' + String(this.port),
      charactersPerLine: options.charactersPerLine ?? CHARACTERS_PER_LINE_80MM,
    }
  }

  async print(job: PrintJob): Promise<void> {
    this.onLog(String(job.length) + ' Bytes an ' + this.info.target)
    await this.send(job)
  }

  async openCashDrawer(): Promise<void> {
    const impuls = Uint8Array.from(cashDrawerPulse())
    this.onLog(
      'Kassenladen-Impuls ESC p an ' +
        this.info.target +
        ' — ' +
        [...impuls].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
    )
    await this.send(impuls)
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.send(new Uint8Array(0))
      return true
    } catch {
      return false
    }
  }

  /**
   * Oeffnet die Verbindung, schreibt und wartet, bis die Bytes wirklich raus
   * sind. Jeder Fehlerweg — Zeitueberschreitung, abgewiesene Verbindung,
   * Abbruch beim Schreiben — endet in einem PrinterError mit der
   * urspruenglichen Ursache als `cause`. Nichts wird verschluckt.
   */
  private send(bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new Socket()
      let erledigt = false

      const fertig = (fehler?: unknown): void => {
        if (erledigt) return
        erledigt = true
        socket.destroy()
        if (fehler === undefined) {
          resolve()
        } else {
          reject(
            new PrinterError(
              'Druck an ' + this.info.target + ' fehlgeschlagen',
              this.info.target,
              { cause: fehler },
            ),
          )
        }
      }

      socket.setTimeout(this.timeoutMs)
      socket.on('timeout', () => {
        fertig(
          new Error(
            'Zeitueberschreitung nach ' +
              String(this.timeoutMs) +
              ' ms. Laeuft der Drucker bzw. escpresso auf ' +
              this.info.target +
              '?',
          ),
        )
      })
      socket.on('error', (fehler) => {
        fertig(fehler)
      })

      socket.connect(this.port, this.options.host, () => {
        if (bytes.length === 0) {
          fertig()
          return
        }
        socket.end(bytes, () => {
          fertig()
        })
      })
    })
  }
}

/**
 * ZVT-Terminalsimulator, TCP auf Port 20007.
 *
 * Beantwortet Registrierung, Autorisierung, Storno und Kassenschnitt, sendet
 * Zwischenstaende — und kann auf Knopfdruck kaputtgehen. Die Fehlerbilder sind
 * der eigentliche Zweck (CLAUDE.md, Ports und Adapter).
 *
 * Nachrichtenaufbau nach PA00P015_13.09_final_en.pdf (VdTH), gegengeprueft an
 * Portalum.Zvt.
 */

import { createServer, type Server, type Socket } from 'node:net'

import {
  ACK,
  ECR_COMMAND,
  PT_COMMAND,
  RESULT_CODE,
  type Apdu,
  decodeAmount,
  decodeApdu,
  decodeBcd,
  encodeAmount,
  encodeApdu,
  encodeBcd,
  findBitmap,
  intermediateText,
  parseBitmaps,
  resultText,
  toHex,
} from '@bonbon/ports'

import { SCENARIOS, type Scenario, type ScenarioName } from './scenarios.js'

export interface MockTerminalOptions {
  readonly port?: number
  readonly host?: string
  /** Pause zwischen den Zwischenstaenden, damit man sie sieht. */
  readonly stepDelayMs?: number
  readonly onLog?: (message: string) => void
}

const schlafen = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class MockTerminal {
  private server: Server | undefined
  private scenario: Scenario = SCENARIOS.erfolg
  private readonly port: number
  private readonly host: string
  private readonly stepDelayMs: number
  private readonly onLog: (message: string) => void

  /** Vorgaenge, die intern autorisiert wurden — auch die, deren Antwort nie ankam. */
  readonly autorisierteVorgaenge: { receiptNumber: string; amountInCents: number }[] = []

  private belegzaehler = 0
  private tracezaehler = 0

  constructor(options: MockTerminalOptions = {}) {
    this.port = options.port ?? 20007
    this.host = options.host ?? '127.0.0.1'
    this.stepDelayMs = options.stepDelayMs ?? 250
    this.onLog = options.onLog ?? ((): void => undefined)
  }

  get currentScenario(): Scenario {
    return this.scenario
  }

  /** Fehlerbild zur Laufzeit umschalten, ohne Neustart. */
  setScenario(name: ScenarioName): void {
    this.scenario = SCENARIOS[name]
    this.onLog('Fehlerbild jetzt: ' + name + ' — ' + this.scenario.beschreibung)
  }

  start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.onLog('Kasse verbunden von ' + String(socket.remoteAddress))
        this.handleConnection(socket)
      })
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        this.server = server
        resolve({ host: this.host, port: this.port })
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === undefined) {
        resolve()
        return
      }
      this.server.close(() => {
        resolve()
      })
    })
  }

  // --- Verbindung -----------------------------------------------------------

  private handleConnection(socket: Socket): void {
    let buffer = new Uint8Array(0)

    const senden = (apdu: Apdu, was: string): void => {
      const bytes = encodeApdu(apdu)
      this.onLog('  -> ' + was.padEnd(28) + toHex(bytes))
      socket.write(bytes)
    }

    const ack = (): void => {
      senden(
        {
          controlClass: ACK.positive[0],
          controlInstruction: ACK.positive[1],
          data: new Uint8Array(0),
        },
        'ACK 80 00',
      )
    }

    socket.on('data', (chunk: Buffer) => {
      const neu = new Uint8Array(buffer.length + chunk.length)
      neu.set(buffer, 0)
      neu.set(chunk, buffer.length)
      buffer = neu

      for (;;) {
        const gelesen = decodeApdu(buffer)
        if (gelesen === undefined) break
        buffer = buffer.slice(gelesen.bytesConsumed)
        void this.handleApdu(gelesen.apdu, socket, senden, ack)
      }
    })

    socket.on('error', (fehler) => {
      this.onLog('Verbindungsfehler: ' + fehler.message)
    })
    socket.on('close', () => {
      this.onLog('Kasse getrennt')
    })
  }

  private async handleApdu(
    apdu: Apdu,
    socket: Socket,
    senden: (a: Apdu, was: string) => void,
    ack: () => void,
  ): Promise<void> {
    const { controlClass: klasse, controlInstruction: befehl, data } = apdu

    // Quittungen der Kasse brauchen keine Antwort.
    if (klasse === 0x80 || klasse === 0x84) return

    const bezeichnung = toHex(Uint8Array.from([klasse, befehl]))

    if (klasse === ECR_COMMAND.registration[0] && befehl === ECR_COMMAND.registration[1]) {
      const passwort = decodeBcd(data.slice(0, 3))
      this.onLog('<- Registrierung (' + bezeichnung + '), Passwort ' + passwort)
      ack()
      await schlafen(this.stepDelayMs)
      senden(
        {
          controlClass: PT_COMMAND.completion[0],
          controlInstruction: PT_COMMAND.completion[1],
          data: new Uint8Array(0),
        },
        'Completion',
      )
      return
    }

    if (klasse === ECR_COMMAND.authorisation[0] && befehl === ECR_COMMAND.authorisation[1]) {
      const { bitmaps } = parseBitmaps(data)
      const betragBytes = findBitmap(bitmaps, 0x04)
      const betrag = betragBytes === undefined ? 0 : decodeAmount(betragBytes)
      this.onLog(
        '<- Autorisierung (' + bezeichnung + '), Betrag ' + String(betrag) + ' Cent  [' + this.scenario.name + ']',
      )
      ack()
      await this.runPayment(betrag, socket, senden)
      return
    }

    if (klasse === ECR_COMMAND.reversal[0] && befehl === ECR_COMMAND.reversal[1]) {
      const { bitmaps } = parseBitmaps(data.slice(3))
      const belegBytes = findBitmap(bitmaps, 0x87)
      const beleg = belegBytes === undefined ? '' : decodeBcd(belegBytes)
      this.onLog('<- Storno (' + bezeichnung + ') fuer Beleg ' + beleg)
      ack()
      await schlafen(this.stepDelayMs)

      const index = this.autorisierteVorgaenge.findIndex((v) => v.receiptNumber === beleg)
      if (index < 0) {
        // Genau der Fall, den eine Kasse beim Aufloesen eines unklaren
        // Ausgangs trifft: sie storniert vorsichtshalber, und es gab gar
        // nichts zu stornieren. Das ist eine gute Nachricht, kein Fehler.
        this.onLog('   kein solcher Vorgang — Storno nicht moeglich')
        senden(
          {
            controlClass: PT_COMMAND.statusInformation[0],
            controlInstruction: PT_COMMAND.statusInformation[1],
            data: Uint8Array.from([0x27, RESULT_CODE.reversalNotPossible]),
          },
          'Status-Information',
        )
      } else {
        const vorgang = this.autorisierteVorgaenge[index]
        this.autorisierteVorgaenge.splice(index, 1)
        this.onLog('   storniert: ' + String(vorgang?.amountInCents ?? 0) + ' Cent')
        senden(
          {
            controlClass: PT_COMMAND.statusInformation[0],
            controlInstruction: PT_COMMAND.statusInformation[1],
            data: Uint8Array.from([
              0x27,
              RESULT_CODE.noError,
              0x04,
              ...encodeAmount(vorgang?.amountInCents ?? 0),
              0x87,
              ...encodeBcd(Number.parseInt(beleg, 10), 2),
            ]),
          },
          'Status-Information',
        )
      }
      await schlafen(this.stepDelayMs)
      senden(
        {
          controlClass: PT_COMMAND.completion[0],
          controlInstruction: PT_COMMAND.completion[1],
          data: new Uint8Array(0),
        },
        'Completion',
      )
      return
    }

    if (klasse === ECR_COMMAND.endOfDay[0] && befehl === ECR_COMMAND.endOfDay[1]) {
      const summe = this.autorisierteVorgaenge.reduce((a, v) => a + v.amountInCents, 0)
      this.onLog(
        '<- Kassenschnitt (' + bezeichnung + '), ' +
          String(this.autorisierteVorgaenge.length) + ' Vorgaenge, ' + String(summe) + ' Cent',
      )
      ack()
      await schlafen(this.stepDelayMs)
      senden(
        {
          controlClass: PT_COMMAND.statusInformation[0],
          controlInstruction: PT_COMMAND.statusInformation[1],
          data: Uint8Array.from([0x27, RESULT_CODE.noError, 0x04, ...encodeAmount(summe)]),
        },
        'Status-Information',
      )
      await schlafen(this.stepDelayMs)
      senden(
        {
          controlClass: PT_COMMAND.completion[0],
          controlInstruction: PT_COMMAND.completion[1],
          data: new Uint8Array(0),
        },
        'Completion (Ende-Kassenschnitt)',
      )
      this.autorisierteVorgaenge.length = 0
      return
    }

    if (klasse === ECR_COMMAND.abort[0] && befehl === ECR_COMMAND.abort[1]) {
      this.onLog('<- Abbruch durch die Kasse (' + bezeichnung + ')')
      ack()
      senden(
        {
          controlClass: PT_COMMAND.abort[0],
          controlInstruction: PT_COMMAND.abort[1],
          data: Uint8Array.from([RESULT_CODE.abortViaTimeoutOrAbortKey]),
        },
        'Abort',
      )
      return
    }

    this.onLog('<- unbekannter Befehl ' + bezeichnung + ', wird quittiert und ignoriert')
    ack()
  }

  /** Der eigentliche Zahlungsablauf mit dem eingestellten Fehlerbild. */
  private async runPayment(
    betragInCent: number,
    socket: Socket,
    senden: (a: Apdu, was: string) => void,
  ): Promise<void> {
    const szenario = this.scenario

    for (const status of szenario.intermediates) {
      await schlafen(this.stepDelayMs)
      if (socket.destroyed) return
      senden(
        {
          controlClass: PT_COMMAND.intermediateStatus[0],
          controlInstruction: PT_COMMAND.intermediateStatus[1],
          data: Uint8Array.from([status]),
        },
        'Zwischenstatus ' + intermediateText(status),
      )
    }

    if (szenario.stallAfterIntermediates === true) {
      this.onLog('   *** Fehlerbild timeout: es kommt nichts mehr ***')
      return
    }

    this.belegzaehler += 1
    this.tracezaehler += 1
    const belegnummer = String(this.belegzaehler).padStart(4, '0')

    if (szenario.dropAfterAuthorisation === true) {
      // Die Zahlung ist beim Netzbetreiber durch. Das Terminal merkt sie sich.
      this.autorisierteVorgaenge.push({ receiptNumber: belegnummer, amountInCents: betragInCent })
      this.onLog('   *** AUTORISIERT: Beleg ' + belegnummer + ', ' + String(betragInCent) + ' Cent ***')
      this.onLog('   *** Fehlerbild abriss-nach-autorisierung: Verbindung wird gekappt, ***')
      this.onLog('   *** bevor die Status-Information rausgeht. Die Kasse erfaehrt nichts. ***')
      await schlafen(this.stepDelayMs)
      socket.destroy()
      return
    }

    await schlafen(this.stepDelayMs)
    if (socket.destroyed) return

    const erfolgreich = szenario.resultCode === RESULT_CODE.noError
    if (erfolgreich) {
      this.autorisierteVorgaenge.push({ receiptNumber: belegnummer, amountInCents: betragInCent })
    }

    const daten: number[] = [0x27, szenario.resultCode]
    if (erfolgreich) {
      daten.push(0x04, ...encodeAmount(betragInCent))
      daten.push(0x0b, ...encodeBcd(this.tracezaehler, 3))
      daten.push(0x87, ...encodeBcd(this.belegzaehler, 2))
      daten.push(0x29, ...encodeBcd(68_007_500, 4))
    }

    senden(
      {
        controlClass: PT_COMMAND.statusInformation[0],
        controlInstruction: PT_COMMAND.statusInformation[1],
        data: Uint8Array.from(daten),
      },
      'Status-Information ' + resultText(szenario.resultCode),
    )

    await schlafen(this.stepDelayMs)
    if (socket.destroyed) return
    senden(
      {
        controlClass: PT_COMMAND.completion[0],
        controlInstruction: PT_COMMAND.completion[1],
        data: new Uint8Array(0),
      },
      'Completion',
    )
  }
}

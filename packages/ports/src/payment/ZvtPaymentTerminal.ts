/**
 * PaymentPort ueber ZVT auf TCP, Port 20007.
 *
 * Dieselbe Klasse bedient das Mock-Terminal aus `tools/mock-terminal` und ein
 * echtes CCV Base Next — es unterscheidet sie nur die IP-Adresse. Sie braucht
 * `node:net` und laeuft damit im Backend, in Werkzeugen und im Rust-Teil,
 * nicht im Webview.
 */

import { Socket } from 'node:net'

import type { Cents } from '@bonbon/core'

import {
  PaymentError,
  type PaymentOutcome,
  type PaymentPort,
  type PaymentRequest,
  type PaymentTerminalInfo,
} from './PaymentPort.js'
import {
  ACK,
  CONFIG_BYTE_WITH_INTERMEDIATE_STATUS,
  CURRENCY_EUR,
  DEFAULT_PASSWORD,
  ECR_COMMAND,
  SERVICE_BYTE_STATUS_ONLY,
  PT_COMMAND,
  RESULT_CODE,
  intermediateText,
  isAbort,
  isPositiveAck,
  resultText,
} from './zvt/constants.js'
import {
  type Apdu,
  decodeApdu,
  decodeAmount,
  decodeBcd,
  encodeAmount,
  encodeApdu,
  encodeBcd,
  findBitmap,
  parseBitmaps,
  toHex,
} from './zvt/protocol.js'

export interface ZvtPaymentOptions {
  readonly host: string
  /** ZVT ueber TCP. 20007 ist der uebliche Port und die Vorgabe. */
  readonly port?: number
  /** Passwort des Terminals, 3 Byte BCD. */
  readonly password?: number
  /** Zeitlimit fuer einen einzelnen Vorgang. */
  readonly timeoutMs?: number
  readonly onLog?: (message: string) => void
}

/** Ein empfangener Vorgangsabschluss. */
interface StatusInformation {
  readonly resultCode: number
  readonly amount?: number | undefined
  readonly receiptNumber?: string | undefined
  readonly traceNumber?: string | undefined
  readonly terminalId?: string | undefined
}

export class ZvtPaymentTerminal implements PaymentPort {
  readonly info: PaymentTerminalInfo
  private readonly port: number
  private readonly password: number
  private readonly timeoutMs: number
  private readonly onLog: (message: string) => void

  constructor(private readonly options: ZvtPaymentOptions) {
    this.port = options.port ?? 20007
    this.password = options.password ?? DEFAULT_PASSWORD
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.onLog = options.onLog ?? ((): void => undefined)
    this.info = { target: 'zvt://' + options.host + ':' + String(this.port) }
  }

  async isReachable(): Promise<boolean> {
    try {
      const verbindung = await this.connect()
      verbindung.close()
      return true
    } catch {
      return false
    }
  }

  async register(): Promise<void> {
    const daten = Uint8Array.from([
      ...encodeBcd(this.password, 3),
      CONFIG_BYTE_WITH_INTERMEDIATE_STATUS,
      ...encodeBcd(CURRENCY_EUR, 2),
    ])
    const ergebnis = await this.runDialogue(ECR_COMMAND.registration, daten, 'Registrierung', {
      expectStatusInformation: false,
    })
    if (ergebnis.kind === 'declined' || ergebnis.kind === 'aborted') {
      throw new PaymentError(
        'Registrierung abgelehnt: ' + ergebnis.reason,
        this.info.target,
      )
    }
    if (ergebnis.kind === 'unknown') {
      throw new PaymentError(
        'Registrierung ohne eindeutige Antwort: ' + ergebnis.reason,
        this.info.target,
      )
    }
  }

  async authorize(request: PaymentRequest): Promise<PaymentOutcome> {
    const betrag: number = request.amount
    const daten = Uint8Array.from([
      0x04,
      ...encodeAmount(betrag),
      0x49,
      ...encodeBcd(request.currencyCode ?? CURRENCY_EUR, 2),
    ])
    return this.runDialogue(ECR_COMMAND.authorisation, daten, 'Autorisierung', {
      amount: request.amount,
      onProgress: request.onProgress,
      expectStatusInformation: true,
    })
  }

  async reverse(receiptNumber: string): Promise<PaymentOutcome> {
    const daten = Uint8Array.from([
      ...encodeBcd(this.password, 3),
      0x87,
      ...encodeBcd(Number.parseInt(receiptNumber, 10), 2),
    ])
    return this.runDialogue(ECR_COMMAND.reversal, daten, 'Storno', {
      expectStatusInformation: true,
    })
  }

  /**
   * Fragt nach dem zuletzt ausgefuehrten Vorgang — `06 20` Repeat Receipt.
   *
   * ## Warum dieser Befehl und nicht ein anderer
   *
   * Die Spezifikation nennt ihn ausdruecklich fuer diesen Zweck (2.20.2):
   *
   *   "Depending on the service-byte the PT sends the Status-Information of
   *    the last transaction executed. This ensures that the ECR can
   *    resynchronise in case of an inconclusive ending of a transaction."
   *
   * Die Alternativen leisten es nicht:
   *
   * - `05 01` Status-Enquiry liefert den Zustand des **Terminals** (fuer
   *   zeitgesteuerte Aktionen wie Kassenschnitt), nicht den des letzten
   *   Vorgangs. Kein Ergebniscode, keine Belegnummer.
   * - `06 10` Send Turnover Totals liefert eine Summe ueber alle gespeicherten
   *   Vorgaenge. Damit liesse sich hoechstens indirekt schliessen, ob einer
   *   dazugekommen ist — und bei parallelem Betrieb nicht einmal das.
   * - `84 9C` Repeat Statusinfo setzt voraus, dass der Dialog noch steht. Genau
   *   der ist beim Verbindungsabriss weg.
   *
   * `06 20` ist damit der einzige Weg, der Ergebnis **und** Belegnummer
   * zurueckgibt — und die Belegnummer braucht man, um ueberhaupt stornieren zu
   * koennen.
   *
   * ## Was am echten Terminal noch zu pruefen ist
   *
   * Ob ein **CCV Base Next** diesen Befehl beherrscht, konnte ich nicht
   * belegen. `06 20` ist Teil des Standards und Portalum.Zvt setzt ihn um,
   * dessen Testliste nennt aber CardComplete, Hobex, Worldline und Global
   * Payments — CCV nicht. Vor dem Pilotbetrieb am echten Geraet nachweisen;
   * faellt es aus, bleibt als Rueckfallebene die Kombination aus `06 10` und
   * einem Abgleich ueber das Tagesjournal.
   */
  async queryLastTransaction(): Promise<PaymentOutcome> {
    const daten = Uint8Array.from([
      ...encodeBcd(this.password, 3),
      0x03,
      SERVICE_BYTE_STATUS_ONLY,
    ])
    return this.runDialogue(ECR_COMMAND.repeatReceipt, daten, 'Nachfrage letzter Vorgang', {
      expectStatusInformation: true,
    })
  }

  async endOfDay(): Promise<PaymentOutcome> {
    const daten = encodeBcd(this.password, 3)
    return this.runDialogue(ECR_COMMAND.endOfDay, daten, 'Kassenschnitt', {
      expectStatusInformation: true,
    })
  }

  // --- Ablauf ---------------------------------------------------------------

  /**
   * Fuehrt einen vollstaendigen ZVT-Dialog.
   *
   * Ablauf laut Spezifikation:
   *   ECR -> PT  Befehl
   *   PT  -> ECR 80 00 00                    (Quittung der Transportschicht)
   *   PT  -> ECR 04 FF …                     (Zwischenstaende, beliebig oft)
   *   PT  -> ECR 04 0F …                     (Status-Information mit BMP 27)
   *   PT  -> ECR 06 0F                       (Completion)
   * oder statt der letzten beiden:
   *   PT  -> ECR 06 1E <result-code>         (Abort)
   *
   * Jede empfangene Nachricht wird von der Kasse mit 80 00 00 quittiert.
   */
  private async runDialogue(
    command: readonly number[],
    data: Uint8Array,
    label: string,
    optionen: {
      amount?: Cents | undefined
      onProgress?: ((p: { code: number; text: string }) => void) | undefined
      /**
       * Erwartet dieser Befehl eine Status-Information mit BMP 27?
       *
       * Bei Zahlung, Storno und Kassenschnitt ja — dort steht das Ergebnis
       * drin. Die Registrierung dagegen wird laut Spezifikation nur mit
       * Completion beantwortet:
       *
       *   ECR -> PT: 06 00 14 …
       *   PT -> ECR: 80 00 00
       *   PT -> ECR: 06 0F 12 19 00 29 65 …
       *
       * Ein Completion ohne Status-Information ist dort also der Normalfall
       * und kein unklarer Ausgang.
       */
      expectStatusInformation?: boolean | undefined
    } = {},
  ): Promise<PaymentOutcome> {
    const verbindung = await this.connect()
    let status: StatusInformation | undefined

    try {
      const apdu: Apdu = {
        controlClass: command[0] as number,
        controlInstruction: command[1] as number,
        data,
      }
      this.onLog(label + ' -> ' + toHex(encodeApdu(apdu)))
      verbindung.send(encodeApdu(apdu))

      for (;;) {
        const naechste = await verbindung.receive(this.timeoutMs)

        if (naechste === 'closed') {
          // Der kritische Fall. Siehe ausfuehrliche Erlaeuterung unten.
          return this.unknownOutcome(
            'Die Verbindung zum Terminal brach ab, bevor eine Status-Information ankam',
            status?.receiptNumber,
          )
        }

        const { controlClass: klasse, controlInstruction: befehl, data: nutzdaten } = naechste

        if (isPositiveAck(klasse, befehl)) continue

        // Jede Nachricht des Terminals wird quittiert.
        verbindung.send(
          encodeApdu({
            controlClass: ACK.positive[0],
            controlInstruction: ACK.positive[1],
            data: new Uint8Array(0),
          }),
        )

        if (klasse === PT_COMMAND.intermediateStatus[0] && befehl === PT_COMMAND.intermediateStatus[1]) {
          const code = nutzdaten[0] ?? 0
          this.onLog(label + ' <- Zwischenstatus ' + intermediateText(code))
          optionen.onProgress?.({ code, text: intermediateText(code) })
          continue
        }

        if (klasse === PT_COMMAND.statusInformation[0] && befehl === PT_COMMAND.statusInformation[1]) {
          status = this.readStatusInformation(nutzdaten)
          this.onLog(
            label + ' <- Status-Information, Ergebnis ' + resultText(status.resultCode),
          )
          continue
        }

        if (klasse === PT_COMMAND.abort[0] && befehl === PT_COMMAND.abort[1]) {
          const code = nutzdaten[0] ?? RESULT_CODE.processingError
          this.onLog(label + ' <- Abort, ' + resultText(code))
          return this.outcomeFromResult(code, optionen.amount, status)
        }

        if (klasse === PT_COMMAND.completion[0] && befehl === PT_COMMAND.completion[1]) {
          this.onLog(label + ' <- Completion')
          if (status === undefined) {
            if (optionen.expectStatusInformation === false) {
              // Registrierung: Completion allein ist die Erfolgsmeldung.
              return this.outcomeFromResult(RESULT_CODE.noError, optionen.amount, undefined)
            }
            // Bei einer Zahlung dagegen hat das Terminal den Vorgang beendet,
            // das Ergebnis aber nicht mitgeteilt. Das ist unklar, nicht gut.
            return this.unknownOutcome(
              'Das Terminal meldete Completion ohne Status-Information',
              undefined,
            )
          }
          return this.outcomeFromResult(status.resultCode, optionen.amount, status)
        }

        this.onLog(
          label +
            ' <- unbeachtet: ' +
            toHex(Uint8Array.from([klasse, befehl])) +
            ' (' +
            String(nutzdaten.length) +
            ' Byte)',
        )
      }
    } catch (fehler) {
      if (fehler instanceof TimeoutError) {
        return this.unknownOutcome(
          'Das Terminal antwortete ' + String(this.timeoutMs) + ' ms lang nicht',
          status?.receiptNumber,
        )
      }
      throw new PaymentError(label + ' an ' + this.info.target + ' fehlgeschlagen', this.info.target, {
        cause: fehler,
      })
    } finally {
      verbindung.close()
    }
  }

  private readStatusInformation(data: Uint8Array): StatusInformation {
    const { bitmaps } = parseBitmaps(data)
    const ergebnis = findBitmap(bitmaps, 0x27)
    const betrag = findBitmap(bitmaps, 0x04)
    const beleg = findBitmap(bitmaps, 0x87)
    const trace = findBitmap(bitmaps, 0x0b)
    const terminal = findBitmap(bitmaps, 0x29)
    return {
      resultCode: ergebnis?.[0] ?? RESULT_CODE.processingError,
      amount: betrag === undefined ? undefined : decodeAmount(betrag),
      receiptNumber: beleg === undefined ? undefined : decodeBcd(beleg),
      traceNumber: trace === undefined ? undefined : decodeBcd(trace),
      terminalId: terminal === undefined ? undefined : decodeBcd(terminal),
    }
  }

  private outcomeFromResult(
    code: number,
    amount: Cents | undefined,
    status: StatusInformation | undefined,
  ): PaymentOutcome {
    if (code === RESULT_CODE.noError) {
      if (amount === undefined) {
        // Beim Storno und beim Kassenschnitt kennt der Aufrufer den Betrag
        // nicht vorher — er steht in BMP 04 der Status-Information. Ihn hier
        // zu verwerfen hiesse, ein Storno ueber 9,40 EUR als 0,00 EUR zu
        // melden.
        return {
          kind: 'approved',
          amount: (status?.amount ?? 0) as Cents,
          ...(status?.receiptNumber === undefined ? {} : { receiptNumber: status.receiptNumber }),
          ...(status?.traceNumber === undefined ? {} : { traceNumber: status.traceNumber }),
          ...(status?.terminalId === undefined ? {} : { terminalId: status.terminalId }),
        }
      }
      // Der vom Terminal gemeldete Betrag hat Vorrang: er ist der, der
      // tatsaechlich autorisiert wurde. Weicht er ab, faellt das hier auf.
      if (status?.amount !== undefined && status.amount !== (amount as number)) {
        return {
          kind: 'unknown',
          reason:
            'Das Terminal meldet einen anderen Betrag als angefordert: ' +
            String(status.amount) +
            ' statt ' +
            String(amount) +
            ' Cent',
          ...(status.receiptNumber === undefined ? {} : { receiptNumber: status.receiptNumber }),
        }
      }
      return {
        kind: 'approved',
        amount,
        ...(status?.receiptNumber === undefined ? {} : { receiptNumber: status.receiptNumber }),
        ...(status?.traceNumber === undefined ? {} : { traceNumber: status.traceNumber }),
        ...(status?.terminalId === undefined ? {} : { terminalId: status.terminalId }),
      }
    }

    return isAbort(code)
      ? { kind: 'aborted', resultCode: code, reason: resultText(code) }
      : { kind: 'declined', resultCode: code, reason: resultText(code) }
  }

  /**
   * Der Fall, wegen dem dieser Port so gebaut ist.
   *
   * Das Terminal kann die Zahlung beim Netzbetreiber bereits autorisiert
   * haben, und der Kunde hat die Karte womoeglich schon eingesteckt gesehen —
   * aber die Antwort erreicht die Kasse nie, weil die Verbindung vorher
   * abreisst oder in den Timeout laeuft.
   *
   * **Die Kasse weiss dann nicht, ob der Kunde bezahlt hat.** Sie darf den
   * Vorgang weder als bezahlt buchen (dann fehlt womoeglich das Geld) noch als
   * nicht bezahlt verwerfen (dann ist der Kunde belastet, ohne Beleg).
   *
   * Die Spezifikation kennt drei Wege heraus, in dieser Reihenfolge:
   *
   * 1. **Status-Information erneut anfordern.** Die Kasse quittiert negativ mit
   *    `84 9C` ("Repeat Statusinfo"). Das Terminal sendet die letzte
   *    Status-Information noch einmal. Der guenstigste Fall — das Ergebnis
   *    kommt doch noch, ohne dass irgendetwas rueckgaengig gemacht wird.
   *
   * 2. **Nachfragen.** `05 01` Status-Enquiry fragt den Zustand des Terminals
   *    ab. Damit laesst sich klaeren, ob es noch mitten im Vorgang steckt.
   *
   * 3. **Stornieren.** `06 30` Reversal mit `87<receipt-no>` macht die Zahlung
   *    rueckgaengig. Der sichere Weg, wenn 1 und 2 nichts ergeben: lieber eine
   *    Zahlung stornieren, die nie stattgefunden hat — ein Storno auf einen
   *    nicht existierenden Vorgang beantwortet das Terminal mit
   *    "Storno nicht moeglich" —, als eine erfolgte Belastung zu uebersehen.
   *
   * Ohne Belegnummer bleibt nur Weg 1 und 2, deshalb wird sie mitgefuehrt,
   * sobald sie einmal ueber den Draht kam.
   *
   * Was **nicht** passieren darf: den Vorgang stillschweigend als erfolgreich
   * behandeln (CLAUDE.md, Regel 15).
   */
  private unknownOutcome(reason: string, receiptNumber: string | undefined): PaymentOutcome {
    this.onLog('UNKLARER AUSGANG: ' + reason)
    return {
      kind: 'unknown',
      reason,
      ...(receiptNumber === undefined ? {} : { receiptNumber }),
    }
  }

  // --- Verbindung -----------------------------------------------------------

  private connect(): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      const socket = new Socket()
      socket.once('error', reject)
      socket.connect(this.port, this.options.host, () => {
        socket.removeListener('error', reject)
        resolve(new Connection(socket))
      })
    })
  }
}

class TimeoutError extends Error {
  constructor() {
    super('Zeitlimit erreicht')
    this.name = 'TimeoutError'
  }
}

/** Puffert eingehende Bytes und gibt sie APDU-weise heraus. */
class Connection {
  private buffer = new Uint8Array(0)
  private closed = false
  private fehler: unknown = undefined

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      const neu = new Uint8Array(this.buffer.length + chunk.length)
      neu.set(this.buffer, 0)
      neu.set(chunk, this.buffer.length)
      this.buffer = neu
    })
    socket.on('close', () => {
      this.closed = true
    })
    socket.on('error', (e) => {
      this.fehler = e
      this.closed = true
    })
  }

  send(bytes: Uint8Array): void {
    this.socket.write(bytes)
  }

  /** Naechste APDU, `'closed'` wenn die Gegenseite auflegt. */
  async receive(timeoutMs: number): Promise<Apdu | 'closed'> {
    const ende = Date.now() + timeoutMs
    for (;;) {
      const gelesen = decodeApdu(this.buffer)
      if (gelesen !== undefined) {
        this.buffer = this.buffer.slice(gelesen.bytesConsumed)
        return gelesen.apdu
      }
      if (this.closed) {
        if (this.fehler !== undefined) {
          throw this.fehler instanceof Error
            ? this.fehler
            : new Error('Socketfehler: ' + JSON.stringify(this.fehler))
        }
        return 'closed'
      }
      if (Date.now() > ende) throw new TimeoutError()
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  close(): void {
    this.socket.destroy()
  }
}

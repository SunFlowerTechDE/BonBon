/**
 * Adapter — die Brücke von den Ports zur Umgebung.
 *
 * Der Webview kann kein TCP und keine Dateien. Was das braucht, läuft im
 * Rust-Teil und wird über `invoke()` aufgerufen. Die Portimplementierungen
 * bleiben trotzdem TypeScript — sie tauschen nur den Transportweg.
 *
 * Ohne Tauri (also im Browser während der Entwicklung) greifen Vorschau- und
 * Speichervarianten. Die App startet damit ohne jede Peripherie.
 */

import type { ChainedEvent, Hasher, SaleEvent } from '@bonbon/core'
import { GENESIS_HASH, chainEvent } from '@bonbon/core'
import {
  type PrinterInfo,
  type PrinterPort,
  type PrintJob,
  MockTse,
  PrinterError,
  type TsePort,
  cashDrawerPulse,
  previewLines,
} from '@bonbon/ports'

import type { DruckerKonfiguration, EventLogKonfiguration, Konfiguration } from './konfiguration.js'
import { laeuftInTauri } from './konfiguration.js'

// --- Tauri-Aufruf ----------------------------------------------------------

type InvokeFn = <T>(befehl: string, argumente?: Record<string, unknown>) => Promise<T>

async function invoke<T>(befehl: string, argumente?: Record<string, unknown>): Promise<T> {
  const modul = (await import('@tauri-apps/api/core')) as { invoke: InvokeFn }
  return modul.invoke<T>(befehl, argumente)
}

// --- Hasher ----------------------------------------------------------------

/**
 * SHA-256 über die WebCrypto-API.
 *
 * `crypto.subtle.digest` ist asynchron, der `Hasher` des Kerns ist synchron.
 * Für die Hash-Kette wird deshalb im Webview eine synchrone Implementierung
 * gebraucht — die liefert der Rust-Teil. Ohne Tauri behilft sich die
 * Entwicklungsvariante mit einer nicht-kryptographischen Funktion, die
 * ausdrücklich als solche gekennzeichnet ist.
 */
export function entwicklungsHasher(): Hasher {
  return {
    hash: (input: string): string => {
      // FNV-1a, viermal mit verschiedenen Startwerten. Deterministisch und
      // ohne Abhängigkeit — aber NICHT kryptographisch. Nur für den
      // Entwicklungsbetrieb ohne Rust-Teil.
      let a = 0x811c9dc5
      let b = 0x01000193
      let c = 0x9e3779b9
      let d = 0x85ebca6b
      for (let i = 0; i < input.length; i += 1) {
        const z = input.charCodeAt(i)
        a = Math.imul(a ^ z, 0x01000193) >>> 0
        b = Math.imul(b + z * (i + 1), 0x85ebca6b) >>> 0
        c = Math.imul(c ^ (z + i), 0xc2b2ae35) >>> 0
        d = Math.imul(d + z, 0x27d4eb2f) >>> 0
      }
      return [a, b, c, d].map((n) => n.toString(16).padStart(8, '0')).join('').repeat(2)
    },
  }
}

// --- Drucker ---------------------------------------------------------------

/** Drucker über den Rust-Teil: TCP auf Port 9100. */
export class TauriDrucker implements PrinterPort {
  readonly info: PrinterInfo

  constructor(
    private readonly host: string,
    private readonly port: number,
    zeichenProZeile: number,
    private readonly onLog: (nachricht: string) => void,
  ) {
    this.info = { target: 'tcp://' + host + ':' + String(port), charactersPerLine: zeichenProZeile }
  }

  async print(job: PrintJob): Promise<void> {
    this.onLog(String(job.length) + ' Bytes an ' + this.info.target)
    try {
      await invoke('tcp_senden', { host: this.host, port: this.port, bytes: [...job] })
    } catch (fehler) {
      throw new PrinterError('Druck fehlgeschlagen', this.info.target, { cause: fehler })
    }
  }

  async openCashDrawer(): Promise<void> {
    this.onLog('Kassenladen-Impuls ESC p')
    await this.print(Uint8Array.from(cashDrawerPulse()))
  }

  /**
   * Erreichbarkeit — die Antwort des Befehls, nicht sein blosses Gelingen.
   *
   * Hier stand vorher `await invoke(...); return true`. Der Befehl liefert bei
   * geschlossenem Port aber `Ok(false)`, nicht einen Fehler — das Warten
   * gelang also, und die Kasse meldete den Drucker als erreichbar, obwohl
   * niemand lauschte. Genau die Sorte stiller Erfolgsmeldung, die Regel 8
   * verbietet: gelungener Aufruf ist nicht dasselbe wie gelungene Sache.
   */
  async isReachable(): Promise<boolean> {
    try {
      return await invoke<boolean>('tcp_erreichbar', { host: this.host, port: this.port })
    } catch (fehler) {
      // Der Aufruf selbst ist gescheitert — Namensaufloesung, IPC. Das ist ein
      // anderer Fehler als „Port zu", macht den Drucker aber genauso wenig
      // erreichbar. Er wird gemeldet und nicht verschluckt.
      this.onLog('Erreichbarkeit nicht feststellbar: ' + String(fehler))
      return false
    }
  }
}

/**
 * Drucker, der nichts druckt, sondern den Bon anzeigt.
 *
 * Damit läuft ein Verkauf ohne Drucker vollständig durch — der Beleg wird
 * erzeugt, kodiert und ist einsehbar. Er wird nur nicht zu Papier.
 */
export class VorschauDrucker implements PrinterPort {
  readonly info: PrinterInfo
  /** Der zuletzt „gedruckte" Bon als Zeilen. */
  letzterBon: string[] = []
  ladeGeoeffnet = 0

  constructor(
    zeichenProZeile: number,
    private readonly onLog: (nachricht: string) => void,
  ) {
    this.info = { target: 'vorschau://drucker', charactersPerLine: zeichenProZeile }
  }

  async print(job: PrintJob): Promise<void> {
    this.letzterBon = previewLines(job, this.info.charactersPerLine)
    this.onLog(String(job.length) + ' Bytes — Vorschau, nicht gedruckt')
    return Promise.resolve()
  }

  async openCashDrawer(): Promise<void> {
    this.ladeGeoeffnet += 1
    this.onLog('Kassenladen-Impuls (Vorschau)')
    return Promise.resolve()
  }

  async isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

export function baueDrucker(
  konfiguration: DruckerKonfiguration,
  onLog: (nachricht: string) => void,
): PrinterPort {
  const breite = konfiguration.zeichenProZeile ?? 48
  if (konfiguration.art === 'tcp' && laeuftInTauri()) {
    return new TauriDrucker(
      konfiguration.host ?? '127.0.0.1',
      konfiguration.port ?? 9100,
      breite,
      onLog,
    )
  }
  if (konfiguration.art === 'tcp') {
    onLog('Drucker `tcp` verlangt den Rust-Teil — im Browser gilt die Vorschau.')
  }
  return new VorschauDrucker(breite, onLog)
}

// --- TSE -------------------------------------------------------------------

export function baueTse(
  konfiguration: Konfiguration,
  onLog: (nachricht: string) => void,
): TsePort {
  if (konfiguration.tse.art === 'fiskaltrust') {
    // Der fiskaltrust-Adapter kommt in M3. Bis dahin sagt die Kasse
    // ausdruecklich, dass sie den Mock benutzt — statt es zu verschweigen.
    onLog(
      'TSE `fiskaltrust` ist noch nicht angebunden (kommt in M3). Es laeuft der Mock. ' +
        'Die erzeugten Signaturen sind KEINE echten Signaturen.',
    )
  }
  return new MockTse({
    seriennummer: 'MOCK-TSE-' + konfiguration.kasse.seriennummer,
    onLog,
  })
}

// --- Event Log -------------------------------------------------------------

export interface EventLogPort {
  readonly info: { readonly target: string }
  /** Hängt ein Ereignis an und gibt es verkettet zurück. */
  anhaengen(deviceId: string, type: string, payload: string, occurredAt: string, id: string): Promise<ChainedEvent>
  anzahl(): Promise<number>
  /**
   * Zaehlt die Ereignisse eines Geraets mit einem bestimmten Typ.
   *
   * Die Kasse liest daraus beim Start, wie viele Bons dieses Geraet schon
   * geschrieben hat, und fuehrt die Belegnummer fort. Ohne diese Frage
   * beginnt sie nach jedem Neustart wieder bei 1.
   */
  anzahlTyp(deviceId: string, type: string): Promise<number>
}

/** Event Log im Arbeitsspeicher — für den Entwicklungsbetrieb ohne Rust-Teil. */
export class SpeicherEventLog implements EventLogPort {
  readonly info = { target: 'speicher://eventlog' }
  readonly ereignisse: ChainedEvent[] = []

  constructor(
    private readonly hasher: Hasher,
    private readonly onLog: (nachricht: string) => void,
  ) {}

  async anhaengen(
    deviceId: string,
    type: string,
    payload: string,
    occurredAt: string,
    id: string,
  ): Promise<ChainedEvent> {
    const letzter = this.ereignisse.filter((e) => e.deviceId === deviceId).at(-1)
    const event: SaleEvent = {
      id,
      deviceId,
      seq: (letzter?.seq ?? 0) + 1,
      occurredAt: occurredAt as never,
      type,
      payload,
    }
    const verkettet = chainEvent(letzter?.hash ?? GENESIS_HASH, event, this.hasher)
    this.ereignisse.push(verkettet)
    this.onLog('Ereignis ' + String(verkettet.seq) + ': ' + type)
    return Promise.resolve(verkettet)
  }

  async anzahl(): Promise<number> {
    return Promise.resolve(this.ereignisse.length)
  }

  async anzahlTyp(deviceId: string, type: string): Promise<number> {
    return Promise.resolve(
      this.ereignisse.filter((e) => e.deviceId === deviceId && e.type === type).length,
    )
  }
}

/** Event Log über den Rust-Teil: SQLite im WAL-Modus. */
class TauriEventLog implements EventLogPort {
  readonly info: { readonly target: string }

  constructor(
    private readonly pfad: string,
    private readonly onLog: (nachricht: string) => void,
  ) {
    this.info = { target: 'sqlite://' + pfad }
  }

  async anhaengen(
    deviceId: string,
    type: string,
    payload: string,
    occurredAt: string,
    id: string,
  ): Promise<ChainedEvent> {
    const ergebnis = await invoke<ChainedEvent>('eventlog_anhaengen', {
      pfad: this.pfad,
      deviceId,
      type,
      payload,
      occurredAt,
      id,
    })
    this.onLog('Ereignis ' + String(ergebnis.seq) + ': ' + type)
    return ergebnis
  }

  async anzahl(): Promise<number> {
    return invoke<number>('eventlog_anzahl', { pfad: this.pfad })
  }

  async anzahlTyp(deviceId: string, type: string): Promise<number> {
    return invoke<number>('eventlog_anzahl_typ', { pfad: this.pfad, deviceId, type })
  }
}

export function baueEventLog(
  konfiguration: EventLogKonfiguration,
  hasher: Hasher,
  onLog: (nachricht: string) => void,
): EventLogPort {
  if (konfiguration.art === 'sqlite' && laeuftInTauri()) {
    return new TauriEventLog(konfiguration.pfad ?? 'bonbon-eventlog.db', onLog)
  }
  if (konfiguration.art === 'sqlite') {
    onLog('Event Log `sqlite` verlangt den Rust-Teil — im Browser wird in den Speicher geschrieben.')
  }
  return new SpeicherEventLog(hasher, onLog)
}

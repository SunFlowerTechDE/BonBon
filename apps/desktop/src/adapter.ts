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
  type MockTseGespeichert,
  type MockTseSpeicher,
  PrinterError,
  type TsePort,
  cashDrawerPulse,
  previewLines,
} from '@bonbon/ports'

import type { DruckerKonfiguration, EventLogKonfiguration, Konfiguration } from './konfiguration.js'
import { TSE_ZUSTANDSDATEI, laeuftInTauri } from './konfiguration.js'

// --- Tauri-Aufruf ----------------------------------------------------------

type InvokeFn = <T>(befehl: string, argumente?: Record<string, unknown>) => Promise<T>

async function invoke<T>(befehl: string, argumente?: Record<string, unknown>): Promise<T> {
  const modul = (await import('@tauri-apps/api/core')) as { invoke: InvokeFn }
  return modul.invoke<T>(befehl, argumente)
}

// --- Dateien ---------------------------------------------------------------

/**
 * Dateizugriff — im Tauri-Fenster ueber den Rust-Teil, sonst gar nicht.
 *
 * `undefined` heisst „nicht da", ein geworfener Fehler heisst „da, aber nicht
 * lesbar". Beides zusammenzuwerfen hiesse, eine kaputte Konfiguration als
 * fehlende durchzuwinken — die Kasse liefe dann still mit den Vorgaben weiter.
 */
export interface DateiPort {
  lies(pfad: string): Promise<string | undefined>
  schreib(pfad: string, inhalt: string): Promise<void>
  anwendungsverzeichnis(): Promise<string>
}

class TauriDateien implements DateiPort {
  async lies(pfad: string): Promise<string | undefined> {
    return (await invoke<string | null>('datei_lesen', { pfad })) ?? undefined
  }

  async schreib(pfad: string, inhalt: string): Promise<void> {
    await invoke<void>('datei_schreiben', { pfad, inhalt })
  }

  async anwendungsverzeichnis(): Promise<string> {
    return invoke<string>('anwendungsverzeichnis')
  }
}

/** Dateien im Arbeitsspeicher — fuer den Browserbetrieb und fuer Tests. */
export class SpeicherDateien implements DateiPort {
  readonly inhalte = new Map<string, string>()

  constructor(private readonly ordner = 'speicher://anwendung') {}

  async lies(pfad: string): Promise<string | undefined> {
    return Promise.resolve(this.inhalte.get(pfad))
  }

  async schreib(pfad: string, inhalt: string): Promise<void> {
    this.inhalte.set(pfad, inhalt)
    return Promise.resolve()
  }

  async anwendungsverzeichnis(): Promise<string> {
    return Promise.resolve(this.ordner)
  }
}

export function baueDateien(): DateiPort {
  return laeuftInTauri() ? new TauriDateien() : new SpeicherDateien()
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

/**
 * Der Zustand der MockTse in einer Datei neben der Anwendung.
 *
 * Eine echte TSE ist ein Geraet und vergisst beim Neustart der Kasse nichts.
 * Ein Mock, der bei Transaktion 1 wieder anfaengt, verdeckt genau die Fehler,
 * die im Laden auffallen — wiederverwendete Transaktionsnummern und
 * Transaktionen, die offen stehenbleiben.
 */
export class MockTseSpeicherInDatei implements MockTseSpeicher {
  constructor(
    private readonly dateien: DateiPort,
    private readonly pfad: string,
    private readonly onLog: (nachricht: string) => void,
  ) {}

  async laden(): Promise<MockTseGespeichert | undefined> {
    const text = await this.dateien.lies(this.pfad)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as MockTseGespeichert
    } catch (fehler) {
      // Nicht stillschweigend bei 0 weitermachen: eine unlesbare Zustandsdatei
      // wuerde Transaktionsnummern ein zweites Mal vergeben.
      throw new Error(
        'Der gespeicherte TSE-Zustand in ' + this.pfad + ' ist unlesbar: ' + String(fehler),
      )
    }
  }

  async sichern(zustand: MockTseGespeichert): Promise<void> {
    try {
      await this.dateien.schreib(this.pfad, JSON.stringify(zustand, null, 2))
    } catch (fehler) {
      this.onLog('TSE-Zustand nicht sicherbar: ' + String(fehler))
      throw fehler
    }
  }
}

/**
 * Der Speicher fuer den MockTse-Zustand, neben der Anwendung.
 *
 * Scheitert schon das Ermitteln des Verzeichnisses, laeuft der Mock fluechtig
 * weiter — aber es wird gesagt. Ein Mock ohne Gedaechtnis ist besser als eine
 * Kasse, die deswegen nicht startet; verschwiegen wird es trotzdem nicht.
 */
export async function baueTseSpeicher(
  dateien: DateiPort,
  onLog: (nachricht: string) => void,
): Promise<MockTseSpeicher | undefined> {
  try {
    const ordner = await dateien.anwendungsverzeichnis()
    return new MockTseSpeicherInDatei(dateien, ordner + '/' + TSE_ZUSTANDSDATEI, onLog)
  } catch (fehler) {
    onLog(
      'TSE-Zustand wird nicht gesichert (' + String(fehler) + ') — Transaktionsnummern ' +
        'beginnen nach einem Neustart wieder bei 1.',
    )
    return undefined
  }
}

export function baueTse(
  konfiguration: Konfiguration,
  speicher: MockTseSpeicher | undefined,
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
    ...(speicher === undefined ? {} : { speicher }),
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
   * Das zuletzt geschriebene Ereignis eines Typs.
   *
   * Die Kasse liest daraus beim Start die zuletzt vergebene Belegnummer: das
   * letzte `SaleStarted` traegt sie im Payload. Eine Zaehlung waere der
   * fragilere Weg — sie stimmt nur, solange jeder begonnene Bon auch
   * abgeschlossen wird.
   */
  letztesEreignis(deviceId: string, type: string): Promise<ChainedEvent | undefined>
  /** Alle Ereignisse ab einer Sequenznummer, aufsteigend. */
  ereignisseAb(deviceId: string, abSeq: number): Promise<readonly ChainedEvent[]>
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

  async letztesEreignis(deviceId: string, type: string): Promise<ChainedEvent | undefined> {
    return Promise.resolve(
      this.ereignisse.filter((e) => e.deviceId === deviceId && e.type === type).at(-1),
    )
  }

  async ereignisseAb(deviceId: string, abSeq: number): Promise<readonly ChainedEvent[]> {
    return Promise.resolve(this.ereignisse.filter((e) => e.deviceId === deviceId && e.seq >= abSeq))
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

  async letztesEreignis(deviceId: string, type: string): Promise<ChainedEvent | undefined> {
    const gefunden = await invoke<ChainedEvent | null>('eventlog_letztes_ereignis', {
      pfad: this.pfad,
      deviceId,
      type,
    })
    return gefunden ?? undefined
  }

  async ereignisseAb(deviceId: string, abSeq: number): Promise<readonly ChainedEvent[]> {
    return invoke<ChainedEvent[]>('eventlog_ereignisse_ab', {
      pfad: this.pfad,
      deviceId,
      abSeq,
    })
  }
}

/**
 * Loest einen relativen Event-Log-Pfad gegen das Anwendungsverzeichnis auf.
 *
 * Ein absoluter Pfad bleibt, wie er ist — wer die Datenbank bewusst woandershin
 * legt, soll das koennen.
 */
export async function nebenDerAnwendung(
  dateien: DateiPort,
  konfiguration: EventLogKonfiguration,
): Promise<EventLogKonfiguration> {
  const pfad = konfiguration.pfad
  if (pfad === undefined || /^([A-Za-z]:[\/]|[\/])/.test(pfad)) return konfiguration
  const ordner = await dateien.anwendungsverzeichnis()
  return { ...konfiguration, pfad: ordner + '/' + pfad }
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

/**
 * Event Log auf SQLite — der echte Schreibpfad aus Regel 2, nicht eine
 * vereinfachte Nachbildung.
 *
 * - WAL-Modus, `synchronous = NORMAL`
 * - Hash-Kette über den Vorgänger
 * - lückenlose Sequenznummer je Gerät
 * - append-only: kein UPDATE, kein DELETE
 *
 * Benutzt `node:sqlite` aus Node selbst — keine Abhängigkeit, dieselbe
 * SQLite-Bibliothek, die auch der Rust-Teil später anspricht.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import {
  type ChainedEvent,
  GENESIS_HASH,
  type Hasher,
  type SaleEvent,
  chainEvent,
  isoTimestamp,
  verifyChain,
  type ChainVerification,
} from '@bonbon/core'

/** SHA-256 über Node. Der Kern selbst kennt keine Hashfunktion (Regel 11). */
export const nodeHasher: Hasher = {
  hash: (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex'),
}

export interface EventLogOptions {
  readonly path: string
  /**
   * `synchronous`-Stufe.
   *
   * NORMAL ist im WAL-Modus die uebliche Wahl: die Datenbank bleibt nach einem
   * Absturz des Betriebssystems konsistent, es kann aber die letzte
   * Transaktion fehlen. FULL waere sicherer und deutlich langsamer. Fuer eine
   * Kasse ist NORMAL vertretbar, weil ein fehlendes letztes Ereignis auffaellt
   * — eine kaputte Datei nicht.
   */
  readonly synchronous?: 'OFF' | 'NORMAL' | 'FULL'
}

export class EventLog {
  private readonly db: DatabaseSync
  private readonly einfuegen
  private readonly letzterStand

  constructor(private readonly options: EventLogOptions) {
    this.db = new DatabaseSync(options.path)

    // WAL erlaubt gleichzeitiges Lesen waehrend geschrieben wird und ist bei
    // hoher Schreiblast deutlich schneller als der Rollback-Journal-Modus.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = ' + (options.synchronous ?? 'NORMAL'))
    // Fremdschluessel brauchen wir hier nicht, aber die Pruefung kostet nichts.
    this.db.exec('PRAGMA foreign_keys = ON')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sale_events (
        id          TEXT    NOT NULL PRIMARY KEY,
        device_id   TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        occurred_at TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        prev_hash   TEXT    NOT NULL,
        hash        TEXT    NOT NULL,
        synced_at   TEXT,
        UNIQUE (device_id, seq)
      ) STRICT
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_device_seq ON sale_events (device_id, seq)')

    this.einfuegen = this.db.prepare(`
      INSERT INTO sale_events (id, device_id, seq, occurred_at, type, payload, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.letzterStand = this.db.prepare(
      'SELECT seq, hash FROM sale_events WHERE device_id = ? ORDER BY seq DESC LIMIT 1',
    )
  }

  /** Letzte Sequenznummer und Hash eines Geraets. */
  head(deviceId: string): { seq: number; hash: string } {
    const zeile = this.letzterStand.get(deviceId) as { seq: number; hash: string } | undefined
    return zeile ?? { seq: 0, hash: GENESIS_HASH }
  }

  /**
   * Haengt ein Ereignis an.
   *
   * Sequenznummer und Vorgaengerhash kommen aus dem gespeicherten Stand, nicht
   * aus dem Aufrufer — sonst koennte ein Fehler im Aufrufer eine Luecke
   * erzeugen. Das UNIQUE (device_id, seq) faengt zusaetzlich den Fall ab, dass
   * zwei Schreiber gleichzeitig dieselbe Nummer vergeben wollen.
   */
  append(
    deviceId: string,
    type: string,
    payload: string,
    occurredAt: string,
    id: string,
  ): ChainedEvent {
    const stand = this.head(deviceId)
    const event: SaleEvent = {
      id,
      deviceId,
      seq: stand.seq + 1,
      occurredAt: isoTimestamp(occurredAt),
      type,
      payload,
    }
    const verkettet = chainEvent(stand.hash, event, nodeHasher)
    this.einfuegen.run(
      verkettet.id,
      verkettet.deviceId,
      verkettet.seq,
      verkettet.occurredAt,
      verkettet.type,
      verkettet.payload,
      verkettet.prevHash,
      verkettet.hash,
    )
    return verkettet
  }

  count(): number {
    const zeile = this.db.prepare('SELECT COUNT(*) AS n FROM sale_events').get() as { n: number }
    return zeile.n
  }

  devices(): string[] {
    const zeilen = this.db
      .prepare('SELECT DISTINCT device_id FROM sale_events ORDER BY device_id')
      .all() as { device_id: string }[]
    return zeilen.map((z) => z.device_id)
  }

  /**
   * Liest die Kette eines Geraets in Bloecken und prueft sie.
   *
   * Blockweise, damit auch ein Bestand von zehn Jahren nicht komplett in den
   * Speicher muss — die Zielhardware hat 4 GB RAM.
   */
  verify(deviceId: string, batchSize = 5000): ChainVerification {
    const lesen = this.db.prepare(`
      SELECT id, device_id, seq, occurred_at, type, payload, prev_hash, hash
      FROM sale_events WHERE device_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `)

    const probleme: ChainVerification['problems'][number][] = []
    let geprueft = 0
    let letzteSeq = 0

    for (;;) {
      const zeilen = lesen.all(deviceId, letzteSeq, batchSize) as {
        id: string
        device_id: string
        seq: number
        occurred_at: string
        type: string
        payload: string
        prev_hash: string
        hash: string
      }[]
      if (zeilen.length === 0) break

      const block: ChainedEvent[] = zeilen.map((z) => ({
        id: z.id,
        deviceId: z.device_id,
        seq: z.seq,
        occurredAt: z.occurred_at as ChainedEvent['occurredAt'],
        type: z.type,
        payload: z.payload,
        prevHash: z.prev_hash,
        hash: z.hash,
      }))

      const ergebnis = verifyChain(block, nodeHasher, { expectedFirstSeq: letzteSeq + 1 })
      probleme.push(...ergebnis.problems)
      geprueft += ergebnis.checked
      letzteSeq = block[block.length - 1]?.seq ?? letzteSeq
      if (zeilen.length < batchSize) break
    }

    return { ok: probleme.length === 0, checked: geprueft, problems: probleme }
  }

  /**
   * Veraendert ein Ereignis nachtraeglich — **nur fuer den Manipulationstest**.
   *
   * Der Betrieb kennt diese Funktion nicht: der Log ist append-only (Regel 2).
   * Sie steht hier, damit sich nachweisen laesst, dass die Kettenpruefung eine
   * Veraenderung findet und die Stelle benennt.
   */
  tamperForTest(deviceId: string, seq: number, neuerPayload: string): void {
    this.db
      .prepare('UPDATE sale_events SET payload = ? WHERE device_id = ? AND seq = ?')
      .run(neuerPayload, deviceId, seq)
  }

  /** Loescht ein Ereignis — ebenfalls nur fuer den Manipulationstest. */
  deleteForTest(deviceId: string, seq: number): void {
    this.db.prepare('DELETE FROM sale_events WHERE device_id = ? AND seq = ?').run(deviceId, seq)
  }

  close(): void {
    this.db.close()
  }

  get path(): string {
    return this.options.path
  }
}

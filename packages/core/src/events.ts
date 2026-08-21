/**
 * Event Log — Typen und Hash-Kette (CLAUDE.md, Regel 2).
 *
 * Der Log ist append-only: kein UPDATE, kein DELETE. Korrekturen sind neue
 * Ereignisse. Die Hash-Kette über den Vorgänger ist nicht gesetzlich
 * vorgeschrieben, kostet aber fast nichts und macht bei einer Kassennachschau
 * belegbar, dass lokal nichts nachträglich verändert wurde.
 *
 * Dieses Modul ist plattformfrei und deterministisch (Regeln 11 und Struktur).
 * Es kennt keine Hashfunktion — die kommt als `Hasher` von außen, genau wie
 * Zeit und IDs. Im Node-Backend ist das `node:crypto`, im Tauri-Client der
 * Rust-Teil.
 */

import type { IsoTimestamp } from './time.js'

/**
 * Eine Hashfunktion. Muss für dieselbe Eingabe immer dieselbe Ausgabe liefern
 * und kryptographisch sein — SHA-256 als Hexstring in Kleinbuchstaben.
 */
export interface Hasher {
  hash(input: string): string
}

export interface SaleEvent {
  /** ULID, von außen erzeugt (Regel 11). */
  readonly id: string
  readonly deviceId: string
  /** Lückenlos je Gerät, beginnend bei 1. */
  readonly seq: number
  readonly occurredAt: IsoTimestamp
  readonly type: string
  /** Nutzdaten als bereits serialisiertes JSON. */
  readonly payload: string
}

export interface ChainedEvent extends SaleEvent {
  readonly prevHash: string
  readonly hash: string
}

/**
 * Vorgänger des ersten Ereignisses je Gerät.
 *
 * 64 Nullen, also dieselbe Länge wie ein SHA-256-Hex. Damit hat jede Zeile
 * dieselbe Form, und der Kettenanfang ist nicht durch ein leeres Feld
 * gekennzeichnet, das jemand versehentlich erzeugen könnte.
 */
export const GENESIS_HASH = '0'.repeat(64)

/**
 * Baut die Eingabe für den Hash.
 *
 * Jedes Feld wird **längenpräfigiert** aneinandergehängt. Ohne das ließen sich
 * Zeichen zwischen benachbarten Feldern verschieben, ohne den Hash zu ändern:
 * `type="a", payload="bc"` und `type="ab", payload="c"` ergäben bei einfacher
 * Verkettung dieselbe Eingabe. Mit Längenpräfix nicht.
 */
export function eventHashInput(prevHash: string, event: SaleEvent): string {
  const felder: readonly string[] = [
    prevHash,
    event.id,
    event.deviceId,
    String(event.seq),
    event.occurredAt,
    event.type,
    event.payload,
  ]
  return felder.map((f) => String(f.length) + ':' + f).join('|')
}

export function hashEvent(prevHash: string, event: SaleEvent, hasher: Hasher): string {
  return hasher.hash(eventHashInput(prevHash, event))
}

/** Hängt ein Ereignis an die Kette und berechnet seinen Hash. */
export function chainEvent(prevHash: string, event: SaleEvent, hasher: Hasher): ChainedEvent {
  return { ...event, prevHash, hash: hashEvent(prevHash, event, hasher) }
}

// --- Prüfung ---------------------------------------------------------------

export type ChainProblemKind =
  /** Der gespeicherte Hash passt nicht zum Inhalt — das Ereignis wurde verändert. */
  | 'hash-mismatch'
  /** Der Vorgängerhash passt nicht zum tatsächlichen Vorgänger — die Kette ist zerschnitten. */
  | 'prev-hash-mismatch'
  /** Eine Sequenznummer fehlt — ein Ereignis wurde entfernt. */
  | 'sequence-gap'
  /** Eine Sequenznummer kommt doppelt vor. */
  | 'sequence-duplicate'
  /** Die Kette beginnt nicht mit dem Genesis-Hash. */
  | 'bad-genesis'

export interface ChainProblem {
  readonly kind: ChainProblemKind
  readonly deviceId: string
  readonly seq: number
  readonly eventId: string
  readonly detail: string
}

export interface ChainVerification {
  readonly ok: boolean
  readonly checked: number
  readonly problems: readonly ChainProblem[]
}

/**
 * Prüft eine nach `seq` aufsteigend sortierte Kette eines Geräts.
 *
 * Gefunden werden vier Manipulationen:
 *
 * 1. Ein Ereignis wurde inhaltlich verändert → `hash-mismatch`
 * 2. Ein Ereignis wurde ersetzt → zusätzlich `prev-hash-mismatch` beim Nachfolger
 * 3. Ein Ereignis wurde entfernt → `sequence-gap`
 * 4. Ein Ereignis wurde eingefügt → `sequence-duplicate` oder `prev-hash-mismatch`
 *
 * Die Prüfung bricht nicht beim ersten Fund ab, sondern zählt alle Stellen auf.
 * Bei einer Kassennachschau ist die Frage nicht nur *ob*, sondern *wo* und
 * *wie oft*.
 */
export function verifyChain(
  events: readonly ChainedEvent[],
  hasher: Hasher,
  options: { readonly expectedFirstSeq?: number } = {},
): ChainVerification {
  const problems: ChainProblem[] = []
  let vorherigerHash = GENESIS_HASH
  let vorherigeSeq = (options.expectedFirstSeq ?? 1) - 1

  for (const event of events) {
    if (event.seq === vorherigeSeq) {
      problems.push({
        kind: 'sequence-duplicate',
        deviceId: event.deviceId,
        seq: event.seq,
        eventId: event.id,
        detail: 'Sequenznummer ' + String(event.seq) + ' kommt mehrfach vor',
      })
    } else if (event.seq !== vorherigeSeq + 1) {
      problems.push({
        kind: 'sequence-gap',
        deviceId: event.deviceId,
        seq: event.seq,
        eventId: event.id,
        detail:
          'Nach Sequenznummer ' +
          String(vorherigeSeq) +
          ' folgt ' +
          String(event.seq) +
          ' — es fehlen ' +
          String(event.seq - vorherigeSeq - 1) +
          ' Ereignisse',
      })
    }

    if (event.prevHash !== vorherigerHash) {
      problems.push({
        kind: vorherigeSeq < (options.expectedFirstSeq ?? 1) ? 'bad-genesis' : 'prev-hash-mismatch',
        deviceId: event.deviceId,
        seq: event.seq,
        eventId: event.id,
        detail:
          'prev_hash ist ' +
          event.prevHash.slice(0, 16) +
          '…, erwartet war ' +
          vorherigerHash.slice(0, 16) +
          '…',
      })
    }

    const erwartet = hashEvent(event.prevHash, event, hasher)
    if (erwartet !== event.hash) {
      problems.push({
        kind: 'hash-mismatch',
        deviceId: event.deviceId,
        seq: event.seq,
        eventId: event.id,
        detail:
          'Der gespeicherte Hash passt nicht zum Inhalt: gespeichert ' +
          event.hash.slice(0, 16) +
          '…, berechnet ' +
          erwartet.slice(0, 16) +
          '… — dieses Ereignis wurde nachtraeglich veraendert',
      })
    }

    vorherigerHash = event.hash
    vorherigeSeq = event.seq
  }

  return { ok: problems.length === 0, checked: events.length, problems }
}

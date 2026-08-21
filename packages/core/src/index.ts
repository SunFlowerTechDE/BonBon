/**
 * @bonbon/core — Domaenenkern.
 *
 * Dieses Paket ist plattformfrei: es laeuft unveraendert im Tauri-Webview und
 * im Node-Backend. Es importiert nichts, was nicht in jeder JS-Laufzeit
 * existiert — kein fs, kein window, kein React (CLAUDE.md, Struktur).
 *
 * Es ist ausserdem deterministisch: keine eigene Quelle fuer Zeit oder Zufall
 * (CLAUDE.md, Regel 11).
 *
 * Inhalt ab M1: Bonberechnung, Steuerlogik, Rabatte, Rundung, Event-Typen,
 * DSFinV-K-Mapping.
 */

export const CORE_PACKAGE_NAME = '@bonbon/core' as const

export const CORE_VERSION = '0.0.0' as const

export {
  type Cents,
  ZERO_CENTS,
  addCents,
  cents,
  multiplyCents,
  subtractCents,
  sumCents,
} from './money.js'

export { type Clock, type IdGenerator, type IsoTimestamp, isoTimestamp } from './time.js'

export {
  GENESIS_HASH,
  type ChainProblem,
  type ChainProblemKind,
  type ChainVerification,
  type ChainedEvent,
  type Hasher,
  type SaleEvent,
  chainEvent,
  eventHashInput,
  hashEvent,
  verifyChain,
} from './events.js'

export {
  type Beleg,
  type BelegRenderer,
  type Belegposition,
  type Haendlerangaben,
  type Steuerausweis,
  type TseSignatur,
  type Verzehrart,
  type Zahlart,
  type Zahlung,
  steuerKennzeichen,
  steuersatzText,
  verzehrartText,
  zahlartText,
} from './receipt.js'

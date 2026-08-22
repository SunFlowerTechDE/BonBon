/**
 * @bonbon/ports — Interfaces der Geraeteschicht plus Implementierungen.
 *
 * Alles, was Geld kostet oder Hardware braucht, liegt hinter einem schmalen
 * Interface mit je einer Mock- und einer Echt-Implementierung. Umgeschaltet
 * wird ueber Konfiguration, nie ueber Code (CLAUDE.md, Ports und Adapter).
 *
 * Hinweis zur Plattform: `TcpPrinter` braucht `node:net` und laeuft daher im
 * Backend, in Werkzeugen und im Rust-Teil — nicht im Webview. Interface,
 * ESC/POS-Erzeugung und Mock sind frei von Laufzeitabhaengigkeiten.
 */

export {
  PrinterError,
  type PrinterInfo,
  type PrinterPort,
  type PrintJob,
} from './printer/PrinterPort.js'

export {
  CODE_PAGE_WPC1252,
  UnsupportedCharacterError,
  encodeWpc1252,
  isPrintable,
  simplifyForReceipt,
} from './printer/codepage.js'

export {
  CHARACTERS_PER_LINE_58MM,
  CHARACTERS_PER_LINE_80MM,
  EscPosBuilder,
  LineTooWideError,
  align,
  beginJob,
  bold,
  cashDrawerPulse,
  cut,
  feed,
  initialize,
  selectCodePage,
  textSize,
  underline,
  wrap,
} from './printer/escpos.js'

export {
  type AnalysedLine,
  UnknownCommandError,
  analyseLines,
  findOverlongLines,
  hexdump,
  previewBox,
  previewLines,
  stripCommands,
} from './printer/preview.js'

export {
  EscPosReceiptRenderer,
  type EscPosReceiptOptions,
  euroText,
  zeitpunktText,
} from './printer/EscPosReceiptRenderer.js'

export { TcpPrinter, type TcpPrinterOptions } from './printer/TcpPrinter.js'
export { MockPrinter, type MockFailure, type MockPrinterOptions } from './printer/MockPrinter.js'

// --- Kartenzahlung ---------------------------------------------------------

export {
  PaymentError,
  UnresolvedPaymentError,
  assertSettled,
  type PaymentOutcome,
  type PaymentPort,
  type PaymentProgress,
  type PaymentRequest,
  type PaymentTerminalInfo,
} from './payment/PaymentPort.js'

export {
  ACK,
  CONFIG_BYTE_WITH_INTERMEDIATE_STATUS,
  CURRENCY_EUR,
  DEFAULT_PASSWORD,
  ECR_COMMAND,
  INTERMEDIATE_STATUS,
  INTERMEDIATE_TEXT,
  PT_COMMAND,
  RESULT_CODE,
  RESULT_TEXT,
  SERVICE_BYTE_STATUS_ONLY,
  intermediateText,
  isAbort,
  isPositiveAck,
  resultText,
} from './payment/zvt/constants.js'

export {
  BMP_LENGTH,
  ZvtProtocolError,
  type Apdu,
  type Bitmap,
  type DecodedApdu,
  buildBitmaps,
  decodeAmount,
  decodeApdu,
  decodeBcd,
  encodeAmount,
  encodeApdu,
  encodeBcd,
  findBitmap,
  parseBitmaps,
  toHex,
} from './payment/zvt/protocol.js'

export { ZvtPaymentTerminal, type ZvtPaymentOptions } from './payment/ZvtPaymentTerminal.js'

// --- TSE -------------------------------------------------------------------

export {
  TseError,
  type Signieranfrage,
  type Signierergebnis,
  type TsePort,
  type TseStatus,
  type TseZustand,
} from './tse/TsePort.js'

export { MockTse, type MockTseFehler, type MockTseOptions } from './tse/MockTse.js'

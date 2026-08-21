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

export { TcpPrinter, type TcpPrinterOptions } from './printer/TcpPrinter.js'
export { MockPrinter, type MockFailure, type MockPrinterOptions } from './printer/MockPrinter.js'

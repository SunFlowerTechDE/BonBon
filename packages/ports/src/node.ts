/**
 * @bonbon/ports/node — die Adapter, die eine Node-Laufzeit brauchen.
 *
 * Warum getrennt: `TcpPrinter` und `ZvtPaymentTerminal` bauen echte Sockets
 * auf und importieren dafuer `node:net`. Im Webview gibt es das nicht — dort
 * geht TCP ueber den Rust-Teil.
 *
 * Bis hierhin stand beides im Sammel-Modul, mit einem Hinweis im Kopf, dass es
 * nicht ins Webview gehoert. Der Hinweis stimmte; nur hielt sich der Bundler
 * nicht daran: er zieht am Sammel-Modul und bekommt `node:net` mit, ob es
 * gebraucht wird oder nicht. Der Bau des Webviews brach daran ab.
 *
 * Ein Kommentar, den ein Werkzeug nicht lesen kann, ist keine Grenze. Diese
 * hier ist eine: wer die Node-Adapter will, muss `@bonbon/ports/node`
 * schreiben und weiss damit, was er tut.
 */

export { TcpPrinter, type TcpPrinterOptions } from './printer/TcpPrinter.js'
export { ZvtPaymentTerminal, type ZvtPaymentOptions } from './payment/ZvtPaymentTerminal.js'

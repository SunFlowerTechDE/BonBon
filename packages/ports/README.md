# @bonbon/ports

Schmale Interfaces fuer alles, was Geld kostet oder Hardware braucht — plus je
eine Mock- und eine Echt-Implementierung. Umgeschaltet wird ueber Konfiguration,
nie ueber Code.

| Port | Mock | Echt |
|---|---|---|
| `TsePort` | `MockTse` | fiskaltrust Launcher (localhost), spaeter fiskaly/Swissbit |
| `PrinterPort` | escpresso auf `localhost:9100` | Epson TM-m30III |
| `CashDrawerPort` | Log-Zeile plus Symbol in der UI | `ESC p` ueber den Drucker |
| `PaymentPort` | `MockTerminal` auf `localhost:20007` | CCV Base Next ueber ZVT |

Jeder Mock braucht Schalter fuer Timeout, Ablehnung und Totalausfall. Mocks sind
Produktionscode und bleiben dauerhaft in der Testsuite (CLAUDE.md, Ports und Adapter).

---

## Zwei Einstiegspunkte

```ts
import { MockTse, EscPosReceiptRenderer } from '@bonbon/ports'       // ueberall
import { TcpPrinter, ZvtPaymentTerminal } from '@bonbon/ports/node'  // nur Node
```

`@bonbon/ports` ist **frei von Laufzeitabhaengigkeiten** und laeuft im Webview
genauso wie in Node. `@bonbon/ports/node` enthaelt die Adapter, die echte
Sockets aufmachen und dafuer `node:net` brauchen.

Die Trennung ist nicht kosmetisch. Vorher standen beide im selben
Einstiegspunkt, mit einem Hinweis im Kopf, dass `TcpPrinter` nicht ins Webview
gehoert. Der Hinweis stimmte — nur liest ein Bundler keine Kommentare: er zog
`node:net` in das Webview-Buendel, und der erste echte Bau der Anwendung brach
daran ab. `test/webview-tauglich.test.ts` prueft seitdem beide Richtungen: der
Webview-Einstiegspunkt darf kein `node:`-Modul erreichen, und
`@bonbon/ports/node` **muss** eines erreichen — sonst koennte die Pruefung gar
nichts finden und bliebe still gruen.

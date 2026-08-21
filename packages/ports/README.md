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

**Status:** Platzhalter. Inhalt entsteht in M0/M1.

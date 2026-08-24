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

## Die TSE-Transaktion hat einen Anfang

`TsePort` kennt vier Schritte, nicht einen:

```ts
beginneTransaktion()    // beim Oeffnen des Bons
signiere()              // beim Abschluss, beendet die Transaktion
brichTransaktionAb()    // Bon verworfen, oder Rest aus einem Absturz
offeneTransaktionen()   // beim Start der Kasse gefragt
```

Die Signatur entsteht nicht am Ende des Bons, sondern spannt sich ueber ihn.
Die KassenSichV verlangt die Protokollierung **mit Beginn** des
Aufzeichnungsvorgangs — sonst laege zwischen der ersten Position und dem
Abschluss ein Zeitraum, in dem nichts festgehalten ist.

Daraus folgt ein Zustand, den es vorher nicht gab: eine Transaktion, die
begonnen wurde und nie endete. Stuerzt die Kasse dazwischen ab, steht sie auf
der TSE offen, ohne lokales Gegenstueck. Deshalb gehoeren
`offeneTransaktionen()` und `brichTransaktionAb()` zum Port — ohne sie liesse
sich der Zustand nicht einmal feststellen.

### Abbildung auf fiskaltrust (nachgeschlagen, fuer M3)

| Hier | fiskaltrust |
|---|---|
| `beginneTransaktion` | `ftReceiptCase 0x4445000000000008` |
| `signiere` | Kassenbeleg, beendet die Transaktion |
| `brichTransaktionAb` | `ftReceiptCase 0x444500000000000B` (Fail-Transaction) |
| `offeneTransaktionen` | Zero-Receipt `0x4445000000000002`; die Antwort traegt `CurrentStartedTransactionNumbers` |

Zum Abbrechen kennt die Middleware zwei Wege. **Explizit** schliesst genau eine
Transaktion, referenziert ueber `cbReceiptReference`. **Implizit** schliesst
mehrere: die Nummern gehen als
`ftReceiptCaseData: {"CurrentStartedTransactionNumbers":[1,2,3]}` mit, und
`cbReceiptReference` **muss dann leer sein**. Der implizite Weg schliesst auch
Transaktionen, die nicht von der Middleware geoeffnet wurden — genau die
entstehen bei einem Absturz.

**Offen fuer M3:** welcher `ftSignatureType` die Nummern in der Antwort des
Zero-Receipts traegt, ist nicht belegt. Der Adapter sieht das am laufenden
Launcher nach, statt zu raten.

## Der MockTse vergisst nichts

Transaktionsnummer, Signaturzaehler und offene Transaktionen ueberdauern einen
Neustart, wenn ein `MockTseSpeicher` mitgegeben wird. Eine echte TSE ist ein
Geraet, kein Prozess — sie vergisst beim Neustart der Kasse nichts.

Ein Mock, der bei 1 wieder anfaengt, verdeckt genau die Fehler, die im Laden
auffallen: eine wiederverwendete Transaktionsnummer und ein Vorgang, der offen
stehenbleibt. Das ist dieselbe Regel wie „jeder Mock muss kaputtgehen koennen",
nur andersherum — ein Mock, der bequemer ist als das echte Geraet, testet den
falschen Fall.

Ohne Speicher bleibt er fluechtig; das ist der richtige Vorgabefall fuer einen
einzelnen Test.

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

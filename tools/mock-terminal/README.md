# @bonbon/mock-terminal

ZVT-Terminalsimulator, TCP auf Port 20007. Beantwortet Registrierung,
Autorisierung, Storno und Kassenschnitt, sendet Zwischenstände — und kann auf
Knopfdruck kaputtgehen.

```
pnpm terminal                                 Fehlerbild "erfolg"
pnpm terminal -- --szenario timeout           anderes Fehlerbild
pnpm terminal -- --port 20008 --delay 500     anderer Port, langsamer
```

Im laufenden Betrieb umschalten: Namen eintippen, Enter. `liste` zeigt die
Auswahl, `status` die intern verbuchten Vorgänge, `ende` beendet.

Ohne interaktives Terminal (Hintergrundprozess, Dienst, CI) läuft der Server
weiter und das Fehlerbild wird beim Start mit `--szenario` gewählt.

Der Gegenpart — eine Kasse, die zahlt — liegt in [tools/zvt-spike](../zvt-spike/):

```
pnpm zahlung                        3,80 EUR
pnpm zahlung -- --betrag 940        anderer Betrag, in Cent
pnpm zahlung -- --storno 0001       Storno einer Belegnummer
pnpm zahlung -- --kassenschnitt     Kassenschnitt
```

---

## Die Fehlerbilder

Ein Mock, der immer funktioniert, testet nur den Schönwetterfall — und der
Ausfallpfad ist bei einer Kasse der rechtlich heikelste Teil (CLAUDE.md,
Ports und Adapter).

| Name | Was passiert | Ausgang an der Kasse |
|---|---|---|
| `erfolg` | Zahlung wird angenommen | `approved` |
| `ablehnung-deckung` | Guthaben nicht ausreichend (0x71) | `declined` |
| `ablehnung-gesperrt` | Karte in Sperrliste (0x6E) | `declined` |
| `timeout` | nach den Zwischenständen kommt nichts mehr | `unknown` |
| `kundenabbruch` | Abbruchtaste (0x6C) | `aborted` |
| `abriss-nach-autorisierung` | **autorisiert, dann Leitung tot** | `unknown` |

### Der letzte Fall ist der Grund für dieses Werkzeug

Das Terminal hat die Zahlung beim Netzbetreiber durch. Der Kunde ist belastet.
Dann reißt die Verbindung ab, bevor die Status-Information bei der Kasse
ankommt — **der Betrieb weiß nicht, ob der Kunde bezahlt hat.**

Im Spike durchgespielt:

```
1. pnpm zahlung -- --betrag 940
   -> UNKLARER AUSGANG, Belegnummer unbekannt

   Terminal intern:  *** AUTORISIERT: Beleg 0001, 940 Cent ***
                     *** Verbindung wird gekappt, bevor die Status-Information
                         rausgeht. Die Kasse erfaehrt nichts. ***

2. pnpm zahlung -- --storno 0001
   -> ZAHLUNG ANGENOMMEN, 9,40 EUR
   Der Kunde WAR also belastet. Das Storno hat es rückgängig gemacht.

3. pnpm zahlung -- --storno 0001   (Gegenprobe)
   -> ZAHLUNG ABGELEHNT: Storno nicht möglich
   Beweis, dass Schritt 2 tatsächlich gewirkt hat.
```

**Wie eine Kasse den Fall auflöst**, nach ZVT-Spezifikation, in dieser
Reihenfolge (steht auch ausführlich im Code bei `unknownOutcome`):

1. **Status-Information erneut anfordern** — negative Quittung `84 9C`
   („Repeat Statusinfo"). Der günstigste Weg, es wird nichts rückgängig
   gemacht.
2. **Nachfragen** — `05 01` Status-Enquiry.
3. **Stornieren** — `06 30` Reversal mit `87<receipt-no>`. Der sichere Weg,
   wenn 1 und 2 nichts ergeben: lieber eine Zahlung stornieren, die nie
   stattgefunden hat — das Terminal antwortet dann „Storno nicht möglich" —,
   als eine erfolgte Belastung zu übersehen.

Bleibt es unklar, entscheidet ein Mensch. Die Software rät nicht
(CLAUDE.md, Regel 15).

---

## Protokoll

Nachrichtenaufbau nach **ECR-Interface ZVT-Protocol, Revision 13.09 final**
vom 20.11.2020 (VdTH, `PA00P015_13.09_final_en.pdf`), gegengeprüft an
[Portalum.Zvt](https://github.com/Portalum/Portalum.Zvt).

Die Spezifikation gibt es kostenlos beim
[VdTH](https://www.terminalhersteller.de/Downloads.aspx).

### APDU

```
Control-field (2 Byte)  Length (1 oder 3 Byte)  Data-block
```

Das Längenfeld ist einstellig bis 254 Byte. Bei `FF` folgen zwei weitere
Bytes, niederwertiges zuerst — Beispiel aus der Doku: `06 D3 FF 5D 03 …`
entspricht 0x035D = 861 Byte.

### Benutzte Befehle

| Code | Richtung | Bedeutung |
|---|---|---|
| `06 00` | ECR → PT | Registration |
| `06 01` | ECR → PT | Authorisation |
| `06 30` | ECR → PT | Reversal (Storno) |
| `06 50` | ECR → PT | End-of-Day (Kassenschnitt) |
| `06 B0` | ECR → PT | Abort |
| `04 FF` | PT → ECR | Intermediate Status-Information |
| `04 0F` | PT → ECR | Status-Information (Ergebnis in BMP 27) |
| `06 0F` | PT → ECR | Completion |
| `06 1E` | PT → ECR | Abort |
| `80 00` | beide | Positive Quittung |
| `84 9C` | ECR → PT | Repeat Statusinfo |

Beträge sind **6 Byte gepacktes BCD** (BMP 04) in der kleinsten
Währungseinheit — 3,80 EUR sind `00 00 00 00 03 80`. Kein Fließkomma, nirgends
(CLAUDE.md, Regel 3).

### Zwei Stolperstellen

**Die Registrierung wird nur mit `06 0F` Completion beantwortet**, ohne
Status-Information. Beim ersten Bauen hat der Client sie deshalb als unklaren
Ausgang gewertet. Wo eine Status-Information zu erwarten ist und wo nicht,
steht jetzt ausdrücklich am Aufruf.

**Die Statuscode-Tabellen im PDF verrutschen beim Extrahieren.** Die englische
Spalte steht eine Zeile tiefer als der Code, die deutsche nicht: bei `0A` liest
man englisch „Expired card", deutsch aber „Karte einstecken". Maßgeblich ist
die deutsche Spalte — Portalum.Zvt sagt an derselben Stelle „Insert card". Ein
Test hält das fest.

---

## Aufbau

Kein Socket in der Anwendungslogik. Die Kasse kennt nur `PaymentPort`
(CLAUDE.md, Ports und Adapter):

```
@bonbon/ports
  PaymentPort            Interface, vier Ausgänge inkl. unknown
  ZvtPaymentTerminal     ZVT über TCP — Mock und echtes Gerät, nur andere IP
  zvt/protocol.ts        APDU, BCD, Bitmaps — reine Bytes, kein I/O
  zvt/constants.ts       Befehle, Ergebniscodes, Zwischenstände

tools/mock-terminal      dieser Simulator
tools/zvt-spike          die Kasse, die dagegen zahlt
```

Eine zweite Implementierung für ein echtes Terminal ist nicht nötig — dieselbe
`ZvtPaymentTerminal` spricht mit beiden. Später kommen Payment-SDKs für Mobile
daneben, ohne dass sich am Aufrufer etwas ändert.

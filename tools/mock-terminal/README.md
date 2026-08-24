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
1. Zahlung ueber 9,40 EUR
   -> UNKLARER AUSGANG, Belegnummer unbekannt

   Terminal intern:  *** AUTORISIERT: Beleg 0001, 940 Cent ***
                     *** Verbindung wird gekappt, bevor die Status-Information
                         rausgeht. Die Kasse erfaehrt nichts. ***

2. Nachfrage: Repeat Receipt (06 20), Service-byte 03
   -> Betrag 9,40 EUR, Belegnummer 0001, Ergebnis "kein Fehler"

3. Betrag stimmt mit dem angeforderten ueberein
   -> aufgeklaert: der Kunde HAT bezahlt. Die Kasse schliesst den Bon mit
      dieser Belegnummer ab. Ein Storno waere hier falsch.
```

Gegenprobe mit dem Fehlerbild `timeout`, bei dem nichts autorisiert wurde:

```
2. Nachfrage -> "Funktion nicht moeglich"
3. Es gab keine erfolgreiche Zahlung. Der Bon bleibt offen.
```

**Schritt 2 ist der Kern.** Ohne ihn kennt die Kasse die Belegnummer gar nicht
und könnte nicht einmal stornieren — im Betrieb fällt sie nicht vom Himmel.

**Wie eine Kasse den Fall auflöst**, nach ZVT-Spezifikation, in dieser
Reihenfolge (steht auch ausführlich im Code bei `unknownOutcome` und
`queryLastTransaction`):

1. **Status-Information erneut anfordern** — negative Quittung `84 9C`
   („Repeat Statusinfo"). Setzt voraus, dass der Dialog noch steht; beim
   Verbindungsabriss ist er weg, also meist nicht anwendbar.
2. **Nachfragen** — `06 20` Repeat Receipt mit Service-byte `03`. Die
   Spezifikation nennt ihn wörtlich für diesen Zweck (2.20.2): *„the PT sends
   the Status-Information of the last transaction executed. This ensures that
   the ECR can resynchronise in case of an inconclusive ending of a
   transaction."* Der einzige Weg, der Ergebnis **und** Belegnummer liefert.
   `05 01` Status-Enquiry leistet das nicht — es meldet den Zustand des
   Terminals, nicht den des letzten Vorgangs.
3. **Stornieren** — `06 30` Reversal mit `87<receipt-no>`. Nur wenn 2 kein
   klares Ergebnis bringt: lieber eine Zahlung stornieren, die nie
   stattgefunden hat — das Terminal antwortet dann „Storno nicht möglich" —,
   als eine erfolgte Belastung zu übersehen.

Weicht der bei 2 gemeldete Betrag vom angeforderten ab, wird **nicht**
automatisch storniert: dann gehört der letzte Vorgang womöglich zu einem
anderen Bon.

Zusätzliches Sicherheitsnetz aus dem Protokoll selbst (2.2.8): Bleibt die
Quittung der Kasse zur Status-Information aus, führt das Terminal von sich aus
ein **Auto-Reversal** durch — allerdings erst nach Entnahme der Karte, und
danach nicht mehr. Darauf allein darf sich die Kasse nicht verlassen.

Ob ein **CCV Base Next** `06 20` beherrscht, ist nicht belegt. Der Befehl
gehört zum Standard und Portalum.Zvt setzt ihn um, dessen Testliste nennt aber
CardComplete, Hobex, Worldline und Global Payments — CCV nicht. Vor dem
Pilotbetrieb am echten Gerät nachweisen.

Bleibt es unklar, entscheidet ein Mensch. Die Software rät nicht
(CLAUDE.md, Regel 15).

---

## Protokoll

Nachrichtenaufbau nach **ECR-Interface ZVT-Protocol, Revision 13.09 final**
vom 20.11.2020 (VdTH, `PA00P015_13.09_final_en.pdf`), gegengeprüft an
[Portalum.Zvt](https://github.com/Portalum/Portalum.Zvt).

Die Spezifikation gibt es kostenlos beim
[VdTH](https://www.terminalhersteller.de/Downloads.aspx).

> ### Offener Punkt: Revision 13.13 nachziehen
>
> Umgesetzt ist **13.09** vom 20.11.2020. Beim VdTH liegt inzwischen
> **13.13** vom 17.06.2025.
>
> Für den Mock unkritisch — er spricht mit sich selbst. **Vor dem ersten
> echten Terminal muss jemand die Unterschiede durchsehen**, besonders bei:
>
> - **Ergebniscodes** (Kapitel 10) — neue Codes laufen hier als „unbekannter
>   ZVT-Ergebniscode 0x.." auf. Sichtbar ist gewollt, am Tresen aber unschön.
> - **Zwischenständen** (Tabelle 17) — dasselbe für die Anzeige.
> - **Repeat Receipt (06 20)** und dem Service-byte, weil die Auflösung eines
>   unklaren Ausgangs daran hängt.
> - **TLV-Tags**, falls wir sie später brauchen.
>
> Erledigt in: —

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
| `06 20` | ECR → PT | Repeat Receipt (Nachfrage letzter Vorgang) |
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

### Drei Stolperstellen

**Die Registrierung wird nur mit `06 0F` Completion beantwortet**, ohne
Status-Information. Beim ersten Bauen hat der Client sie deshalb als unklaren
Ausgang gewertet. Wo eine Status-Information zu erwarten ist und wo nicht,
steht jetzt ausdrücklich am Aufruf.

**Die Statuscode-Tabellen im PDF verrutschen beim Extrahieren.** Die englische
Spalte steht eine Zeile tiefer als der Code, die deutsche nicht: bei `0A` liest
man englisch „Expired card", deutsch aber „Karte einstecken". Maßgeblich ist
die deutsche Spalte — Portalum.Zvt sagt an derselben Stelle „Insert card". Ein
Test hält das fest.

**`05 01` Status-Enquiry ist nicht das, wonach es klingt.** Es meldet den
Zustand des Terminals für zeitgesteuerte Aktionen, nicht das Ergebnis des
letzten Vorgangs. Für die Wiederaufnahme nach einem Abriss braucht es `06 20`.

---

## Aufbau

Kein Socket in der Anwendungslogik. Die Kasse kennt nur `PaymentPort`
(CLAUDE.md, Ports und Adapter):

```
@bonbon/ports
  PaymentPort            Interface, vier Ausgänge inkl. unknown
                         plus queryLastTransaction() für die Wiederaufnahme
  ZvtPaymentTerminal     ZVT über TCP — Mock und echtes Gerät, nur andere IP
  zvt/protocol.ts        APDU, BCD, Bitmaps — reine Bytes, kein I/O
  zvt/constants.ts       Befehle, Ergebniscodes, Zwischenstände

tools/mock-terminal      dieser Simulator
tools/zvt-spike          die Kasse, die dagegen zahlt
```

Eine zweite Implementierung für ein echtes Terminal ist nicht nötig — dieselbe
`ZvtPaymentTerminal` spricht mit beiden. **Das ist eine Annahme**, keine
Messung: geprüft ist nur die Seite gegen diesen Simulator, und der stammt aus
derselben Lesart der Spezifikation wie der Adapter. Später kommen Payment-SDKs für Mobile
daneben, ohne dass sich am Aufrufer etwas ändert.

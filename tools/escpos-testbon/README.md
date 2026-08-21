# @bonbon/escpos-testbon

M0-Spike: ESC/POS-Testbon gegen escpresso auf TCP 9100, spaeter gegen einen
echten Epson TM-m30III.

```
pnpm testbon                      an localhost:9100
pnpm testbon --host 192.168.1.50  an ein echtes Geraet
pnpm testbon --mock               ohne Netzwerk
pnpm testbon --no-drawer          ohne Kassenladen-Impuls
pnpm testbon --hexdump            zusaetzlich die rohen Bytes
```

Der Bon enthaelt Kopfzeile, drei Positionen mit Umlauten, Summe, den
Steuerausweis fuer 19 % und 7 % getrennt und die TSE-Signaturdaten im Fuss.

Alle festen Beschriftungen tragen echte Umlaute — `Rückgeld`, `außer Haus`,
`Signaturzähler`, `Prüfwert`, `für Ihren Besuch`. Behelfsschreibweisen gibt es
nicht, die Codepage kann sie. Das Eszett liegt auf 0xDF, also nicht im selben
Block wie die Umlaute, und wird eigens getestet.

## Signatur und Vorgang gehoeren zusammen

`baueTestbon` nimmt **einen abgeschlossenen Vorgang**, nicht Positionen und
Signatur getrennt (CLAUDE.md, Regel 14). Der Typ ist nur ueber `abschliessen()`
zu bekommen, und diese Funktion prueft gegen den Pruefwert, dass beides
zusammengehoert: Kassenseriennummer, Transaktionsnummer, Signaturzaehler,
Zahlbetrag und die Summen je Steuersatz.

Die Signatur im Testbon stammt aus einem echten Rundlauf mit
`pnpm spike --warenkorb`, also fuer genau diesen Warenkorb:

```
Beleg^7.70_1.70_0.00_0.00_0.00^9.40:Bar;4;8
      19 %  7 %              Summe
```

## escpresso starten

```
git clone https://github.com/jflaflamme/escpresso.git
cd escpresso
cargo build --release
./target/release/escpresso
```

Es oeffnet ein Fenster und lauscht auf `0.0.0.0:9100`. Papierbreite im Fenster
auf **80mm** stellen; oben rechts steht dann `48cpl | :9100`.

---

## Die drei Entscheidungen, die hier zaehlen

### Codepage: WPC1252, gesetzt mit `ESC t 16`

Der TM-m30III startet laut Technical Reference Guide mit
`Default Character Code Page: PC437`. PC437 kann Umlaute, aber **kein Euro** —
und die Einstellung geht bei `ESC @`, Reset und Ausschalten verloren. Deshalb
setzt **jeder** Druckauftrag die Codepage selbst, in dieser Reihenfolge:

```
ESC @        zuruecksetzen        1B 40
ESC t 16     WPC1252 waehlen      1B 74 10
```

Umgekehrt waere es falsch: `ESC @` wuerde die Codepage wieder auf PC437 setzen.

Warum WPC1252 und nicht PC858:

1. Enthaelt alle deutschen Zeichen **und** das Eurozeichen.
2. Im Bereich 0xA0–0xFF byteweise identisch mit den Unicode-Codepoints —
   `ä` ist U+00E4 und Byte 0xE4. In PC858 stuende `ä` auf 0x84, das braucht
   eine DOS-Positionstabelle.
3. escpresso bildet die Codepages 2, 16 und 19 **alle** auf Windows-1252 ab
   (`src/main.rs`, `ESC t`). Bei n = 19 zeigt der Emulator also etwas anderes
   als ein echtes Geraet. Nur bei n = 16 stimmen beide ueberein.

Kein Zeichen wird still ersetzt: `encodeWpc1252` wirft bei allem, was die
Codepage nicht kann, und nennt Zeichen, Codepoint und Position. Ein Beleg mit
`K?sekuchen` entsteht gar nicht erst.

### Zeichen pro Zeile: abhängig vom Schriftmodus

`CHARACTERS_PER_LINE_80MM = 48` ist die Breite bei **einfacher** Breite, belegt
aus dem TM-m30III TRG (48/35 column mode ist Werkseinstellung, Font A = 48).

**Die nutzbare Breite ist keine Konstante, sondern eine Funktion des
Schriftmodus.** In doppelter Breite passen nur 24 Zeichen. Der `EscPosBuilder`
führt den Modus mit und rechnet die Breite bei jeder Zeile neu aus; `columns`,
`rule` und `wrapped` benutzen diesen Wert. Eine zu breite Zeile wirft
(`LineTooWideError`), statt über den Papierrand zu laufen.

Die Summenzeile nutzt das: doppelte Breite, dadurch 24 Zeichen, und der Betrag
steht am rechten Papierrand. Vorher wurde sie in doppelter Breite gesetzt, aber
weiter auf 48 Spalten ausgerichtet — der wichtigste Betrag des Bons landete
neben dem Papier.

`findOverlongLines()` liest den fertigen Bytestrom zurück, bestimmt für jede
Zeile den geltenden Modus und meldet jede Zeile, die zu breit ist. Der Test
prüft damit den **ganzen** Bon, nicht einzelne Stellen.

### Kassenladen-Impuls: `ESC p 0 50 50`

```
1B 70 00 32 32
```

`m = 0` ist Pin 2 des Anschlusses, `t1`/`t2` sind Einheiten zu 2 ms — also
100 ms Impuls und 100 ms Pause. Zu kurze Impulse oeffnen manche Schloesser
nicht. Der Impuls wird im Protokoll ausgegeben, mit Bytes und Klartext.

Er ist ein eigener Aufruf am Port (`openCashDrawer`), nicht Teil des Bons: die
Lade muss auch ohne Beleg aufgehen, etwa beim Kassensturz.

---

## Bekannter Unterschied zwischen escpresso und echtem Geraet

**escpresso liest `GS !` mit vertauschten Haelften.**

Epson (TM-T20 ESC/POS Quick Reference):

> Upper 4 bits of n: width magnification
> Lower 4 bits of n: height magnification

escpresso (`src/main.rs`, GS-Zweig `b'!'`):

```rust
let width_mul  = (mode & 0x07) + 1;      // liest Breite UNTEN
let height_mul = ((mode >> 4) & 0x07) + 1;
```

Folge: Die Zeile `SUMME EUR … 9,40` wird mit `GS ! 0x01` gesendet — nach Epson
doppelte Hoehe, einfache Breite. escpresso macht daraus doppelte **Breite**,
damit passen nur 24 statt 48 Spalten, und der Betrag faellt rechts aus dem Bild.

**Geloest ohne Anpassung an den Emulator:** Die Summenzeile benutzt jetzt
`GS ! 0x11` — doppelte Breite *und* doppelte Hoehe. Weil beide Halbbytes gleich
sind, liest escpresso denselben Modus wie ein echter Drucker; die vertauschte
Auswertung faellt nicht mehr ins Gewicht. Die Zeile wird auf 24 Zeichen
ausgerichtet und passt damit auf beiden Seiten aufs Papier.

Bei `0x01` oder `0x10` wuerden Vorschau und Geraet weiter auseinanderlaufen.
Am TM-m30III in M6 gegenzupruefen.

---

## Aufbau

Kein Socket in der Anwendungslogik. Der Spike kennt nur `PrinterPort`
(CLAUDE.md, Ports und Adapter):

```
@bonbon/ports
  PrinterPort      Interface
  TcpPrinter       TCP 9100 — escpresso und echtes Geraet, nur andere IP
  MockPrinter      mit Schaltern fuer refused, timeout, outOfPaper, partialWrite
  escpos.ts        Befehle und Bonaufbau, reine Bytes, kein I/O
  codepage.ts      WPC1252, wirft statt zu ersetzen
  preview.ts       Bytestrom als Text, fuer Konsole und Test

tools/escpos-testbon
  testbon.ts       Bonaufbau, reine Funktion
  main.ts          Aufruf, Ausgabe, Fehlerbehandlung
```

Eine USB-Implementierung kommt spaeter daneben, ohne dass sich am Aufrufer
etwas aendert.

Die Betraege sind `Cents` aus `@bonbon/core`. Nach Euro umgerechnet wird
ausschliesslich in der Darstellung (CLAUDE.md, Regel 3).

> **Hinweis zu `steuerAusBrutto`:** Die Funktion steht vorlaeufig hier, damit
> der Testbon einen Steuerausweis zeigen kann. Sie gehoert in M1 nach
> `@bonbon/core`, zusammen mit den uebrigen Rundungsregeln und Property-based
> Tests.

# @bonbon/tse-spike

M0-Spike: ein vollstaendiger Vorgang gegen den lokal laufenden fiskaltrust Launcher.

Der Spike liegt in `tools/`, nicht in `packages/core`. Er darf die Uhr lesen und
Netzwerk benutzen — Regel 11 gilt nur fuer den Kern. Die Betraege kommen trotzdem
als `Cents` aus `@bonbon/core`.

```
pnpm spike              expliziter Ablauf: Startbeleg, dann Abschlussbeleg
pnpm spike --implicit   ein einziger Sign-Aufruf, Middleware macht beides
pnpm spike --verbose    zusaetzlich jeder Request und jede Antwort im Rohtext
```

## Was der Spike macht

1. `Echo` gegen den Launcher, danach `Journal` mit `ftJournalType 0` fuer die Version
2. `Sign` mit Start-transaction-receipt (`0x4445000000000008`)
3. Position: 1x Cappuccino, 3,80 EUR, 19 %, Verzehr im Haus
4. `Sign` mit Pos-receipt (`0x4445000000000001`) und Barzahlung
5. Alle Signaturdaten, erst die sechs Belegfelder, dann `ftSignatures` ungefiltert

---

## Den Launcher auf Windows zum Laufen bringen

### 1. CashBox im Portal anlegen

Im fiskaltrust Portal (Sandbox) unter **Configuration → CashBox** eine CashBox
anlegen. Bei der Rolle KassenHersteller gibt es dafuer die gefuehrte Anlage.
Die CashBox braucht:

- eine **Queue** (Markt DE)
- eine **SCU** (Signature Creation Unit) — in der Sandbox die Software-TSE
- die Zuordnung Queue → SCU

Ohne zugeordnete SCU nimmt die Queue zwar Belege an, kann aber nicht signieren.
Das ist der haeufigste Grund, warum der erste Rundlauf scheitert.

### 2. CashBox neu bauen

Nach jeder Aenderung an der Konfiguration im Portal **Rebuild** ausloesen. Der
Launcher laedt seine Konfiguration beim Start aus der Cloud; ohne Rebuild
arbeitet er mit dem alten Stand.

### 3. Launcher herunterladen

Im Portal beim CashBox-Eintrag den Launcher fuer Windows herunterladen und in
einen Ordner ohne Leerzeichen entpacken, zum Beispiel `C:\fiskaltrust`.

Das Paket enthaelt `fiskaltrust.exe` sowie die Hilfsskripte `install-service.cmd`,
`uninstall-service.cmd` und `test.cmd`.

### 4. Beim ersten Mal im Testmodus starten

**Nicht** gleich als Dienst installieren. Erst im Testmodus, dort siehst du die
Logausgabe direkt:

```
Rechtsklick auf test.cmd  →  Als Administrator ausführen
```

Der Testmodus schreibt beim Start, welche Endpunkte er oeffnet. Warte, bis die
Queue als bereit gemeldet wird.

Zwei Eigenheiten des Testmodus unter Windows:

- **Jeder Tastendruck im Fenster beendet die Middleware.** Also nicht
  hineinklicken und tippen.
- Ein Klick ins Fenster schaltet den Markierungsmodus der Konsole ein und
  **haelt die Verarbeitung an**, bis du `Esc` drueckst. Wenn der Spike
  ploetzlich in den Timeout laeuft, ist meistens das die Ursache.

### 5. Queue-URL aus dem Portal holen

**Configuration → Queue**, den Listeneintrag aufklappen, die URL kopieren. Sie
sieht so aus:

```
rest://localhost:1500/f84bf516-a17b-4432-afa6-8c1050e2854d
```

Der Port stammt aus deiner Queue-Konfiguration und ist **nicht** fest — nicht
raten, kopieren. Falls der Port schon belegt ist, startet der Launcher nicht;
dann im Portal den Port aendern, CashBox neu bauen, Launcher neu herunterladen.

### 6. `.env` anlegen

```
cp .env.example .env
```

und ausfuellen:

```
FISKALTRUST_CASHBOX_ID=<CashBox-ID aus dem Portal>
FISKALTRUST_ACCESS_TOKEN=<Access Token aus dem Portal>
FISKALTRUST_URL=rest://localhost:1500/<deine-queue-id>
```

`.env` steht in `.gitignore` und wird nie committet. Das `rest://` darf stehen
bleiben, der Spike rechnet es selbst in `http://` um.

### 7. Rundlauf starten

```
pnpm spike
```

Beim ersten Versuch lohnt sich `pnpm spike --verbose` — dann siehst du jeden
Request und jede Antwort im Rohtext.

### 8. Erst danach als Dienst installieren

Wenn der Rundlauf steht, den Testmodus beenden und

```
Rechtsklick auf install-service.cmd  →  Als Administrator ausführen
```

Danach laeuft die Middleware ueber die Windows-Dienste
(`net start` / `net stop`).

---

## Wenn es hakt

Der Spike verschluckt nichts: bei einem HTTP-Fehler bekommst du Statuszeile,
alle Header und den **ungekuerzten** Antwortkoerper, bei einem Netzwerkfehler
die vollstaendige `cause`-Kette samt `code`. Meldet die Middleware einen
Fehlerzustand in `ftState`, werden zusaetzlich alle `ftSignatures` ausgegeben —
laut Dokumentation steht der Grund genau dort.

| Symptom | Meist die Ursache |
|---|---|
| `ECONNREFUSED` | Launcher laeuft nicht, oder falscher Port in `FISKALTRUST_URL` |
| `404` | Queue-ID in der URL passt nicht zur laufenden CashBox |
| Timeout ohne Antwort | Konsolenfenster des Testmodus steht im Markierungsmodus (`Esc`) |
| `ftState` meldet ERROR/FAIL | Queue ohne zugeordnete SCU, oder CashBox nicht neu gebaut |

---

## Quellen

Alle Endpunkte, Feldnamen und Kennzahlen stammen aus der Dokumentation, die
Fundstelle steht jeweils im Code daneben:

- [Installation](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/general/installation)
- [Desktop Launcher](https://docs.fiskaltrust.cloud/docs/posdealers/technical-operations/middleware/launchers/desktop)
- [Integration Steps](https://docs.fiskaltrust.cloud/docs/poscreators/get-started/middleware-integration)
- [Communication](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/general/communication)
- [Middleware API v1](https://docs.fiskaltrust.cloud/apis/middleware-api-v1)
- [Data Structures](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/general/data-structures)
- [Single Receipt Creation (DE)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/germany/single-receipt-creation)
- [ftReceiptCase (DE)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/germany/reference-tables/ftreceiptcase)
- [ftChargeItemCase (DE)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/germany/reference-tables/ftchargeitemcase)
- [ftPayItemCase (DE)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/germany/reference-tables/ftpayitemcase)
- [ftSignatureType (DE)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/germany/reference-tables/ftsignaturetype)
- [Reference Tables (allgemein)](https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/general/reference-tables)

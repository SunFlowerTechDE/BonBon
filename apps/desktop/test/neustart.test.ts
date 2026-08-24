/**
 * Was ein Absturz hinterlässt — und wie die Kasse damit umgeht.
 *
 * Alle Fälle hier stammen aus dem Beweislauf durch die gebaute Anwendung. Im
 * kopflosen Verkaufstest konnten sie nicht auffallen: dort lebt jede Kasse nur
 * für die Dauer eines Tests, und ein Neustart kommt darin nicht vor. Genau
 * deshalb steht der Lauf durch das echte Fenster daneben — und deshalb wandern
 * seine Funde hierher zurück, wo sie bei jedem Testlauf geprüft werden.
 *
 * Ein Absturz wird nicht behauptet, sondern **vollzogen**: die Kasse wird
 * fallengelassen, ohne den Bon zu beenden. Event Log und TSE-Zustand
 * überdauern das, weil beide dieselben Speicher weiterbenutzen — genau wie im
 * Laden, wo die SQLite-Datei und das TSE-Gerät den Prozess überleben.
 */

import { describe, expect, it, vi } from 'vitest'

import { cents, gesamtbetrag } from '@bonbon/core'
import { MockTse, MockTseSpeicherImRam } from '@bonbon/ports'

import {
  SpeicherEventLog,
  TauriDrucker,
  VorschauDrucker,
  entwicklungsHasher,
} from '../src/adapter.js'
import { Kasse, TSE_AUFGELOEST } from '../src/kasse.js'
import { VORGABE } from '../src/konfiguration.js'

/**
 * Eine Kasse mit Speichern, die einen Neustart überdauern.
 *
 * Log und TSE-Speicher werden hereingereicht, die Kasse selbst nicht: jeder
 * Aufruf erzeugt eine neue. Das **ist** der Neustart.
 */
function starteKasse(
  log: SpeicherEventLog,
  tseSpeicher: MockTseSpeicherImRam,
  protokoll: string[] = [],
): { kasse: Kasse; tse: MockTse; protokoll: string[] } {
  const melde = (n: string): void => {
    protokoll.push(n)
  }
  const tse = new MockTse({ seriennummer: 'MOCK-TSE-TEST', speicher: tseSpeicher, onLog: melde })
  const kasse = new Kasse(VORGABE, tse, new VorschauDrucker(48, melde), log, melde)
  return { kasse, tse, protokoll }
}

async function neueKasse(
  log: SpeicherEventLog,
  tseSpeicher: MockTseSpeicherImRam,
  protokoll: string[] = [],
): Promise<{ kasse: Kasse; tse: MockTse; protokoll: string[] }> {
  const gestartet = starteKasse(log, tseSpeicher, protokoll)
  await gestartet.tse.ladeZustand()
  await gestartet.kasse.richteEin()
  return gestartet
}

async function verkaufe(kasse: Kasse): Promise<string> {
  await kasse.beginneBon('im-haus')
  await kasse.tippeArtikel('KAFFEE')
  const ergebnis = await kasse.schliesseAb('bar', cents(300))
  return ergebnis.beleg.belegnummer
}

describe('Belegnummer über einen Neustart', () => {
  it('fängt nicht wieder bei 1 an', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    const nummer1 = await verkaufe((await neueKasse(log, tseSpeicher)).kasse)
    const nummer2 = await verkaufe((await neueKasse(log, tseSpeicher)).kasse)

    expect(nummer1).toBe('BONBON-DEV-001-00001')
    expect(nummer2).toBe('BONBON-DEV-001-00002')
  })

  it('verbraucht die Nummer auch bei einem verworfenen Bon', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    const { kasse } = await neueKasse(log, tseSpeicher)
    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAFFEE')
    const verworfen = await kasse.brichAb('Kunde hat es sich anders ueberlegt')
    expect(verworfen.zustand).toBe('abgebrochen')
    expect(verworfen.saleId).toBe('BONBON-DEV-001-00001')

    // Genau hier lag der Fehler der Zaehlung: sie haette den verworfenen Bon
    // nicht mitgezaehlt und die 00001 ein zweites Mal vergeben.
    const naechste = await verkaufe((await neueKasse(log, tseSpeicher)).kasse)
    expect(naechste).toBe('BONBON-DEV-001-00002')

    const nummern = log.ereignisse
      .filter((e) => e.type === 'SaleStarted')
      .map((e) => (JSON.parse(e.payload) as { saleId: string }).saleId)
    expect(new Set(nummern).size).toBe(nummern.length)
  })

  it('kommt mit ueberlappenden Tipps zurecht', async () => {
    // Gefunden im Beweislauf: zwei Klicks auf denselben Artikel im Abstand von
    // 120 ms ergaben statt zwei Cappuccino nur einen — beide Vorgaenge lasen
    // denselben Bon und rechneten dieselbe Ereignis-Id aus. Hier werden sie
    // absichtlich gleichzeitig losgeschickt, ohne dazwischen zu warten.
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const { kasse } = await neueKasse(log, new MockTseSpeicherImRam())

    await Promise.all([
      kasse.tippeArtikel('CAPPUCCINO'),
      kasse.tippeArtikel('CAPPUCCINO'),
      kasse.tippeArtikel('KAESEKUCHEN'),
    ])

    const bon = kasse.bon
    expect(bon?.saleId).toBe('BONBON-DEV-001-00001')
    expect(gesamtbetrag(bon as never)).toBe(2 * 380 + 390) // 11,50 EUR

    const ids = log.ereignisse.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Genau ein Bon wurde eroeffnet, nicht drei.
    expect(log.ereignisse.filter((e) => e.type === 'SaleStarted')).toHaveLength(1)
  })

  it('vergibt keine Ereignis-Id zweimal', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    for (let neustart = 0; neustart < 3; neustart += 1) {
      await verkaufe((await neueKasse(log, tseSpeicher)).kasse)
    }

    const ids = log.ereignisse.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(log.ereignisse.map((e) => e.seq)).toEqual(log.ereignisse.map((_, i) => i + 1))
  })
})

describe('Der Bon lebt im Log, von Anfang an', () => {
  it('schreibt jedes Ereignis, wenn es passiert — nicht erst beim Abschluss', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const { kasse } = await neueKasse(log, new MockTseSpeicherImRam())

    await kasse.beginneBon('im-haus')
    expect(log.ereignisse.map((e) => e.type)).toEqual(['SaleStarted'])

    await kasse.tippeArtikel('KAFFEE')
    expect(log.ereignisse.map((e) => e.type)).toEqual(['SaleStarted', 'LineAdded'])

    await kasse.setzeVerzehrart('ausser-haus')
    expect(log.ereignisse.map((e) => e.type)).toEqual([
      'SaleStarted',
      'LineAdded',
      'DiningModeChanged',
    ])

    await kasse.schliesseAb('bar', cents(300))
    expect(log.ereignisse.map((e) => e.type)).toEqual([
      'SaleStarted',
      'LineAdded',
      'DiningModeChanged',
      'PaymentTaken',
      'SaleFinished',
    ])
  })

  it('übernimmt ein Ereignis nicht, wenn das Schreiben scheitert', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const { kasse } = await neueKasse(log, new MockTseSpeicherImRam())
    await kasse.beginneBon('im-haus')

    const echtesAnhaengen = log.anhaengen.bind(log)
    const kaputt = vi.spyOn(log, 'anhaengen').mockRejectedValueOnce(new Error('Datentraeger voll'))

    await expect(kasse.tippeArtikel('KAFFEE')).rejects.toThrow('Datentraeger voll')
    // Der Bon zeigt die Position nicht — sonst liefen Anzeige und
    // Aufzeichnung auseinander.
    expect(kasse.bon?.zeilen).toHaveLength(0)

    kaputt.mockImplementation(echtesAnhaengen)
    await kasse.tippeArtikel('KAFFEE')
    expect(kasse.bon?.zeilen).toHaveLength(1)
  })

  it('hält einen verworfenen Bon als SaleCancelled fest, mit Grund', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const { kasse, tse } = await neueKasse(log, new MockTseSpeicherImRam())

    await kasse.beginneBon('im-haus')
    await kasse.tippeArtikel('KAFFEE')
    await kasse.brichAb('Kunde ist gegangen')

    const abbruch = log.ereignisse.find((e) => e.type === 'SaleCancelled')
    expect(abbruch).toBeDefined()
    expect((JSON.parse(abbruch?.payload ?? '{}') as { grund: string }).grund).toBe(
      'Kunde ist gegangen',
    )
    // Und die TSE-Transaktion steht danach nicht mehr offen.
    expect(await tse.offeneTransaktionen()).toEqual([])
    expect(tse.abgebrocheneVorgaenge).toHaveLength(1)
  })
})

describe('Verwaiste TSE-Transaktion nach einem Absturz', () => {
  it('bricht sie ab, wenn der Bon im Log unvollständig ist', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    // --- Lauf 1: Bon beginnen, dann abstürzen ---
    const erste = await neueKasse(log, tseSpeicher)
    await erste.kasse.beginneBon('im-haus')
    await erste.kasse.tippeArtikel('KAFFEE')
    expect(erste.kasse.laufendeTransaktion).toBe('1')
    expect(await erste.tse.offeneTransaktionen()).toHaveLength(1)
    // Hier ist der Absturz: die Kasse wird einfach nicht mehr benutzt.

    // --- Lauf 2 ---
    const protokoll: string[] = []
    const zweite = await neueKasse(log, tseSpeicher, protokoll)

    expect(await zweite.tse.offeneTransaktionen()).toEqual([])
    expect(zweite.tse.abgebrocheneVorgaenge).toEqual([
      { transaktionsnummer: 1, grund: 'Beim Start vorgefunden: kein abgeschlossener Bon im Log' },
    ])

    // Der unbeendete Bon ist als abgebrochen festgehalten, nicht verschwunden.
    expect(log.ereignisse.filter((e) => e.type === 'SaleCancelled')).toHaveLength(1)

    // Und das Aufräumen selbst steht im Log — nicht nur im Bildschirmprotokoll.
    const aufgeloest = log.ereignisse.filter((e) => e.type === TSE_AUFGELOEST)
    expect(aufgeloest).toHaveLength(1)
    expect(JSON.parse(aufgeloest[0]?.payload ?? '{}')).toMatchObject({
      transaktionsnummer: '1',
      ausgang: 'abgebrochen',
    })
    expect(protokoll.join(' ')).toContain('TSE-Transaktion 1: abgebrochen')

    // Die nächste Belegnummer läuft weiter, sie wird nicht wiederverwendet.
    expect(await verkaufe(zweite.kasse)).toBe('BONBON-DEV-001-00002')
  })

  it('schließt sie ab, wenn der Bon im Log vollständig ist', async () => {
    // Der Absturz zwischen dem Schreiben von SaleFinished und der Signatur.
    // Genau dafür schreibt die Kasse den Log **vor** der Signatur: dieser
    // Zustand ist reparierbar, der umgekehrte nicht.
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    const erste = await neueKasse(log, tseSpeicher)
    await erste.kasse.beginneBon('im-haus')
    await erste.kasse.tippeArtikel('KAFFEE')

    // Die Signatur schlägt fehl, weil die TSE genau jetzt nicht antwortet —
    // die Transaktion steht aber bereits offen.
    erste.tse.setFehler({ art: 'ausgefallen', grund: 'Absturz mitten im Abschluss' })
    const ergebnis = await erste.kasse.schliesseAb('bar', cents(300))
    expect(ergebnis.signiert).toBe(false)

    // Der Log ist vollständig: SaleFinished steht drin.
    expect(log.ereignisse.map((e) => e.type)).toContain('SaleFinished')
    // Und die Transaktion steht noch offen.
    erste.tse.setFehler({ art: 'keiner' })
    expect(await erste.tse.offeneTransaktionen()).toHaveLength(1)

    // --- Neustart ---
    const protokoll: string[] = []
    const zweite = await neueKasse(log, tseSpeicher, protokoll)

    expect(await zweite.tse.offeneTransaktionen()).toEqual([])
    expect(zweite.tse.abgebrocheneVorgaenge).toEqual([])
    expect(zweite.tse.signierteVorgaenge.map((v) => v.belegreferenz)).toEqual([
      'BONBON-DEV-001-00001',
    ])

    const aufgeloest = log.ereignisse.filter((e) => e.type === TSE_AUFGELOEST)
    expect(JSON.parse(aufgeloest[0]?.payload ?? '{}')).toMatchObject({
      ausgang: 'abgeschlossen',
      belegreferenz: 'BONBON-DEV-001-00001',
    })
    // Der Bon war abgeschlossen — er bekommt kein SaleCancelled.
    expect(log.ereignisse.filter((e) => e.type === 'SaleCancelled')).toHaveLength(0)
    expect(protokoll.join(' ')).toContain('abgeschlossen')
  })

  it('sperrt die Kasse nicht, wenn die TSE beim Start nicht antwortet', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    const erste = await neueKasse(log, tseSpeicher)
    await erste.kasse.beginneBon('im-haus')
    await erste.kasse.tippeArtikel('KAFFEE')

    // Neustart, aber die TSE ist weg. Regel 8: die Kasse läuft weiter.
    const protokoll: string[] = []
    const gestartet = starteKasse(log, tseSpeicher, protokoll)
    await gestartet.tse.ladeZustand()
    gestartet.tse.setFehler({ art: 'ausgefallen', grund: 'TSE-Stick nicht erkannt' })
    await expect(gestartet.kasse.richteEin()).resolves.toBeUndefined()

    expect(protokoll.join(' ')).toContain('nicht abfragbar')
    expect(protokoll.join(' ')).toContain('beim naechsten Start nachgeholt')
  })
})

describe('Die MockTse vergisst nichts', () => {
  it('führt die Transaktionsnummer über Neustarts fort', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    const erste = await neueKasse(log, tseSpeicher)
    await verkaufe(erste.kasse)
    expect(erste.tse.signierteVorgaenge.at(-1)?.transaktionsnummer).toBe(1)

    const zweite = await neueKasse(log, tseSpeicher)
    await verkaufe(zweite.kasse)

    // Ein Mock, der bei 1 wieder anfinge, verdeckte genau den Fehler, den der
    // Lauf durch die gebaute Anwendung gefunden hat.
    expect(zweite.tse.signierteVorgaenge.at(-1)?.transaktionsnummer).toBe(2)
  })

  it('zählt den Signaturzähler weiter, nicht neu', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    const tseSpeicher = new MockTseSpeicherImRam()

    await verkaufe((await neueKasse(log, tseSpeicher)).kasse)
    const gespeichert = await tseSpeicher.laden()
    expect(gespeichert?.signaturzaehler).toBeGreaterThan(0)

    await verkaufe((await neueKasse(log, tseSpeicher)).kasse)
    const danach = await tseSpeicher.laden()
    expect(danach?.signaturzaehler).toBeGreaterThan(gespeichert?.signaturzaehler ?? 0)
  })

  it('bleibt ohne Speicher flüchtig — der Vorgabefall für einen Einzeltest', async () => {
    const ohne = new MockTse({ seriennummer: 'MOCK-TSE-TEST' })
    await ohne.ladeZustand()
    await ohne.beginneTransaktion({ belegreferenz: 'X-1', kassenSeriennummer: 'K' })
    expect(await ohne.offeneTransaktionen()).toHaveLength(1)

    const neu = new MockTse({ seriennummer: 'MOCK-TSE-TEST' })
    await neu.ladeZustand()
    expect(await neu.offeneTransaktionen()).toEqual([])
  })

  it('meldet eine Signatur ohne offene Transaktion als Ausfall, nicht als Erfolg', async () => {
    // Regel 12: kein stilles Durchwinken. Eine Signatur auf eine Transaktion,
    // die es nicht gibt, waere eine Signatur ohne Vorgang.
    const tse = new MockTse()
    const ergebnis = await tse.signiere({
      belegreferenz: 'X-1',
      kassenSeriennummer: 'K',
      transaktionsnummer: '99',
      umsaetze: {
        regel19: cents(0),
        ermaessigt7: cents(0),
        durchschnitt107: cents(0),
        durchschnitt55: cents(0),
        null0: cents(0),
      },
      zahlungen: [],
    })
    expect(ergebnis.art).toBe('ausgefallen')
  })
})

const rufeTauri = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (befehl: string, argumente: unknown) => rufeTauri(befehl, argumente) as Promise<unknown>,
}))

describe('TauriDrucker.isReachable', () => {
  it('meldet nicht erreichbar, wenn der Befehl `false` liefert', async () => {
    rufeTauri.mockReset().mockResolvedValue(false)
    const drucker = new TauriDrucker('127.0.0.1', 9100, 48, () => undefined)

    // Hier stand vorher `await invoke(...); return true` — der Aufruf gelang,
    // also galt der Drucker als erreichbar, obwohl niemand lauschte.
    await expect(drucker.isReachable()).resolves.toBe(false)

    // Ohne diese Zeile wäre der Test wertlos: greift der Mock nicht, wirft
    // der echte Aufruf, `catch` liefert ebenfalls `false` — grün aus dem
    // falschen Grund.
    expect(rufeTauri).toHaveBeenCalledWith('tcp_erreichbar', {
      host: '127.0.0.1',
      port: 9100,
    })
  })

  it('meldet erreichbar, wenn der Befehl `true` liefert', async () => {
    rufeTauri.mockReset().mockResolvedValue(true)
    const drucker = new TauriDrucker('127.0.0.1', 9100, 48, () => undefined)
    await expect(drucker.isReachable()).resolves.toBe(true)
  })

  it('meldet nicht erreichbar und protokolliert, wenn der Aufruf selbst scheitert', async () => {
    rufeTauri.mockReset().mockRejectedValue(new Error('IPC weg'))
    const protokoll: string[] = []
    const drucker = new TauriDrucker('127.0.0.1', 9100, 48, (n) => protokoll.push(n))

    await expect(drucker.isReachable()).resolves.toBe(false)
    expect(protokoll.join(' ')).toContain('IPC weg')
  })
})

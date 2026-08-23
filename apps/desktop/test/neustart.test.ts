/**
 * Was ein Neustart der Kasse nicht kaputtmachen darf.
 *
 * Beide Faelle hier stammen aus dem Beweislauf durch die gebaute Anwendung.
 * Im kopflosen Verkaufstest konnten sie nicht auffallen: dort lebt jede Kasse
 * nur fuer die Dauer eines Tests, und ein Neustart kommt darin nicht vor.
 * Genau deshalb steht der Lauf durch das echte Fenster daneben — und genau
 * deshalb wandern seine Funde hierher zurueck, wo sie bei jedem Testlauf
 * geprueft werden.
 */

import { describe, expect, it, vi } from 'vitest'

import { cents } from '@bonbon/core'
import { MockTse } from '@bonbon/ports'

import { SpeicherEventLog, TauriDrucker, VorschauDrucker, entwicklungsHasher } from '../src/adapter.js'
import { Kasse } from '../src/kasse.js'
import { VORGABE } from '../src/konfiguration.js'

/**
 * Ein Event Log, das den Inhalt ueber „Neustarts" hinweg behaelt.
 *
 * Die zweite Kasse bekommt dasselbe Log — das ist der Neustart: neue Kasse,
 * neuer Arbeitsspeicher, aber dieselbe Aufzeichnung auf dem Datentraeger.
 */
function baueKasse(log: SpeicherEventLog): Kasse {
  return new Kasse(VORGABE, new MockTse(), new VorschauDrucker(48, () => undefined), log, () => undefined)
}

async function verkaufe(kasse: Kasse): Promise<string> {
  kasse.beginneBon('im-haus')
  kasse.tippeArtikel('KAFFEE')
  const ergebnis = await kasse.schliesseAb('bar', cents(300))
  return ergebnis.beleg.belegnummer
}

describe('Belegnummer ueber einen Neustart', () => {
  it('faengt nicht wieder bei 1 an', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)

    const erste = baueKasse(log)
    await erste.knuepfeAnVorgeschichteAn()
    const nummer1 = await verkaufe(erste)

    // --- Neustart: neue Kasse, dasselbe Log ---
    const zweite = baueKasse(log)
    await zweite.knuepfeAnVorgeschichteAn()
    const nummer2 = await verkaufe(zweite)

    expect(nummer1).toBe('BONBON-DEV-001-00001')
    expect(nummer2).toBe('BONBON-DEV-001-00002')
  })

  it('vergibt keine Ereignis-Id zweimal', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)

    for (let neustart = 0; neustart < 3; neustart += 1) {
      const kasse = baueKasse(log)
      await kasse.knuepfeAnVorgeschichteAn()
      await verkaufe(kasse)
    }

    const ids = log.ereignisse.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Und die Kette bleibt lueckenlos durchnummeriert.
    expect(log.ereignisse.map((e) => e.seq)).toEqual(
      log.ereignisse.map((_, i) => i + 1),
    )
  })

  it('haelt die Invariante: Anzahl der SaleStarted-Ereignisse gleich hoechste Belegnummer', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)

    for (let neustart = 0; neustart < 4; neustart += 1) {
      const kasse = baueKasse(log)
      await kasse.knuepfeAnVorgeschichteAn()
      // Ein Bon, der begonnen und offen gelassen wird — seine Nummer wird nie
      // geschrieben und darf danach neu vergeben werden.
      kasse.beginneBon('im-haus')
      kasse.tippeArtikel('TEE')
      // ... und dann doch ein richtiger Verkauf, im selben Bon.
      await kasse.schliesseAb('bar', cents(250))
    }

    const begonnene = log.ereignisse.filter((e) => e.type === 'SaleStarted')
    expect(begonnene).toHaveLength(4)
    const nummern = begonnene.map((e) => (JSON.parse(e.payload) as { saleId: string }).saleId)
    expect(nummern).toEqual([
      'BONBON-DEV-001-00001',
      'BONBON-DEV-001-00002',
      'BONBON-DEV-001-00003',
      'BONBON-DEV-001-00004',
    ])
  })

  it('schlaegt ohne das Anknuepfen fehl — sonst pruefte der Test nichts', async () => {
    const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
    // Der Speicher-Log weist doppelte Ids nicht ab, SQLite schon (Primaer-
    // schluessel). Geprueft wird deshalb die Ursache: dieselbe Belegnummer.
    const erste = baueKasse(log)
    await erste.knuepfeAnVorgeschichteAn()
    const nummer1 = await verkaufe(erste)

    const ohneAnknuepfen = baueKasse(log)
    const nummer2 = await verkaufe(ohneAnknuepfen)

    expect(nummer2).toBe(nummer1)
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

    // Ohne diese Zeile waere der Test wertlos: greift der Mock nicht, wirft
    // der echte Aufruf, `catch` liefert ebenfalls `false` — gruen aus dem
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

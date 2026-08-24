/**
 * Der Diagnose-Modus — und die zwei Bedingungen, die ihn begrenzen.
 *
 * Er misst den Verkaufspfad. Ein Werkzeug, das dabei selbst bremst oder seine
 * Werte in die steuerliche Aufzeichnung schreibt, richtet mehr Schaden an als
 * es Erkenntnis bringt. Beide Bedingungen sind hier geprüft, nicht nur
 * beschrieben.
 */

import { describe, expect, it, vi } from 'vitest'

import { cents } from '@bonbon/core'
import { MockTse, MockTseSpeicherImRam } from '@bonbon/ports'

import {
  DiagnoseSenke,
  SpeicherDateien,
  SpeicherEventLog,
  VorschauDrucker,
  entwicklungsHasher,
} from '../src/adapter.js'
import {
  CSV_KOPF,
  KEINE_DIAGNOSE,
  MARKE,
  Verkaufsmessung,
  alsCsv,
  alsProtokollzeile,
  werteAus,
} from '../src/diagnose.js'
import { Kasse } from '../src/kasse.js'
import { VORGABE } from '../src/konfiguration.js'

/** Eine Uhr, die nur vorwärts geht, wenn der Test es sagt. */
function stellUhr(): { jetzt: () => number; weiter: (ms: number) => void } {
  let stand = 1000
  return {
    jetzt: () => stand,
    weiter: (ms) => {
      stand += ms
    },
  }
}

async function baueKasse(): Promise<{ kasse: Kasse; log: SpeicherEventLog; protokoll: string[] }> {
  const protokoll: string[] = []
  const log = new SpeicherEventLog(entwicklungsHasher(), () => undefined)
  const kasse = new Kasse(
    VORGABE,
    new MockTse({ speicher: new MockTseSpeicherImRam() }),
    new VorschauDrucker(48, () => undefined),
    log,
    (n) => protokoll.push(n),
  )
  await kasse.richteEin()
  return { kasse, log, protokoll }
}

describe('Die Messung beginnt beim ersten Artikeltipp', () => {
  it('rechnet Zeitpunkte relativ zum Beginn, nicht zur Wanduhr', () => {
    const uhr = stellUhr()
    const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')

    uhr.weiter(2500)
    messung.punkt(MARKE.artikel + 'Cappuccino')
    uhr.weiter(1200)
    messung.punkt(MARKE.artikel + 'Käsekuchen')

    expect(messung.messpunkte.map((p) => p.zeitpunktMs)).toEqual([2500, 3700])
  })

  it('misst Maschinenphasen als Dauer, nicht als Zeitpunkt', () => {
    const uhr = stellUhr()
    const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')

    uhr.weiter(500)
    const fertig = messung.beginne('TSE-Signatur')
    uhr.weiter(180)
    fertig()

    const punkt = messung.messpunkte[0]
    expect(punkt?.art).toBe('maschine')
    expect(punkt?.zeitpunktMs).toBe(500)
    expect(punkt?.dauerMs).toBe(180)
  })
})

describe('Die Auswertung nennt die Abstaende, nicht nur die Summe', () => {
  const uhr = stellUhr()
  const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')
  uhr.weiter(0)
  messung.punkt(MARKE.artikel + 'Cappuccino')
  uhr.weiter(900)
  messung.punkt(MARKE.artikel + 'Käsekuchen')
  uhr.weiter(300)
  messung.punkt('Zahlung geoeffnet')
  // Die lange Pause: jemand rechnet, was der Kunde gibt.
  uhr.weiter(7000)
  messung.punkt('Betrag gewaehlt: 20,00')
  uhr.weiter(400)
  messung.punkt(MARKE.zahlungsart + 'bar')
  const fertig = messung.beginne('TSE-Signatur')
  uhr.weiter(120)
  fertig()
  uhr.weiter(80)
  messung.punkt(MARKE.fertig)

  const a = werteAus(messung.messpunkte)

  it('trennt die Zeit vor und nach der Zahlungsart', () => {
    // 900 + 300 + 7000 + 400 = 8600 bis zur Zahlungsart, danach 120 ms
    // Signatur und 80 ms bis das Raster wieder frei ist.
    expect(a.gesamtMs).toBe(8800)
    expect(a.bisZahlungsartMs).toBe(8600)
    expect(a.abZahlungsartMs).toBe(200)
  })

  it('findet die laengste Pause und sagt, wovor sie lag', () => {
    // Das ist der Wert, um den es geht: eine lange Pause vor der
    // Betragsbestaetigung heisst etwas anderes als eine zwischen zwei Artikeln.
    expect(a.laengstePause.vorMs).toBe(7000)
    expect(a.laengstePause.bezeichnung).toBe('Betrag gewaehlt: 20,00')
  })

  it('zaehlt die Artikeltipps und summiert die Maschinenzeit getrennt', () => {
    expect(a.tipps).toBe(2)
    expect(a.maschineMs).toBe(120)
  })

  it('fasst das in eine Zeile, die niemand ueberliest', () => {
    const zeile = alsProtokollzeile(a, 'BONBON-DEV-001-00007')
    expect(zeile).toContain('8.8 s gesamt')
    expect(zeile).toContain('2 Tipps')
    expect(zeile).toContain('laengste Pause 7.0 s')
  })
})

describe('Die CSV', () => {
  it('traegt den Abstand als eigene Spalte', () => {
    const uhr = stellUhr()
    const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')
    messung.punkt(MARKE.artikel + 'Kaffee')
    uhr.weiter(1500)
    messung.punkt(MARKE.artikel + 'Kaffee')

    const zeilen = alsCsv(messung.messpunkte, 'lauf-1', 'BON-1').trim().split('\n')
    expect(zeilen[0]?.split(';')).toEqual([
      'lauf-1', 'BON-1', '1', 'interaktion', 'Artikel: Kaffee', '0', '0', '',
    ])
    expect(zeilen[1]?.split(';')[6]).toBe('1500')
  })

  it('verschiebt die Spalten nicht, wenn eine Bezeichnung ein Semikolon enthaelt', () => {
    const uhr = stellUhr()
    const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')
    messung.punkt('Artikel: Brot; Butter')
    const zeile = alsCsv(messung.messpunkte, 'lauf', 'BON').trim()
    expect(zeile.split(';')).toHaveLength(CSV_KOPF.trim().split(';').length)
  })

  it('schreibt den Kopf nur einmal', async () => {
    const dateien = new SpeicherDateien()
    const senke = new DiagnoseSenke(dateien, 'diagnose.csv', () => undefined)
    await senke.schreibe('a;b\n')
    await senke.schreibe('c;d\n')
    const inhalt = dateien.inhalte.get('diagnose.csv') ?? ''
    expect(inhalt.split('\n').filter((z) => z.startsWith('verkauf;'))).toHaveLength(1)
    expect(inhalt).toContain('a;b')
    expect(inhalt).toContain('c;d')
  })

  it('laesst einen Schreibfehler nicht nach aussen', async () => {
    // Ein Diagnosewerkzeug, das einen Verkauf zu Fall bringt, ist sein Geld
    // nicht wert.
    const dateien = new SpeicherDateien()
    vi.spyOn(dateien, 'haenge').mockRejectedValue(new Error('Datentraeger voll'))
    const protokoll: string[] = []
    const senke = new DiagnoseSenke(dateien, 'diagnose.csv', (n) => protokoll.push(n))

    await expect(senke.schreibe('x\n')).resolves.toBeUndefined()
    expect(protokoll.join(' ')).toContain('Datentraeger voll')
  })
})

describe('Bedingung 1: die Messwerte gehen nicht in den Event Log', () => {
  it('schreibt waehrend eines gemessenen Verkaufs kein einziges Diagnoseereignis', async () => {
    const { kasse, log } = await baueKasse()
    const uhr = stellUhr()
    const messung = new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00')
    kasse.setzeDiagnose(messung)

    await kasse.tippeArtikel('CAPPUCCINO')
    await kasse.setzeVerzehrart('ausser-haus')
    await kasse.schliesseAb('bar', cents(500))

    // Der Log ist die steuerliche Aufzeichnung. Nichts, was nach Messung
    // aussieht, darf darin auftauchen.
    const typen = log.ereignisse.map((e) => e.type)
    expect(typen.filter((t) => /diagnose|messung|zeit/i.test(t))).toEqual([])
    // Und auch keine Nutzlast traegt Messwerte ein.
    const alles = log.ereignisse.map((e) => e.payload).join(' ')
    expect(alles).not.toContain('zeitpunktMs')
    expect(alles).not.toContain('dauerMs')

    // Gemessen wurde trotzdem.
    expect(messung.messpunkte.length).toBeGreaterThan(3)
  })
})

describe('Bedingung 2: im Verkaufspfad wird nichts angefasst', () => {
  it('beruehrt waehrend des Verkaufs keine Datei', async () => {
    const { kasse } = await baueKasse()
    const dateien = new SpeicherDateien()
    const gelesen = vi.spyOn(dateien, 'lies')
    const geschrieben = vi.spyOn(dateien, 'schreib')
    const angehaengt = vi.spyOn(dateien, 'haenge')

    const uhr = stellUhr()
    kasse.setzeDiagnose(new Verkaufsmessung(uhr.jetzt, '2026-08-24T10:00:00+02:00'))
    await kasse.tippeArtikel('KAFFEE')
    await kasse.schliesseAb('bar', cents(300))

    // Messen heisst Zeitstempel merken. Geschrieben wird erst danach, und
    // zwar von der Anwendung, nicht von der Kasse (Regel 6).
    expect(gelesen).not.toHaveBeenCalled()
    expect(geschrieben).not.toHaveBeenCalled()
    expect(angehaengt).not.toHaveBeenCalled()
  })

  it('kostet nichts, wenn der Modus aus ist', async () => {
    const { kasse, log } = await baueKasse()
    // Vorgabe ist KEINE_DIAGNOSE — drei leere Methoden ohne Zustand.
    kasse.setzeDiagnose(KEINE_DIAGNOSE)
    await kasse.tippeArtikel('KAFFEE')
    const ergebnis = await kasse.schliesseAb('bar', cents(300))

    expect(ergebnis.signiert).toBe(true)
    expect(log.ereignisse.length).toBeGreaterThan(0)
    expect(KEINE_DIAGNOSE.aktiv).toBe(false)
  })
})

describe('Der Modus ist standardmaessig aus', () => {
  it('steht in der Vorgabe auf aus', () => {
    // Regel 21: bei einem Kunden waere das Verhaltens- und
    // Leistungskontrolle. Ein Vorgabewert `an` waere ein Rechtsproblem,
    // kein Bequemlichkeitsdetail.
    expect(VORGABE.diagnose.art).toBe('aus')
  })
})

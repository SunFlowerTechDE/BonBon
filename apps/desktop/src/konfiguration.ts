/**
 * Konfiguration der Kasse.
 *
 * **Kein Adapter ist im Code fest verdrahtet** (CLAUDE.md, Ports und Adapter).
 * Welche TSE, welcher Drucker, welcher Event Log — das steht hier und wird zur
 * Laufzeit aus `bonbon.config.json` gelesen.
 *
 * Die Vorgaben sind so gewählt, dass die App **ohne laufenden Launcher und
 * ohne Drucker startet**: MockTse und Vorschaudrucker. Wer den echten Weg
 * will, ändert die Datei — nicht den Code.
 */

import type { Haendlerangaben } from '@bonbon/core'

export interface TseKonfiguration {
  readonly art: 'mock' | 'fiskaltrust'
  /** Nur bei `fiskaltrust`: Queue-URL aus dem Portal, `rest://` oder `http://`. */
  readonly url?: string
  readonly cashBoxId?: string
  readonly accessToken?: string
}

export interface DruckerKonfiguration {
  /** `tcp` = echter Drucker oder escpresso, `vorschau` = nur anzeigen. */
  readonly art: 'tcp' | 'vorschau'
  readonly host?: string
  readonly port?: number
  readonly zeichenProZeile?: number
  /** Kassenladen-Impuls mitsenden. */
  readonly kassenlade?: boolean
}

export interface EventLogKonfiguration {
  /** `sqlite` schreibt über den Rust-Teil, `speicher` nur in den Arbeitsspeicher. */
  readonly art: 'sqlite' | 'speicher'
  readonly pfad?: string
}

export interface Konfiguration {
  readonly kasse: {
    readonly deviceId: string
    /** Kassenseriennummer, geht in den Prüfwert und auf den Beleg. */
    readonly seriennummer: string
  }
  readonly haendler: Haendlerangaben
  readonly tse: TseKonfiguration
  readonly drucker: DruckerKonfiguration
  readonly eventLog: EventLogKonfiguration
}

/**
 * Vorgabe für den Entwicklungsbetrieb.
 *
 * Mock-TSE und Vorschaudrucker — die App startet damit ohne jede Peripherie.
 */
export const VORGABE: Konfiguration = {
  kasse: {
    deviceId: 'KASSE-01',
    seriennummer: 'BONBON-DEV-001',
  },
  haendler: {
    name: 'Café Sonnenblume',
    strasse: 'Bäckerstraße 12',
    postleitzahl: '66111',
    ort: 'Saarbrücken',
    steuernummer: '040/123/45678',
  },
  tse: { art: 'mock' },
  drucker: { art: 'vorschau', zeichenProZeile: 48, kassenlade: true },
  eventLog: { art: 'speicher' },
}

/** Läuft die App im Tauri-Fenster oder nur im Browser? */
export function laeuftInTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Lädt die Konfiguration.
 *
 * Im Tauri-Fenster aus `bonbon.config.json` neben der Anwendung, im Browser
 * aus `/bonbon.config.json`. Fehlt sie oder ist sie fehlerhaft, gilt die
 * Vorgabe — und das wird gemeldet, nicht verschwiegen.
 */
export async function ladeKonfiguration(
  melde: (nachricht: string) => void,
): Promise<Konfiguration> {
  try {
    const antwort = await fetch('/bonbon.config.json', { cache: 'no-store' })
    if (!antwort.ok) {
      melde('Keine bonbon.config.json gefunden — es gelten die Vorgaben (Mock-TSE, Vorschaudrucker).')
      return VORGABE
    }
    const gelesen = (await antwort.json()) as Partial<Konfiguration>
    const zusammengefuehrt: Konfiguration = {
      kasse: { ...VORGABE.kasse, ...gelesen.kasse },
      haendler: { ...VORGABE.haendler, ...gelesen.haendler },
      tse: { ...VORGABE.tse, ...gelesen.tse },
      drucker: { ...VORGABE.drucker, ...gelesen.drucker },
      eventLog: { ...VORGABE.eventLog, ...gelesen.eventLog },
    }
    melde(
      'Konfiguration geladen: TSE ' +
        zusammengefuehrt.tse.art +
        ', Drucker ' +
        zusammengefuehrt.drucker.art +
        ', Event Log ' +
        zusammengefuehrt.eventLog.art,
    )
    return zusammengefuehrt
  } catch (fehler) {
    melde(
      'Konfiguration nicht lesbar, es gelten die Vorgaben: ' +
        (fehler instanceof Error ? fehler.message : String(fehler)),
    )
    return VORGABE
  }
}

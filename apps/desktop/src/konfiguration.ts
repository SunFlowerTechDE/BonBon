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

import type { DateiPort } from './adapter.js'

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

/**
 * Diagnose-Modus — ein **Entwicklungswerkzeug**.
 *
 * Standardmäßig aus, und das ist keine Bequemlichkeitsentscheidung: bei einem
 * Kunden zu messen, wie schnell eine Aushilfe kassiert, ist Verhaltens- und
 * Leistungskontrolle. Das braucht eine Rechtsgrundlage nach DSGVO und, wo ein
 * Betriebsrat besteht, dessen Mitbestimmung nach § 87 Abs. 1 Nr. 6 BetrVG.
 * Siehe CLAUDE.md, Regel 21.
 */
export interface DiagnoseKonfiguration {
  readonly art: 'aus' | 'an'
  /** Wohin die CSV geschrieben wird. Relativ heißt: neben die Anwendung. */
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
  readonly diagnose: DiagnoseKonfiguration
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
  // Aus. Immer. Wer misst, schaltet es bewusst ein (Regel 21).
  diagnose: { art: 'aus', pfad: 'bonbon-diagnose.csv' },
}

/** Läuft die App im Tauri-Fenster oder nur im Browser? */
export function laeuftInTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Der Dateiname neben der Anwendung. */
export const KONFIGURATIONSDATEI = 'bonbon.config.json'

/** Der Zustand der MockTse, ebenfalls neben der Anwendung. */
export const TSE_ZUSTANDSDATEI = 'bonbon-tse-zustand.json'

/**
 * Lädt die Konfiguration — aus der Datei **neben der Anwendung**.
 *
 * Vorher lag sie in `public/` und wurde beim Bauen ins Anwendungsbündel
 * gepackt. Damit war sie nicht zu ändern, ohne neu zu bauen — für eine Kasse
 * unbrauchbar: jeder Laden hat eine andere Drucker-IP, und niemand baut
 * deswegen die Software neu.
 *
 * Fehlt die Datei, gilt die Vorgabe (Mock-TSE, Vorschaudrucker, Event Log im
 * Speicher). Die Kasse startet damit ohne jede Peripherie **und sagt, wo sie
 * die Datei erwartet hätte** — sonst sucht der Betreiber im Dunkeln.
 *
 * Ist die Datei da, aber unlesbar, ist das **ein Fehler und keine fehlende
 * Datei**. Beides gleich zu behandeln hieße, eine kaputte Konfiguration
 * stillschweigend durch die Vorgaben zu ersetzen: die Kasse liefe dann mit
 * Vorschaudrucker weiter, obwohl ein echter eingerichtet war.
 */
export async function ladeKonfiguration(
  dateien: DateiPort,
  melde: (nachricht: string) => void,
): Promise<Konfiguration> {
  const ordner = await dateien.anwendungsverzeichnis()
  const pfad = ordner + PFADTRENNER + KONFIGURATIONSDATEI

  let text: string | undefined
  try {
    text = await dateien.lies(pfad)
  } catch (fehler) {
    // Da, aber nicht lesbar. Das wird gemeldet und nicht als „fehlt" behandelt.
    melde(
      'Die Konfiguration ' + pfad + ' ist nicht lesbar: ' +
        (fehler instanceof Error ? fehler.message : String(fehler)) +
        ' — es gelten die Vorgaben.',
    )
    return VORGABE
  }

  if (text === undefined) {
    melde(
      'Keine ' + KONFIGURATIONSDATEI + ' in ' + ordner +
        ' — es gelten die Vorgaben (Mock-TSE, Vorschaudrucker, Event Log im Speicher).',
    )
    return VORGABE
  }

  let gelesen: Partial<Konfiguration>
  try {
    gelesen = JSON.parse(text) as Partial<Konfiguration>
  } catch (fehler) {
    melde(
      'Die Konfiguration ' + pfad + ' ist kein gueltiges JSON: ' +
        (fehler instanceof Error ? fehler.message : String(fehler)) +
        ' — es gelten die Vorgaben.',
    )
    return VORGABE
  }

  const zusammengefuehrt: Konfiguration = {
    kasse: { ...VORGABE.kasse, ...gelesen.kasse },
    haendler: { ...VORGABE.haendler, ...gelesen.haendler },
    tse: { ...VORGABE.tse, ...gelesen.tse },
    drucker: { ...VORGABE.drucker, ...gelesen.drucker },
    eventLog: { ...VORGABE.eventLog, ...gelesen.eventLog },
    diagnose: { ...VORGABE.diagnose, ...gelesen.diagnose },
  }
  melde(
    'Konfiguration aus ' + pfad + ': TSE ' + zusammengefuehrt.tse.art +
      ', Drucker ' + zusammengefuehrt.drucker.art +
      ', Event Log ' + zusammengefuehrt.eventLog.art,
  )
  if (zusammengefuehrt.diagnose.art === 'an') {
    // Laut, nicht beilaeufig: ein eingeschalteter Diagnose-Modus muss sichtbar
    // sein, sonst misst er unbemerkt mit.
    melde(
      'DIAGNOSE-MODUS IST AN — Zeiten werden nach ' +
        (zusammengefuehrt.diagnose.pfad ?? 'bonbon-diagnose.csv') +
        ' geschrieben. Entwicklungswerkzeug; bei einem Kunden nur mit ' +
        'ausdruecklicher Einwilligung des Betriebs (Regel 21).',
    )
  }
  return zusammengefuehrt
}

/**
 * Pfadtrenner.
 *
 * Windows nimmt beides an, deshalb genuegt der Schraegstrich. Ihn hier
 * festzuschreiben ist ehrlicher als `path.join` zu importieren — im Webview
 * gibt es kein `node:path`.
 */
const PFADTRENNER = '/'

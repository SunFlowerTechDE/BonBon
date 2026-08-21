/**
 * Messhilfen und Hochrechnung.
 */

import { createHash } from 'node:crypto'

import { type Hasher, eventHashInput } from '@bonbon/core'

/** Ein realistisches Ereignis: eine Position auf einem Bon. */
export function beispielEreignis(nummer: number): {
  id: string
  type: string
  payload: string
  occurredAt: string
} {
  const typen = [
    'BonEroeffnet',
    'PositionHinzugefuegt',
    'PositionHinzugefuegt',
    'VerzehrartGesetzt',
    'ZahlungBegonnen',
    'ZahlungAbgeschlossen',
    'BonAbgeschlossen',
    'BelegGedruckt',
  ] as const
  const type = typen[nummer % typen.length] as string
  return {
    id: '01J' + String(nummer).padStart(23, '0'),
    type,
    payload: JSON.stringify({ artikel: 'Cappuccino', betragCent: 380, steuersatzPromille: 190 }),
    occurredAt: new Date().toISOString().replace('Z', '+00:00'),
  }
}

export interface Perzentile {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly anzahl: number
}

/** Wie viele Messwerte liegen ueber einer Schwelle? */
export function ueberSchwelle(werte: readonly number[], schwelleMs: number): number {
  return werte.filter((w) => w > schwelleMs).length
}

export function perzentile(werte: readonly number[]): Perzentile {
  if (werte.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, anzahl: 0 }
  const sortiert = [...werte].sort((a, b) => a - b)
  const bei = (anteil: number): number =>
    sortiert[Math.min(sortiert.length - 1, Math.floor(sortiert.length * anteil))] ?? 0
  return {
    p50: bei(0.5),
    p95: bei(0.95),
    p99: bei(0.99),
    max: sortiert[sortiert.length - 1] ?? 0,
    anzahl: sortiert.length,
  }
}

export function formatiereDauer(millisekunden: number): string {
  if (millisekunden < 1000) return millisekunden.toFixed(0) + ' ms'
  const sekunden = millisekunden / 1000
  if (sekunden < 90) return sekunden.toFixed(1) + ' s'
  const minuten = sekunden / 60
  if (minuten < 90) return minuten.toFixed(1) + ' Minuten'
  return (minuten / 60).toFixed(1) + ' Stunden'
}

/**
 * Wie lange dauert die Pruefung der gesamten Kette nach zehn Jahren?
 *
 * Grundlage laut Auftrag: ein Cafe mit rund 100 Bons am Tag und etwa
 * 8 Ereignissen je Bon.
 */
export function hochrechnung(
  latenzen: readonly number[],
  hasher: Hasher,
  gemessen?: { readonly ereignisse: number; readonly dbBytes: number },
): void {
  const BONS_PRO_TAG = 100
  const EREIGNISSE_PRO_BON = 8
  const TAGE_PRO_JAHR = 365
  const JAHRE = 10

  const proTag = BONS_PRO_TAG * EREIGNISSE_PRO_BON
  const gesamt = proTag * TAGE_PRO_JAHR * JAHRE

  console.log('')
  console.log('--- Hochrechnung auf zehn Jahre ' + '-'.repeat(46))
  console.log('  Annahme: ' + String(BONS_PRO_TAG) + ' Bons am Tag, ' + String(EREIGNISSE_PRO_BON) + ' Ereignisse je Bon')
  console.log('    pro Tag    ' + proTag.toLocaleString('de-DE') + ' Ereignisse')
  console.log('    pro Jahr   ' + (proTag * TAGE_PRO_JAHR).toLocaleString('de-DE'))
  console.log('    zehn Jahre ' + gesamt.toLocaleString('de-DE'))

  // Reine Rechenzeit der Kettenpruefung messen: Hash bilden und vergleichen.
  const beispiel = beispielEreignis(1)
  const eingabe = eventHashInput('0'.repeat(64), {
    id: beispiel.id,
    deviceId: 'KASSE-01',
    seq: 1,
    occurredAt: beispiel.occurredAt as never,
    type: beispiel.type,
    payload: beispiel.payload,
  })

  const proben = 200_000
  const t0 = performance.now()
  for (let i = 0; i < proben; i += 1) hasher.hash(eingabe)
  const proHash = (performance.now() - t0) / proben

  console.log('')
  // proHash steht in Millisekunden. 1/proHash waeren Hashes je Millisekunde —
  // fuer "pro Sekunde" mal 1000.
  console.log('  Gemessen: ' + (proHash * 1000).toFixed(2) + ' Mikrosekunden je Hash')
  console.log('    (' + Math.round(1000 / proHash).toLocaleString('de-DE') + ' Hashes pro Sekunde)')

  const reineRechenzeit = gesamt * proHash
  console.log('    reine Rechenzeit fuer ' + gesamt.toLocaleString('de-DE') + ' Hashes: ' + formatiereDauer(reineRechenzeit))

  // Das Lesen aus SQLite dominiert. Aus der Dauerlast ist die Schreiblatenz
  // bekannt; Lesen ist deutlich guenstiger, wird hier aber konservativ mit
  // derselben Groessenordnung angesetzt.
  const schreibP50 = perzentile(latenzen).p50
  if (schreibP50 > 0) {
    const geschaetztLesen = gesamt * schreibP50 * 0.3
    console.log('')
    console.log('  Mit dem Lesen aus SQLite (grob geschaetzt als 30 % der Schreiblatenz):')
    console.log('    ' + formatiereDauer(reineRechenzeit + geschaetztLesen))
  }

  // Aus dem Lauf abgeleitet statt geraten: die Dauerlast kennt die Dateigroesse
  // und die Anzahl der Ereignisse.
  const bytesProEreignis =
    gemessen !== undefined && gemessen.ereignisse > 0
      ? gemessen.dbBytes / gemessen.ereignisse
      : 320
  console.log('')
  console.log('  Datenbestand nach zehn Jahren:')
  console.log(
    '    ' +
      Math.round(bytesProEreignis) +
      ' Byte je Ereignis ' +
      (gemessen === undefined ? '(geschaetzt)' : '(aus diesem Lauf gemessen)'),
  )
  console.log('    ' + ((gesamt * bytesProEreignis) / 1024 / 1024 / 1024).toFixed(2) + ' GB')

  console.log('')
  console.log('  Bewertung:')
  if (reineRechenzeit < 60_000) {
    console.log('    Die Pruefung der gesamten Kette bleibt im Minutenbereich. Sie kann')
    console.log('    als Ganzes laufen, etwa auf Verlangen bei einer Kassennachschau.')
  } else {
    console.log('    Die Pruefung dauert zu lange fuer einen Durchlauf am Stueck.')
  }
  console.log('    Trotzdem einplanen: Bei 4 GB RAM darf die Pruefung nicht die ganze')
  console.log('    Kette in den Speicher laden. Sie laeuft deshalb blockweise')
  console.log('    (siehe EventLog.verify) und braucht konstant wenig Speicher.')
  console.log('')
  console.log('    Fuer den Alltag empfiehlt sich zusaetzlich ein Pruefpunkt je')
  console.log('    Tagesabschluss: Hash und Sequenznummer des letzten Ereignisses')
  console.log('    festhalten, dann muss im Regelfall nur der laufende Tag geprueft')
  console.log('    werden — rund ' + String(proTag) + ' Ereignisse statt ' + gesamt.toLocaleString('de-DE') + '.')
}

export { createHash }

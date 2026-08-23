/**
 * Erzeugt die gemeinsamen Testvektoren fuer die Hash-Eingabe.
 *
 *   node werkzeuge/testvektoren-erzeugen.mjs
 *
 * Nur ausfuehren, wenn sich die Bildung der Hash-Eingabe absichtlich aendert.
 * Dann laufen beide Seiten — TypeScript und Rust — gegen die neue Datei, und
 * die Aenderung faellt in beiden auf. Genau das ist der Zweck.
 */
import { writeFileSync } from 'node:fs'
import { eventHashInput } from '../packages/core/dist/index.js'

const FAELLE = [
  {
    name: 'einfach',
    prevHash: '0'.repeat(64),
    ereignis: { id: 'EVT-0001', deviceId: 'KASSE-01', seq: 1, occurredAt: '2026-08-21T10:00:00+02:00', type: 'PositionHinzugefuegt', payload: '{}' },
  },
  {
    name: 'mit Nutzdaten',
    prevHash: 'a'.repeat(64),
    ereignis: { id: '01J00000000000000000000042', deviceId: 'KASSE-01', seq: 4711, occurredAt: '2026-12-31T23:59:60Z', type: 'SaleFinished', payload: JSON.stringify({ artikel: 'Cappuccino', betragCent: 380 }) },
  },
  {
    name: 'Umlaute und Trennzeichen',
    prevHash: '0'.repeat(64),
    ereignis: { id: 'EVT|0002', deviceId: 'KASSE:01', seq: 2, occurredAt: '2026-08-21T10:00:00+02:00', type: 'Kaesekuchen-Aenderung', payload: '{"text":"Bäckerstraße 12"}' },
  },
  {
    name: 'leere Felder',
    prevHash: '0'.repeat(64),
    ereignis: { id: '', deviceId: '', seq: 0, occurredAt: '', type: '', payload: '' },
  },
  // Die beiden zeigen, warum laengenpraefigiert wird: ohne Praefix waeren sie
  // identisch.
  {
    name: 'Verschiebefalle a',
    prevHash: '0'.repeat(64),
    ereignis: { id: 'X', deviceId: 'Y', seq: 1, occurredAt: 'Z', type: 'a', payload: 'bc' },
  },
  {
    name: 'Verschiebefalle b',
    prevHash: '0'.repeat(64),
    ereignis: { id: 'X', deviceId: 'Y', seq: 1, occurredAt: 'Z', type: 'ab', payload: 'c' },
  },
]

const vektoren = FAELLE.map((f) => ({ ...f, eingabe: eventHashInput(f.prevHash, f.ereignis) }))

writeFileSync(
  new URL('../testvektoren/hash-eingabe.json', import.meta.url),
  JSON.stringify(
    {
      zweck:
        'Gemeinsame Testvektoren fuer die Hash-Eingabe der Event-Log-Kette. ' +
        'TypeScript (@bonbon/core, eventHashInput) und Rust ' +
        '(apps/desktop/src-tauri, hash_eingabe) lesen dieselbe Datei und pruefen ' +
        'dagegen. Ein neues Feld am Ereignis laesst beide Seiten fehlschlagen, ' +
        'statt sie still auseinanderlaufen zu lassen.',
      erzeugtVon: 'werkzeuge/testvektoren-erzeugen.mjs',
      vektoren,
    },
    null,
    2,
  ) + '\n',
)
console.log(vektoren.length + ' Vektoren geschrieben nach testvektoren/hash-eingabe.json')

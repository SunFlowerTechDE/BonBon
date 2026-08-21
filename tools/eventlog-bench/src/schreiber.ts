/**
 * Schreibt ununterbrochen Ereignisse, bis er hart beendet wird.
 *
 * Eigener Prozess, damit ihn der Absturztest mit SIGKILL treffen kann — ohne
 * Aufraeumen, ohne Flush, genau wie ein Stromausfall.
 */

import { EventLog } from './store.js'
import { beispielEreignis } from './messung.js'

const pfad = process.argv[2]
if (pfad === undefined) {
  console.error('Aufruf: schreiber.ts <pfad-zur-db>')
  process.exit(2)
}

const log = new EventLog({ path: pfad })
let i = 0
for (;;) {
  const e = beispielEreignis(i)
  const geschrieben = log.append('KASSE-01', e.type, e.payload, e.occurredAt, e.id)
  i += 1
  if (i % 20 === 0) process.stdout.write('seq=' + String(geschrieben.seq) + '\n')
}

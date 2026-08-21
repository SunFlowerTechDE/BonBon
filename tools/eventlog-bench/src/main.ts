/**
 * M0-Spike: Event Log unter Last.
 *
 *   pnpm eventlog                     alle Messungen
 *   pnpm eventlog -- --dauerlast      nur die Dauerlast
 *   pnpm eventlog -- --stoss          nur den Stossbetrieb
 *   pnpm eventlog -- --absturz        nur die Absturzsicherheit
 *   pnpm eventlog -- --manipulation   nur den Manipulationsnachweis
 *   pnpm eventlog -- --minuten 1      kuerzere Dauerlast (Vorgabe 10)
 *
 * Gemessen wird der echte Schreibpfad: SQLite im WAL-Modus, synchronous
 * NORMAL, Hash-Kette und lueckenlose Sequenznummer je Geraet.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { cpus, totalmem, type as osType, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EventLog, nodeHasher } from './store.js'
import {
  beispielEreignis,
  formatiereDauer,
  hochrechnung,
  perzentile,
  ueberSchwelle,
} from './messung.js'

const HIER = dirname(fileURLToPath(import.meta.url))
const ARBEITSORDNER = resolve(HIER, '..', '.bench')

function argWert(argv: readonly string[], name: string, vorgabe: string): string {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : vorgabe
}

function frisch(name: string): string {
  if (!existsSync(ARBEITSORDNER)) mkdirSync(ARBEITSORDNER, { recursive: true })
  const pfad = join(ARBEITSORDNER, name)
  for (const endung of ['', '-wal', '-shm']) rmSync(pfad + endung, { force: true })
  return pfad
}

function groesse(pfad: string): number {
  try {
    return statSync(pfad).size
  } catch {
    return 0
  }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(0) + ' kB'
}

const schlafen = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- Umgebung --------------------------------------------------------------

function zeigeUmgebung(): void {
  console.log('='.repeat(78))
  console.log('BonBon — Event Log unter Last (M0-Spike)')
  console.log('='.repeat(78))

  let cpuName = cpus()[0]?.model ?? 'unbekannt'
  let laufwerk = 'unbekannt'
  try {
    // Auf Windows verraet MSFT_PhysicalDisk, ob SSD (MediaType 4) oder
    // Festplatte (3). Die Zielhardware hat moeglicherweise eine Festplatte,
    // und darauf sieht die Messung anders aus.
    const ausgabe = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-PhysicalDisk | Select-Object -First 1 -Property FriendlyName,MediaType | ForEach-Object { \"$($_.FriendlyName)|$($_.MediaType)\" })",
      ],
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
    if (ausgabe !== '') laufwerk = ausgabe.replace('|', ' — ')
  } catch {
    laufwerk = 'nicht ermittelbar'
  }
  if (cpuName.length > 60) cpuName = cpuName.slice(0, 60) + '…'

  console.log('  Gemessen auf:')
  console.log('    Betriebssystem  ' + osType() + ' ' + release())
  console.log('    Prozessor       ' + cpuName + '  (' + String(cpus().length) + ' Kerne)')
  console.log('    Arbeitsspeicher ' + (totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB')
  console.log('    Laufwerk        ' + laufwerk)
  console.log('    Node            ' + process.version)
  console.log('')
  console.log('  Zielhardware laut CLAUDE.md: Windows 10 64-bit, 4 GB RAM,')
  console.log('  moeglicherweise mit Festplatte statt SSD. Weicht die Messmaschine')
  console.log('  davon ab, sind die Zahlen hier optimistisch.')
}

// --- Lastprofile -----------------------------------------------------------

interface Messwerte {
  readonly latenzen: number[]
  readonly dbGroesse: { minute: number; db: number; wal: number }[]
}

async function dauerlast(minuten: number): Promise<Messwerte> {
  const pfad = frisch('dauerlast.db')
  const log = new EventLog({ path: pfad })
  const geraet = 'KASSE-01'

  console.log('')
  console.log('--- Dauerlast: 500 Ereignisse pro Minute ueber ' + String(minuten) + ' Minuten ' + '-'.repeat(20))

  const latenzen: number[] = []
  const dbGroesse: Messwerte['dbGroesse'] = []
  const abstandMs = 60_000 / 500 // 120 ms

  for (let minute = 1; minute <= minuten; minute += 1) {
    const beginn = performance.now()
    for (let i = 0; i < 500; i += 1) {
      const faellig = beginn + i * abstandMs
      const wartezeit = faellig - performance.now()
      if (wartezeit > 1) await schlafen(wartezeit)

      const e = beispielEreignis(latenzen.length)
      const t0 = performance.now()
      log.append(geraet, e.type, e.payload, e.occurredAt, e.id)
      latenzen.push(performance.now() - t0)
    }
    const db = groesse(pfad)
    const wal = groesse(pfad + '-wal')
    dbGroesse.push({ minute, db, wal })
    process.stdout.write(
      '  Minute ' + String(minute).padStart(2) + ': ' +
        String(latenzen.length).padStart(5) + ' Ereignisse, DB ' + mb(db).padStart(9) +
        ', WAL ' + kb(wal).padStart(8) + '\n',
    )
  }

  const p = perzentile(latenzen)
  console.log('')
  console.log('  Schreiblatenz:')
  console.log('    p50  ' + p.p50.toFixed(3) + ' ms')
  console.log('    p95  ' + p.p95.toFixed(3) + ' ms')
  console.log('    p99  ' + p.p99.toFixed(3) + ' ms')
  console.log('    max  ' + p.max.toFixed(3) + ' ms')
  console.log(
    '    ueber 50 ms: ' +
      String(ueberSchwelle(latenzen, 50)) +
      ' von ' +
      String(latenzen.length) +
      ',  ueber 10 ms: ' +
      String(ueberSchwelle(latenzen, 10)),
  )
  console.log('  ' + String(log.count()) + ' Ereignisse, Kette wird geprueft …')
  const geprueft = log.verify(geraet)
  console.log('    ' + (geprueft.ok ? 'Kette intakt' : 'KETTE DEFEKT: ' + String(geprueft.problems.length) + ' Stellen'))
  log.close()
  return { latenzen, dbGroesse }
}

async function stossbetrieb(runden: number): Promise<Messwerte> {
  const pfad = frisch('stoss.db')
  const log = new EventLog({ path: pfad })
  const geraet = 'KASSE-01'

  console.log('')
  console.log('--- Stossbetrieb: 20 Ereignisse in 8 Sekunden, ' + String(runden) + ' Runden ' + '-'.repeat(22))
  console.log('  (Das Profil an einer Theke: minutenlang nichts, dann alles auf einmal.)')

  const latenzen: number[] = []
  const dbGroesse: Messwerte['dbGroesse'] = []
  const abstandMs = 8000 / 20 // 400 ms

  for (let runde = 1; runde <= runden; runde += 1) {
    // Ruhephase. Kurz gehalten, damit der Lauf nicht ewig dauert — die
    // Latenzspitze entsteht am Anfang des Stosses, nicht durch die Laenge der
    // Pause. Im Betrieb sind es Minuten.
    await schlafen(3000)

    const rundenLatenzen: number[] = []
    const beginn = performance.now()
    for (let i = 0; i < 20; i += 1) {
      const faellig = beginn + i * abstandMs
      const wartezeit = faellig - performance.now()
      if (wartezeit > 1) await schlafen(wartezeit)

      const e = beispielEreignis(latenzen.length)
      const t0 = performance.now()
      log.append(geraet, e.type, e.payload, e.occurredAt, e.id)
      const dauer = performance.now() - t0
      latenzen.push(dauer)
      rundenLatenzen.push(dauer)
    }
    const db = groesse(pfad)
    const wal = groesse(pfad + '-wal')
    dbGroesse.push({ minute: runde, db, wal })
    const erste = rundenLatenzen[0] ?? 0
    console.log(
      '  Runde ' + String(runde) + ': erstes Ereignis nach der Pause ' + erste.toFixed(3) +
        ' ms, Rest max ' + Math.max(...rundenLatenzen.slice(1)).toFixed(3) +
        ' ms, WAL ' + kb(wal),
    )
  }

  const p = perzentile(latenzen)
  console.log('')
  console.log('  Schreiblatenz:')
  console.log('    p50  ' + p.p50.toFixed(3) + ' ms')
  console.log('    p95  ' + p.p95.toFixed(3) + ' ms')
  console.log('    p99  ' + p.p99.toFixed(3) + ' ms')
  console.log('    max  ' + p.max.toFixed(3) + ' ms')
  console.log(
    '    ueber 50 ms: ' +
      String(ueberSchwelle(latenzen, 50)) +
      ' von ' +
      String(latenzen.length) +
      ',  ueber 10 ms: ' +
      String(ueberSchwelle(latenzen, 10)),
  )
  const geprueft = log.verify(geraet)
  console.log('  ' + (geprueft.ok ? 'Kette intakt' : 'KETTE DEFEKT'))
  log.close()
  return { latenzen, dbGroesse }
}

// --- Absturzsicherheit -----------------------------------------------------

async function absturz(): Promise<boolean> {
  console.log('')
  console.log('--- Absturzsicherheit ' + '-'.repeat(56))
  console.log('  Ein Kindprozess schreibt ununterbrochen und wird mitten im Schreiben')
  console.log('  hart beendet (SIGKILL). Danach wird die Datei geprueft.')

  const pfad = frisch('absturz.db')
  const schreiber = resolve(HIER, 'schreiber.ts')

  // Ueber tsx starten, weil der Schreiber TypeScript ist und ueber .js-Endungen
  // importiert — das kann Nodes eingebautes Type-Stripping nicht aufloesen.
  const tsx = resolve(HIER, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const kind = spawn(process.execPath, [tsx, schreiber, pfad], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })

  let letzteGemeldete = 0
  kind.stdout.on('data', (d: Buffer) => {
    const treffer = /seq=(\d+)/.exec(d.toString())
    if (treffer?.[1] !== undefined) letzteGemeldete = Number(treffer[1])
  })
  let fehlerAusgabe = ''
  kind.stderr.on('data', (d: Buffer) => {
    fehlerAusgabe += d.toString()
  })

  await schlafen(3000)
  console.log('  Zuletzt gemeldet: seq=' + String(letzteGemeldete))
  kind.kill('SIGKILL')
  await new Promise((r) => kind.once('exit', r))
  console.log('  Prozess hart beendet.')

  if (letzteGemeldete === 0) {
    console.log('  Der Schreiber hat nichts gemeldet. Fehlerausgabe:')
    console.log(fehlerAusgabe.slice(0, 800))
    return false
  }

  await schlafen(500)
  const log = new EventLog({ path: pfad })
  const anzahl = log.count()
  const ergebnis = log.verify('KASSE-01')
  const kopf = log.head('KASSE-01')
  log.close()

  console.log('')
  console.log('  Nach dem Absturz:')
  console.log('    Ereignisse in der Datei: ' + String(anzahl))
  console.log('    hoechste Sequenznummer:  ' + String(kopf.seq))
  console.log('    Kette:                   ' + (ergebnis.ok ? 'intakt' : 'DEFEKT'))
  // Die Invarianten, auf die es ankommt:
  //
  // 1. Die Kette ist intakt — jede Zeile hasht auf ihren Nachfolger.
  // 2. count === hoechste seq: die Datei enthaelt einen lueckenlosen Praefix
  //    1..N. Das schliesst aus, dass mitten in der Kette etwas fehlt; verloren
  //    gehen kann nur ein Stueck am Ende.
  // 3. Kein Ereignis, dessen Schreibvorgang zurueckgekehrt ist, fehlt.
  const lueckenlos = anzahl === kopf.seq
  const gemeldeteVorhanden = kopf.seq >= letzteGemeldete
  const inOrdnung = ergebnis.ok && lueckenlos && gemeldeteVorhanden

  console.log('    lueckenloser Praefix 1..N: ' + (lueckenlos ? 'ja' : 'NEIN'))
  console.log(
    '    alle gemeldeten Ereignisse da: ' +
      (gemeldeteVorhanden ? 'ja' : 'NEIN') +
      '   (gemeldet bis ' + String(letzteGemeldete) + ', in der Datei bis ' + String(kopf.seq) + ')',
  )

  console.log('')
  if (inOrdnung) {
    console.log('  In Ordnung: Kette intakt, Sequenz lueckenlos, kein bestaetigtes')
    console.log('  Ereignis verloren. Ein halb geschriebenes Ereignis gibt es nicht —')
    console.log('  SQLite schreibt die Zeile entweder ganz oder gar nicht.')
    console.log('')
    console.log('  Einordnung, damit die Aussage nicht groesser klingt als sie ist:')
    console.log('    SIGKILL beendet den Prozess, nicht den Rechner. Die bereits')
    console.log('    uebergebenen Daten liegen noch im Cache des Betriebssystems und')
    console.log('    werden von ihm geschrieben. Geprueft ist damit der Absturz der')
    console.log('    Anwendung.')
    console.log('    Bei einem STROMAUSFALL kann synchronous = NORMAL im WAL-Modus die')
    console.log('    letzten Transaktionen verlieren — die Datei bleibt aber konsistent')
    console.log('    und die Kette intakt. Das ist der bewusst eingegangene Handel:')
    console.log('    FULL waere sicherer und deutlich langsamer. Ein fehlendes letztes')
    console.log('    Ereignis faellt auf, eine kaputte Datei nicht.')
  } else {
    console.log('  NICHT in Ordnung. Details:')
    for (const p of ergebnis.problems.slice(0, 5)) console.log('    ' + p.kind + ' bei seq ' + String(p.seq))
  }
  return inOrdnung
}

// --- Manipulationsnachweis -------------------------------------------------

function manipulation(): boolean {
  console.log('')
  console.log('--- Manipulationsnachweis ' + '-'.repeat(52))
  console.log('  Das ist die Funktion, die bei einer Kassennachschau zaehlt.')

  const pfad = frisch('manipulation.db')
  const log = new EventLog({ path: pfad })
  const geraet = 'KASSE-01'

  for (let i = 0; i < 200; i += 1) {
    const e = beispielEreignis(i)
    log.append(geraet, e.type, e.payload, e.occurredAt, e.id)
  }
  const vorher = log.verify(geraet)
  console.log('')
  console.log('  200 Ereignisse geschrieben. Kette: ' + (vorher.ok ? 'intakt' : 'DEFEKT'))

  // --- Fall 1: ein Betrag wird nachtraeglich veraendert ---
  console.log('')
  console.log('  Fall 1: Betrag von Ereignis 87 nachtraeglich von 380 auf 100 Cent geaendert')
  log.tamperForTest(geraet, 87, JSON.stringify({ artikel: 'Cappuccino', betragCent: 100 }))
  const nachher = log.verify(geraet)
  console.log('    gefunden: ' + (nachher.ok ? 'NEIN — das waere ein Totalausfall' : 'ja'))
  for (const p of nachher.problems) {
    console.log('    -> ' + p.kind + ' bei Sequenznummer ' + String(p.seq))
    console.log('       ' + p.detail)
  }

  // --- Fall 2: ein Ereignis wird geloescht ---
  const pfad2 = frisch('manipulation2.db')
  const log2 = new EventLog({ path: pfad2 })
  for (let i = 0; i < 50; i += 1) {
    const e = beispielEreignis(i)
    log2.append(geraet, e.type, e.payload, e.occurredAt, e.id)
  }
  console.log('')
  console.log('  Fall 2: Ereignis 25 vollstaendig geloescht')
  log2.deleteForTest(geraet, 25)
  const nachher2 = log2.verify(geraet)
  console.log('    gefunden: ' + (nachher2.ok ? 'NEIN' : 'ja'))
  for (const p of nachher2.problems.slice(0, 3)) {
    console.log('    -> ' + p.kind + ' bei Sequenznummer ' + String(p.seq))
    console.log('       ' + p.detail)
  }

  const beideGefunden = !nachher.ok && !nachher2.ok
  const stelleGenannt = nachher.problems.some((p) => p.seq === 87)
  console.log('')
  console.log(
    '  Ergebnis: ' +
      (beideGefunden && stelleGenannt
        ? 'Beide Manipulationen gefunden, die Stelle wird benannt.'
        : 'NICHT vollstaendig erkannt.'),
  )

  log.close()
  log2.close()
  return beideGefunden && stelleGenannt
}

// --- Ablauf ----------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const alles =
    !argv.includes('--dauerlast') &&
    !argv.includes('--stoss') &&
    !argv.includes('--absturz') &&
    !argv.includes('--manipulation')
  const minuten = Number.parseInt(argWert(argv, '--minuten', '10'), 10)
  const runden = Number.parseInt(argWert(argv, '--runden', '5'), 10)

  zeigeUmgebung()

  let dauerMesswerte: Messwerte | undefined
  if (alles || argv.includes('--dauerlast')) dauerMesswerte = await dauerlast(minuten)
  if (alles || argv.includes('--stoss')) await stossbetrieb(runden)

  let absturzOk = true
  if (alles || argv.includes('--absturz')) absturzOk = await absturz()

  let manipulationOk = true
  if (alles || argv.includes('--manipulation')) manipulationOk = manipulation()

  if (alles || argv.includes('--dauerlast')) {
    const letzte = dauerMesswerte?.dbGroesse[dauerMesswerte.dbGroesse.length - 1]
    hochrechnung(
      dauerMesswerte?.latenzen ?? [],
      nodeHasher,
      letzte === undefined
        ? undefined
        : { ereignisse: dauerMesswerte?.latenzen.length ?? 0, dbBytes: letzte.db },
    )
  }

  console.log('')
  console.log('='.repeat(78))
  console.log(absturzOk && manipulationOk ? 'Alle Nachweise erbracht' : 'NACHWEIS GESCHEITERT')
  console.log('='.repeat(78))
  return absturzOk && manipulationOk ? 0 : 1
}

export { formatiereDauer }

process.exitCode = await main()

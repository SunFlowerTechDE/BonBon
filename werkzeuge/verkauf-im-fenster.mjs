/**
 * Faehrt einen echten Verkauf in der gebauten Anwendung.
 *
 * Warum das ueberhaupt sein muss: alle bisherigen Nachweise umgehen jeweils
 * ein Stueck des Wegs. Der kopflose Verkaufstest laesst den Webview weg, die
 * Rust-Pfadtests lassen das JavaScript weg. Was dazwischen liegt — die
 * `invoke()`-Bruecke des echten WebView2 — hat bis hierhin niemand angefasst.
 *
 * Deshalb wird hier die gebaute Exe gestartet, und zwar mit
 * `--remote-debugging-port`. WebView2 macht dann dasselbe Protokoll auf, das
 * auch Edge benutzt. Ueber das Protokoll werden die Knoepfe **im laufenden
 * Fenster** geklickt: keine Nachbildung der Oberflaeche, keine
 * nachgestellten Ereignisse in einer Testumgebung, sondern dieselben Klicks,
 * die auch eine Hand ausloest.
 *
 * Der Verkauf ist derselbe wie im kopflosen Test: Cappuccino x2 plus
 * Kaesekuchen, 11,50 Euro, bar mit 20 Euro. Damit sind die beiden Nachweise
 * vergleichbar — weicht das Ergebnis ab, liegt es am Weg, nicht am Vorgang.
 *
 * Aufruf:
 *   node werkzeuge/verkauf-im-fenster.mjs [pfad-zur-exe]
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Der Dateiname kommt aus `[package] name` in Cargo.toml, nicht aus
// `productName` in tauri.conf.json — die Exe heisst `bonbon-kasse.exe`.
const STANDARD_EXE = resolve(
  process.cwd(),
  'apps/desktop/src-tauri/target/release/bonbon-kasse.exe',
)
const PORT = 9222
const ZEITLIMIT_MS = 60_000

/** Wartet, ohne den Prozess zu blockieren. */
const warte = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Sucht die Seite des Fensters.
 *
 * WebView2 braucht einen Moment, bis das Protokoll offen ist. Deshalb wird
 * gewartet — aber mit Grenze, damit ein nicht startendes Fenster nicht in
 * einer Endlosschleife endet.
 */
async function findeSeite() {
  const bis = Date.now() + ZEITLIMIT_MS
  let letzterFehler = 'keiner'
  while (Date.now() < bis) {
    try {
      const antwort = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const seiten = await antwort.json()
      const seite = seiten.find((s) => s.type === 'page' && s.webSocketDebuggerUrl)
      if (seite) return seite
      letzterFehler = `keine Seite in ${JSON.stringify(seiten.map((s) => s.type))}`
    } catch (fehler) {
      letzterFehler = String(fehler)
    }
    await warte(300)
  }
  throw new Error(`Fenster nicht erreichbar nach ${ZEITLIMIT_MS} ms: ${letzterFehler}`)
}

/** Eine sehr kleine Klientin fuer das Debug-Protokoll. */
class Fernsteuerung {
  #ws
  #naechsteId = 1
  #offen = new Map()

  static async verbinde(url) {
    const f = new Fernsteuerung()
    f.#ws = new WebSocket(url)
    f.#ws.addEventListener('message', (e) => {
      const nachricht = JSON.parse(e.data)
      const warteschlange = f.#offen.get(nachricht.id)
      if (!warteschlange) return
      f.#offen.delete(nachricht.id)
      if (nachricht.error) warteschlange.ab(new Error(JSON.stringify(nachricht.error)))
      else warteschlange.auf(nachricht.result)
    })
    await new Promise((auf, ab) => {
      f.#ws.addEventListener('open', auf, { once: true })
      f.#ws.addEventListener('error', () => {
        ab(new Error('Verbindung zum Fenster fehlgeschlagen'))
      }, { once: true })
    })
    return f
  }

  #sende(method, params) {
    const id = this.#naechsteId++
    return new Promise((auf, ab) => {
      this.#offen.set(id, { auf, ab })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Wertet JavaScript im Fenster aus.
   *
   * Eine geworfene Ausnahme im Fenster wird hier zur Ausnahme — sonst liefe
   * ein fehlgeschlagener Klick als Erfolg durch.
   */
  async werteAus(ausdruck) {
    const ergebnis = await this.#sende('Runtime.evaluate', {
      expression: ausdruck,
      awaitPromise: true,
      returnByValue: true,
    })
    if (ergebnis.exceptionDetails) {
      const e = ergebnis.exceptionDetails
      throw new Error('Im Fenster gescheitert: ' + (e.exception?.description ?? e.text))
    }
    return ergebnis.result.value
  }

  schliesse() {
    this.#ws.close()
  }
}

/**
 * Der Verkauf, als ein Stueck Code im Fenster.
 *
 * Bewusst am Ende gebuendelt statt Klick fuer Klick ueber das Protokoll: jede
 * Runde kostet einen Nachrichtenwechsel, und React braucht zwischen den Klicks
 * ohnehin eine Zeichenrunde. So bleibt das Warten dort, wo es hingehoert.
 */
const VERKAUF = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms))
  const protokoll = []

  const suche = (auswahl, text) =>
    [...document.querySelectorAll(auswahl)].find((e) => e.textContent.includes(text))

  const klicke = async (auswahl, text, was) => {
    const knopf = suche(auswahl, text)
    if (!knopf) throw new Error(was + ' nicht gefunden: ' + auswahl + ' mit "' + text + '"')
    if (knopf.disabled) throw new Error(was + ' ist gesperrt: ' + text)
    knopf.click()
    await warte(120)
    protokoll.push(was + ': ' + text)
  }

  /**
   * Tippt einen Artikel und wartet, bis der Bon ihn zeigt.
   *
   * **Keine feste Frist.** Die Kasse arbeitet Vorgaenge nacheinander ab, und
   * jeder schreibt ins Event Log; wie lange das dauert, haengt am Datentraeger.
   * Ein fester Wert hat hier schon dreimal ein falsches Bild erzeugt — zuletzt
   * stand der Bon bei 3,80 Euro, waehrend der Treiber schon zahlen wollte, und
   * das sah aus wie ein Fehler in der Anwendung.
   */
  const tippe = async (bezeichnung) => {
    const vorher = document.querySelector('.summe')?.textContent ?? ''
    const kachel = suche('.artikel-kachel', bezeichnung)
    if (!kachel) throw new Error('Artikel nicht gefunden: ' + bezeichnung)
    kachel.click()
    for (let i = 0; i < 200; i++) {
      if ((document.querySelector('.summe')?.textContent ?? '') !== vorher) break
      await warte(25)
    }
    if ((document.querySelector('.summe')?.textContent ?? '') === vorher) {
      throw new Error('Der Bon hat sich nach 5 Sekunden nicht geaendert: ' + bezeichnung)
    }
    protokoll.push('Artikel: ' + bezeichnung)
  }

  // Zwei Cappuccino aus den Heissgetraenken.
  await klicke('.gruppe', 'Heiß', 'Warengruppe')
  await tippe('Cappuccino')
  await tippe('Cappuccino')

  // Ein Kaesekuchen aus der zweiten Gruppe.
  await klicke('.gruppe', 'Kuchen', 'Warengruppe')
  await tippe('Käsekuchen')

  const summe = document.querySelector('.summe')?.textContent ?? '(keine Summe)'
  protokoll.push('Summe im Fenster: ' + summe)

  await klicke('.zahlen', '', 'Zahlen')
  await warte(200)

  // 20 Euro geben, dann bar abschliessen.
  const zwanzig = suche('.schnellbetraege button', '20,00')
  if (!zwanzig) throw new Error('Schnellbetrag 20,00 nicht angeboten')
  zwanzig.click()
  await warte(150)
  protokoll.push('Gegeben: 20,00')

  const rueckgeld = document.querySelector('.rueckgeld')?.textContent ?? '(kein Rueckgeld)'
  protokoll.push('Rueckgeld im Fenster: ' + rueckgeld)

  await klicke('.dialog-knoepfe .bar', '', 'Bar abschließen')

  // Auf den Abschluss warten — Signatur, Druck und Event Log brauchen Zeit.
  for (let i = 0; i < 100; i++) {
    if (document.querySelector('.abschluss')) break
    await warte(100)
  }
  const abschluss = document.querySelector('.abschluss')
  if (!abschluss) throw new Error('Kein Abschluss nach 10 Sekunden')

  const fehler = document.querySelector('.fehler')

  // Darstellung: kam die mitgelieferte Schrift an, und stehen die Farben?
  // Ein Stylesheet, das nicht ins Buendel gelangt, faellt sonst nicht auf —
  // die Kasse rechnet ja trotzdem richtig.
  const stil = (auswahl, eigenschaft) => {
    const el = document.querySelector(auswahl)
    return el ? getComputedStyle(el)[eigenschaft] : '(nicht da)'
  }
  const darstellung = {
    poppinsGeladen: document.fonts.check('600 16px Poppins'),
    schnitte: [...document.fonts].filter((f) => f.family === 'Poppins')
      .map((f) => f.weight + '/' + f.status).sort(),
    schriftDerKachel: stil('.artikel-kachel', 'fontFamily'),
    kopf: stil('.kopf', 'backgroundColor'),
    summe: stil('.summe', 'backgroundColor'),
    tsePunkt: stil('.punkt', 'backgroundColor'),
    tseText: document.querySelector('.tse')?.textContent ?? '(nicht da)',
  }

  return {
    protokoll,
    abschluss: abschluss.textContent,
    fehler: fehler ? fehler.textContent : null,
    darstellung,
    fuss: (document.querySelector('.fuss')?.textContent ?? '').slice(0, 4000),
  }
})()`

/**
 * Beendet die Anwendung samt Kindprozessen.
 *
 * `kill()` allein genuegt unter Windows nicht: WebView2 laeuft in eigenen
 * Prozessen, und der Hauptprozess ueberlebt das Signal regelmaessig. Beim
 * naechsten Lauf haengt dann eine alte Instanz auf dem Debug-Port, und der
 * naechste Bau kann die Exe nicht ersetzen — genau so ist dieser Lauf einmal
 * gescheitert.
 */
function beende(anwendung) {
  anwendung.kill()
  if (process.platform !== 'win32' || anwendung.pid === undefined) return
  try {
    // /T nimmt den Prozessbaum mit, /F erzwingt es.
    spawnSync('taskkill', ['/pid', String(anwendung.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // Schon weg. Kein Grund, den Lauf daran scheitern zu lassen.
  }
}

/**
 * Nur den Bon oeffnen — fuer den Absturzfall.
 *
 * Danach wird die Anwendung hart beendet. Zurueck bleibt: ein `SaleStarted` im
 * Log ohne Abschluss und eine TSE-Transaktion, die offen steht. Genau der
 * Zustand, den der Abgleich beim naechsten Start aufloesen muss.
 */
const BON_OEFFNEN = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms))
  const suche = (auswahl, text) =>
    [...document.querySelectorAll(auswahl)].find((e) => e.textContent.includes(text))

  const kachel = suche('.artikel-kachel', 'Cappuccino')
  if (!kachel) throw new Error('Artikel nicht gefunden')
  kachel.click()
  await warte(600)

  return {
    protokoll: ['Bon geoeffnet, eine Position getippt'],
    abschluss: document.querySelector('.summe')?.textContent ?? '(keine Summe)',
    fehler: document.querySelector('.fehler')?.textContent ?? null,
    darstellung: {},
    fuss: (document.querySelector('.fuss')?.textContent ?? '').slice(0, 4000),
  }
})()`

/**
 * Zwei Latte Macchiato, einer bleibt hier, einer geht.
 *
 * Der Fall, fuer den der Umschalter je Zeile da ist. Er ist zugleich der
 * einzige im Sortiment, bei dem die Verzehrart seit dem 1.1.2026 den
 * Steuersatz noch bewegt — Speisen sind in beiden Faellen ermaessigt.
 */
const GETEILTE_ZEILE = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms))
  const suche = (auswahl, text) =>
    [...document.querySelectorAll(auswahl)].find((e) => e.textContent.includes(text))
  const protokoll = []

  const latte = suche('.artikel-kachel', 'Latte Macchiato')
  if (!latte) throw new Error('Latte Macchiato nicht gefunden')
  latte.click(); await warte(200)
  latte.click(); await warte(300)
  protokoll.push('Zeilen nach zwei Tipps: ' + document.querySelectorAll('.bonzeilen li').length)

  const vorher = document.querySelectorAll('.bonzeilen li').length
  const umschalter = document.querySelector('.bonzeilen li .zeilen-verzehrart')
  if (!umschalter) throw new Error('Kein Umschalter an der Bonzeile')
  umschalter.click()

  // Auf die Aufspaltung warten, statt eine Frist zu raten. Ein fester
  // Zeitwert hat hier schon einmal einen Zustand von vor dem Klick
  // ausgewertet — und das sah aus wie ein Fehler in der Anwendung.
  for (let i = 0; i < 100; i++) {
    if (document.querySelectorAll('.bonzeilen li').length !== vorher) break
    await warte(50)
  }
  if (document.querySelectorAll('.bonzeilen li').length === vorher) {
    throw new Error('Die Zeile hat sich nach 5 Sekunden nicht aufgespalten')
  }

  const zeilen = [...document.querySelectorAll('.bonzeilen li')].map((li) => ({
    text: li.textContent,
    einzeln: li.classList.contains('einzeln'),
  }))
  protokoll.push('Zeilen nach dem Umschalten: ' + zeilen.length)
  for (const z of zeilen) protokoll.push('  ' + (z.einzeln ? '[einzeln] ' : '          ') + z.text)
  protokoll.push('Steuerausweis: ' + (document.querySelector('.steuern')?.textContent ?? '-'))
  protokoll.push('Legende sichtbar: ' + Boolean(document.querySelector('.legende')))
  protokoll.push('Hinweis: ' + (document.querySelector('.steuerhinweis')?.textContent ?? '(fehlt)'))

  await klickeZahlen()
  async function klickeZahlen() {
    document.querySelector('.zahlen')?.click()
    await warte(300)
    const passend = suche('.schnellbetraege button', 'passend')
    if (!passend) throw new Error('Kein passender Betrag angeboten')
    passend.click(); await warte(200)
    document.querySelector('.dialog-knoepfe .bar')?.click()
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('.abschluss')) break
      await warte(100)
    }
  }

  const abschluss = document.querySelector('.abschluss')
  if (!abschluss) throw new Error('Kein Abschluss')
  return {
    protokoll,
    abschluss: abschluss.textContent,
    fehler: document.querySelector('.fehler')?.textContent ?? null,
    darstellung: {},
    fuss: (document.querySelector('.fuss')?.textContent ?? '').slice(0, 4000),
  }
})()`

/**
 * Sorgt dafuer, dass keine Vorgaengerinstanz mehr am Debug-Port haengt.
 *
 * Ohne das haengt sich der naechste Lauf an das **alte** Fenster: die neue
 * Instanz bekommt den Port nicht, `/json/list` antwortet aber trotzdem — vom
 * Vorgaenger. Das Ergebnis sind Laeufe, die einander widersprechen, weil sie
 * verschiedene Fenster bedient haben. Genau so ist hier einmal ein Verkauf
 * ausgewertet worden, der aus dem Lauf davor stammte.
 */
async function stelleSicherDassNichtsLaeuft() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/im', 'bonbon-kasse.exe', '/T', '/F'], { stdio: 'ignore' })
  }
  const bis = Date.now() + 15_000
  while (Date.now() < bis) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`)
    } catch {
      return // Niemand antwortet mehr — der Port ist frei.
    }
    await warte(250)
  }
  throw new Error(`Am Port ${PORT} antwortet weiterhin jemand — alte Instanz nicht beendet.`)
}

/**
 * Misst den Umschalter in beiden Zustaenden — und die Hoehe dazwischen.
 *
 * Der Punkt ist nicht die Optik, sondern dass die Zeile ihre Hoehe behaelt:
 * sonst ruckt das Artikelraster hoch, sobald die erste Latte im Bon landet.
 */
const UMSCHALTER = `(async () => {
  const warte = (ms) => new Promise((r) => setTimeout(r, ms))
  const suche = (auswahl, text) =>
    [...document.querySelectorAll(auswahl)].find((e) => e.textContent.includes(text))
  const protokoll = []

  const messe = (wann) => {
    const zeile = document.querySelector('.verzehrart')
    const knopf = document.querySelector('.verzehrart button')
    protokoll.push(
      wann.padEnd(26) +
        'Hoehe ' + Math.round(zeile.getBoundingClientRect().height) + ' px' +
        ' · Knopf ' + Math.round(knopf.getBoundingClientRect().width) + ' px' +
        ' · ' + (zeile.classList.contains('klein') ? 'klein' : 'prominent') +
        ' · sichtbar ' + (getComputedStyle(knopf).display !== 'none'),
    )
    return Math.round(zeile.getBoundingClientRect().height)
  }

  const leer = messe('leerer Bon')

  // Kuchen liegt in der zweiten Warengruppe.
  suche('.gruppe', 'Kuchen').click(); await warte(250)
  suche('.artikel-kachel', 'Käsekuchen').click()
  await warte(400)
  const nurSpeise = messe('nur Kuchen')
  protokoll.push('Hinweis: ' + (document.querySelector('.folgenlos')?.textContent ?? '(keiner)'))

  suche('.gruppe', 'Heiß').click(); await warte(200)
  suche('.artikel-kachel', 'Latte Macchiato').click()
  await warte(600)
  const mitLatte = messe('mit Latte Macchiato')

  // Latte wieder entfernen — der Schalter darf jetzt NICHT unter dem Finger
  // kleiner werden.
  const weg = [...document.querySelectorAll('.bonzeilen li')]
    .find((li) => li.textContent.includes('Latte'))?.querySelector('.weg')
  if (weg) { weg.click(); await warte(500) }
  const nachEntfernen = messe('Latte wieder entfernt')

  protokoll.push('Hoehe konstant: ' + (leer === nurSpeise && nurSpeise === mitLatte && mitLatte === nachEntfernen))

  document.querySelector('.verwerfen')?.click()
  await warte(500)

  return {
    protokoll,
    abschluss: 'Umschalter vermessen',
    fehler: document.querySelector('.fehler')?.textContent ?? null,
    darstellung: {},
    fuss: '',
  }
})()`

async function main() {
  const argumente = process.argv.slice(2)
  const absturz = argumente.includes('--absturz')
  const geteilt = argumente.includes('--geteilt')
  const umschalter = argumente.includes('--umschalter')
  const pfad = argumente.find((a) => !a.startsWith('--'))
  const exe = pfad ? resolve(pfad) : STANDARD_EXE
  if (!existsSync(exe)) {
    console.error(`Die Anwendung fehlt: ${exe}`)
    console.error('Erst bauen: cd apps/desktop && pnpm exec tauri build')
    process.exit(1)
  }

  await stelleSicherDassNichtsLaeuft()
  console.log(`Starte ${exe}`)
  const anwendung = spawn(exe, [], {
    env: {
      ...process.env,
      // WebView2 reicht diese Zeichenkette an die Browserinstanz durch. Ohne
      // sie gibt es kein Debug-Protokoll — und ohne das keinen Klick von hier.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  anwendung.stdout.on('data', (d) => process.stdout.write('  [App] ' + d))
  anwendung.stderr.on('data', (d) => process.stderr.write('  [App] ' + d))

  let code
  let steuerung
  try {
    const seite = await findeSeite()
    console.log(`Fenster gefunden: ${seite.title}`)
    steuerung = await Fernsteuerung.verbinde(seite.webSocketDebuggerUrl)

    // Der Kasse Zeit lassen, die Konfiguration zu laden.
    for (let i = 0; i < 100; i++) {
      const bereit = await steuerung.werteAus(`Boolean(document.querySelector('.artikel-kachel'))`)
      if (bereit) break
      await warte(100)
    }

    const ergebnis = await steuerung.werteAus(absturz ? BON_OEFFNEN : geteilt ? GETEILTE_ZEILE : umschalter ? UMSCHALTER : VERKAUF)

    console.log('\n--- Verkauf ---')
    for (const zeile of ergebnis.protokoll) console.log('  ' + zeile)
    console.log('\n--- Abschluss ---')
    console.log('  ' + ergebnis.abschluss)
    if (ergebnis.fehler) console.log('  FEHLERMELDUNG: ' + ergebnis.fehler)

    console.log('\n' + '--- Darstellung ---')
    for (const [name, wert] of Object.entries(ergebnis.darstellung)) {
      console.log('  ' + name.padEnd(18) + (Array.isArray(wert) ? wert.join(' ') : String(wert)))
    }
    console.log('\n--- Protokoll der Kasse ---')
    console.log('  ' + ergebnis.fuss.replaceAll('\n', '\n  '))

    code = ergebnis.fehler ? 1 : 0
  } catch (fehler) {
    console.error('\nGescheitert: ' + (fehler instanceof Error ? fehler.stack : String(fehler)))
    code = 1
  } finally {
    steuerung?.schliesse()
    beende(anwendung)
  }
  process.exit(code)
}

await main()

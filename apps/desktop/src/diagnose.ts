/**
 * Diagnose-Modus — die Kasse misst sich selbst.
 *
 * Wie lange ein Verkauf dauert, war bisher eine Stoppuhrfrage. Von Hand
 * gestoppt misst man aber die eigene Reaktionszeit mit, und man bekommt genau
 * eine Zahl: die Gesamtdauer. **Interessant sind die Abstände** — eine lange
 * Pause vor der Betragsbestätigung heißt etwas anderes als eine lange Pause
 * zwischen zwei Artikeln. Das eine ist Kopfrechnen, das andere Suchen im
 * Raster.
 *
 * ## Zwei Bedingungen, die den Entwurf bestimmen
 *
 * **1. Die Messwerte gehen nicht in den Event Log.** Der ist die steuerliche
 * Aufzeichnung; Diagnosedaten haben darin nichts zu suchen. Eigene Datei,
 * eigener Speicher, eigenes Format.
 *
 * **2. Nichts davon darf im Verkaufspfad bremsen.** Messen heißt hier:
 * Zeitstempel in ein Array schieben. Keine Datei, kein `await`, keine
 * Formatierung während des Verkaufs. Geschrieben wird **nach** dem Abschluss,
 * und ein Fehler dabei erreicht den Verkauf nicht.
 *
 * Ist der Modus aus, ist `KEINE_DIAGNOSE` im Spiel: drei leere Methoden. Der
 * Verkaufspfad zahlt dafür nichts (Regel 6).
 *
 * ## Die Uhr
 *
 * `performance.now()` statt `Date.now()`: monoton und unabhängig davon, ob
 * jemand die Systemzeit stellt oder eine Zeitumstellung dazwischenliegt. Für
 * Abstände ist das die einzig brauchbare Quelle. Die Wanduhrzeit steht
 * zusätzlich in der Datei — aber nur, damit sich ein Verkauf wiederfinden
 * lässt, nicht zum Rechnen.
 *
 * Die Zeitquelle kommt von außen, damit die Tests nicht auf echte Uhren warten
 * müssen (dieselbe Überlegung wie Regel 11, auch wenn sie nur für den Kern
 * gilt).
 */

/** Ein Messpunkt. */
export interface Messpunkt {
  /**
   * `interaktion` — jemand hat etwas getan.
   * `maschine` — die Kasse hat etwas getan und dafür gebraucht.
   *
   * Getrennt, weil die beiden nichts miteinander zu tun haben: eine langsame
   * TSE ist ein Geräteproblem, eine lange Pause vor dem Zahlen ein Problem der
   * Bedienung. Sie in einer Spalte zu mischen hieße, das zu verwischen.
   */
  readonly art: 'interaktion' | 'maschine'
  readonly bezeichnung: string
  /** Millisekunden seit dem ersten Artikeltipp. */
  readonly zeitpunktMs: number
  /** Nur bei Maschinenphasen: wie lange sie gedauert hat. */
  readonly dauerMs?: number
}

/**
 * Was die Kasse während eines Verkaufs melden darf.
 *
 * Bewusst schmal: zwei Methoden, beide ohne Rückgabewert, der man ansehen
 * müsste, ob sie gelungen sind. Eine Diagnose, die den Verkauf scheitern lassen
 * kann, ist ihr Geld nicht wert.
 */
export interface Diagnose {
  readonly aktiv: boolean
  /** Ein Zeitpunkt — jemand hat etwas getan. */
  punkt(bezeichnung: string): void
  /**
   * Beginn einer Maschinenphase. Der Rückgabewert beendet sie.
   *
   * `const fertig = diagnose.beginne('TSE-Signatur'); … ; fertig()`
   */
  beginne(bezeichnung: string): () => void
}

/** Der Modus ist aus. Drei leere Methoden, kein Zustand. */
export const KEINE_DIAGNOSE: Diagnose = {
  aktiv: false,
  punkt: () => undefined,
  beginne: () => () => undefined,
}

/**
 * Die Messung eines einzelnen Verkaufs.
 *
 * Beginnt beim **ersten Artikeltipp**, nicht bei einem Startknopf. Damit fällt
 * die Überlegungszeit davor heraus — die gehört dem Kunden, nicht der Kasse.
 */
export class Verkaufsmessung implements Diagnose {
  readonly aktiv = true
  private readonly punkte: Messpunkt[] = []
  private readonly beginn: number

  constructor(
    private readonly jetztMs: () => number,
    /** Wanduhrzeit des Beginns — nur zum Wiederfinden, nicht zum Rechnen. */
    readonly wanduhr: string,
  ) {
    this.beginn = jetztMs()
  }

  punkt(bezeichnung: string): void {
    this.punkte.push({
      art: 'interaktion',
      bezeichnung,
      zeitpunktMs: this.jetztMs() - this.beginn,
    })
  }

  beginne(bezeichnung: string): () => void {
    const start = this.jetztMs()
    return () => {
      this.punkte.push({
        art: 'maschine',
        bezeichnung,
        zeitpunktMs: start - this.beginn,
        dauerMs: this.jetztMs() - start,
      })
    }
  }

  get messpunkte(): readonly Messpunkt[] {
    return this.punkte
  }
}

// --- Auswertung -------------------------------------------------------------

export interface Auswertung {
  readonly gesamtMs: number
  /** Vom ersten Tipp bis zur Wahl der Zahlungsart. */
  readonly bisZahlungsartMs: number
  /** Von der Zahlungsart bis „Raster wieder frei". */
  readonly abZahlungsartMs: number
  readonly tipps: number
  /** Der größte Abstand zwischen zwei Interaktionen — und wovor er lag. */
  readonly laengstePause: { readonly vorMs: number; readonly bezeichnung: string }
  /** Summe der Maschinenphasen. */
  readonly maschineMs: number
}

/** Kennzeichnungen, an denen die Auswertung die Abschnitte erkennt. */
export const MARKE = {
  artikel: 'Artikel: ',
  zahlungsart: 'Zahlart: ',
  fertig: 'Raster frei',
} as const

/**
 * Rechnet die Messpunkte in die Zahlen um, die im Protokoll stehen.
 *
 * Die **Abstände** sind der Punkt: `laengstePause` sagt, wo die Zeit
 * tatsächlich hingegangen ist, und die Summe allein sagt das nie.
 */
export function werteAus(punkte: readonly Messpunkt[]): Auswertung {
  const interaktionen = punkte.filter((p) => p.art === 'interaktion')
  const maschine = punkte.filter((p) => p.art === 'maschine')

  const zahlungsart = interaktionen.find((p) => p.bezeichnung.startsWith(MARKE.zahlungsart))
  const letzter = interaktionen.at(-1)
  const gesamtMs = letzter?.zeitpunktMs ?? 0

  let laengstePause = { vorMs: 0, bezeichnung: '(keine)' }
  let vorher = 0
  for (const p of interaktionen) {
    const abstand = p.zeitpunktMs - vorher
    if (abstand > laengstePause.vorMs) laengstePause = { vorMs: abstand, bezeichnung: p.bezeichnung }
    vorher = p.zeitpunktMs
  }

  return {
    gesamtMs,
    bisZahlungsartMs: zahlungsart?.zeitpunktMs ?? gesamtMs,
    abZahlungsartMs: zahlungsart === undefined ? 0 : gesamtMs - zahlungsart.zeitpunktMs,
    tipps: interaktionen.filter((p) => p.bezeichnung.startsWith(MARKE.artikel)).length,
    laengstePause,
    maschineMs: maschine.reduce((summe, p) => summe + (p.dauerMs ?? 0), 0),
  }
}

/** Eine Zeile fürs Protokoll — kurz genug, dass sie niemand überliest. */
export function alsProtokollzeile(a: Auswertung, belegnummer: string): string {
  const s = (ms: number): string => (ms / 1000).toFixed(1) + ' s'
  return (
    'Diagnose ' + belegnummer + ': ' + s(a.gesamtMs) + ' gesamt · ' +
    s(a.bisZahlungsartMs) + ' bis Zahlart · ' +
    s(a.abZahlungsartMs) + ' danach · ' +
    String(a.tipps) + ' Tipps · ' +
    'laengste Pause ' + s(a.laengstePause.vorMs) + ' vor "' + a.laengstePause.bezeichnung + '" · ' +
    'Maschine ' + Math.round(a.maschineMs) + ' ms'
  )
}

// --- CSV --------------------------------------------------------------------

export const CSV_KOPF =
  'verkauf;belegnummer;nr;art;bezeichnung;zeitpunkt_ms;abstand_ms;dauer_ms\n'

/**
 * Die Messpunkte als CSV-Zeilen.
 *
 * Semikolon als Trenner: die Datei wird in Deutschland geöffnet, und Excel
 * erwartet dort das Semikolon. Ein Komma erzwänge einen Importdialog, den
 * niemand ausfüllt.
 *
 * `abstand_ms` steht als eigene Spalte da, obwohl es sich aus `zeitpunkt_ms`
 * ausrechnen ließe — es ist die Zahl, um die es geht, und eine Spalte, die man
 * erst herleiten muss, wird nicht angesehen.
 */
export function alsCsv(
  punkte: readonly Messpunkt[],
  verkauf: string,
  belegnummer: string,
): string {
  let vorher = 0
  return punkte
    .map((p, i) => {
      const abstand = p.art === 'interaktion' ? p.zeitpunktMs - vorher : undefined
      if (p.art === 'interaktion') vorher = p.zeitpunktMs
      return [
        verkauf,
        belegnummer,
        String(i + 1),
        p.art,
        // Semikolon im Text würde die Spalten verschieben.
        p.bezeichnung.replace(/;/g, ','),
        Math.round(p.zeitpunktMs),
        abstand === undefined ? '' : Math.round(abstand),
        p.dauerMs === undefined ? '' : Math.round(p.dauerMs),
      ].join(';')
    })
    .join('\n') + '\n'
}

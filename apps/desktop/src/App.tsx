/**
 * Die Kassenoberfläche.
 *
 * Schlicht und funktional, Standardformen. Die Farbwelt kommt in einem eigenen
 * Schritt — hier geht es darum, dass ein Verkauf sauber durchläuft.
 */

// React 19 stellt den JSX-Namensraum nicht mehr global bereit — er wird
// importiert.
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type Bon,
  type Cents,
  type Verzehrart,
  aktiveZeilen,
  bonSteuerausweis,
  bonZeilensumme,
  cents,
  gesamtbetrag,
  steuerKennzeichen,
  steuersatzText,
} from '@bonbon/core'
import { type PrinterPort, type TsePort, type TseZustand, euroText } from '@bonbon/ports'

import { type EventLogPort, VorschauDrucker, baueDrucker, baueEventLog, baueTse, entwicklungsHasher } from './adapter.js'
import { TSE_ANZEIGE, type TseAnzeigeStatus } from './farben.js'
import { type Abschlussergebnis, Kasse, schnellbetraege } from './kasse.js'
import { type Konfiguration, ladeKonfiguration, laeuftInTauri } from './konfiguration.js'
import { ARTIKEL, WARENGRUPPEN, type Warengruppe } from './stammdaten.js'

type Ansicht = 'raster' | 'zahlung'

export function App(): JSX.Element {
  const [konfiguration, setKonfiguration] = useState<Konfiguration | undefined>()
  const [protokoll, setProtokoll] = useState<string[]>([])
  const [bon, setBon] = useState<Bon | undefined>()
  const [ansicht, setAnsicht] = useState<Ansicht>('raster')
  const [gruppe, setGruppe] = useState<Warengruppe>(WARENGRUPPEN[0] as Warengruppe)
  const [tseZustand, setTseZustand] = useState<TseZustand | undefined>()
  const [letzterAbschluss, setLetzterAbschluss] = useState<Abschlussergebnis | undefined>()
  const [fehler, setFehler] = useState<string | undefined>()

  const kasseRef = useRef<Kasse | undefined>(undefined)
  const druckerRef = useRef<PrinterPort | undefined>(undefined)
  const tseRef = useRef<TsePort | undefined>(undefined)
  const logRef = useRef<EventLogPort | undefined>(undefined)

  const melde = useCallback((nachricht: string) => {
    setProtokoll((bisher) => [...bisher.slice(-40), nachricht])
  }, [])

  // --- Einrichtung ---
  useEffect(() => {
    let abgebrochen = false
    void (async () => {
      const k = await ladeKonfiguration(melde)
      if (abgebrochen) return
      const hasher = entwicklungsHasher()
      const tse = baueTse(k, melde)
      const drucker = baueDrucker(k.drucker, melde)
      const log = baueEventLog(k.eventLog, hasher, melde)
      tseRef.current = tse
      druckerRef.current = drucker
      logRef.current = log
      const neueKasse = new Kasse(k, tse, drucker, log, melde)
      // Vor dem ersten Bon: an die schon geschriebenen Bons anknuepfen, sonst
      // beginnt die Belegnummer nach jedem Neustart wieder bei 1.
      await neueKasse.knuepfeAnVorgeschichteAn()
      if (abgebrochen) return
      kasseRef.current = neueKasse
      setKonfiguration(k)
      setTseZustand(await tse.zustand())
      if (!laeuftInTauri()) {
        melde('Läuft im Browser — Vorschaudrucker und Speicher-Event-Log.')
      }
    })()
    return () => {
      abgebrochen = true
    }
  }, [melde])

  const kasse = kasseRef.current

  const sicher = useCallback((tuwas: () => void) => {
    try {
      setFehler(undefined)
      tuwas()
    } catch (f) {
      setFehler(f instanceof Error ? f.message : String(f))
    }
  }, [])

  const artikelTippen = useCallback(
    (artikelId: string) => {
      if (kasse === undefined) return
      sicher(() => {
        if (kasse.bon === undefined || !kasse.offen) {
          setBon(kasse.beginneBon('im-haus'))
        }
        setBon(kasse.tippeArtikel(artikelId))
      })
    },
    [kasse, sicher],
  )

  const verzehrartSetzen = useCallback(
    (neu: Verzehrart) => {
      if (kasse === undefined) return
      sicher(() => {
        if (kasse.bon === undefined || !kasse.offen) {
          setBon(kasse.beginneBon(neu))
        } else {
          setBon(kasse.setzeVerzehrart(neu))
        }
      })
    },
    [kasse, sicher],
  )

  const abschliessen = useCallback(
    async (zahlart: 'bar' | 'karte', gegeben: Cents) => {
      if (kasse === undefined) return
      try {
        setFehler(undefined)
        const ergebnis = await kasse.schliesseAb(zahlart, gegeben)
        setLetzterAbschluss(ergebnis)
        setBon(undefined)
        // Nach dem Abschluss zurueck zum Raster, ohne Bestaetigungsdialog.
        setAnsicht('raster')
        if (tseRef.current !== undefined) setTseZustand(await tseRef.current.zustand())
      } catch (f) {
        setFehler(f instanceof Error ? f.message : String(f))
      }
    },
    [kasse],
  )

  const summe = useMemo(() => (bon === undefined ? cents(0) : gesamtbetrag(bon)), [bon])
  const zeilen = useMemo(() => (bon === undefined ? [] : aktiveZeilen(bon)), [bon])
  const ausweis = useMemo(() => (bon === undefined ? [] : bonSteuerausweis(bon)), [bon])

  if (konfiguration === undefined) {
    return <div className="laden">Kasse wird eingerichtet …</div>
  }

  return (
    <div className="kasse">
      <header className="kopf">
        <div className="kopf-links">
          <strong>{konfiguration.haendler.name}</strong>
          <span className="kasse-id">{konfiguration.kasse.seriennummer}</span>
        </div>
        <TseAmpel zustand={tseZustand} />
      </header>

      <VerzehrartUmschalter
        aktuell={bon?.verzehrart}
        onWaehle={verzehrartSetzen}
        gesperrt={kasse === undefined}
      />

      <main className="hauptbereich">
        <section className="raster">
          <nav className="gruppen">
            {WARENGRUPPEN.map((g) => (
              <button
                key={g}
                type="button"
                className={g === gruppe ? 'gruppe aktiv' : 'gruppe'}
                onClick={() => {
                  setGruppe(g)
                }}
              >
                {g}
              </button>
            ))}
          </nav>
          <div className="artikel">
            {ARTIKEL.filter((a) => a.warengruppe === gruppe).map((a) => (
              <button
                key={a.id}
                type="button"
                className="artikel-kachel"
                onClick={() => {
                  artikelTippen(a.id)
                }}
              >
                <span className="artikel-name">{a.bezeichnung}</span>
                <span className="artikel-preis">{euroText(a.preis)} €</span>
              </button>
            ))}
          </div>
        </section>

        <aside className="bon">
          <h2>Bon</h2>
          {zeilen.length === 0 ? (
            <p className="leer">
              {letzterAbschluss === undefined
                ? 'Artikel antippen, um zu beginnen.'
                : 'Bon abgeschlossen. Nächster Kunde.'}
            </p>
          ) : (
            <ul className="bonzeilen">
              {zeilen.map((z) => (
                <li key={z.lineId}>
                  <span className="menge">{z.menge} ×</span>
                  <span className="bez">{z.bezeichnung}</span>
                  <span className="kennz">{steuerKennzeichen(z.steuersatzPromille)}</span>
                  <span className="betrag">{euroText(bonZeilensumme(z))}</span>
                  <button
                    type="button"
                    className="weg"
                    title="Position entfernen"
                    onClick={() => {
                      if (kasse !== undefined) sicher(() => setBon(kasse.entfernePosition(z.lineId)))
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {ausweis.length > 0 && (
            <table className="steuern">
              <tbody>
                {ausweis.map((z) => (
                  <tr key={z.steuersatzPromille}>
                    <td>
                      {steuerKennzeichen(z.steuersatzPromille)} {steuersatzText(z.steuersatzPromille)} %
                    </td>
                    <td>netto {euroText(z.netto)}</td>
                    <td>USt {euroText(z.steuer)}</td>
                    <td>{euroText(z.brutto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="summe">
            <span>Summe</span>
            <strong>{euroText(summe)} €</strong>
          </div>

          <button
            type="button"
            className="zahlen"
            disabled={zeilen.length === 0}
            onClick={() => {
              setAnsicht('zahlung')
            }}
          >
            Zahlen
          </button>
        </aside>
      </main>

      {ansicht === 'zahlung' && bon !== undefined && (
        <Zahlungsdialog
          summe={summe}
          onAbbrechen={() => {
            setAnsicht('raster')
          }}
          onBar={(gegeben) => {
            void abschliessen('bar', gegeben)
          }}
          onKarte={() => {
            void abschliessen('karte', summe)
          }}
        />
      )}

      {fehler !== undefined && (
        <div className="fehler" role="alert">
          {fehler}
        </div>
      )}

      <footer className="fuss">
        <Abschlussmeldung ergebnis={letzterAbschluss} drucker={druckerRef.current} />
        <details>
          <summary>Protokoll ({protokoll.length})</summary>
          <pre>{protokoll.join('\n')}</pre>
        </details>
      </footer>
    </div>
  )
}

// --- Bausteine -------------------------------------------------------------

/**
 * Zustand der TSE — Farbe **und** Zeichen **und** Wort.
 *
 * Vorher stand hier ein farbiger Punkt und daneben „TSE". Wer Rot und Gruen
 * schlecht unterscheidet — rund 8 % der Maenner — konnte daran nicht ablesen,
 * ob die Kasse signieren kann oder nicht. Jetzt traegt der Punkt ein Zeichen,
 * und daneben steht der Zustand ausgeschrieben. Die Farbe ist die schnellste
 * Information, aber nicht die einzige.
 *
 * `role="status"` statt eines blossen `div`: Vorleseprogramme melden die
 * Aenderung dann von selbst.
 */
function TseAmpel({ zustand }: { zustand: TseZustand | undefined }): JSX.Element {
  const status: TseAnzeigeStatus =
    zustand === undefined
      ? 'unbekannt'
      : zustand.status === 'bereit'
        ? 'bereit'
        : zustand.status === 'gestoert'
          ? 'gestoert'
          : 'ausgefallen'
  const anzeige = TSE_ANZEIGE[status]
  const klasse =
    anzeige.farbe === 'signalGut' ? 'gut' : anzeige.farbe === 'signalWarnung' ? 'warnung' : 'fehler'

  return (
    <div className="tse" role="status" title={zustand?.meldung ?? 'TSE-Zustand unbekannt'}>
      {/* Das Zeichen ist fuer das Auge da; vorgelesen wird das Wort daneben. */}
      <span className={'punkt ' + klasse} aria-hidden="true">
        {anzeige.zeichen}
      </span>
      <span>{anzeige.wort}</span>
    </div>
  )
}

function VerzehrartUmschalter({
  aktuell,
  onWaehle,
  gesperrt,
}: {
  aktuell: Verzehrart | undefined
  onWaehle: (v: Verzehrart) => void
  gesperrt: boolean
}): JSX.Element {
  return (
    <div className="verzehrart">
      <button
        type="button"
        disabled={gesperrt}
        className={aktuell === 'im-haus' ? 'gewaehlt' : ''}
        onClick={() => {
          onWaehle('im-haus')
        }}
      >
        Hier essen
      </button>
      <button
        type="button"
        disabled={gesperrt}
        className={aktuell === 'ausser-haus' ? 'gewaehlt' : ''}
        onClick={() => {
          onWaehle('ausser-haus')
        }}
      >
        Mitnehmen
      </button>
    </div>
  )
}

function Zahlungsdialog({
  summe,
  onAbbrechen,
  onBar,
  onKarte,
}: {
  summe: Cents
  onAbbrechen: () => void
  onBar: (gegeben: Cents) => void
  onKarte: () => void
}): JSX.Element {
  const [gegeben, setGegeben] = useState<Cents | undefined>()
  const betraege = useMemo(() => schnellbetraege(summe), [summe])
  const rueckgeld = gegeben === undefined ? undefined : cents(gegeben - summe)

  return (
    <div className="dialog-hintergrund">
      <div className="dialog">
        <h2>Zu zahlen: {euroText(summe)} €</h2>

        <div className="schnellbetraege">
          {betraege.map((b) => (
            <button
              key={b}
              type="button"
              className={b === summe ? 'passend' : ''}
              onClick={() => {
                setGegeben(b)
              }}
            >
              {euroText(b)} €{b === summe ? ' (passend)' : ''}
            </button>
          ))}
        </div>

        {rueckgeld !== undefined && (
          <div className="rueckgeld">
            <span>Rückgeld</span>
            <strong>{euroText(rueckgeld)} €</strong>
          </div>
        )}

        <div className="dialog-knoepfe">
          <button
            type="button"
            className="bar"
            disabled={gegeben === undefined}
            onClick={() => {
              if (gegeben !== undefined) onBar(gegeben)
            }}
          >
            Bar abschließen
          </button>
          <button type="button" className="karte" onClick={onKarte}>
            Karte
          </button>
          <button type="button" className="abbrechen" onClick={onAbbrechen}>
            Zurück
          </button>
        </div>
      </div>
    </div>
  )
}

function Abschlussmeldung({
  ergebnis,
  drucker,
}: {
  ergebnis: Abschlussergebnis | undefined
  drucker: PrinterPort | undefined
}): JSX.Element | null {
  if (ergebnis === undefined) return null
  const vorschau = drucker instanceof VorschauDrucker ? drucker.letzterBon : undefined
  return (
    <div className="abschluss">
      <span>
        Beleg {ergebnis.beleg.belegnummer} · {euroText(ergebnis.beleg.gesamtbetrag)} € ·{' '}
        {ergebnis.signiert ? 'signiert' : 'NICHT signiert (' + (ergebnis.ausfallgrund ?? '') + ')'} ·{' '}
        {ergebnis.gedruckt ? 'gedruckt' : 'nicht gedruckt'} · {ergebnis.ereignisse} Ereignisse
      </span>
      {vorschau !== undefined && vorschau.length > 0 && (
        <details>
          <summary>Bon ansehen</summary>
          <pre className="bonvorschau">{vorschau.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}

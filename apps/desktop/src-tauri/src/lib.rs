//! Rust-Teil der Kasse.
//!
//! Der Webview kann kein TCP und keine Dateien. Hier stehen deshalb genau die
//! Befehle, die das brauchen — als schmale Transportschicht, nicht als zweite
//! Fachlogik. Die Portimplementierungen bleiben TypeScript und rufen von hier
//! nur `tcp_senden`, `eventlog_anhaengen` und Verwandte auf.
//!
//! Warum so wenig hier steht: Die Steuer- und Rundungslogik darf es nur einmal
//! geben (CLAUDE.md, Stack). Sie liegt in `@bonbon/core` und läuft unverändert
//! im Client und im Backend. Jede Zeile Fachlogik hier wäre eine zweite
//! Implementierung.

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const ZEITLIMIT: Duration = Duration::from_secs(5);

// --- Drucker ---------------------------------------------------------------

/// Sendet rohe ESC/POS-Bytes an einen Drucker auf Port 9100.
///
/// Fehler werden vollständig weitergereicht, nicht zusammengefasst — beim
/// ersten Aufbau will man die echte Meldung sehen.
#[tauri::command]
fn tcp_senden(host: String, port: u16, bytes: Vec<u8>) -> Result<(), String> {
    let adresse = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Adresse {host}:{port} nicht auflösbar: {e}"))?
        .next()
        .ok_or_else(|| format!("Keine Adresse für {host}:{port}"))?;

    let mut strom = TcpStream::connect_timeout(&adresse, ZEITLIMIT)
        .map_err(|e| format!("Verbindung zu {host}:{port} fehlgeschlagen: {e}"))?;
    strom
        .set_write_timeout(Some(ZEITLIMIT))
        .map_err(|e| format!("Zeitlimit nicht setzbar: {e}"))?;
    strom
        .write_all(&bytes)
        .map_err(|e| format!("Schreiben an {host}:{port} fehlgeschlagen: {e}"))?;
    strom
        .flush()
        .map_err(|e| format!("Leeren des Puffers fehlgeschlagen: {e}"))?;
    Ok(())
}

/// Prüft, ob auf dem Port etwas lauscht — ohne zu drucken.
#[tauri::command]
fn tcp_erreichbar(host: String, port: u16) -> Result<bool, String> {
    let adresse = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Adresse nicht auflösbar: {e}"))?
        .next()
        .ok_or_else(|| "Keine Adresse".to_string())?;
    Ok(TcpStream::connect_timeout(&adresse, ZEITLIMIT).is_ok())
}

// --- Event Log -------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerkettetesEreignis {
    id: String,
    device_id: String,
    seq: i64,
    occurred_at: String,
    #[serde(rename = "type")]
    typ: String,
    payload: String,
    prev_hash: String,
    hash: String,
    /**
     * Zu welchem Bon das Ereignis gehoert.
     *
     * Der Wert kommt vom Aufrufer und wird hier **nicht** aus dem Payload
     * gelesen: welches Feld den Bon benennt, weiss allein die TypeScript-Seite.
     *
     * Er geht bewusst **nicht** in die Hash-Eingabe ein. Die Kette bleibt damit
     * unveraendert (dieselben Testvektoren gelten weiter), und die Spalte ist
     * trotzdem nicht faelschbar: sie ist aus dem Payload ableitbar, und der ist
     * gehasht.
     */
    sale_id: Option<String>,
}

fn oeffne(pfad: &str) -> Result<Connection, String> {
    let verbindung = Connection::open(pfad).map_err(|e| format!("Datenbank {pfad}: {e}"))?;
    // WAL und synchronous NORMAL — dieselben Einstellungen wie im M0-Lasttest.
    verbindung
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("WAL nicht setzbar: {e}"))?;
    verbindung
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("synchronous nicht setzbar: {e}"))?;
    verbindung
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sale_events (
                id          TEXT    NOT NULL PRIMARY KEY,
                device_id   TEXT    NOT NULL,
                seq         INTEGER NOT NULL,
                occurred_at TEXT    NOT NULL,
                type        TEXT    NOT NULL,
                payload     TEXT    NOT NULL,
                prev_hash   TEXT    NOT NULL,
                hash        TEXT    NOT NULL,
                sale_id     TEXT,
                synced_at   TEXT,
                UNIQUE (device_id, seq)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS idx_events_device_seq
                ON sale_events (device_id, seq);
             CREATE INDEX IF NOT EXISTS idx_events_device_sale
                ON sale_events (device_id, sale_id);",
        )
        .map_err(|e| format!("Tabelle nicht anlegbar: {e}"))?;

    // Aeltere Datenbanken kennen `sale_id` noch nicht. Die Spalte wird
    // ergaenzt; vorhandene Zeilen behalten NULL.
    //
    // **Kein Nachtragen.** Man koennte die Spalte aus dem Payload fuellen, aber
    // das waere ein UPDATE auf `sale_events` — und der Log ist append-only
    // (Regel 2). Eine Ausnahme „nur fuer eine abgeleitete Spalte" waere der
    // Anfang vom Ende dieser Regel. Ereignisse aus der Zeit davor tauchen in
    // den Abfragen nach Bon deshalb nicht auf; das ist der Preis und er wird
    // hier genannt, nicht verschwiegen.
    let hat_spalte = verbindung
        .prepare("SELECT 1 FROM pragma_table_info('sale_events') WHERE name = 'sale_id'")
        .and_then(|mut a| a.exists([]))
        .map_err(|e| format!("Spaltenpruefung fehlgeschlagen: {e}"))?;
    if !hat_spalte {
        verbindung
            .execute_batch(
                "ALTER TABLE sale_events ADD COLUMN sale_id TEXT;
                 CREATE INDEX IF NOT EXISTS idx_events_device_sale
                    ON sale_events (device_id, sale_id);",
            )
            .map_err(|e| format!("Spalte sale_id nicht ergaenzbar: {e}"))?;
    }

    Ok(verbindung)
}

/// Die Hash-Eingabe, längenpräfigiert — Byte für Byte dieselbe Bildung wie in
/// `@bonbon/core` (`eventHashInput`).
///
/// Diese Funktion **muss** mit der TypeScript-Fassung übereinstimmen, sonst
/// bricht die Kette beim Wechsel des Schreibwegs. Der Test unten prüft gegen
/// `testvektoren/hash-eingabe.json` — dieselbe Datei, gegen die auch
/// `@bonbon/core` prüft.
fn hash_eingabe(prev_hash: &str, e: &VerkettetesEreignis) -> String {
    let felder = [
        prev_hash,
        &e.id,
        &e.device_id,
        &e.seq.to_string(),
        &e.occurred_at,
        &e.typ,
        &e.payload,
    ];
    felder
        .iter()
        .map(|f| format!("{}:{}", f.chars().count(), f))
        .collect::<Vec<_>>()
        .join("|")
}

/// Eine Zeile aus `sale_events` in ein Ereignis.
fn lies_ereignis(z: &rusqlite::Row<'_>) -> rusqlite::Result<VerkettetesEreignis> {
    Ok(VerkettetesEreignis {
        id: z.get(0)?,
        device_id: z.get(1)?,
        seq: z.get(2)?,
        occurred_at: z.get(3)?,
        typ: z.get(4)?,
        payload: z.get(5)?,
        prev_hash: z.get(6)?,
        hash: z.get(7)?,
        sale_id: z.get(8)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn eventlog_anhaengen(
    pfad: String,
    device_id: String,
    r#type: String,
    payload: String,
    occurred_at: String,
    id: String,
    sale_id: Option<String>,
) -> Result<VerkettetesEreignis, String> {
    let verbindung = oeffne(&pfad)?;

    let (letzte_seq, letzter_hash): (i64, String) = verbindung
        .query_row(
            "SELECT seq, hash FROM sale_events WHERE device_id = ?1 ORDER BY seq DESC LIMIT 1",
            [&device_id],
            |zeile| Ok((zeile.get(0)?, zeile.get(1)?)),
        )
        .unwrap_or((0, GENESIS_HASH.to_string()));

    let mut ereignis = VerkettetesEreignis {
        id,
        device_id,
        seq: letzte_seq + 1,
        occurred_at,
        typ: r#type,
        payload,
        prev_hash: letzter_hash.clone(),
        hash: String::new(),
        sale_id,
    };

    let mut hasher = Sha256::new();
    hasher.update(hash_eingabe(&letzter_hash, &ereignis).as_bytes());
    ereignis.hash = hex::encode(hasher.finalize());

    verbindung
        .execute(
            "INSERT INTO sale_events
               (id, device_id, seq, occurred_at, type, payload, prev_hash, hash, sale_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                ereignis.id,
                ereignis.device_id,
                ereignis.seq,
                ereignis.occurred_at,
                ereignis.typ,
                ereignis.payload,
                ereignis.prev_hash,
                ereignis.hash,
                ereignis.sale_id,
            ],
        )
        .map_err(|e| format!("Ereignis nicht schreibbar: {e}"))?;

    Ok(ereignis)
}

/// Das zuletzt geschriebene Ereignis eines Typs.
///
/// Die Kasse liest daraus beim Start die zuletzt vergebene Belegnummer: das
/// letzte `SaleStarted` traegt sie im Payload. Rust gibt nur die Zeile zurueck
/// und deutet nichts — welche Bedeutung im Payload steckt, weiss allein die
/// TypeScript-Seite (CLAUDE.md, Stack).
///
/// Vorher stand hier eine Zaehlung der `SaleStarted`-Ereignisse. Die stimmte
/// nur, solange jeder begonnene Bon auch abgeschlossen wurde — ein verworfener
/// oder geparkter Bon haette seine Nummer ein zweites Mal vergeben lassen.
#[tauri::command]
fn eventlog_letztes_ereignis(
    pfad: String,
    device_id: String,
    r#type: String,
) -> Result<Option<VerkettetesEreignis>, String> {
    let verbindung = oeffne(&pfad)?;
    let ergebnis = verbindung.query_row(
        "SELECT id, device_id, seq, occurred_at, type, payload, prev_hash, hash, sale_id
           FROM sale_events
          WHERE device_id = ?1 AND type = ?2
          ORDER BY seq DESC LIMIT 1",
        rusqlite::params![device_id, r#type],
        lies_ereignis,
    );
    match ergebnis {
        Ok(e) => Ok(Some(e)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Letztes Ereignis nicht lesbar: {e}")),
    }
}

/// Alle Ereignisse eines Bons, aufsteigend.
#[tauri::command]
fn eventlog_ereignisse_zu_beleg(
    pfad: String,
    device_id: String,
    sale_id: String,
) -> Result<Vec<VerkettetesEreignis>, String> {
    let verbindung = oeffne(&pfad)?;
    let mut abfrage = verbindung
        .prepare(
            "SELECT id, device_id, seq, occurred_at, type, payload, prev_hash, hash, sale_id
               FROM sale_events
              WHERE device_id = ?1 AND sale_id = ?2
              ORDER BY seq",
        )
        .map_err(|e| format!("Abfrage nicht vorbereitbar: {e}"))?;
    // Erst binden, dann zurueckgeben: sonst lebt die Abfrage laenger als die
    // Verbindung, die sie ausleiht.
    let zeilen = abfrage
        .query_map(rusqlite::params![device_id, sale_id], lies_ereignis)
        .map_err(|e| format!("Abfrage fehlgeschlagen: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Zeilen nicht lesbar: {e}"))?;
    Ok(zeilen)
}

/// Belege, die bestimmte Ereignistypen haben — und andere nicht.
///
/// Reine Mengenrechnung. **Welche** Typen einen Bon beenden oder eine Signatur
/// belegen, weiss allein die TypeScript-Seite und gibt es hier hinein; Rust
/// kennt die Bedeutung der Namen nicht (CLAUDE.md, Stack).
///
/// Damit findet die Kasse beim Start in einer Abfrage:
/// - unbeendete Bons: hat `SaleStarted`, hat nicht `SaleFinished`/`SaleCancelled`
/// - Bons ohne Signaturnachweis: hat `SaleFinished`, hat kein Signaturereignis
///
/// Zurueck kommen die Belege in der Reihenfolge ihres ersten Ereignisses —
/// aelteste zuerst, damit sie in der Reihenfolge aufgeloest werden koennen, in
/// der sie entstanden sind.
#[tauri::command]
fn eventlog_belege(
    pfad: String,
    device_id: String,
    enthaelt: Vec<String>,
    enthaelt_nicht: Vec<String>,
) -> Result<Vec<String>, String> {
    let verbindung = oeffne(&pfad)?;

    // Platzhalter fuer beide Listen. Eine leere Liste ergibt eine Summe von 0
    // und damit die jeweils neutrale Bedingung.
    let platzhalter = |anzahl: usize, ab: usize| -> String {
        (0..anzahl)
            .map(|i| format!("?{}", ab + i))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let hat = platzhalter(enthaelt.len(), 2);
    let hat_nicht = platzhalter(enthaelt_nicht.len(), 2 + enthaelt.len());

    let sql = format!(
        "SELECT sale_id FROM sale_events
          WHERE device_id = ?1 AND sale_id IS NOT NULL
          GROUP BY sale_id
         HAVING SUM(CASE WHEN type IN ({}) THEN 1 ELSE 0 END) {}
            AND SUM(CASE WHEN type IN ({}) THEN 1 ELSE 0 END) = 0
          ORDER BY MIN(seq)",
        if hat.is_empty() { "NULL".to_string() } else { hat },
        if enthaelt.is_empty() { ">= 0" } else { "> 0" },
        if hat_nicht.is_empty() { "NULL".to_string() } else { hat_nicht },
    );

    let werte: Vec<&dyn rusqlite::ToSql> = std::iter::once(&device_id as &dyn rusqlite::ToSql)
        .chain(enthaelt.iter().map(|t| t as &dyn rusqlite::ToSql))
        .chain(enthaelt_nicht.iter().map(|t| t as &dyn rusqlite::ToSql))
        .collect();

    let mut abfrage = verbindung
        .prepare(&sql)
        .map_err(|e| format!("Abfrage nicht vorbereitbar: {e}"))?;
    let belege = abfrage
        .query_map(werte.as_slice(), |z| z.get::<_, String>(0))
        .map_err(|e| format!("Abfrage fehlgeschlagen: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Zeilen nicht lesbar: {e}"))?;
    Ok(belege)
}

#[tauri::command]
fn eventlog_anzahl(pfad: String) -> Result<i64, String> {
    let verbindung = oeffne(&pfad)?;
    verbindung
        .query_row("SELECT COUNT(*) FROM sale_events", [], |z| z.get(0))
        .map_err(|e| format!("Zählen fehlgeschlagen: {e}"))
}

// --- Dateien ---------------------------------------------------------------

/// Liest eine Textdatei. `None`, wenn sie nicht da ist.
///
/// Der Unterschied ist wichtig: „gibt es nicht" ist ein normaler Zustand — die
/// Konfiguration ist eben noch nicht angelegt. „Gibt es, aber ich komme nicht
/// heran" ist ein Fehler und wird als solcher gemeldet. Beides in `None`
/// zusammenzuwerfen hiesse, eine unlesbare Datei als „nicht vorhanden"
/// durchzuwinken, und die Kasse liefe still mit den Vorgaben weiter.
#[tauri::command]
fn datei_lesen(pfad: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&pfad) {
        Ok(inhalt) => Ok(Some(inhalt)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Datei {pfad} nicht lesbar: {e}")),
    }
}

/// Schreibt eine Textdatei — vollstaendig oder gar nicht.
///
/// Erst in eine Nebendatei, dann umbenennen. Ein Absturz mitten im Schreiben
/// hinterlaesst sonst eine halbe Datei, und beim naechsten Start faellt die
/// Kasse auf die Vorgaben zurueck, ohne dass jemand weiss, warum.
#[tauri::command]
fn datei_schreiben(pfad: String, inhalt: String) -> Result<(), String> {
    let neben = format!("{pfad}.neu");
    std::fs::write(&neben, inhalt).map_err(|e| format!("Datei {neben} nicht schreibbar: {e}"))?;
    std::fs::rename(&neben, &pfad).map_err(|e| format!("Umbenennen nach {pfad} fehlgeschlagen: {e}"))
}

/// Haengt Text an eine Datei an und legt sie an, falls noetig.
///
/// Fuer die Diagnose-Aufzeichnung: sie waechst zeilenweise, und die ganze Datei
/// dafuer zu lesen und neu zu schreiben wuerde mit jedem Verkauf teurer.
///
/// **Ausdruecklich kein `datei_schreiben` mit Vorlesen.** Der Unterschied ist
/// nicht Bequemlichkeit: die Diagnosedatei ist die einzige, die im Betrieb
/// unbegrenzt waechst.
#[tauri::command]
fn datei_anhaengen(pfad: String, inhalt: String) -> Result<(), String> {
    use std::io::Write as _;
    let mut datei = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&pfad)
        .map_err(|e| format!("Datei {pfad} nicht zu oeffnen: {e}"))?;
    datei
        .write_all(inhalt.as_bytes())
        .map_err(|e| format!("Anhaengen an {pfad} fehlgeschlagen: {e}"))
}

/// Das Verzeichnis, in dem die Anwendung liegt.
///
/// Dorthin gehoert die Konfiguration: jeder Laden hat eine andere Drucker-IP,
/// und im Anwendungsbuendel waere die Datei nur mit einem neuen Bau zu aendern.
#[tauri::command]
fn anwendungsverzeichnis() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Eigener Pfad unbekannt: {e}"))?;
    let ordner = exe
        .parent()
        .ok_or_else(|| "Die Anwendung liegt in keinem Verzeichnis".to_string())?;
    Ok(ordner.display().to_string())
}

// --- Start -----------------------------------------------------------------

/// Der Befehlssatz — an einer Stelle, damit Betrieb und Test nicht auseinanderlaufen.
///
/// Der Beweislauf in `pfadtests` baut die App mit **demselben** Makro. Ein
/// Befehl, der hier steht, ist damit auch im Test erreichbar; einer, der hier
/// fehlt, fehlt in beiden. Zwei getrennte Listen wuerden still driften: der
/// Test bliebe gruen, waehrend im Betrieb ein Befehl unbekannt ist.
macro_rules! befehle {
    () => {
        tauri::generate_handler![
            tcp_senden,
            tcp_erreichbar,
            eventlog_anhaengen,
            eventlog_anzahl,
            eventlog_letztes_ereignis,
            eventlog_ereignisse_zu_beleg,
            eventlog_belege,
            datei_lesen,
            datei_schreiben,
            datei_anhaengen,
            anwendungsverzeichnis
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(befehle!())
        .run(tauri::generate_context!())
        .expect("Die Kasse konnte nicht gestartet werden");
}

#[cfg(test)]
mod pfadtests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Ein Fall aus `testvektoren/hash-eingabe.json`.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vektor {
        name: String,
        prev_hash: String,
        ereignis: VektorEreignis,
        eingabe: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VektorEreignis {
        id: String,
        device_id: String,
        seq: i64,
        occurred_at: String,
        #[serde(rename = "type")]
        typ: String,
        payload: String,
    }

    #[derive(Deserialize)]
    struct Vektordatei {
        vektoren: Vec<Vektor>,
    }

    /// Die Hash-Eingabe muss Byte für Byte der TypeScript-Fassung entsprechen.
    ///
    /// Geprüft wird gegen `testvektoren/hash-eingabe.json` — dieselbe Datei,
    /// gegen die auch `@bonbon/core` prüft. Ein festgeschriebener Wert hier
    /// hätte heute gehalten, wäre aber stillschweigend gedriftet, sobald jemand
    /// dem Ereignis ein Feld hinzufügt: dieser Test bliebe grün, während die
    /// Ketten auseinanderlaufen.
    ///
    /// Mit der gemeinsamen Datei schlagen beide Seiten fehl. Das ist gewollt.
    #[test]
    fn hash_eingabe_stimmt_mit_den_testvektoren_ueberein() {
        let pfad = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../testvektoren/hash-eingabe.json");
        let inhalt = std::fs::read_to_string(pfad)
            .unwrap_or_else(|e| panic!("Testvektoren nicht lesbar ({pfad}): {e}"));
        let datei: Vektordatei =
            serde_json::from_str(&inhalt).expect("Testvektoren nicht lesbar (JSON)");

        assert!(!datei.vektoren.is_empty(), "Keine Testvektoren vorhanden");

        for vektor in &datei.vektoren {
            let e = VerkettetesEreignis {
                id: vektor.ereignis.id.clone(),
                device_id: vektor.ereignis.device_id.clone(),
                seq: vektor.ereignis.seq,
                occurred_at: vektor.ereignis.occurred_at.clone(),
                typ: vektor.ereignis.typ.clone(),
                payload: vektor.ereignis.payload.clone(),
                prev_hash: vektor.prev_hash.clone(),
                hash: String::new(),
                // Geht nicht in die Hash-Eingabe ein — die Testvektoren
                // gelten unveraendert weiter.
                sale_id: None,
            };
            assert_eq!(
                hash_eingabe(&vektor.prev_hash, &e),
                vektor.eingabe,
                "Testvektor \"{}\" weicht ab — Rust und TypeScript bilden die                  Hash-Eingabe unterschiedlich. Die Kette braeche beim Wechsel                  des Schreibwegs.",
                vektor.name
            );
        }
    }
}

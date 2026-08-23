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
                synced_at   TEXT,
                UNIQUE (device_id, seq)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS idx_events_device_seq
                ON sale_events (device_id, seq);",
        )
        .map_err(|e| format!("Tabelle nicht anlegbar: {e}"))?;
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn eventlog_anhaengen(
    pfad: String,
    device_id: String,
    r#type: String,
    payload: String,
    occurred_at: String,
    id: String,
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
    };

    let mut hasher = Sha256::new();
    hasher.update(hash_eingabe(&letzter_hash, &ereignis).as_bytes());
    ereignis.hash = hex::encode(hasher.finalize());

    verbindung
        .execute(
            "INSERT INTO sale_events
               (id, device_id, seq, occurred_at, type, payload, prev_hash, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                ereignis.id,
                ereignis.device_id,
                ereignis.seq,
                ereignis.occurred_at,
                ereignis.typ,
                ereignis.payload,
                ereignis.prev_hash,
                ereignis.hash,
            ],
        )
        .map_err(|e| format!("Ereignis nicht schreibbar: {e}"))?;

    Ok(ereignis)
}

/// Zaehlt die Ereignisse eines Geraets mit einem bestimmten Typ.
///
/// Bewusst nur eine Zaehlung, keine Auswertung: **was** die Zahl bedeutet,
/// entscheidet die TypeScript-Seite. Sie liest daraus, wie viele Bons dieses
/// Geraet schon geschrieben hat, und fuehrt die Belegnummer dort fort. Wuerde
/// Rust das selbst herleiten, laege ein Stueck Fachlogik ein zweites Mal vor
/// (CLAUDE.md, Stack).
#[tauri::command]
fn eventlog_anzahl_typ(pfad: String, device_id: String, r#type: String) -> Result<i64, String> {
    let verbindung = oeffne(&pfad)?;
    verbindung
        .query_row(
            "SELECT COUNT(*) FROM sale_events WHERE device_id = ?1 AND type = ?2",
            rusqlite::params![device_id, r#type],
            |z| z.get(0),
        )
        .map_err(|e| format!("Zaehlen nach Typ fehlgeschlagen: {e}"))
}

#[tauri::command]
fn eventlog_anzahl(pfad: String) -> Result<i64, String> {
    let verbindung = oeffne(&pfad)?;
    verbindung
        .query_row("SELECT COUNT(*) FROM sale_events", [], |z| z.get(0))
        .map_err(|e| format!("Zählen fehlgeschlagen: {e}"))
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
            eventlog_anzahl_typ
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

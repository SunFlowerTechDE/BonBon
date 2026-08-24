//! Beweislauf fuer den echten Rust-Pfad.
//!
//! Diese Tests rufen die Befehle **nicht** als gewoehnliche Rust-Funktionen auf,
//! sondern ueber `tauri::test::get_ipc_response` — also ueber dieselbe
//! IPC-Bruecke, die auch der Webview benutzt, mit denselben JSON-Argumenten,
//! die `adapter.ts` schickt. Der Unterschied ist wesentlich: ein direkter
//! Funktionsaufruf wuerde die Serialisierung ueberspringen, und genau dort
//! koennte ein `Vec<u8>` unbemerkt verbogen werden oder ein Argumentname
//! stillschweigend nicht ankommen. Ein Bon, der als Zahlenfeld durch JSON
//! geht, ist die empfindlichste Stelle im ganzen Weg.
//!
//! Was hier **nicht** geprueft wird: der Webview-Prozess selbst. Die
//! Mock-Runtime ersetzt WebView2. Der Weg ab `invoke()` ist derselbe, der Weg
//! davor — Browser, JavaScript-Bruecke — ist es nicht.

use std::io::Read;
use std::net::TcpListener;
use std::sync::mpsc;

use serde::de::DeserializeOwned;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

use super::*;

/// Der Bon aus dem ESC/POS-Spike, unveraendert eingebettet.
///
/// `include_bytes!` statt Lesen zur Laufzeit: faellt die Datei weg, bricht der
/// Bau, nicht erst der Test.
const REFERENZBON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../tools/escpos-testbon/test/fixtures/testbon-referenz.bin"
));

/// Der Port, auf dem escpresso lauscht.
const ESCPRESSO_PORT: u16 = 9100;

// --- Hilfen ----------------------------------------------------------------

/// Baut die Kasse mit demselben Befehlssatz wie `run()`.
fn kasse() -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .invoke_handler(befehle!())
        .build(mock_context(noop_assets()))
        .expect("App nicht baubar");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("Webview nicht baubar");
    (app, webview)
}

/// Ruft einen Befehl ueber die IPC-Bruecke auf — wie `invoke()` im Webview.
fn rufe<T: DeserializeOwned>(
    webview: &WebviewWindow<MockRuntime>,
    befehl: &str,
    argumente: serde_json::Value,
) -> Result<T, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: befehl.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("URL"),
            body: InvokeBody::Json(argumente),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|antwort| {
        antwort
            .deserialize::<T>()
            .expect("Antwort des Befehls nicht lesbar")
    })
}

/// Nimmt eine Verbindung an, schreibt alles mit und leitet auf Wunsch weiter.
///
/// Das Weiterleiten ist der Kniff: derselbe Bon geht einmal durch, wird dabei
/// byteweise festgehalten **und** landet trotzdem auf escpresso. Sonst muesste
/// man zweimal senden und haette zwei verschiedene Laeufe verglichen.
fn mitschnitt(weiterleiten_an: Option<u16>) -> (u16, mpsc::Receiver<Vec<u8>>) {
    let lauscher = TcpListener::bind("127.0.0.1:0").expect("Kein Port frei");
    let port = lauscher.local_addr().expect("Adresse").port();
    let (sender, empfaenger) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut strom, _) = lauscher.accept().expect("Keine Verbindung angenommen");
        let mut puffer = Vec::new();
        strom.read_to_end(&mut puffer).expect("Lesen fehlgeschlagen");
        if let Some(ziel) = weiterleiten_an {
            let mut weiter = TcpStream::connect(("127.0.0.1", ziel))
                .expect("Weiterleitung fehlgeschlagen — laeuft escpresso?");
            weiter.write_all(&puffer).expect("Weiterleiten");
            weiter.flush().expect("Leeren");
        }
        sender.send(puffer).expect("Mitschnitt nicht zustellbar");
    });
    (port, empfaenger)
}

fn hex_von(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Ein frischer Datenbankpfad; Reste eines vorherigen Laufs werden entfernt.
fn frischer_datenbankpfad(name: &str) -> String {
    let pfad = std::env::temp_dir().join(format!(
        "bonbon-pfadtest-{}-{name}.db",
        std::process::id()
    ));
    for anhang in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{anhang}", pfad.display()));
    }
    pfad.display().to_string()
}

/// Liest die Kette aus der Datei und prueft sie vollstaendig nach.
fn kette_pruefen(pfad: &str, erwartete_anzahl: i64) -> Vec<VerkettetesEreignis> {
    let db = Connection::open(pfad).expect("Datenbank nicht zu oeffnen");

    let modus: String = db
        .query_row("PRAGMA journal_mode", [], |z| z.get(0))
        .expect("journal_mode nicht lesbar");
    assert_eq!(
        modus.to_lowercase(),
        "wal",
        "Die Datenbank laeuft nicht im WAL-Modus"
    );

    let mut abfrage = db
        .prepare(
            "SELECT id, device_id, seq, occurred_at, type, payload, prev_hash, hash, sale_id
             FROM sale_events ORDER BY seq",
        )
        .expect("Abfrage nicht vorbereitbar");
    let zeilen: Vec<VerkettetesEreignis> = abfrage
        .query_map([], |z| {
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
        })
        .expect("Abfrage fehlgeschlagen")
        .collect::<Result<_, _>>()
        .expect("Zeilen nicht lesbar");

    assert_eq!(
        zeilen.len() as i64,
        erwartete_anzahl,
        "Es stehen nicht so viele Ereignisse in der Datei, wie geschrieben wurden"
    );

    let mut vorheriger = GENESIS_HASH.to_string();
    for (i, e) in zeilen.iter().enumerate() {
        assert_eq!(
            e.seq,
            i as i64 + 1,
            "Luecke oder Sprung in der Sequenz an Position {i}"
        );
        assert_eq!(
            e.prev_hash, vorheriger,
            "Ereignis {} zeigt auf einen anderen Vorgaenger als seinen tatsaechlichen",
            e.seq
        );
        let erwartet = hex_von(hash_eingabe(&e.prev_hash, e).as_bytes());
        assert_eq!(
            e.hash, erwartet,
            "Der gespeicherte Hash von Ereignis {} passt nicht zu seinem Inhalt",
            e.seq
        );
        vorheriger = e.hash.clone();
    }
    zeilen
}

fn ereignis_anhaengen(
    webview: &WebviewWindow<MockRuntime>,
    pfad: &str,
    geraet: &str,
    nummer: i64,
) -> VerkettetesEreignis {
    rufe(
        webview,
        "eventlog_anhaengen",
        serde_json::json!({
            "pfad": pfad,
            "deviceId": geraet,
            "type": "SaleLineAdded",
            "payload": format!(r#"{{"artikel":"Cappuccino","nummer":{nummer}}}"#),
            "occurredAt": format!("2026-08-24T09:{nummer:02}:00.000Z"),
            "id": format!("evt-{nummer}"),
            "saleId": format!("{geraet}-BON"),
        }),
    )
    .unwrap_or_else(|f| panic!("eventlog_anhaengen fehlgeschlagen: {f}"))
}

// --- Bondruck --------------------------------------------------------------

/// Der Bon kommt byteweise unveraendert an.
///
/// Geprueft wird gegen `testbon-referenz.bin` aus dem ESC/POS-Spike — dieselbe
/// Referenz, gegen die schon der Renderer prueft. Damit haengen beide Seiten an
/// einer Datei: aendert sich der Bon, faellt es an beiden Stellen auf.
#[test]
fn tcp_senden_liefert_den_bon_byteweise_unveraendert_aus() {
    let (port, empfaenger) = mitschnitt(None);
    let (_app, webview) = kasse();

    rufe::<()>(
        &webview,
        "tcp_senden",
        serde_json::json!({ "host": "127.0.0.1", "port": port, "bytes": REFERENZBON }),
    )
    .unwrap_or_else(|f| panic!("tcp_senden fehlgeschlagen: {f}"));

    let angekommen = empfaenger
        .recv_timeout(Duration::from_secs(10))
        .expect("Nichts angekommen");

    assert_eq!(
        angekommen.len(),
        REFERENZBON.len(),
        "Laenge weicht ab: {} statt {} Bytes",
        angekommen.len(),
        REFERENZBON.len()
    );
    assert_eq!(
        hex_von(&angekommen),
        hex_von(REFERENZBON),
        "Pruefsumme weicht ab"
    );
    assert_eq!(
        angekommen.as_slice(),
        REFERENZBON,
        "Der Bon ist unterwegs veraendert worden"
    );
}

/// Derselbe Bon gegen das laufende escpresso.
///
/// Ausdruecklich `#[ignore]`: dieser Test braucht ein laufendes escpresso auf
/// Port 9100 und wird deshalb nur auf Zuruf gestartet
/// (`cargo test -- --ignored`). Er wird **nicht** stillschweigend
/// uebersprungen, wenn escpresso fehlt — dann schlaegt er fehl. Ein Test, der
/// sich selbst wegduckt, beweist nichts.
#[test]
#[ignore = "braucht ein laufendes escpresso auf Port 9100"]
fn bon_geht_ueber_tcp_senden_an_das_laufende_escpresso() {
    let (port, empfaenger) = mitschnitt(Some(ESCPRESSO_PORT));
    let (_app, webview) = kasse();

    rufe::<()>(
        &webview,
        "tcp_senden",
        serde_json::json!({ "host": "127.0.0.1", "port": port, "bytes": REFERENZBON }),
    )
    .unwrap_or_else(|f| panic!("tcp_senden fehlgeschlagen: {f}"));

    let angekommen = empfaenger
        .recv_timeout(Duration::from_secs(10))
        .expect("Nichts angekommen");
    assert_eq!(
        angekommen.as_slice(),
        REFERENZBON,
        "Was bei escpresso ankam, ist nicht der Referenzbon"
    );
    println!(
        "An escpresso ausgeliefert: {} Bytes, SHA-256 {}",
        angekommen.len(),
        hex_von(&angekommen)
    );
}

// --- Erreichbarkeit --------------------------------------------------------

/// `tcp_erreichbar` sagt die Wahrheit — in beide Richtungen.
///
/// Der zweite Teil ist der wichtige: ein geschlossener Port muss `false`
/// liefern und **keinen Fehler werfen**. Wer den Unterschied nicht sauber
/// meldet, kann ihn im Aufrufer auch nicht auseinanderhalten.
#[test]
fn tcp_erreichbar_meldet_offen_und_geschlossen_richtig() {
    let lauscher = TcpListener::bind("127.0.0.1:0").expect("Kein Port frei");
    let port = lauscher.local_addr().expect("Adresse").port();
    let (_app, webview) = kasse();

    let offen: bool = rufe(
        &webview,
        "tcp_erreichbar",
        serde_json::json!({ "host": "127.0.0.1", "port": port }),
    )
    .unwrap_or_else(|f| panic!("tcp_erreichbar fehlgeschlagen: {f}"));
    assert!(offen, "Ein lauschender Port wurde nicht als offen gemeldet");

    drop(lauscher);

    let geschlossen: bool = rufe(
        &webview,
        "tcp_erreichbar",
        serde_json::json!({ "host": "127.0.0.1", "port": port }),
    )
    .unwrap_or_else(|f| panic!("tcp_erreichbar hat geworfen, statt `false` zu melden: {f}"));
    assert!(
        !geschlossen,
        "Ein geschlossener Port wurde als erreichbar gemeldet"
    );
}

// --- Event Log -------------------------------------------------------------

/// Die Kette laeuft ueber einen Neustart der App hinweg weiter.
///
/// Der Neustart wird nicht behauptet, sondern vollzogen: die erste App wird
/// samt Datenbankverbindung fallengelassen, danach baut der Test eine neue.
/// Der Fortsetzungspunkt kann damit nur aus der Datei kommen — im
/// Arbeitsspeicher ist nichts mehr.
#[test]
fn eventlog_schreibt_nach_sqlite_und_setzt_die_kette_nach_neustart_fort() {
    let pfad = frischer_datenbankpfad("kette");
    let geraet = "KASSE-01";

    let erste: Vec<VerkettetesEreignis> = {
        let (_app, webview) = kasse();
        (1..=3)
            .map(|n| ereignis_anhaengen(&webview, &pfad, geraet, n))
            .collect()
    };
    assert_eq!(
        erste.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3],
        "Die erste Sitzung hat nicht bei 1 begonnen"
    );
    assert_eq!(
        erste[0].prev_hash, GENESIS_HASH,
        "Das erste Ereignis haengt nicht am Genesis-Hash"
    );

    // --- Neustart ---
    let zweite: Vec<VerkettetesEreignis> = {
        let (_app, webview) = kasse();
        let anzahl: i64 = rufe(
            &webview,
            "eventlog_anzahl",
            serde_json::json!({ "pfad": pfad }),
        )
        .unwrap_or_else(|f| panic!("eventlog_anzahl fehlgeschlagen: {f}"));
        assert_eq!(anzahl, 3, "Nach dem Neustart fehlen Ereignisse");
        (4..=6)
            .map(|n| ereignis_anhaengen(&webview, &pfad, geraet, n))
            .collect()
    };
    assert_eq!(
        zweite.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![4, 5, 6],
        "Die zweite Sitzung hat die Sequenz nicht fortgesetzt"
    );
    assert_eq!(
        zweite[0].prev_hash, erste[2].hash,
        "Die Kette bricht an der Nahtstelle des Neustarts"
    );

    let gespeichert = kette_pruefen(&pfad, 6);
    assert_eq!(
        gespeichert
            .iter()
            .map(|e| e.hash.clone())
            .collect::<Vec<_>>(),
        erste
            .iter()
            .chain(zweite.iter())
            .map(|e| e.hash.clone())
            .collect::<Vec<_>>(),
        "Was in der Datei steht, ist nicht das, was der Befehl gemeldet hat"
    );
}

/// Die Belegnummer kommt aus dem Log, nicht aus einer Zaehlung.
///
/// `eventlog_letztes_ereignis` liefert das zuletzt geschriebene `SaleStarted`
/// des Geraets — daraus liest die Kasse die zuletzt vergebene Nummer. Eine
/// Zaehlung stimmte nur, solange jeder begonnene Bon auch abgeschlossen wurde;
/// ein verworfener Bon haette seine Nummer ein zweites Mal vergeben lassen.
#[test]
fn letztes_ereignis_findet_den_zuletzt_begonnenen_bon() {
    let pfad = frischer_datenbankpfad("letztes");
    let (_app, webview) = kasse();

    let schreibe = |typ: &str, geraet: &str, nummer: i64, nutzlast: &str, beleg: &str| {
        let _: VerkettetesEreignis = rufe(
            &webview,
            "eventlog_anhaengen",
            serde_json::json!({
                "pfad": pfad,
                "deviceId": geraet,
                "type": typ,
                "payload": nutzlast,
                "occurredAt": format!("2026-08-24T10:{nummer:02}:00.000Z"),
                "id": format!("{geraet}-{typ}-{nummer}"),
                "saleId": beleg,
            }),
        )
        .unwrap_or_else(|f| panic!("eventlog_anhaengen fehlgeschlagen: {f}"));
    };

    let letztes = |geraet: &str, typ: &str| -> Option<VerkettetesEreignis> {
        rufe(
            &webview,
            "eventlog_letztes_ereignis",
            serde_json::json!({ "pfad": pfad, "deviceId": geraet, "type": typ }),
        )
        .unwrap_or_else(|f| panic!("eventlog_letztes_ereignis fehlgeschlagen: {f}"))
    };

    assert!(
        letztes("KASSE-A", "SaleStarted").is_none(),
        "Ohne Ereignisse darf nichts gefunden werden"
    );

    schreibe("SaleStarted", "KASSE-A", 1, r#"{"saleId":"K-00001"}"#, "K-00001");
    schreibe("LineAdded", "KASSE-A", 2, "{}", "K-00001");
    schreibe("SaleFinished", "KASSE-A", 3, "{}", "K-00001");
    schreibe("SaleStarted", "KASSE-A", 4, r#"{"saleId":"K-00002"}"#, "K-00002");
    schreibe("SaleStarted", "KASSE-B", 5, r#"{"saleId":"X-00009"}"#, "X-00009");

    let a = letztes("KASSE-A", "SaleStarted").expect("SaleStarted fehlt");
    assert_eq!(a.payload, r#"{"saleId":"K-00002"}"#, "Nicht das letzte gefunden");
    assert_eq!(a.seq, 4);

    let b = letztes("KASSE-B", "SaleStarted").expect("SaleStarted fehlt");
    assert_eq!(
        b.payload, r#"{"saleId":"X-00009"}"#,
        "Fremdes Geraet nicht getrennt"
    );

    // Und der Bon selbst, ueber seine Belegnummer.
    let bon: Vec<VerkettetesEreignis> = rufe(
        &webview,
        "eventlog_ereignisse_zu_beleg",
        serde_json::json!({ "pfad": pfad, "deviceId": "KASSE-A", "saleId": "K-00001" }),
    )
    .unwrap_or_else(|f| panic!("eventlog_ereignisse_zu_beleg fehlgeschlagen: {f}"));
    assert_eq!(
        bon.iter().map(|e| e.typ.as_str()).collect::<Vec<_>>(),
        vec!["SaleStarted", "LineAdded", "SaleFinished"],
        "Der Bon kam nicht vollstaendig oder nicht in Reihenfolge zurueck"
    );
}

/// `eventlog_belege` trennt „hat" von „hat nicht" — und Geraet von Geraet.
///
/// Daran haengen beide Abgleiche beim Start: unbeendete Bons und Bons ohne
/// Signaturnachweis. Faende die Abfrage zu viel, wuerde ein abgeschlossener
/// Vorgang abgebrochen; faende sie zu wenig, bliebe eine Luecke stehen.
#[test]
fn belege_findet_was_fehlt_und_was_da_ist() {
    let pfad = frischer_datenbankpfad("belege");
    let (_app, webview) = kasse();
    let mut nummer = 0;

    let mut schreibe = |geraet: &str, beleg: &str, typ: &str| {
        nummer += 1;
        let _: VerkettetesEreignis = rufe(
            &webview,
            "eventlog_anhaengen",
            serde_json::json!({
                "pfad": pfad,
                "deviceId": geraet,
                "type": typ,
                "payload": "{}",
                "occurredAt": format!("2026-08-24T11:{nummer:02}:00.000Z"),
                "id": format!("{beleg}-{typ}-{nummer}"),
                "saleId": beleg,
            }),
        )
        .unwrap_or_else(|f| panic!("eventlog_anhaengen fehlgeschlagen: {f}"));
    };

    // A: sauber durch. B: begonnen, nie beendet. C: abgeschlossen, aber ohne
    // Signaturnachweis. D: abgebrochen. E: auf einem anderen Geraet, offen.
    schreibe("K1", "A", "SaleStarted");
    schreibe("K1", "A", "SaleFinished");
    schreibe("K1", "A", "TseSignaturErfasst");
    schreibe("K1", "B", "SaleStarted");
    schreibe("K1", "C", "SaleStarted");
    schreibe("K1", "C", "SaleFinished");
    schreibe("K1", "D", "SaleStarted");
    schreibe("K1", "D", "SaleCancelled");
    schreibe("K2", "E", "SaleStarted");

    let belege = |geraet: &str, hat: Vec<&str>, hat_nicht: Vec<&str>| -> Vec<String> {
        rufe(
            &webview,
            "eventlog_belege",
            serde_json::json!({
                "pfad": pfad,
                "deviceId": geraet,
                "enthaelt": hat,
                "enthaeltNicht": hat_nicht,
            }),
        )
        .unwrap_or_else(|f| panic!("eventlog_belege fehlgeschlagen: {f}"))
    };

    assert_eq!(
        belege("K1", vec!["SaleStarted"], vec!["SaleFinished", "SaleCancelled"]),
        vec!["B".to_string()],
        "Unbeendete Bons falsch bestimmt"
    );
    assert_eq!(
        belege(
            "K1",
            vec!["SaleFinished"],
            vec!["TseSignaturErfasst", "TseSignaturAusgefallen"]
        ),
        vec!["C".to_string()],
        "Bons ohne Signaturnachweis falsch bestimmt"
    );
    assert_eq!(
        belege("K2", vec!["SaleStarted"], vec!["SaleFinished", "SaleCancelled"]),
        vec!["E".to_string()],
        "Geraete nicht getrennt"
    );
    // Leere Listen sind neutral: alle Belege des Geraets.
    assert_eq!(
        belege("K1", vec![], vec![]),
        vec!["A".to_string(), "B".to_string(), "C".to_string(), "D".to_string()],
        "Ohne Bedingung muessen alle Belege kommen, aeltester zuerst"
    );
}

/// Dateien: fehlend, vorhanden, unlesbar sind drei verschiedene Antworten.
#[test]
fn datei_lesen_trennt_fehlend_von_fehlerhaft() {
    let ordner = std::env::temp_dir().join(format!("bonbon-datei-{}", std::process::id()));
    std::fs::create_dir_all(&ordner).expect("Ordner");
    let datei = ordner.join("konfiguration.json").display().to_string();
    let _ = std::fs::remove_file(&datei);

    let (_app, webview) = kasse();

    let gelesen: Option<String> = rufe(&webview, "datei_lesen", serde_json::json!({ "pfad": datei }))
        .unwrap_or_else(|f| panic!("datei_lesen fehlgeschlagen: {f}"));
    assert!(gelesen.is_none(), "Eine fehlende Datei ist kein Fehler");

    rufe::<()>(
        &webview,
        "datei_schreiben",
        serde_json::json!({ "pfad": datei, "inhalt": "{\"drucker\":\"tcp\"}" }),
    )
    .unwrap_or_else(|f| panic!("datei_schreiben fehlgeschlagen: {f}"));

    let gelesen: Option<String> = rufe(&webview, "datei_lesen", serde_json::json!({ "pfad": datei }))
        .unwrap_or_else(|f| panic!("datei_lesen fehlgeschlagen: {f}"));
    assert_eq!(gelesen.as_deref(), Some("{\"drucker\":\"tcp\"}"));

    // Ein Verzeichnis statt einer Datei: vorhanden, aber nicht lesbar. Das
    // muss ein Fehler sein und darf nicht als „nicht da" durchgehen.
    let als_datei: Result<Option<String>, _> = rufe(
        &webview,
        "datei_lesen",
        serde_json::json!({ "pfad": ordner.display().to_string() }),
    );
    assert!(
        als_datei.is_err(),
        "Ein Verzeichnis wurde als fehlende Datei gemeldet"
    );

    // Und das Schreiben ist vollstaendig oder gar nicht — die Nebendatei
    // bleibt nicht liegen.
    assert!(
        !std::path::Path::new(&format!("{datei}.neu")).exists(),
        "Die Nebendatei des Schreibvorgangs blieb liegen"
    );
}

/// Das Anwendungsverzeichnis ist da und enthaelt die laufende Datei.
#[test]
fn anwendungsverzeichnis_zeigt_auf_die_laufende_datei() {
    let (_app, webview) = kasse();
    let ordner: String = rufe(&webview, "anwendungsverzeichnis", serde_json::json!({}))
        .unwrap_or_else(|f| panic!("anwendungsverzeichnis fehlgeschlagen: {f}"));
    let eigener = std::env::current_exe().expect("eigener Pfad");
    assert_eq!(
        std::path::Path::new(&ordner),
        eigener.parent().expect("Elternverzeichnis")
    );
}

/// Eine bereits vergebene id wird abgewiesen, nicht still ueberschrieben.
#[test]
fn doppelte_id_wird_abgewiesen() {
    let pfad = frischer_datenbankpfad("doppelt");
    let (_app, webview) = kasse();
    ereignis_anhaengen(&webview, &pfad, "KASSE-02", 1);

    let zweiter: Result<VerkettetesEreignis, _> = rufe(
        &webview,
        "eventlog_anhaengen",
        serde_json::json!({
            "pfad": pfad,
            "deviceId": "KASSE-02",
            "type": "SaleLineAdded",
            "payload": "{}",
            "occurredAt": "2026-08-24T09:01:00.000Z",
            "id": "evt-1",
        }),
    );
    assert!(
        zweiter.is_err(),
        "Ein Ereignis mit bereits vergebener id wurde angenommen"
    );
    kette_pruefen(&pfad, 1);
}

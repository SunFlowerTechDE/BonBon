fn main() {
    let mut attribute = tauri_build::Attributes::new();

    // Auf Windows braucht das Manifest eine Sonderbehandlung.
    //
    // `tauri_build` bettet sein Manifest ueber die Ressourcendatei ein — und
    // die landet nur im Anwendungsbinary, nicht in den Testbinaries. Ohne
    // Manifest laedt Windows die alte ComCtl32 v5; darin fehlt
    // `TaskDialogIndirect`, die tao importiert. Das Testbinary stirbt dann
    // beim Laden mit STATUS_ENTRYPOINT_NOT_FOUND, bevor ein einziger Test
    // laeuft — ein Fehler, der wie ein Testfehler aussieht, aber keiner ist.
    //
    // `rustc-link-arg-tests` greift nur bei eigenen `[[test]]`-Zielen, nicht
    // bei den Modultests der Bibliothek. Deshalb der andere Weg: tauri sein
    // Manifest abnehmen und stattdessen dasselbe fuer **alle** gelinkten Ziele
    // setzen. Anwendung und Test laufen damit unter derselben Umgebung — was
    // der Test beweist, gilt auch fuer das, was ausgeliefert wird.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let wurzel = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR fehlt");
        let manifest = std::path::Path::new(&wurzel).join("windows-app-manifest.xml");
        assert!(
            manifest.exists(),
            "windows-app-manifest.xml fehlt: {}",
            manifest.display()
        );
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
        attribute =
            attribute.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }

    tauri_build::try_build(attribute).expect("tauri-build fehlgeschlagen");
}

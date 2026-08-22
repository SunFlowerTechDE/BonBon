// Ohne dieses Attribut oeffnet sich unter Windows im Release-Bau zusaetzlich
// ein Konsolenfenster hinter der Kasse.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bonbon_kasse_lib::run()
}

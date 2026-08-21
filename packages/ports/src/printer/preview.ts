/**
 * Vorschau eines Druckauftrags.
 *
 * Nimmt den fertigen Bytestrom und macht daraus den Text, den der Drucker
 * setzen wuerde — die Steuersequenzen werden entfernt, der Text nach WPC1252
 * zurueckgelesen.
 *
 * Zweck ist nicht Schoenheit, sondern Pruefbarkeit: damit laesst sich im Test
 * zusichern, dass keine Zeile breiter ist als das Papier, und auf der Konsole
 * zeigen, was tatsaechlich gesendet wird. Ein Emulator kann denselben
 * Bytestrom anders darstellen — was hier steht, ist das, was beim Geraet
 * ankommt.
 */

/**
 * Alle Sequenzen, die dieses Paket erzeugt, mit ihrer Laenge in Bytes.
 * Die Steuerzeichen sind hier der Gegenstand, deshalb die Ausnahme von
 * `no-control-regex` — sie zu maskieren wuerde den Ausdruck unlesbar machen.
 */
/* eslint-disable no-control-regex */
const COMMAND_PATTERNS: readonly RegExp[] = [
  /\x1b@/g, // ESC @      zuruecksetzen
  /\x1bt[\s\S]/g, // ESC t n    Codepage
  /\x1ba[\s\S]/g, // ESC a n    Ausrichtung
  /\x1bE[\s\S]/g, // ESC E n    Fettdruck
  /\x1b-[\s\S]/g, // ESC - n    Unterstreichen
  /\x1bd[\s\S]/g, // ESC d n    Vorschub
  /\x1bp[\s\S]{3}/g, // ESC p m t1 t2  Kassenlade
  /\x1d![\s\S]/g, // GS ! n     Zeichengroesse
  /\x1dV[\s\S]/g, // GS V m     Schnitt
]
/* eslint-enable no-control-regex */

/** Entfernt die Steuersequenzen und liefert den reinen Text. */
export function stripCommands(job: Uint8Array): string {
  let text = Buffer.from(job).toString('latin1')
  for (const muster of COMMAND_PATTERNS) text = text.replace(muster, '')
  return text
}

/** Der Bon als Zeilen, so wie der Drucker sie setzen wuerde. */
export function previewLines(job: Uint8Array): string[] {
  return stripCommands(job).split('\n')
}

/** Der Bon in einem Rahmen der Papierbreite, fuer die Konsole. */
export function previewBox(job: Uint8Array, charactersPerLine: number): string {
  const rand = '+' + '-'.repeat(charactersPerLine + 2) + '+'
  const zeilen = previewLines(job).map((z) => '| ' + z.padEnd(charactersPerLine) + ' |')
  return [rand, ...zeilen, rand].join('\n')
}

/** Rohe Bytes als Hexdump mit ASCII-Spalte. */
export function hexdump(job: Uint8Array): string {
  const zeilen: string[] = []
  for (let i = 0; i < job.length; i += 16) {
    const teil = [...job.slice(i, i + 16)]
    const hex = teil.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
    const txt = teil.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
    zeilen.push(i.toString(16).padStart(6, '0') + '  ' + hex.padEnd(47) + '  ' + txt)
  }
  return zeilen.join('\n')
}

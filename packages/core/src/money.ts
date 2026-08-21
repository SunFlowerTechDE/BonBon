/**
 * Geldbetraege (CLAUDE.md, Regel 3).
 *
 * Ein Geldbetrag ist eine Ganzzahl in Cent — niemals Fliesskomma, niemals Euro.
 * `Cents` ist ein Branded Type: ein `number` laesst sich nicht ohne den
 * Konstruktor `cents()` an eine `Cents`-Stelle uebergeben. Das faengt den
 * teuersten Fluechtigkeitsfehler dieses Projekts ab — `3.80` dort einzusetzen,
 * wo `380` erwartet wird.
 *
 * Die Umrechnung nach Euro passiert ausschliesslich in der Darstellungsschicht.
 */

export type Cents = number & { readonly __brand: unique symbol }

/**
 * Erzeugt einen Geldbetrag. Wirft, wenn `value` keine sichere Ganzzahl ist —
 * insbesondere bei Euro-Betraegen wie `3.80`, bei `NaN` und bei Werten
 * jenseits von `Number.MAX_SAFE_INTEGER`.
 *
 * Negative Betraege sind erlaubt: Stornos und Rabatte brauchen sie.
 */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `Geldbetrag muss eine sichere Ganzzahl in Cent sein, erhalten: ${String(value)}. ` +
        'Euro gehoert in die Darstellungsschicht (CLAUDE.md, Regel 3).',
    )
  }
  return value as Cents
}

export const ZERO_CENTS: Cents = cents(0)

/** Summe zweier Betraege. Wirft bei Ueberlauf ueber den sicheren Ganzzahlbereich. */
export function addCents(a: Cents, b: Cents): Cents {
  return cents(a + b)
}

/** Differenz zweier Betraege. Das Ergebnis darf negativ sein. */
export function subtractCents(a: Cents, b: Cents): Cents {
  return cents(a - b)
}

/** Summe beliebig vieler Betraege, z. B. der Positionen eines Bons. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0
  for (const value of values) {
    total += value
  }
  return cents(total)
}

/**
 * Einzelpreis mal Menge. `quantity` muss eine nicht-negative Ganzzahl sein —
 * gebrochene Mengen (0,25 kg Eis) brauchen eine benannte Rundungsregel und
 * kommen deshalb nicht hier, sondern mit der Rundungslogik in M1.
 */
export function multiplyCents(amount: Cents, quantity: number): Cents {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(
      `Menge muss eine nicht-negative Ganzzahl sein, erhalten: ${String(quantity)}.`,
    )
  }
  return cents(amount * quantity)
}

// Bewusst nicht vorhanden: eine Division.
//
// Jede Division von Geld erzeugt einen Rest, und wohin der Rest geht, ist eine
// fachliche Entscheidung (kaufmaennisch runden, Restcent auf die groesste
// Position, Restcent auf die erste Position). Eine Division ohne explizit
// benannte Rundungsregel waere genau die stille Ungenauigkeit, die in der
// Betriebspruefung auffaellt. Die Rundungsregeln kommen in M1 als eigene,
// benannte Funktionen.

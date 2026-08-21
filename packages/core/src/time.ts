/**
 * Zeit im Domaenenkern (CLAUDE.md, Regel 11).
 *
 * Der Kern hat keine eigene Zeitquelle. Er liest nie die Uhr, sondern bekommt
 * Zeitstempel hereingereicht — als Parameter oder ueber eine injizierte `Clock`.
 * Nur so ist die Bonberechnung deterministisch testbar, und genau diese Tests
 * schuetzen vor Rundungs- und Steuerfehlern.
 *
 * Zeitstempel tragen immer einen Zeitzonen-Offset. Ein Zeitstempel ohne Offset
 * ist im Kern ungueltig: der Steuersatz haengt vom Datum ab, und eine
 * Sommerzeitgrenze oder ein Serverstandort duerfen daran nichts aendern.
 *
 * `IsoTimestamp` ist bewusst etwas weiter als `Date`: er laesst die Schaltsekunde
 * zu. Wer ihn nach `Date` umwandelt, muss diesen Fall behandeln — siehe die
 * Anmerkung in `isoTimestamp()`.
 */

export type IsoTimestamp = string & { readonly __brand: unique symbol }

/**
 * ISO 8601, Datum und Zeit, mit Zonenangabe: `Z` oder `+HH:MM` / `-HH:MM`.
 * Eine reine Ortszeit wie `2026-08-21T10:00:00` faellt bewusst durch.
 */
const ISO_8601_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return lengths[month - 1] ?? 0
}

/**
 * Prueft und markiert einen Zeitstempel als `IsoTimestamp`.
 *
 * Die Kalenderpruefung ist absichtlich handgeschrieben: `Date.parse` akzeptiert
 * `2026-02-30` klaglos und rollt auf den 2. Maerz weiter. Ein Bon mit einem
 * Datum, das es nicht gibt, soll laut auffallen und nicht still verschoben werden.
 */
export function isoTimestamp(value: string): IsoTimestamp {
  const match = ISO_8601_WITH_OFFSET.exec(value)
  if (match === null) {
    throw new RangeError(
      `Zeitstempel muss ISO 8601 mit Zonenangabe sein (z. B. 2026-08-21T10:15:00+02:00), ` +
        `erhalten: ${JSON.stringify(value)} (CLAUDE.md, Regel 11).`,
    )
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    match

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  // 60 ist zugelassen: ISO 8601 kennt die Schaltsekunde, und einen gueltigen
  // Zeitstempel der TSE abzuweisen waere der schlechtere Fehler.
  //
  // ACHTUNG, Falle: `Date` kennt die Schaltsekunde nicht.
  // `Date.parse('2016-12-31T23:59:60Z')` liefert in V8 NaN, also ein Invalid Date.
  // Jede Umwandlung von IsoTimestamp nach Date ausserhalb des Kerns muss den Fall
  // deshalb ausdruecklich behandeln — entweder ablehnen oder :60 auf :59.999
  // normalisieren. Sie darf ihn nicht stillschweigend durchreichen, sonst steht
  // ein Invalid Date im Event Log. Siehe CLAUDE.md, Regel 11.
  const second = Number(secondText)

  const calendarValid =
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  const clockValid = hour <= 23 && minute <= 59 && second <= 60
  const offsetValid =
    offsetHourText === undefined ||
    (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59)

  if (!calendarValid || !clockValid || !offsetValid) {
    throw new RangeError(
      `Zeitstempel bezeichnet keinen existierenden Zeitpunkt: ${JSON.stringify(value)} ` +
        '(CLAUDE.md, Regel 11).',
    )
  }

  return value as IsoTimestamp
}

/**
 * Injizierte Zeitquelle. Der Kern deklariert sie, implementiert sie aber nicht —
 * die echte Uhr lebt im Client bzw. im Backend, im Test eine feste Uhr.
 */
export interface Clock {
  now(): IsoTimestamp
}

/**
 * Injizierte ID-Quelle. Erzeugt die ULIDs des Event Logs. Auch hier gilt:
 * der Kern deklariert, die Aussenwelt implementiert.
 */
export interface IdGenerator {
  next(): string
}

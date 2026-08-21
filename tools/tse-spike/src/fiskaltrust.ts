/**
 * Konstanten und Client fuer die fiskaltrust Middleware (Markt DE).
 *
 * Alle Werte hier stammen aus der Dokumentation auf docs.fiskaltrust.cloud,
 * die Fundstelle steht jeweils daneben. Nichts davon ist geraten.
 */

import { parse, readUint64, stringify, toHex, uint64 } from './json64.js'

// --- Kennzahlen ------------------------------------------------------------
// 0x4445 ist ASCII "DE" und leitet alle marktspezifischen Werte ein.

/**
 * ftReceiptCase, Markt DE.
 * docs: /poscreators/middleware-doc/germany/reference-tables/ftreceiptcase
 */
export const RECEIPT_CASE = {
  /** Pos-receipt — der normale Kassenbeleg, DSFinV-K "Kassenbeleg-V1". */
  posReceipt: 0x4445000000000001n,
  /** Start-transaction-receipt — beginnt einen Vorgang im expliziten Ablauf. */
  startTransaction: 0x4445000000000008n,
  /** Update-transaction-receipt — schreibt Positionen in einen laufenden Vorgang. */
  updateTransaction: 0x4445000000000009n,
} as const

/**
 * ftReceiptCaseFlags.
 * docs: /poscreators/middleware-doc/germany/reference-tables/ftreceiptcase
 */
export const RECEIPT_CASE_FLAG = {
  /**
   * Implicit Transaction: "No Start-Transaction call to the Sign method is
   * required, it is done implicitly." Die Middleware fuehrt StartTransaction
   * und FinishTransaction der TSE dann selbst in einem einzigen Sign-Aufruf aus.
   */
  implicitTransaction: 0x0000000100000000n,
} as const

/**
 * ftChargeItemCase, Markt DE.
 * docs: /poscreators/middleware-doc/germany/reference-tables/ftchargeitemcase
 */
export const CHARGE_ITEM_CASE = {
  /** Regelsteuersatz, seit 1.1.2019 19,00 %. UST_SCHLUESSEL 1. */
  vatNormal19: 0x4445000000000001n,
  /** Ermaessigter Steuersatz, seit 1.1.2019 7,00 %. UST_SCHLUESSEL 2. */
  vatReduced7: 0x4445000000000002n,
} as const

/**
 * ftPayItemCase, Markt DE.
 * docs: /poscreators/middleware-doc/germany/reference-tables/ftpayitemcase
 */
export const PAY_ITEM_CASE = {
  /** Cash payment in national currency — Barzahlung in Euro, DSFinV-K "Bar". */
  cashNationalCurrency: 0x4445000000000001n,
} as const

/**
 * ftSignatureType, Markt DE — die Felder, die auf den Beleg gehoeren.
 * docs: /poscreators/middleware-doc/germany/reference-tables/ftsignaturetype
 */
export const SIGNATURE_TYPE = {
  /** Signature according to KassenSichV (QR-code content) — der Pruefwert. */
  qrCodeContent: 0x4445000000000001n,
  /** Start-transaction-result. */
  startTransactionResult: 0x4445000000000010n,
  /** Receipt / transaction number. */
  transactionNumber: 0x4445000000000017n,
  /** Receipt / signature counter. */
  signatureCounter: 0x4445000000000018n,
  /** Receipt / start time (start-transaction). */
  startTime: 0x4445000000000019n,
  /** Receipt / logtime. */
  logTime: 0x444500000000001an,
  /** Receipt / signature. */
  signature: 0x444500000000001dn,
  /** TSE Serial Number. Seit AEAO/KassenSichV 1.1.2024 auf dem Beleg noetig. */
  tseSerialNumber: 0x4445000000000023n,
} as const

/**
 * ftState, untere 32 Bit.
 * docs: /poscreators/middleware-doc/general/reference-tables
 */
export const STATE = {
  /** Error: QueueItem angelegt, aber nicht bis zum ReceiptItem gekommen. */
  error: 0xeeeeeeeen,
  /** Fail: Verarbeitung gescheitert, nichts persistiert. */
  fail: 0xffffffffn,
} as const

// --- Typen -----------------------------------------------------------------

export interface SignatureItem {
  readonly ftSignatureType?: unknown
  readonly ftSignatureFormat?: unknown
  readonly Caption?: string
  readonly caption?: string
  readonly Data?: string
  readonly data?: string
}

export interface ReceiptResponse {
  readonly ftQueueID?: string
  readonly ftQueueItemID?: string
  readonly ftQueueRow?: unknown
  readonly ftCashBoxIdentification?: string
  readonly ftReceiptIdentification?: string
  readonly ftReceiptMoment?: string
  readonly ftSignatures?: readonly SignatureItem[]
  readonly ftState?: unknown
  readonly ftStateData?: unknown
}

export function signatureCaption(item: SignatureItem): string {
  return item.Caption ?? item.caption ?? ''
}

export function signatureData(item: SignatureItem): string {
  return item.Data ?? item.data ?? ''
}

// --- Fehler ----------------------------------------------------------------

/**
 * Traegt die vollstaendige Antwort mit. Nichts wird zusammengefasst — beim
 * ersten Rundlauf steckt die eigentliche Ursache meist woertlich in der
 * Antwort der Middleware.
 */
export class FiskaltrustHttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseHeaders: Record<string, string>,
    readonly body: string,
  ) {
    super(message)
    this.name = 'FiskaltrustHttpError'
  }
}

// --- Client ----------------------------------------------------------------

export interface ClientOptions {
  /**
   * Basis-URL der Queue aus dem fiskaltrust Portal
   * (Configuration -> Queue -> Detailbereich), rest:// durch http:// ersetzt.
   * Beispiel: http://localhost:1500/f84bf516-a17b-4432-afa6-8c1050e2854d
   * docs: /poscreators/get-started/middleware-integration
   */
  readonly baseUrl: string
  readonly cashBoxId: string
  readonly accessToken: string
  readonly timeoutMs: number
  readonly verbose: boolean
}

export interface PostResult {
  readonly url: string
  readonly text: string
  readonly parsed: unknown
}

export class FiskaltrustClient {
  constructor(private readonly options: ClientOptions) {}

  /**
   * Pfadaufbau woertlich aus der Dokumentation:
   * "http://[specified-url]/[xml|json]/[v0|v1]/[echo|sign|journal]"
   * docs: /poscreators/middleware-doc/general/communication
   */
  private url(version: 'v0' | 'v1', operation: string, query?: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '')
    const suffix = query === undefined ? '' : '?' + query
    return base + '/json/' + version + '/' + operation + suffix
  }

  async post(
    version: 'v0' | 'v1',
    operation: string,
    body: unknown,
    query?: string,
  ): Promise<PostResult> {
    const url = this.url(version, operation, query)
    const payload = body === undefined ? '' : stringify(body)

    if (this.options.verbose) {
      console.log('\n  -> POST ' + url)
      if (payload !== '') console.log(indent(payload, '     '))
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Laut Doku nur fuer die SaaS-Middleware noetig, lokal ignoriert.
        // Mitgeschickt, damit derselbe Spike auch gegen die SignatureCloud liefe.
        cashboxid: this.options.cashBoxId,
        accesstoken: this.options.accessToken,
      },
      body: payload,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    })

    const text = await response.text()

    if (this.options.verbose) {
      console.log('  <- ' + String(response.status) + ' ' + response.statusText)
      if (text !== '') console.log(indent(text.slice(0, 4000), '     '))
    }

    if (!response.ok) {
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      throw new FiskaltrustHttpError(
        String(response.status) + ' ' + response.statusText + ' von ' + url,
        url,
        response.status,
        response.statusText,
        responseHeaders,
        text,
      )
    }

    let parsed: unknown = undefined
    if (text.trim() !== '') {
      try {
        parsed = parse(text)
      } catch (cause) {
        throw new Error('Antwort von ' + url + ' ist kein gueltiges JSON. Roher Text:\n' + text, {
          cause,
        })
      }
    }

    return { url, text, parsed }
  }

  /** Echo: "the transferred message is sent back directly". */
  async echo(message: string): Promise<PostResult> {
    return this.post('v1', 'Echo', { message })
  }

  /**
   * Journal mit ftJournalType 0 = "Version Information".
   * docs: /poscreators/middleware-doc/general/reference-tables
   *
   * Die Dokumentation ist hier uneindeutig: die v1-Spezifikation beschreibt die
   * Parameter als Query-Parameter (ftJournalType/from/to), der Changelog zu
   * 1.3.71 nennt die Kurzform ?type=0. Beide werden probiert und das Ergebnis
   * jeder Variante ausgegeben — geraten wird nichts, es wird gezeigt, was die
   * Middleware tatsaechlich beantwortet.
   */
  async versionInformation(): Promise<
    { ok: true; variant: string; text: string } | { ok: false; failures: string[] }
  > {
    const variants: readonly (readonly [string, string])[] = [
      ['v1-Spezifikation', 'ftJournalType=0&from=0&to=0'],
      ['Kurzform aus Changelog 1.3.71', 'type=0'],
    ]
    const failures: string[] = []
    for (const [label, query] of variants) {
      try {
        const { text } = await this.post('v0', 'Journal', undefined, query)
        return { ok: true, variant: label + '  [?' + query + ']', text }
      } catch (error) {
        failures.push(label + '  [?' + query + ']\n' + indent(describeError(error), '  '))
      }
    }
    return { ok: false, failures }
  }

  async sign(request: unknown): Promise<{ response: ReceiptResponse; text: string }> {
    const { parsed, text } = await this.post('v1', 'Sign', request)
    return { response: parsed as ReceiptResponse, text }
  }
}

// --- Auswertung ------------------------------------------------------------

export function stateOf(response: ReceiptResponse): bigint | undefined {
  return readUint64(response.ftState)
}

export function describeState(state: bigint | undefined): string {
  if (state === undefined) return 'ftState fehlt in der Antwort'
  const low = state & 0xffffffffn
  const suffix = ' (' + toHex(state) + ')'
  if (low === STATE.fail) return 'FAIL — Verarbeitung gescheitert, nichts persistiert' + suffix
  if (low === STATE.error) return 'ERROR — QueueItem angelegt, aber nicht abgeschlossen' + suffix
  return 'ok' + suffix
}

export function isFailureState(state: bigint | undefined): boolean {
  if (state === undefined) return false
  const low = state & 0xffffffffn
  return low === STATE.fail || low === STATE.error
}

export function findSignature(response: ReceiptResponse, type: bigint): SignatureItem | undefined {
  return response.ftSignatures?.find((item) => readUint64(item.ftSignatureType) === type)
}

/**
 * Gibt einen Fehler vollstaendig aus: Statuszeile, Header, ungekuerzter
 * Antwortkoerper und die gesamte cause-Kette. Bewusst nichts zusammengefasst.
 */
export function describeError(error: unknown): string {
  const lines: string[] = []
  let current: unknown = error
  let depth = 0
  while (current !== undefined && current !== null && depth < 6) {
    const prefix = depth === 0 ? '' : 'verursacht durch: '
    if (current instanceof FiskaltrustHttpError) {
      lines.push(prefix + current.name + ': ' + current.message)
      lines.push('  URL:    ' + current.url)
      lines.push('  Status: ' + String(current.status) + ' ' + current.statusText)
      for (const [key, value] of Object.entries(current.responseHeaders)) {
        lines.push('  Header: ' + key + ': ' + value)
      }
      lines.push('  Antwortkoerper (ungekuerzt):')
      lines.push(indent(current.body === '' ? '(leer)' : current.body, '    '))
    } else if (current instanceof Error) {
      lines.push(prefix + current.name + ': ' + current.message)
      const code = (current as { code?: unknown }).code
      if (typeof code === 'string') lines.push('  code: ' + code)
      if (depth === 0 && current.stack !== undefined) lines.push(indent(current.stack, '  '))
    } else {
      lines.push(prefix + safeStringify(current))
    }
    current = current instanceof Error ? current.cause : undefined
    depth += 1
  }
  return lines.join('\n')
}

/** Gibt auch Nicht-Error-Werte lesbar aus, statt [object Object] zu zeigen. */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n')
}

export { toHex, uint64 }

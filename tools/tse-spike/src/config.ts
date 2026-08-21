/**
 * Konfiguration des Spikes.
 *
 * Zugangsdaten stehen ausschliesslich in .env und niemals im Code
 * (CLAUDE.md, Umgebung und Geheimnisse). Gelesen wird mit der eingebauten
 * Node-Funktion process.loadEnvFile — dafuer braucht es keine Abhaengigkeit.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SpikeConfig {
  readonly baseUrl: string
  readonly cashBoxId: string
  readonly accessToken: string
  readonly timeoutMs: number
  readonly verbose: boolean
  readonly implicit: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Zeigt einen Wert an, ohne ihn preiszugeben. */
export function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return value.slice(0, 4) + '…' + value.slice(-4) + '  (' + String(value.length) + ' Zeichen)'
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      name +
        ' fehlt oder ist leer.\n' +
        'Trage den Wert in die Datei .env im Projektwurzelverzeichnis ein.\n' +
        'Vorlage: .env.example',
    )
  }
  return value.trim()
}

export function loadConfig(argv: readonly string[], projectRoot: string): SpikeConfig {
  const envPath = resolve(projectRoot, '.env')
  if (!existsSync(envPath)) {
    throw new ConfigError(
      'Keine .env gefunden unter ' +
        envPath +
        '\n' +
        'Lege sie an mit:  cp .env.example .env\n' +
        'und trage die Werte aus dem fiskaltrust Portal ein.',
    )
  }
  process.loadEnvFile(envPath)

  const rawUrl = required('FISKALTRUST_URL')
  // Das Portal zeigt die Queue-URL im Schema rest://. Fuer HTTP wird daraus
  // http:// — docs: /poscreators/get-started/middleware-integration
  const baseUrl = rawUrl.replace(/^rest:\/\//i, 'http://')

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError(
      'FISKALTRUST_URL muss mit rest:// oder http:// beginnen, ist aber: ' +
        rawUrl +
        '\n' +
        'Der Wert steht im fiskaltrust Portal unter Configuration -> Queue,\n' +
        'im aufgeklappten Detailbereich des Queue-Eintrags.\n' +
        'Beispiel: rest://localhost:1500/f84bf516-a17b-4432-afa6-8c1050e2854d',
    )
  }

  const timeoutRaw = process.env['FISKALTRUST_TIMEOUT_MS']
  const timeoutMs = timeoutRaw === undefined ? 30_000 : Number.parseInt(timeoutRaw, 10)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError('FISKALTRUST_TIMEOUT_MS muss eine positive Ganzzahl sein: ' + String(timeoutRaw))
  }

  return {
    baseUrl,
    cashBoxId: required('FISKALTRUST_CASHBOX_ID'),
    accessToken: required('FISKALTRUST_ACCESS_TOKEN'),
    timeoutMs,
    verbose: argv.includes('--verbose') || argv.includes('-v'),
    implicit: argv.includes('--implicit'),
  }
}

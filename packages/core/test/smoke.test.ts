import { describe, expect, it } from 'vitest'

import { CORE_PACKAGE_NAME, CORE_VERSION } from '../src/index.js'

describe('@bonbon/core smoke', () => {
  it('laesst sich importieren und exportiert seine Kennung', () => {
    expect(CORE_PACKAGE_NAME).toBe('@bonbon/core')
    expect(CORE_VERSION).toBe('0.0.0')
  })

  it('laeuft in einer Umgebung ohne DOM', () => {
    // Der Kern darf sich nie auf Browser-Globals verlassen. Wenn dieser Test
    // in einer DOM-Umgebung ausgefuehrt wird, ist die Vitest-Konfiguration
    // fuer core falsch eingestellt.
    expect(typeof (globalThis as Record<string, unknown>)['window']).toBe('undefined')
  })
})

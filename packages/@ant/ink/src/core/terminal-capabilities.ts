/**
 * Terminal capability probe state machine.
 *
 * Mirrors the official ink fork's readings model (chunk-6epjwwt0,
 * _ALL.js @13099953): a fixed set of probeable capabilities, each with a
 * default value and a settled/pending reading, probed via DECRQM / CSI ? u
 * behind the shared DA1 sentinel in TerminalQuerier.
 *
 * Official defaults: `{extendedKeys:!1, synchronizedOutput:!1,
 * kittyKeyboard:!0, kittyGraphics:!1, mousePixels:!1}`.
 *
 * Probe sources:
 * - synchronizedOutput → DECRQM 2026 (verified in official terminal.ts)
 * - mousePixels        → DECRQM 1016 (official MOUSE_SGR_PIXELS)
 * - kittyKeyboard      → CSI ? u flags query (existing querier builder)
 * - extendedKeys       → DECRQM 2027 (Kitty modifier-events convention —
 *   inferred, official probe sequence not yet located in the dump)
 * - kittyGraphics      → no probe (official default is off; the probe
 *   sequence was not located — keeping it unprobed and false)
 */

import { TerminalQuerier, decrqm, kittyKeyboard } from './terminal-querier.js'

export type CapabilityName =
  | 'extendedKeys'
  | 'synchronizedOutput'
  | 'kittyKeyboard'
  | 'kittyGraphics'
  | 'mousePixels'

/** A probe result: settled holds the resolved value; pending holds a
 *  likelihood until the probe round-trip completes. */
type Reading =
  | { state: 'settled'; value: boolean; source: 'probe' | 'default' }
  | { state: 'pending'; likely: boolean; source: 'probe' }

/** DECRPM status byte semantics (CSI ? mode ; status $ y). */
export function decrpmStatusSupported(status: number): boolean {
  // 0=not recognized, 1=set, 2=reset, 3=permanently set, 4=permanently reset
  return status >= 1 && status <= 4
}

const DEFAULTS: Record<CapabilityName, boolean> = {
  extendedKeys: false,
  synchronizedOutput: false,
  kittyKeyboard: true,
  kittyGraphics: false,
  mousePixels: false,
}

const PROBE_MODE: Partial<Record<CapabilityName, number>> = {
  synchronizedOutput: 2026,
  mousePixels: 1016,
  extendedKeys: 2027,
}

export class TerminalCapabilities {
  private readings = new Map<CapabilityName, Reading>()
  private probing = false

  constructor(private querier: TerminalQuerier) {
    for (const name of Object.keys(DEFAULTS) as CapabilityName[]) {
      this.readings.set(name, {
        state: 'settled',
        value: DEFAULTS[name],
        source: 'default',
      })
    }
  }

  /** Current value, falling back to the default while a probe is in flight. */
  get(name: CapabilityName): boolean {
    const r = this.readings.get(name)
    if (!r) return DEFAULTS[name]
    if (r.state === 'settled') return r.value
    return r.likely
  }

  /** Settled value with its source, for callers that must distinguish
   *  probed facts from defaults. */
  now(name: CapabilityName): { value: boolean; probed: boolean } {
    const r = this.readings.get(name)
    if (r && r.state === 'settled')
      return { value: r.value, probed: r.source === 'probe' }
    return { value: this.get(name), probed: false }
  }

  /** Fire one probe batch (idempotent while in flight). Probes that have a
   *  known DECRQM mode go through decrqm; kittyKeyboard via CSI ? u;
   *  kittyGraphics is not probed (official default off). */
  async probe(): Promise<void> {
    if (this.probing) return
    this.probing = true
    try {
      const jobs: Array<Promise<void>> = []
      for (const [name, mode] of Object.entries(PROBE_MODE) as Array<
        [CapabilityName, number]
      >) {
        jobs.push(this.probeDecrqm(name, mode))
      }
      jobs.push(this.probeKittyKeyboard())
      await Promise.all(jobs)
    } finally {
      this.probing = false
    }
  }

  private markPending(name: CapabilityName, likely: boolean): void {
    this.readings.set(name, { state: 'pending', likely, source: 'probe' })
  }

  private settle(name: CapabilityName, value: boolean): void {
    this.readings.set(name, { state: 'settled', value, source: 'probe' })
  }

  private async probeDecrqm(name: CapabilityName, mode: number): Promise<void> {
    this.markPending(name, DEFAULTS[name])
    const r = await this.querier.send(decrqm(mode))
    if (r === undefined) {
      this.settle(name, false)
      return
    }
    this.settle(name, decrpmStatusSupported(r.status))
  }

  private async probeKittyKeyboard(): Promise<void> {
    this.markPending('kittyKeyboard', DEFAULTS.kittyKeyboard)
    const r = await this.querier.send(kittyKeyboard())
    this.settle('kittyKeyboard', r !== undefined)
  }
}

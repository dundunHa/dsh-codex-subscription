import { SPEED_MODE_FAST, SPEED_MODE_STANDARD, SPEED_MODE_ULTRAFAST } from './settings-contract.js'

/**
 * Process-wide key other plugins (for example a subagent router) use to pin a
 * speed mode on one session. A registered symbol keeps the lookup independent
 * of plugin load order and module identity: when this plugin is absent, the
 * slot is simply missing and callers degrade to the global setting.
 */
export const SESSION_SPEED_KEY = Symbol.for('dsh-codex-subscription.session-speed')

const MODES = new Set([SPEED_MODE_STANDARD, SPEED_MODE_FAST, SPEED_MODE_ULTRAFAST])

/**
 * Per-session speed overrides. A session without an override follows the
 * global speed setting; a value outside the known modes is ignored.
 * @returns {{ set(sessionId: string, mode: string | undefined): boolean, get(sessionId: unknown): string | undefined, clear(sessionId: unknown): void, size(): number }}
 */
export function createSessionSpeedRegistry() {
  const modes = new Map()
  return Object.freeze({
    set(sessionId, mode) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      if (mode === undefined) {
        modes.delete(sessionId)
        return true
      }
      if (!MODES.has(mode)) return false
      modes.set(sessionId, mode)
      return true
    },
    get(sessionId) {
      return sessionId === undefined || sessionId === null ? undefined : modes.get(String(sessionId))
    },
    clear(sessionId) {
      if (sessionId !== undefined && sessionId !== null) modes.delete(String(sessionId))
    },
    size: () => modes.size,
  })
}

/**
 * Publish a registry on the process-wide slot for the lifetime of one plugin
 * instance. The returned function removes it only if it is still the one
 * installed, so a reload that already replaced it is left alone.
 * @param {ReturnType<typeof createSessionSpeedRegistry>} registry
 * @param {object} [target=globalThis]
 * @returns {() => void}
 */
export function installSessionSpeedRegistry(registry, target = globalThis) {
  target[SESSION_SPEED_KEY] = registry
  return () => {
    if (target[SESSION_SPEED_KEY] === registry) delete target[SESSION_SPEED_KEY]
  }
}

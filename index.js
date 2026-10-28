// Host half of the OpenCode GO usage plugin.
//
// It resolves the user's OpenCode GO API key, reads the account-level usage
// endpoint (5-hour rolling / weekly / monthly quota windows), enriches it with
// the console's plan status when that endpoint answers, and serves one
// same-origin JSON snapshot to the Client half, which draws the bar below the
// chat composer.
//
// Why a plain HTTP route instead of a generated Remote: the plugin must stay a
// dependency-free plain-JS bundle, and a same-origin route needs no codegen,
// no Typert codec negotiation and no Client build step. The route is fenced to
// same-origin browser requests, so a cross-site page cannot read the numbers.
//
// Data sources (undocumented but in use by other OpenCode clients):
//   GET https://opencode.ai/zen/go/v1/usage        -> per-window percent + reset time (ground truth)
//   GET https://opencode.ai/console/api/go/status  -> plan, billing period, exact micro-cent limits
// Both authenticate with `Authorization: Bearer <personal API key>`. The
// console route is internal: it is enrichment only and a failure there never
// hides the percentage data.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const PLUGIN_ID = 'opencode-go-usage'
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
const DEFAULT_STATUS_URL = 'https://opencode.ai/console/api/go/status'
const DEFAULT_CREDENTIAL = 'OPENCODE_GO_API_KEY'
const DEFAULT_REFRESH_MS = 60_000
const ERROR_RETRY_MS = 15_000
const DEFAULT_TIMEOUT_MS = 15_000
// Documented window ratios of the monthly allowance (Go usage-limits table):
// the 5-hour window is 20% and the weekly window is 50% of the monthly one.
const WINDOW_RATIO = { rolling: 0.2, weekly: 0.5, monthly: 1 }
const WINDOW_NAMES = ['rolling', 'weekly', 'monthly']
// The console API reports money in micro-cents: 1 USD = 100,000,000.
const MICRO_CENTS_PER_USD = 1e8
const ROUTE_PATH = `/${PLUGIN_ID}/api/state`

/** Normalize the row config once, so every later read is total. */
function resolveConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const number = (value, fallback) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const text = (value, fallback) => {
    const parsed = typeof value === 'string' ? value.trim() : ''
    return parsed.length > 0 ? parsed : fallback
  }
  const monthlyLimitUsd = number(source.monthlyLimitUsd, 60)
  const limits = {}
  for (const window of WINDOW_NAMES) {
    const explicit = source.limits !== null && typeof source.limits === 'object'
      ? number(source.limits[window], Number.NaN)
      : Number.NaN
    limits[window] = Number.isFinite(explicit) ? explicit : monthlyLimitUsd * WINDOW_RATIO[window]
  }
  const providers = Array.isArray(source.providers) && source.providers.length > 0
    ? source.providers.map((value) => String(value)).filter((value) => value.length > 0)
    : ['opencode-go', 'opencode']
  return {
    credential: text(source.credential, DEFAULT_CREDENTIAL),
    baseUrl: text(source.baseUrl, DEFAULT_BASE_URL),
    statusUrl: text(source.statusUrl, DEFAULT_STATUS_URL),
    enrich: source.enrich !== false,
    refreshMs: Math.max(15_000, number(source.refreshMs, DEFAULT_REFRESH_MS)),
    timeoutMs: Math.max(1_000, number(source.timeoutMs, DEFAULT_TIMEOUT_MS)),
    limits,
    planLabel: text(source.planLabel, 'Go'),
    providers,
    debug: source.debug === true,
  }
}

/** Pick the first present named object out of a container. */
function firstOf(container, names) {
  if (container === null || typeof container !== 'object') return undefined
  for (const name of names) {
    const value = container[name]
    if (value !== null && typeof value === 'object') return value
  }
  return undefined
}

function round(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Coerce one usage-API window into the shape the Client renders, or null. */
export function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const percent = typeof raw.percent === 'number' ? raw.percent : Number(raw.percent)
  let resetsAt = null
  if (typeof raw.resetsAt === 'string' && raw.resetsAt.length > 0) {
    resetsAt = raw.resetsAt
  } else if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt)) {
    resetsAt = new Date(raw.resetsAt < 1e12 ? raw.resetsAt * 1000 : raw.resetsAt).toISOString()
  } else if (typeof raw.resetAt === 'string' && raw.resetAt.length > 0) {
    resetsAt = raw.resetAt
  }
  return {
    status: typeof raw.status === 'string' ? raw.status : null,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    resetsAt,
  }
}

/**
 * Turn one usage payload into the three normalized windows.
 * Defensive about the container name: the live response wraps the windows in
 * `usage`, but an unwrapped body is accepted too.
 */
export function normalizeUsage(body) {
  const container = body !== null && typeof body === 'object' && body.usage !== null && typeof body.usage === 'object'
    ? body.usage
    : body
  const windows = {
    rolling: normalizeWindow(firstOf(container, ['rolling', 'fiveHour', 'five_hour', '5h'])),
    weekly: normalizeWindow(firstOf(container, ['weekly', 'week', '7d'])),
    monthly: normalizeWindow(firstOf(container, ['monthly', 'month', '30d'])),
  }
  return { windows }
}

function microCentsToUsd(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed / MICRO_CENTS_PER_USD : null
}

/** One console meter -> { limitUsd, usedUsd, resetsAt } or null. */
function normalizeMeter(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const limitUsd = microCentsToUsd(raw.limitMicroCents)
  const usedUsd = microCentsToUsd(raw.usedMicroCents)
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt.length > 0 ? raw.resetsAt : null
  if (limitUsd === null && usedUsd === null && resetsAt === null) return null
  return { limitUsd, usedUsd, resetsAt }
}

/**
 * Read the plan status payload: exact dollar allowances, plan id, billing
 * period and renewal state. Returns null when the shape is not recognizable.
 */
export function normalizeStatus(body) {
  if (body === null || typeof body !== 'object') return null
  const access = body.access !== null && typeof body.access === 'object' ? body.access : {}
  const metersRaw = access.meters !== null && typeof access.meters === 'object' ? access.meters : null
  const meters = metersRaw === null
    ? null
    : {
      rolling: normalizeMeter(firstOf(metersRaw, ['fiveHour', 'five_hour', 'rolling', '5h'])),
      weekly: normalizeMeter(firstOf(metersRaw, ['week', 'weekly', '7d'])),
      monthly: normalizeMeter(firstOf(metersRaw, ['month', 'monthly', '30d'])),
    }
  const product = typeof body.product === 'string' && body.product.length > 0 ? body.product : null
  return {
    product,
    label: planLabelOf(product),
    periodEndsAt: typeof access.endsAt === 'string' ? access.endsAt : null,
    periodStartsAt: typeof access.startsAt === 'string' ? access.startsAt : null,
    cancelAtPeriodEnd: body.cancelAtPeriodEnd === true || access.cancelAtPeriodEnd === true,
    renewalPending: body.renewalPending === true,
    renewalStopReason: typeof body.renewalStopReason === 'string' ? body.renewalStopReason : null,
    meters,
  }
}

function planLabelOf(product) {
  if (typeof product !== 'string' || product.length === 0) return null
  const known = { go: 'Go', 'go-plus': 'Go Plus' }
  if (known[product] !== undefined) return known[product]
  return product
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Combine the percentage windows with the console meters.
 * Percent and reset time come from the usage endpoint (ground truth); the
 * dollar allowance and spend come from the console meters when available and
 * fall back to the configured plan ratios otherwise.
 */
export function mergeWindows(windows, meters, limits) {
  const merged = {}
  for (const name of WINDOW_NAMES) {
    const base = windows !== null && windows !== undefined ? windows[name] : null
    const meter = meters !== null && meters !== undefined ? meters[name] : null
    if ((base === null || base === undefined) && (meter === null || meter === undefined)) {
      merged[name] = null
      continue
    }
    let limitUsd = meter !== null && meter !== undefined && meter.limitUsd !== null ? meter.limitUsd : null
    let usedUsd = meter !== null && meter !== undefined && meter.usedUsd !== null ? meter.usedUsd : null
    let percent = base !== null && base !== undefined && base.percent !== null ? base.percent : null
    if (percent === null && limitUsd !== null && usedUsd !== null && limitUsd > 0) {
      percent = Math.max(0, Math.min(100, Math.floor((usedUsd / limitUsd) * 100)))
    }
    if (limitUsd === null) limitUsd = limits[name] ?? null
    if (usedUsd === null && percent !== null && limitUsd !== null) usedUsd = (limitUsd * percent) / 100
    const remainingUsd = limitUsd !== null && usedUsd !== null ? limitUsd - usedUsd : null
    merged[name] = {
      status: base !== null && base !== undefined ? base.status : null,
      percent,
      resetsAt: base !== null && base !== undefined && base.resetsAt !== null
        ? base.resetsAt
        : (meter !== null && meter !== undefined ? meter.resetsAt : null),
      limitUsd: round(limitUsd, 4),
      usedUsd: round(usedUsd, 4),
      remainingUsd: remainingUsd === null ? null : round(Math.max(0, remainingUsd), 4),
      exact: meter !== null && meter !== undefined && meter.limitUsd !== null,
    }
  }
  return merged
}

/** One readable state object; `error` is `null` only when the usage read worked. */
function makeState({ windows = null, plan = null, error = null, keySource = null, sources = null, fetchedAt = Date.now(), raw = undefined }) {
  return {
    ok: error === null,
    plugin: PLUGIN_ID,
    fetchedAt,
    keySource,
    plan,
    windows,
    sources,
    error,
    ...(raw === undefined ? {} : { raw }),
  }
}

/** Resolve `<home>/...` candidate paths of OpenCode's own credential file. */
function authFileCandidates() {
  const home = homedir()
  const paths = [
    join(home, '.local', 'share', 'opencode', 'auth.json'),
    join(home, '.config', 'opencode', 'auth.json'),
  ]
  if (typeof process.env.XDG_DATA_HOME === 'string' && process.env.XDG_DATA_HOME.length > 0) {
    paths.unshift(join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  }
  return [...new Set(paths)]
}

/** Read one OpenCode auth.json `{ "opencode-go": { type: "api", key } }`. */
async function readAuthFileKey(providers) {
  for (const path of authFileCandidates()) {
    let raw
    try {
      raw = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    for (const name of [...providers, 'opencode-go', 'opencode']) {
      const entry = raw[name]
      if (entry !== null && typeof entry === 'object' && entry.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) {
        return { key: entry.key, source: 'auth.json' }
      }
    }
  }
  return { key: null, source: null }
}

/**
 * Resolve the API key, most authoritative first:
 *   1. the Harness credential store / process environment through the
 *      credentials service (provider-managed value wins over ambient env),
 *   2. OpenCode's own auth.json.
 */
async function resolveApiKey(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(config.credential)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return { key: resolved.value, source: 'credentials' }
      }
    } catch {
      /* fall through to the plain environment */
    }
  }
  const fromEnv = process.env[config.credential]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { key: fromEnv, source: 'env' }
  return readAuthFileKey(config.providers)
}

/** One GET against an authenticated OpenCode endpoint; never throws. */
async function requestJson(url, key, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      })
    } catch {
      continue
    }
    if (response.status === 401) return { error: 'unauthorized' }
    if (response.status === 403) return { error: 'no-subscription' }
    if (!response.ok) return { error: `http-${response.status}` }
    try {
      return { body: await response.json() }
    } catch {
      return { error: 'bad-json' }
    }
  }
  return { error: 'network' }
}

export function apply(ctx, rowConfig) {
  const config = resolveConfig(rowConfig)
  const logger = ctx.logger
  // Latest snapshot, served to the Client without re-hitting the upstream
  // endpoints on every browser poll.
  let cache = null
  let inflight = null
  let lastAttempt = 0
  let lastKeySource = null

  const refresh = ({ force = false } = {}) => {
    const now = Date.now()
    if (inflight !== null) return inflight
    if (!force && cache !== null && now - cache.at < config.refreshMs) {
      return Promise.resolve(cache.state)
    }
    if (!force && now - lastAttempt < ERROR_RETRY_MS && cache !== null) {
      return Promise.resolve(cache.state)
    }
    lastAttempt = now
    const task = (async () => {
      const { key, source } = await resolveApiKey(ctx, config)
      lastKeySource = source
      if (key === null) {
        return makeState({ error: 'no-key', keySource: null })
      }
      const usage = await requestJson(config.baseUrl, key, config.timeoutMs)
      const status = config.enrich
        ? await requestJson(config.statusUrl, key, config.timeoutMs).catch(() => ({ error: 'network' }))
        : { error: 'disabled' }
      const statusInfo = typeof status.body === 'object' && status.body !== null ? normalizeStatus(status.body) : null
      const sources = {
        usage: usage.error === undefined ? 'ok' : usage.error,
        status: statusInfo !== null ? 'ok' : (status.error ?? 'bad-shape'),
      }
      if (usage.error !== undefined) {
        return makeState({
          error: usage.error,
          keySource: source,
          sources,
          raw: config.debug && usage.body !== undefined ? usage.body : undefined,
        })
      }
      const usageData = normalizeUsage(usage.body)
      const hasWindow = WINDOW_NAMES.some((name) => usageData.windows[name] !== null)
      if (!hasWindow && statusInfo === null) {
        return makeState({ error: 'bad-shape', keySource: source, sources, raw: config.debug ? usage.body : undefined })
      }
      const windows = mergeWindows(usageData.windows, statusInfo !== null ? statusInfo.meters : null, config.limits)
      const plan = statusInfo !== null
        ? {
          id: statusInfo.product,
          label: statusInfo.label ?? config.planLabel,
          periodEndsAt: statusInfo.periodEndsAt,
          periodStartsAt: statusInfo.periodStartsAt,
          cancelAtPeriodEnd: statusInfo.cancelAtPeriodEnd,
          renewalPending: statusInfo.renewalPending,
          renewalStopReason: statusInfo.renewalStopReason,
        }
        : { id: null, label: config.planLabel, periodEndsAt: null, cancelAtPeriodEnd: false, renewalPending: false, renewalStopReason: null }
      return makeState({
        windows,
        plan,
        keySource: source,
        sources,
        raw: config.debug && usage.body !== undefined ? usage.body : undefined,
      })
    })()
      .catch(() => makeState({ error: 'network', keySource: lastKeySource }))
      .then((state) => {
        // Cache successful reads for the full window; errors are cached too so
        // a transient failure is retried soon without hammering the endpoint.
        cache = { at: Date.now(), state }
        return state
      })
      .finally(() => {
        inflight = null
      })
    inflight = task
    return task
  }

  ctx.effect(() => {
    // Warm the snapshot once so the first browser poll has an answer ready.
    refresh().catch(() => {})
    const timer = ctx.get('timer')
    if (timer !== undefined && typeof timer.interval === 'function') {
      return timer.interval(() => { refresh().catch(() => {}) }, config.refreshMs)
    }
    const handle = setInterval(() => { refresh().catch(() => {}) }, config.refreshMs)
    if (typeof handle.unref === 'function') handle.unref()
    return () => clearInterval(handle)
  }, `${PLUGIN_ID}:refresh-loop`)

  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    logger?.warn?.(
      '[%s] no webServer service in this profile; the usage route was not registered',
      PLUGIN_ID,
    )
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        writeJson(response, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      let force = false
      try {
        const url = new URL(request.url ?? ROUTE_PATH, 'http://dsh.internal')
        force = url.searchParams.get('refresh') === '1'
      } catch {
        force = false
      }
      try {
        const state = await refresh({ force })
        writeJson(response, 200, state)
      } catch (error) {
        logger?.warn?.('[%s] usage refresh failed: %s', PLUGIN_ID, error instanceof Error ? error.message : String(error))
        writeJson(response, 200, makeState({ error: 'network', keySource: lastKeySource }))
      }
    },
  }), `${PLUGIN_ID}:usage-route`)

  logger?.info?.('[%s] serving %s', PLUGIN_ID, ROUTE_PATH)
}

/** Same-origin fence: refuse cross-site browser requests and foreign origins. */
function isTrustedRequest(request) {
  const headers = request.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const originUrl = new URL(origin)
    const host = typeof headers.host === 'string' ? headers.host : ''
    return originUrl.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

export const name = PLUGIN_ID

export default { name, apply, normalizeUsage, normalizeWindow, normalizeStatus, mergeWindows }

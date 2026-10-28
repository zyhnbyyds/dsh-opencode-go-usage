// Client half of the OpenCode GO usage plugin.
//
// One lazy factory registered into the page's module table, exactly like the
// shipped decoration template: the Host half (index.js) serves the snapshot at
// /opencode-go-usage/api/state, this module polls that same-origin route and
// draws a compact indicator below the chat composer.
//
// Visual language follows the Harness composer bar's own token-usage control
// (the "Token 用量" popover): a small rounded pill in the dock row, and a card
// with an icon + title header, a single divider, then quiet label/value rows.
// Only --dsw-alias-* theme tokens are used for surfaces and text.

window.__ModuleLoader__.load({
  id: '@local/dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'opencode-go-usage'
    const ENDPOINT = '/opencode-go-usage/api/state'
    const POLL_MS = 60_000
    const WINDOWS = ['rolling', 'weekly', 'monthly']

    const EN = {
      region: 'OpenCode GO plan usage',
      plan: 'OpenCode GO',
      rolling: '5h',
      weekly: 'Wk',
      monthly: 'Mo',
      rollingLong: '5-hour',
      weeklyLong: 'Weekly',
      monthlyLong: 'Monthly',
      percentAria: '{label} window: {percent}% used',
      used: 'Used {percent}%',
      resetsIn: 'Resets in {time}',
      resetUnknown: 'Reset time unknown',
      updated: 'Updated {time}',
      refresh: 'Refresh usage',
      refreshing: 'Refreshing…',
      expand: 'Show usage details',
      collapse: 'Hide usage details',
      errorNoKey: 'OpenCode GO is not configured',
      errorUnauthorized: 'The OpenCode GO API key is invalid or revoked',
      errorNoSubscription: 'This account has no OpenCode GO subscription',
      errorNetwork: 'Could not reach opencode.ai',
      errorBadShape: 'Unexpected response from the usage endpoint',
      errorBadJson: 'Unreadable response from the usage endpoint',
      errorHttp: 'Usage endpoint returned HTTP {status}',
      offline: 'Showing the last snapshot',
      planLabel: 'Plan {plan}',
      periodEnd: 'Ends {date} · auto-renew off',
      renews: 'Renews {date}',
    }

    const ZH = {
      region: 'OpenCode GO 套餐用量',
      plan: 'OpenCode GO',
      rolling: '5h',
      weekly: '周',
      monthly: '月',
      rollingLong: '5 小时',
      weeklyLong: '每周',
      monthlyLong: '每月',
      percentAria: '{label}窗口已用 {percent}%',
      used: '已用 {percent}%',
      resetsIn: '{time}后重置',
      resetUnknown: '重置时间未知',
      updated: '更新于 {time}',
      refresh: '刷新用量',
      refreshing: '刷新中…',
      expand: '展开用量详情',
      collapse: '收起用量详情',
      errorNoKey: '未配置 OpenCode GO',
      errorUnauthorized: 'OpenCode GO API Key 无效或已被撤销',
      errorNoSubscription: '当前账号未订阅 OpenCode GO',
      errorNetwork: '无法连接 opencode.ai',
      errorBadShape: '用量接口返回了无法识别的数据',
      errorBadJson: '用量接口响应无法解析',
      errorHttp: '用量接口返回 HTTP {status}',
      offline: '显示的是上次读取的快照',
      planLabel: '套餐 {plan}',
      periodEnd: '{date} 到期 · 未自动续费',
      renews: '续费日 {date}',
    }

    const DICTS = { en: EN, 'zh-CN': ZH, zh: ZH }
    const LONG_LABELS = { rolling: 'rollingLong', weekly: 'weeklyLong', monthly: 'monthlyLong' }

    let localeService = null

    function activeLocale() {
      if (localeService !== null && typeof localeService.getLocale === 'function') {
        try {
          const snapshot = localeService.getLocale()
          if (snapshot !== null && typeof snapshot.active === 'string') return snapshot.active
        } catch {
          /* fall through */
        }
      }
      if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
      return 'en'
    }

    function isChinese(tag) {
      return String(tag).toLowerCase().indexOf('zh') === 0
    }

    function dictionaryFor(tag) {
      return isChinese(tag) ? ZH : EN
    }

    function interpolate(text, vars) {
      if (vars === undefined) return text
      let result = text
      for (const key of Object.keys(vars)) {
        result = result.split(`{${key}}`).join(String(vars[key]))
      }
      return result
    }

    /** Localized translate bound to the live locale; falls back to the bundled copy. */
    function useTranslate() {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (localeService === null || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setRevision((value) => value + 1))
      }, [])
      void revision
      const tag = activeLocale()
      const base = dictionaryFor(tag)
      let bound = null
      if (localeService !== null && typeof localeService.bind === 'function') {
        try {
          bound = localeService.bind(NS)
        } catch {
          bound = null
        }
      }
      return (key, vars) => {
        let text
        if (bound !== null) {
          try {
            const viaService = bound(key)
            text = typeof viaService === 'string' && viaService !== key ? viaService : base[key] ?? EN[key] ?? key
          } catch {
            text = base[key] ?? EN[key] ?? key
          }
        } else {
          text = base[key] ?? EN[key] ?? key
        }
        return interpolate(text, vars)
      }
    }

    function formatMoney(amount) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '0.00'
      if (amount >= 100) return amount.toFixed(0)
      return amount.toFixed(2)
    }

    function formatClock(epochMs, tag) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—'
      try {
        return new Date(epochMs).toLocaleTimeString(isChinese(tag) ? 'zh-CN' : 'en', {
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return new Date(epochMs).toLocaleTimeString()
      }
    }

    function formatDate(iso, tag) {
      const parsed = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
      if (!Number.isFinite(parsed)) return null
      const date = new Date(parsed)
      if (isChinese(tag)) return `${date.getMonth() + 1}月${date.getDate()}日`
      try {
        return date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
      } catch {
        return `${date.getMonth() + 1}/${date.getDate()}`
      }
    }

    /** Compact remaining duration: 2d 3h / 3h 12m / 12m 30s. */
    function formatRemaining(targetMs, tag, now) {
      const delta = targetMs - now
      if (!Number.isFinite(delta)) return null
      if (delta <= 0) return isChinese(tag) ? '即将重置' : 'any moment'
      const totalSeconds = Math.floor(delta / 1000)
      const days = Math.floor(totalSeconds / 86_400)
      const hours = Math.floor((totalSeconds % 86_400) / 3_600)
      const minutes = Math.floor((totalSeconds % 3_600) / 60)
      const seconds = totalSeconds % 60
      if (isChinese(tag)) {
        if (days > 0) return `${days}天${hours}小时`
        if (hours > 0) return `${hours}小时${minutes}分`
        if (minutes > 0) return `${minutes}分${seconds}秒`
        return `${seconds}秒`
      }
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      if (minutes > 0) return `${minutes}m ${seconds}s`
      return `${seconds}s`
    }

    function meterColor(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'var(--dsw-alias-label-secondary)'
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #d14343)'
      if (percent >= 80) return 'var(--dsw-alias-state-warn-primary, #d98800)'
      return 'var(--dsw-alias-state-success-primary, #2e9e5b)'
    }

    function resetTimeOf(window) {
      if (window === null || typeof window !== 'object') return null
      if (typeof window.resetsAt !== 'string' || window.resetsAt.length === 0) return null
      const parsed = Date.parse(window.resetsAt)
      return Number.isFinite(parsed) ? parsed : null
    }

    function errorMessage(error, t) {
      switch (error) {
        case 'no-key': return t('errorNoKey')
        case 'unauthorized': return t('errorUnauthorized')
        case 'no-subscription': return t('errorNoSubscription')
        case 'network': return t('errorNetwork')
        case 'bad-shape': return t('errorBadShape')
        case 'bad-json': return t('errorBadJson')
        default:
          if (typeof error === 'string' && error.indexOf('http-') === 0) {
            return t('errorHttp', { status: error.slice(5) })
          }
          return error === null || error === undefined ? '' : String(error)
      }
    }

    /** Small usage gauge icon shared by the pill and the card header. */
    function GaugeIcon(size) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { flex: '0 0 auto', display: 'block' },
      },
      h('path', {
        d: 'M2.7 11.6a6.6 6.6 0 1 1 10.6 0',
        stroke: 'currentColor',
        strokeWidth: '1.35',
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M8 11.4 10.7 7.6',
        stroke: 'currentColor',
        strokeWidth: '1.35',
        strokeLinecap: 'round',
      }))
    }

    /** Poll the Host snapshot; `reload(true)` forces an upstream refresh. */
    function useUsage() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [offline, setOffline] = React.useState(false)
      const alive = React.useRef(true)
      const lastFetch = React.useRef(0)

      const load = React.useCallback(async (force) => {
        if (force === true) setRefreshing(true)
        try {
          const response = await fetch(force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`http-${response.status}`)
          const data = await response.json()
          if (alive.current !== true) return
          lastFetch.current = Date.now()
          setOffline(false)
          setSnapshot(data)
          setError(data !== null && typeof data.error === 'string' ? data.error : null)
          setPhase(data !== null && data.error === 'no-key' ? 'hidden' : 'ready')
        } catch (fetchError) {
          if (alive.current !== true) return
          void fetchError
          setOffline(true)
          setError((previous) => previous ?? 'network')
          setPhase((previous) => (previous === 'hidden' ? 'hidden' : 'ready'))
        } finally {
          if (alive.current === true) setRefreshing(false)
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        load(false)
        const timer = setInterval(() => { load(false) }, POLL_MS)
        const onFocus = () => {
          if (Date.now() - lastFetch.current > POLL_MS) load(false)
        }
        window.addEventListener('focus', onFocus)
        return () => {
          alive.current = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [load])

      return { snapshot, phase, error, refreshing, offline, reload: load }
    }

    // ---- Styles (measured against the Harness token-usage control) ----

    const wrapStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
    }

    const pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '2px 8px',
      border: 'none',
      borderRadius: '7px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '11px',
      lineHeight: '14px',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      userSelect: 'none',
      transition: 'background-color 0.12s ease',
    }

    // The host's dock pills darken on hover; border-l1 is the closest theme
    // token to that hover fill in light and dark alike.
    const pillHoverStyle = {
      background: 'var(--dsw-alias-border-l1)',
    }

    // The popover is anchored with fixed positioning from the pill's measured
    // rect, so it always sits directly above the pill and is never clipped by
    // the dock row's own box.
    const cardBaseStyle = {
      zIndex: 60,
      width: '300px',
      maxWidth: 'min(300px, 86vw)',
      padding: '12px 16px 10px',
      borderRadius: '14px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'default',
    }

    const cardHeadStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      paddingBottom: '8px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    }

    const cardTitleStyle = {
      fontSize: '14px',
      fontWeight: 600,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
    }

    const cardHeadValueStyle = {
      marginLeft: 'auto',
      fontSize: '14px',
      fontWeight: 600,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
    }

    const iconButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '22px',
      height: '22px',
      marginRight: '-4px',
      padding: 0,
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: 1,
      cursor: 'pointer',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '3px 0',
      fontSize: '14px',
      lineHeight: '18px',
    }

    const rowLabelStyle = {
      color: 'var(--dsw-alias-label-secondary)',
    }

    const rowValueStyle = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '6px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }

    const rowPercentMetricStyle = {
      fontWeight: 500,
      // The host's stats popover renders record values slightly lighter than
      // its title; blend the two label tokens to land on the same tone.
      color: 'color-mix(in srgb, var(--dsw-alias-label-primary) 30%, var(--dsw-alias-label-secondary))',
    }

    // Neutral like the host's rows; color appears only once a window is close
    // to its limit (≥80% warn, ≥90% error).
    const attentionColor = (percent) => {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
      return percent >= 80 ? meterColor(percent) : undefined
    }

    const rowPercentStyle = (percent) => {
      const color = attentionColor(percent)
      return color === undefined ? rowPercentMetricStyle : { ...rowPercentMetricStyle, color, fontWeight: 600 }
    }

    const rowHintStyle = {
      fontSize: '11px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    // The host's popover draws exactly one divider (under the header); the
    // footer recedes through size and colour alone, with no second rule.
    const footerStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      marginTop: '2px',
      paddingTop: '6px',
      fontSize: '10.5px',
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    const TICK = 30_000

    function UsageDetails({ snapshot, t, tag, onRefresh, refreshing, offline, style }) {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), TICK)
        return () => clearInterval(timer)
      }, [])
      const now = Date.now()
      const windows = snapshot !== null && snapshot.windows !== null && typeof snapshot.windows === 'object'
        ? snapshot.windows
        : {}
      const monthly = windows.monthly ?? null
      const plan = snapshot?.plan !== null && typeof snapshot?.plan === 'object' ? snapshot.plan : null
      const planLabel = plan !== null && typeof plan.label === 'string' && plan.label.length > 0 ? plan.label : null

      const rows = []
      for (const name of WINDOWS) {
        const window = windows[name]
        if (window === null || window === undefined) continue
        const percent = typeof window.percent === 'number' ? Math.round(window.percent) : null
        const resetAt = resetTimeOf(window)
        const remaining = resetAt === null ? null : formatRemaining(resetAt, tag, now)
        const hint = remaining !== null ? t('resetsIn', { time: remaining }) : t('resetUnknown')
        rows.push(h('div', { key: name, style: rowStyle },
          h('span', { style: rowLabelStyle }, t(LONG_LABELS[name])),
          h('span', { style: rowValueStyle },
            h('span', { style: rowPercentStyle(window.percent), 'aria-label': t('percentAria', { label: t(LONG_LABELS[name]), percent: percent === null ? '—' : percent }) },
              percent === null ? '—' : `${percent}%`),
            resetAt === null ? null : h('span', { style: rowHintStyle }, hint),
          ),
        ))
      }

      const headline = monthly !== null && typeof monthly.usedUsd === 'number' && typeof monthly.limitUsd === 'number'
        ? `$${formatMoney(monthly.usedUsd)}/$${formatMoney(monthly.limitUsd)}`
        : ''

      const footerLines = []
      const updated = typeof snapshot?.fetchedAt === 'number'
        ? t('updated', { time: formatClock(snapshot.fetchedAt, tag) })
        : null
      const headMeta = [updated, planLabel !== null ? t('planLabel', { plan: planLabel }) : null].filter((value) => value !== null)
      if (headMeta.length > 0 || offline) {
        footerLines.push(h('span', { key: 'meta' }, [headMeta.join(' · '), offline ? t('offline') : null].filter((value) => value !== null).join(' · ')))
      }
      if (plan !== null && typeof plan.periodEndsAt === 'string') {
        const date = formatDate(plan.periodEndsAt, tag)
        if (date !== null) {
          footerLines.push(h('span', { key: 'period' }, plan.cancelAtPeriodEnd === true
            ? t('periodEnd', { date })
            : t('renews', { date })))
        }
      }

      return h('div', {
        style: { ...cardBaseStyle, ...style },
        role: 'dialog',
        'aria-label': t('region'),
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { style: cardHeadStyle },
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', display: 'inline-flex' } }, GaugeIcon(16)),
        h('span', { style: cardTitleStyle }, t('plan')),
        headline.length > 0 ? h('span', { style: cardHeadValueStyle }, headline) : null,
        h('button', {
          type: 'button',
          style: iconButtonStyle,
          onClick: onRefresh,
          disabled: refreshing,
          title: t('refresh'),
          'aria-label': t('refresh'),
        }, refreshing ? '⋯' : '↻'),
      ),
      rows,
      footerLines.length > 0 ? h('div', { style: footerStyle }, footerLines) : null,
      )
    }

    const useIsomorphicLayoutEffect = React.useLayoutEffect ?? React.useEffect

    function UsageBar() {
      const { snapshot, phase, error, refreshing, offline, reload } = useUsage()
      const t = useTranslate()
      const [open, setOpen] = React.useState(false)
      const [hovered, setHovered] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const pillRef = React.useRef(null)
      const tag = activeLocale()

      const measure = React.useCallback(() => {
        const node = pillRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        // The host's own stats popover aligns its left edge with the trigger
        // pill; clamp so a narrow window never pushes the card off-screen.
        const width = 300
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        setAnchor({
          left,
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
        })
      }, [])

      useIsomorphicLayoutEffect(() => {
        if (!open) {
          setAnchor(null)
          return
        }
        measure()
      }, [open, measure])

      React.useEffect(() => {
        if (!open) return undefined
        const onMove = () => measure()
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [open, measure])

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => setOpen(false)
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('click', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (phase === 'hidden') return null
      if (phase === 'loading' && snapshot === null) return null

      const windows = snapshot !== null && snapshot.windows !== null && typeof snapshot.windows === 'object'
        ? snapshot.windows
        : {}
      // "Go" + one compact segment per window: separators live inside the
      // segment text so the pill stays narrow instead of paying a flex gap per
      // token.
      const segments = [
        h('span', { key: 'brand', style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, 'Go'),
      ]
      for (const name of WINDOWS) {
        const window = windows[name]
        if (window === null || window === undefined) continue
        const percent = typeof window.percent === 'number' ? Math.round(window.percent) : null
        segments.push(h('span', { key: name, style: { fontVariantNumeric: 'tabular-nums' } },
          '· ',
          t(name),
          ' ',
          h('span', {
            style: { fontWeight: 600, color: attentionColor(window.percent) },
            'aria-label': t('percentAria', { label: t(name), percent: percent === null ? '—' : percent }),
          }, percent === null ? '—' : `${percent}%`),
        ))
      }

      const errorText = error !== null && error !== 'no-key' ? errorMessage(error, t) : null
      const pillChildren = errorText !== null
        ? [h('span', { key: 'error', style: { color: 'var(--dsw-alias-state-error-primary)' } }, errorText)]
        : segments

      const popoverStyle = anchor === null
        ? null
        : {
          position: 'fixed',
          left: `${anchor.left}px`,
          bottom: `${anchor.bottom}px`,
        }

      return h('div', { style: wrapStyle },
        h('button', {
          ref: pillRef,
          type: 'button',
          style: hovered ? { ...pillStyle, ...pillHoverStyle } : pillStyle,
          onClick: (event) => {
            event.stopPropagation()
            setOpen((value) => !value)
          },
          onPointerEnter: () => setHovered(true),
          onPointerLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          'aria-expanded': open,
          'aria-label': open ? t('collapse') : t('expand'),
          title: open ? t('collapse') : t('expand'),
        }, pillChildren),
        open && snapshot !== null && popoverStyle !== null
          ? h(UsageDetails, {
            snapshot,
            t,
            tag,
            onRefresh: () => reload(true),
            refreshing,
            offline,
            style: popoverStyle,
          })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale') ?? null
        ctx.effect(() => {
          if (localeService === null || typeof localeService.register !== 'function') return () => {}
          const disposers = []
          for (const localeId of Object.keys(DICTS)) {
            try {
              disposers.push(localeService.register(NS, localeId, DICTS[localeId]))
            } catch {
              /* a duplicate or unknown tag must never break the widget */
            }
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* idempotent disposer, ignore */
              }
            }
          }
        }, `${NS}:locale`)
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'opencode-go-usage',
          order: 1,
          label: () => 'OpenCode GO',
        }, UsageBar))
      },
    }
  },
})

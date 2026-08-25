import * as React from 'react'

/**
 * Must equal the namespace the Host half registers: the Plugins settings tab
 * dispatches `settings.plugin.item` once per served namespace, using it as the
 * keyed slot's entry key.
 */
const NAMESPACE = 'vendor-login'

/** Must equal `ROUTE_PREFIX` in the Host half. */
const ROUTE_PREFIX = '/plugin/vendor-login'

/**
 * Every request here is root-relative, which is the whole transport: this card
 * is served by the same `webServer` the Host half registered its routes on.
 * `@deepseek-ai/dsh-api-remotes` is not an option — its capability set is fixed
 * by build-time value imports, so a plugin distributed outside that repository
 * cannot add a method to it.
 */
async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ROUTE_PREFIX}${path}`, { cache: 'no-store', ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

interface VendorRow {
  id: string
  /** The `llm-pi-ai` route this vendor's sign-in makes live. */
  route: string
  label: string
  methods: { id: string; label: string }[]
  available: boolean
  inFlight: boolean
  signedIn: boolean
  routed: boolean
  /** The route exists but carries configuration this plugin did not write. */
  foreignRoute: boolean
}

interface HostState {
  authorization: boolean
  /** Why the authorization seam is unusable, when the Host half knows. */
  error: string | null
  settings: boolean
  vendors: VendorRow[]
}

interface Notice { message: string; url?: string; code?: string }

interface Prompt {
  id: string
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: { id: string; label: string; description?: string }[]
}

interface Session {
  vendor: string
  attempt?: string
  notices: Notice[]
  prompt?: Prompt
  /** `undefined` while the attempt is still running. */
  status?: 'authorized' | 'cancelled' | 'failed'
  error?: string
  warning?: string
}

export const inject = ['slots']

export function apply(ctx: any) {
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NAMESPACE,
  }, VendorLoginCard))
}

function VendorLoginCard() {
  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState<HostState | null>(null)
  const [loadError, setLoadError] = React.useState('')
  const [session, setSession] = React.useState<Session | null>(null)
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const stream = React.useRef<EventSource | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      setState(await call('/state'))
      setLoadError('')
    } catch (err: any) {
      setLoadError(err?.message ?? String(err))
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  // The stream is the attempt: closing it aborts the flow host-side (the Host
  // half withdraws on the response's `close`), so this doubles as the teardown
  // for a card that unmounts mid-login.
  React.useEffect(() => () => { stream.current?.close() }, [])

  const patch = (fn: (prev: Session) => Session) =>
    setSession((prev) => (prev ? fn(prev) : prev))

  /**
   * The payload of one server event, or `undefined` for an event carrying none.
   *
   * Parsing here rather than inside the `patch` updater is deliberate: React
   * calls an updater during the RENDER that follows, so a parse throwing in
   * there is a render-phase crash — and the Plugins tab drops a slot entry
   * whose component crashed, which takes the whole card off the page.
   */
  const payload = (e: any): any => {
    if (typeof e?.data !== 'string') return undefined
    try {
      return JSON.parse(e.data)
    } catch {
      return undefined
    }
  }

  const startLogin = (vendor: string, method?: string) => {
    stream.current?.close()
    setDraft('')
    setSession({ vendor, notices: [] })

    const query = new URLSearchParams({ vendor })
    if (method) query.set('method', method)
    const es = new EventSource(`${ROUTE_PREFIX}/login?${query.toString()}`)
    stream.current = es

    // Named `attempt` and not `open`: `EventSource` fires a NATIVE `open` event
    // of its own when the connection is established, and it carries no data —
    // a listener for a server event of that name would receive it too.
    es.addEventListener('attempt', (e: any) => {
      const data = payload(e)
      if (!data) return
      patch((prev) => ({ ...prev, attempt: data.attempt }))
    })
    es.addEventListener('notice', (e: any) => {
      const notice: Notice | undefined = payload(e)
      if (!notice) return
      patch((prev) => ({ ...prev, notices: [...prev.notices, notice] }))
    })
    es.addEventListener('prompt', (e: any) => {
      const prompt: Prompt | undefined = payload(e)
      if (!prompt) return
      setDraft('')
      patch((prev) => ({ ...prev, prompt }))
    })
    // A flow racing a typed code against the browser callback retires the
    // losing question. The attempt is still running, so only the form goes.
    es.addEventListener('prompt-close', (e: any) => {
      const data = payload(e)
      if (!data) return
      patch((prev) => (prev.prompt?.id === data.id ? { ...prev, prompt: undefined } : prev))
    })
    es.addEventListener('warning', (e: any) => {
      const data = payload(e)
      if (!data) return
      patch((prev) => ({ ...prev, warning: data.message }))
    })
    es.addEventListener('settled', (e: any) => {
      const settled = payload(e)
      es.close()
      patch((prev) => ({ ...prev, prompt: undefined, status: settled?.status ?? 'failed', error: settled?.error }))
      void refresh()
    })
    es.onerror = () => {
      // EventSource reconnects on its own, which would silently start a SECOND
      // attempt against a key the seam allows one attempt on. Close it and say
      // the connection dropped.
      es.close()
      patch((prev) => (prev.status ? prev : { ...prev, status: 'failed', prompt: undefined, error: '与 dsh 的连接中断，登录已取消。' }))
      void refresh()
    }
  }

  const answer = async (value: string) => {
    if (!session?.attempt || !session.prompt) return
    const prompt = session.prompt.id
    patch((prev) => ({ ...prev, prompt: undefined }))
    setDraft('')
    await call('/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempt: session.attempt, prompt, value }),
    }).catch((err: any) => patch((prev) => ({ ...prev, error: err?.message ?? String(err) })))
  }

  const decline = async () => {
    if (!session?.attempt || !session.prompt) return
    const prompt = session.prompt.id
    patch((prev) => ({ ...prev, prompt: undefined }))
    await call('/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempt: session.attempt, prompt, decline: true }),
    }).catch(() => {})
  }

  const cancel = async (vendor: string) => {
    await call('/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor }),
    }).catch(() => {})
    stream.current?.close()
    patch((prev) => (prev.status ? prev : { ...prev, prompt: undefined, status: 'cancelled' }))
    void refresh()
  }

  const signout = async (vendor: string) => {
    setBusy(vendor)
    try {
      await call('/signout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vendor }),
      })
      setSession((prev) => (prev?.vendor === vendor ? null : prev))
      await refresh()
    } catch (err: any) {
      setLoadError(err?.message ?? String(err))
    } finally {
      setBusy('')
    }
  }

  const running = session !== null && session.status === undefined

  const promptForm = (prompt: Prompt) => {
    if (prompt.kind === 'select') {
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        ...(prompt.options ?? []).map((option) =>
          React.createElement('button', {
            key: option.id,
            type: 'button',
            onClick: () => void answer(option.id),
            style: { ...btnOutlineStyle, textAlign: 'left' as const },
          },
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, option.label),
            option.description
              ? React.createElement('span', { style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, option.description)
              : null,
          ),
        ),
      )
    }
    return React.createElement('form', {
      onSubmit: (e: any) => { e.preventDefault(); if (draft.trim()) void answer(draft.trim()) },
      style: { display: 'flex', gap: 8 },
    },
      React.createElement('input', {
        type: prompt.kind === 'secret' ? 'password' : 'text',
        value: draft,
        autoFocus: true,
        placeholder: prompt.placeholder ?? '',
        onChange: (e: any) => setDraft(e.target.value),
        style: { ...inputStyle, flex: 1, minWidth: 0 },
      }),
      React.createElement('button', {
        type: 'submit',
        disabled: draft.trim() === '',
        style: { ...btnPrimaryStyle, opacity: draft.trim() === '' ? 0.5 : 1 },
      }, '提交'),
    )
  }

  const sessionPanel = () => {
    if (!session) return null
    const children: React.ReactNode[] = []

    for (const [index, notice] of session.notices.entries()) {
      children.push(
        React.createElement('div', { key: `n${index}`, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          React.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, notice.message),
          notice.url
            ? React.createElement('a', {
                href: notice.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' as const },
              }, notice.url)
            : null,
          notice.code
            ? React.createElement('code', {
                style: {
                  alignSelf: 'flex-start', fontSize: 15, letterSpacing: 2, fontWeight: 600,
                  padding: '4px 10px', borderRadius: 8,
                  background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)',
                },
              }, notice.code)
            : null,
        ),
      )
    }

    if (session.prompt) {
      children.push(
        React.createElement('div', { key: 'p', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          React.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, session.prompt.message),
          promptForm(session.prompt),
          React.createElement('button', {
            type: 'button',
            onClick: () => void decline(),
            style: { ...btnOutlineStyle, alignSelf: 'flex-start' as const },
          }, '不填了'),
        ),
      )
    }

    if (session.status === undefined && !session.prompt && session.notices.length === 0) {
      children.push(React.createElement('span', { key: 'w', style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '正在启动登录流程…'))
    }

    if (session.status === 'authorized') {
      children.push(React.createElement('span', { key: 's', style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        session.warning ?? '登录成功。该 provider 的模型已写入 llm-pi-ai 路由，可在模型选择器里直接选。'))
    }
    if (session.status === 'cancelled') {
      children.push(React.createElement('span', { key: 's', style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '登录已取消。'))
    }
    if (session.status === 'failed') {
      children.push(React.createElement('span', { key: 's', style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, `登录失败：${session.error ?? '未知错误'}`))
    }

    children.push(
      React.createElement('div', { key: 'a', style: { display: 'flex', gap: 8 } },
        session.status === undefined
          ? React.createElement('button', { type: 'button', onClick: () => void cancel(session.vendor), style: btnOutlineStyle }, '取消登录')
          : React.createElement('button', { type: 'button', onClick: () => setSession(null), style: btnOutlineStyle }, '收起'),
      ),
    )

    return React.createElement('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 10,
        borderRadius: 8, padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
    }, ...children)
  }

  const cardBody = () => {
    if (loadError) return [text(`读取状态失败：${loadError}`)]
    if (!state) return [text('正在读取登录状态…')]
    // The Host half checks the seam's contract at startup, so a version skew
    // has a name by the time it gets here — show it instead of sending the user
    // to the log for something already known.
    if (!state.authorization) {
      return [text(state.error
        ? `登录不可用：${state.error}`
        : '授权服务未挂载——本插件的宿主半边没能加载 @deepseek-ai/dsh-authorization，登录不可用。请查看 dsh 日志。')]
    }

    const children: React.ReactNode[] = []
    // Mounted, but not speaking what this plugin calls: the rows still render
    // (signed-in state is read from the credential store, not the seam), so the
    // reason belongs above them rather than in place of them.
    if (state.error) {
      children.push(
        React.createElement('div', { key: 'err', style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, state.error),
      )
    }
    children.push(
      React.createElement('div', { key: 'intro', style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
        '这里只收那些拿不到 API Key、不登录就用不了的订阅套餐——能自己申请到 API Key 的厂商，直接去「模型」设置页配一条 apiKeyEnv 就行，不必绕这里。登录在 dsh 宿主进程里完成，令牌存进 dsh 的凭据库并自动续期；浏览器这边只负责显示要打开的页面和要填的值。'),
    )

    for (const vendor of state.vendors) {
      const active = session?.vendor === vendor.id
      const badge = vendor.inFlight && !active ? '其他窗口登录中'
        : vendor.signedIn ? '已登录'
        : '未登录'
      children.push(
        React.createElement('div', {
          key: vendor.id,
          style: {
            display: 'flex', flexDirection: 'column', gap: 10,
            borderRadius: 8, padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-3)',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                React.createElement('span', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, vendor.label),
                React.createElement('span', {
                  style: {
                    whiteSpace: 'nowrap' as const, borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px',
                    ...(vendor.signedIn
                      ? { background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' }
                      : { color: 'var(--dsw-alias-label-tertiary)' }),
                  },
                }, badge),
              ),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
                !vendor.available ? `没有为 "${vendor.id}" 注册登录流程——检查 vendors 设置里的 provider id。`
                  : vendor.methods.length === 0 ? `"${vendor.id}" 只提供 API Key，没有账号登录——这不归这张卡片管，去「模型」设置页给它配一条 apiKeyEnv 即可。`
                  : vendor.foreignRoute ? `llm-pi-ai 的 "${vendor.route}" 路由已被别处配置，本插件不会覆盖它；模型走的是那条配置。`
                  : vendor.signedIn && vendor.routed ? `已接入模型选择器（llm-pi-ai 路由 ${vendor.route}）`
                  : vendor.signedIn ? '已登录，但 llm-pi-ai 里没有对应路由；模型不会出现在选择器里。'
                  : `provider id：${vendor.id}`),
            ),
            ...(vendor.available
              ? [
                  vendor.signedIn
                    ? React.createElement('button', {
                        type: 'button',
                        disabled: busy === vendor.id,
                        onClick: () => void signout(vendor.id),
                        style: { ...btnOutlineStyle, flex: 'none' as const },
                      }, busy === vendor.id ? '登出中…' : '登出')
                    : null,
                  vendor.methods[0]
                    ? React.createElement('button', {
                        type: 'button',
                        disabled: running,
                        onClick: () => startLogin(vendor.id, vendor.methods[0].id),
                        style: { ...btnPrimaryStyle, flex: 'none' as const, opacity: running ? 0.5 : 1 },
                      }, vendor.methods[0].label)
                    : null,
                ]
              : []),
          ),
          active ? sessionPanel() : null,
        ),
      )
    }

    return children
  }

  return React.createElement('div', {
    style: {
      display: 'flex', flexDirection: 'column',
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
      transition: 'border-color .16s, background .16s',
    },
  },
    React.createElement('button', {
      type: 'button',
      onClick: () => setOpen(!open),
      style: {
        appearance: 'none', width: '100%', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        background: 'none', border: '0', borderRadius: 12, color: 'inherit',
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
      },
    },
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 2, minWidth: 0 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '厂商账号登录'),
          running ? React.createElement('span', {
            style: { whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px' },
          }, '登录中') : null,
        ),
        React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, '登录那些拿不到 API Key、只能登录才能用的订阅套餐（Claude Pro/Max/Team · ChatGPT · Copilot · SuperGrok）'),
      ),
      React.createElement('span', {
        style: { color: 'var(--dsw-alias-label-tertiary)', display: 'inline-flex', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' },
      },
        React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true },
          React.createElement('path', {
            d: 'M3.5 5.5L7 9l3.5-3.5',
            stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        ),
      ),
    ),
    open ? React.createElement('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 12, margin: '0 16px 4px', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 12 },
    }, ...cardBody()) : null,
  )
}

const inputStyle = {
  height: 34,
  padding: '0 12px',
  font: 'inherit',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
}

const btnOutlineStyle = {
  font: 'inherit', fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)', background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const btnPrimaryStyle = {
  font: 'inherit', fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid transparent', background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

function text(value: string) {
  return React.createElement('span', { key: 'text', style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, value)
}

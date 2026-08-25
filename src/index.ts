import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'vendor-login'

/**
 * `credentials` is required rather than optional: the authorization seam's own
 * `static inject` demands it (a flow's contract is "the record is committed
 * during the run", which the seam confirms through the store), and every fact
 * this plugin reports — signed in or not — is a record read.
 */
export const inject = ['webServer', 'credentials']

/**
 * Settings namespace this plugin owns. The browser card in `./client` is keyed
 * on this string: the Plugins settings tab dispatches `settings.plugin.item`
 * once per namespace the Host serves, so the two halves must spell it
 * identically — and a namespace the Host does not serve is never dispatched.
 */
export const SETTINGS_NAMESPACE = 'vendor-login'

/** Route prefix the browser card talks to. Must match `ROUTE_PREFIX` in ./client. */
const ROUTE_PREFIX = '/plugin/vendor-login'

/**
 * Record scope of every credential `@deepseek-ai/dsh-llm-pi-ai` stores, and
 * also its settings namespace. Both are that plugin's registered name; the
 * credential key grammar is `<scope>/<id>` with the id being pi-ai's own
 * provider id, which is also the harness route key.
 */
const PI_AI = 'llm-pi-ai'

/** The credential-key segment grammar: a lowercase hyphenated identifier. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The calls this plugin makes on the authorization service. Checked once at
 * startup, because the seam ships with a dsh this plugin does not version.
 */
const SEAM_METHODS = ['begin', 'describe', 'cancel'] as const

/**
 * The one login method this plugin drives, as `@deepseek-ai/dsh-llm-pi-ai`
 * spells it.
 *
 * pi-ai registers a second `api-key` method for nearly every provider, which
 * prompts for a key and stores it as the same kind of credential record. That
 * one is deliberately not offered here: a plan reachable with an API key is a
 * plan dsh already covers from the Models settings page with a plain
 * `apiKeyEnv` route, and this card exists for the plans that have no key at
 * all. Filtering it out at the seam boundary — rather than hiding a button —
 * is what keeps the card's offer and the `/login` route's answer identical.
 */
const SIGN_IN_METHOD = 'oauth'

/** The account sign-in a flow offers, or nothing when it only takes a key. */
function signInMethods(entry: any): { id: string; label: string }[] {
  return (entry?.methods ?? []).filter((method: any) => method?.id === SIGN_IN_METHOD)
}

export interface Config {
  vendors: string[]
}

export const Config = Schema.object({
  vendors: Schema.array(Schema.string())
    .default(['anthropic', 'openai-codex', 'github-copilot', 'xai'])
    .description('要在设置卡片里显示的 pi-ai provider id。默认只收「套餐本身拿不到 API Key、不登录就用不了」的那几家：anthropic（Pro/Max/Team 订阅额度只认 OAuth，ANTHROPIC_API_KEY 是 Console 按量计费的另一套账）、openai-codex（ChatGPT Plus/Pro，pi-ai 里这个 provider 连 API Key 路径都没有）、github-copilot（Copilot 不发 API Key，只有设备码 OAuth）、xai（SuperGrok / X Premium 与 console.x.ai 是分开的计费轨，订阅换不出 key）。能自己申请到 API Key 的（kimi-coding、openrouter、radius）故意不收——那些直接在「模型」设置页配一条 apiKeyEnv 就行，不需要本插件；真要显示的话写进这个列表也能出来。'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: any
    credentials: any
    settings: any
    authorization: any
  }
}

/**
 * One in-flight login as the HTTP side sees it: the SSE response it reports
 * through, the abort that withdraws it, and the questions it is waiting on.
 */
interface Attempt {
  key: string
  res: ServerResponse
  abort: AbortController
  prompts: Map<string, { resolve: (value: string) => void; reject: (reason: unknown) => void }>
}

/**
 * One row of the card: what to authorize, and what pi-ai route the sign-in
 * makes usable. The two travel together rather than being re-derived at each
 * use, because every surface that shows a vendor needs both.
 */
interface Vendor {
  /** Card id, which is also the pi-ai provider id. */
  id: string
  /** The credential record its flow writes. */
  key: string
  /** The `llm-pi-ai` route its sign-in should make live. */
  route: string
  /** The profile to store for that route. */
  profile: () => Record<string, unknown>
  /**
   * Whether a RAW stored profile is one this plugin wrote.
   *
   * Separate from `profile()` on purpose: "is this ours" and "is this current"
   * are different questions, and answering the first with an equality test
   * against the second would make the plugin refuse to update its own route.
   */
  owns: (stored: unknown) => boolean
}

/**
 * Mount the HOST's own `@deepseek-ai/dsh-authorization` — not a copy of our own.
 *
 * dsh-base composes the credential seam but not this one, while
 * `@deepseek-ai/dsh-llm-pi-ai` registers its per-provider login flows only
 * inside `ctx.inject(['authorization'], …)`. So the whole sign-in chain ships
 * present and dark, and mounting the service is what lights it up.
 *
 * Resolution is anchored on `ctx.baseUrl` (the profile directory) for the same
 * reason dsh-web-search-free anchors tool-web there: a bare import would pull a
 * second copy carrying its own `@deepseek-ai/cordis`, and a Service class built
 * on a different cordis registers a `ctx.authorization` the host's own
 * injectors cannot see — pi-ai's flows would stay dark while this plugin
 * reported success. In this deployment the profile's `@deepseek-ai/*` tree is
 * symlinked straight into the running dsh install, so the anchored resolve
 * returns the host's own module.
 *
 * The module is resolved out of a dsh install this plugin does not version, so
 * every export it reaches for is checked before use rather than after: a dsh
 * upgrade that renames one would otherwise mount something half-working and
 * surface as an unrelated failure at the first click.
 *
 * @returns the module's declined-error class, which the answer route needs in
 *   order to spell "the human said no" the way the seam's contract requires.
 */
async function mountAuthorization(ctx: Context, logger: any): Promise<new (message?: string) => Error> {
  const baseUrl = (ctx as any).baseUrl
  if (!baseUrl) throw new Error('ctx.baseUrl is unset; cannot anchor authorization resolution')
  const entry = createRequire(baseUrl).resolve('@deepseek-ai/dsh-authorization')
  const mod: any = await import(pathToFileURL(entry).href)
  const Declined = mod.AuthorizationDeclinedError
  if (typeof Declined !== 'function') {
    throw new Error('@deepseek-ai/dsh-authorization 不再导出 AuthorizationDeclinedError；当前 dsh 版本的授权接口与本插件预期不符')
  }

  // Another plugin may already own the seam — one service, one owner. Mounting
  // a second would throw and take this plugin down with it, and the flows we
  // want are registered against the incumbent either way.
  if ((ctx as any).reflect.get('authorization')) {
    logger.info?.('authorization service already mounted; using the existing one')
    return Declined
  }
  const service = mod.default ?? mod.AuthorizationService
  if (typeof service !== 'function') {
    throw new Error('@deepseek-ai/dsh-authorization 没有导出可挂载的服务类（default / AuthorizationService）；当前 dsh 版本的授权接口与本插件预期不符')
  }
  ctx.plugin(service)
  return Declined
}

/** Read a JSON request body, capped so a stuck client cannot grow it unbounded. */
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Whether a request came from this server's own page rather than another site.
 *
 * These routes carry no auth and live at a guessable loopback URL, so without
 * this any page the user happens to have open can reach them. `/signout` is the
 * one that bites: a cross-site `fetch(…, { mode: 'no-cors' })` sends its body as
 * `text/plain`, which is CORS-safelisted and therefore never preflighted, and
 * `vendor=anthropic` is guessable — that is a drive-by credential deletion.
 * `/login` is a plain GET, so an `<img src>` is enough to start a real flow and
 * hold the vendor's key against the one attempt the seam allows.
 *
 * Both headers below are set by the browser and cannot be spoofed from page
 * script. Neither present means a non-browser client (curl, a script), which is
 * left alone: the attacks this closes all need a browser to carry them.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  // Every current browser states the relationship outright. `none` is a URL the
  // user typed or bookmarked; anything but that and `same-origin` is a page.
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  // No Origin at all is not a browser doing a cross-site request: on those it
  // always sends one (`null` included, for an opaque origin).
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Whether the body is declared JSON.
 *
 * Belt to `sameOrigin`'s braces, and the sturdier half: `application/json` is
 * the one content type a page cannot post cross-site without a preflight, and
 * the preflight fails here because nothing serves CORS headers.
 */
function isJsonBody(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.split(';')[0].trim().toLowerCase() === 'application/json'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** One SSE frame. Named events, so the card registers one listener per kind. */
function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** A bounded wait that never keeps the process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

/** Whether a stored route profile is byte-for-byte the one this plugin writes. */
function sameProfile(stored: unknown, ours: Record<string, unknown>): boolean {
  if (typeof stored !== 'object' || stored === null) return false
  const keys = Object.keys(stored as object)
  if (keys.length !== Object.keys(ours).length) return false
  return keys.every((key) => (stored as any)[key] === ours[key])
}

/** The exact key set of a stored profile, for an ownership test. */
function hasExactKeys(stored: unknown, keys: string[]): boolean {
  if (typeof stored !== 'object' || stored === null) return false
  const actual = Object.keys(stored as object)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger?.('vendor-login') || console

  let resolved: () => Config = () => config

  /**
   * The settings seam, or null while it is unmounted.
   *
   * Read through the context `ctx.inject` handed the callback rather than off
   * `ctx` itself: cordis refuses `ctx.<service>` on a context that did not
   * declare the inject, and this plugin cannot declare `settings` as required
   * (a composition without it should still serve sign-in) nor read it
   * undeclared.
   */
  let settings: any = null

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
    resolved = () => scope.get()
    settings = sctx.settings
    sctx.effect(() => () => {
      resolved = () => config
      settings = null
    })
  })

  /**
   * The authorization seam, or undefined until the mount below lands.
   *
   * `ctx.reflect.get` rather than `ctx.authorization`, and no `inject`
   * declaration for it: this plugin MOUNTS that service, and cordis restarts a
   * fiber when a service it injects appears — declaring the inject would
   * restart us the moment our own mount succeeded, and the restart would mount
   * it again. The raw accessor reads the same store without arming that loop.
   */
  const authorization = () => (ctx as any).reflect.get('authorization')

  /**
   * The llm-pi-ai routes as the USER's document spells them, without the
   * schema's defaults.
   *
   * `settings.get()` resolves defaults over the stored section, so a route
   * this plugin wrote as `{}` reads back carrying every field pi-ai gives a
   * default — `defaultContextWindow`, `streamIdleTimeoutMs`, and the rest.
   * Comparing that against what we wrote would call our own route somebody
   * else's, which then shows a wrong warning on the card, refuses to update
   * the route, and leaves it behind on sign-out. The raw layer is the only
   * honest thing to compare against.
   */
  const storedRoutes = (): Record<string, unknown> => {
    const descriptor = settings?.describe?.()?.find((entry: any) => entry?.ns === PI_AI)
    return ((descriptor?.user as any)?.providers ?? {}) as Record<string, unknown>
  }

  /** Every row the card shows. */
  const vendors = (): Vendor[] => {
    const piAi = (resolved().vendors ?? [])
      .filter((id) => {
        if (SEGMENT.test(id)) return true
        logger.warn?.(`vendor "${id}" is not a valid credential-key segment; skipping it`)
        return false
      })
      .map((id): Vendor => ({
        id,
        key: `${PI_AI}/${id}`,
        route: id,
        profile: () => ({}),
        // The empty profile IS the configuration, so an empty stored route is
        // ours and anything with a field in it is the user's own.
        owns: (stored) => hasExactKeys(stored, []),
      }))
    return piAi
  }

  const vendorFor = (id: string): Vendor | undefined => vendors().find((vendor) => vendor.id === id)

  const attempts = new Map<string, Attempt>()
  let Declined: (new (message?: string) => Error) | null = null

  // ---- authorization seam ----------------------------------------------------

  let seamActive: () => void = () => {}
  const seam = new Promise<void>((resolve) => { seamActive = resolve })

  /**
   * Wait for the seam to actually be serving.
   *
   * The callback form of `ctx.inject` is the reactive path onto a service, and
   * it builds a CHILD fiber — which is what makes it safe here even though this
   * plugin mounts that same service: the child running when the service appears
   * is exactly the intent, whereas naming `authorization` in the module-level
   * `inject` would restart the plugin itself the moment its own mount
   * succeeded, and the restart would mount it again.
   *
   * Reading the service straight after `ctx.plugin()` does NOT work: the
   * accessor answers only once the providing fiber is active, so anything done
   * there silently sees nothing.
   */
  ctx.inject(['authorization'], () => { seamActive() })

  // The seam is mounted asynchronously (its module is resolved off the profile
  // directory), so every route awaits this rather than assuming it landed. The
  // mount resolves before the service fiber is active, so this waits for the
  // registration above too — bounded, because a composition where the seam
  // never activates must still answer requests rather than hang on them.
  /**
   * Why sign-in is unavailable, in the words the card should show.
   *
   * The seam is resolved out of a dsh this plugin does not version, so "it did
   * not come up" has several distinct causes — module gone, export renamed,
   * service never activated, methods changed — and a card that reports them all
   * as one sentence sends the user to the log for something we already know.
   */
  let loadError: string | null = null

  const ready = mountAuthorization(ctx, logger)
    .then(async (cls) => {
      Declined = cls
      if (!await Promise.race([seam.then(() => true), delay(5000).then(() => false)])) {
        loadError = '授权服务挂载后 5 秒内没有开始服务。'
        logger.warn?.('the authorization service did not become active within 5s')
        return
      }
      // The mount succeeding says the module loaded, not that it still speaks
      // the three calls the routes below make. Ask now rather than at a click.
      const auth = authorization()
      const missing = SEAM_METHODS.filter((method) => typeof auth?.[method] !== 'function')
      if (missing.length) {
        loadError = `授权服务缺少 ${missing.join('、')} 方法；当前 dsh 版本的授权接口与本插件预期不符。`
        logger.warn?.(`the authorization service is missing: ${missing.join(', ')}`)
      }
    })
    .catch((err: any) => {
      loadError = `挂载 @deepseek-ai/dsh-authorization 失败：${err?.message ?? err}`
      logger.warn?.(`failed to mount the authorization seam: ${err?.message}. Vendor sign-in is unavailable.`)
    })

  // The webserver has no auth or origin policy of its own, so these routes are
  // exactly as reachable as `/api` is. On the default loopback bind that is the
  // local machine; on a deliberate `0.0.0.0` it is the network — and these
  // routes carry an OAuth URL out and a typed authorization code back in.
  if (ctx.webServer.host !== '127.0.0.1') {
    logger.warn?.(`webServer is bound to ${ctx.webServer.host}; ${ROUTE_PREFIX} carries sign-in URLs and typed codes and has no auth of its own`)
  }

  /**
   * What the card renders: one row per vendor, joining what the authorization
   * seam offers against what the credential store already holds and what the
   * pi-ai settings section already routes.
   */
  async function state() {
    await ready
    const auth = authorization()
    const piAi: any = settings?.get(PI_AI) ?? {}
    const routes = piAi?.providers ?? {}

    const rows = await Promise.all(vendors().map(async (vendor) => {
      const entry = auth?.describe?.(vendor.key)
      const record = await ctx.credentials.describeRecord(vendor.key)
      const stored = routes[vendor.route]
      const raw = storedRoutes()[vendor.route]
      return {
        id: vendor.id,
        route: vendor.route,
        label: entry?.label ?? vendor.id,
        methods: signInMethods(entry),
        // No flow means llm-pi-ai is not mounted, or pi-ai ships nothing under
        // this id — either way there is nothing to begin, and saying so beats
        // rendering a button that can only answer NO_FLOW.
        available: entry !== undefined,
        inFlight: entry?.inFlight === true,
        signedIn: record?.configured === true,
        routed: stored !== undefined,
        // A route someone else configured is not ours to claim or to remove,
        // and the card says so rather than silently doing neither.
        foreignRoute: stored !== undefined && !vendor.owns(raw),
      }
    }))
    return { authorization: auth !== undefined, error: loadError, settings: settings !== null, vendors: rows }
  }

  /**
   * Make a signed-into vendor's models selectable by storing its pi-ai route.
   *
   * For a pi-ai provider the profile is empty, and that emptiness is the whole
   * configuration: a catalog route inherits endpoint, protocol, and catalog
   * from pi-ai, and naming no `apiKeyEnv` at all is precisely the case that
   * defers to pi-ai's own ambient discovery — which reads the credential
   * record the sign-in just committed.
   *
   * @returns a warning to show the user, or null when the route is as it should be.
   */
  async function addRoute(vendor: Vendor): Promise<string | null> {
    if (!settings) return null
    const ours = vendor.profile()
    const current: any = settings.get(PI_AI) ?? {}
    const resolvedRoute = current?.providers?.[vendor.route]
    const raw = storedRoutes()[vendor.route]

    if (resolvedRoute !== undefined && !vendor.owns(raw)) {
      return `llm-pi-ai 里已经有一条 "${vendor.route}" 路由，且不是本插件写的，因此保留未动。要用这次登录的话，请到「模型」设置页把它改掉或删掉。`
    }
    if (sameProfile(raw, ours)) return null

    await settings.mutate(PI_AI, [{ op: 'set', path: ['providers', vendor.route], value: ours }])
    logger.info?.(`wrote llm-pi-ai route "${vendor.route}"; its models are now selectable`)
    return null
  }

  /**
   * Drop the route a sign-out leaves unauthenticated — but only while it is
   * still exactly the profile we wrote. A profile carrying anything else is
   * the user's own configuration, and a sign-out is not a mandate to delete it.
   */
  async function dropRoute(vendor: Vendor): Promise<void> {
    if (!settings) return
    const current: any = settings.get(PI_AI) ?? {}
    const stored = current?.providers?.[vendor.route]
    if (stored === undefined) return
    if (!vendor.owns(storedRoutes()[vendor.route])) {
      logger.info?.(`kept llm-pi-ai route "${vendor.route}": it carries configuration this plugin did not write`)
      return
    }
    await settings.mutate(PI_AI, [{ op: 'unset', path: ['providers', vendor.route] }])
  }

  /** Run one login attempt, reporting it down an already-open SSE response. */
  async function login(res: ServerResponse, vendor: Vendor, method: string | undefined): Promise<void> {
    const auth = authorization()
    const attemptId = randomUUID()
    const attempt: Attempt = { key: vendor.key, res, abort: new AbortController(), prompts: new Map() }
    attempts.set(attemptId, attempt)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // The card is same-origin, but a buffering proxy would hold every notice
      // until the flow ended — which is every notice that matters.
      'x-accel-buffering': 'no',
    })
    // `attempt`, not `open`: `EventSource` fires a native `open` event of its
    // own — with no data — when the connection is established, and a browser
    // listener for a server event by that name receives that one too.
    sendEvent(res, 'attempt', { attempt: attemptId })

    // A closed tab must not leave a flow holding the key: the seam allows one
    // attempt per key at a time, so an abandoned attempt would lock out the
    // next one until the vendor's own timeout.
    res.on('close', () => { attempt.abort.abort() })

    const interaction = {
      notify(notice: any) { sendEvent(res, 'notice', notice) },
      prompt(prompt: any) {
        const asked = new Promise<string>((resolve, reject) => {
          const promptId = randomUUID()
          const settle = (fn: (value: any) => void) => (value: any) => {
            attempt.prompts.delete(promptId)
            fn(value)
          }
          attempt.prompts.set(promptId, { resolve: settle(resolve), reject: settle(reject) })

          // A flow racing a typed code against a browser callback withdraws the
          // losing question through the prompt's own signal. That rejection
          // must NOT be the declined error, or a later genuine failure would be
          // misread as the human saying no.
          if (prompt.signal) {
            const withdraw = () => {
              const pending = attempt.prompts.get(promptId)
              if (!pending) return
              sendEvent(res, 'prompt-close', { id: promptId })
              pending.reject(new Error('prompt withdrawn'))
            }
            if (prompt.signal.aborted) { withdraw(); return }
            prompt.signal.addEventListener('abort', withdraw, { once: true })
          }

          sendEvent(res, 'prompt', {
            id: promptId,
            kind: prompt.kind,
            message: prompt.message,
            placeholder: prompt.placeholder,
            options: prompt.options,
          })
        })

        // A prompt the flow walked away from — the losing half of a race, or
        // one still open when the attempt ends — is rejected by the cleanup
        // below at a moment when nothing is awaiting it any more. Marking it
        // handled here keeps that from surfacing as an unhandled rejection;
        // the caller's own `await` on `asked` is unaffected.
        asked.catch(() => {})
        return asked
      },
    }

    try {
      const outcome = await auth.begin({ key: vendor.key, method, interaction, signal: attempt.abort.signal })
      sendEvent(res, 'settled', { status: outcome.status })
      if (outcome.status === 'authorized') {
        try {
          const warning = await addRoute(vendor)
          if (warning) sendEvent(res, 'warning', { message: warning })
        } catch (err: any) {
          // The sign-in itself succeeded and is durable. A route we could not
          // write is a smaller failure than reporting the whole login failed.
          sendEvent(res, 'warning', {
            message: `登录成功，但未能自动写入 llm-pi-ai 路由：${err?.message ?? err}。请到「模型」设置页手动添加该 provider。`,
          })
        }
      }
    } catch (err: any) {
      sendEvent(res, 'settled', { status: 'failed', error: String(err?.message ?? err) })
    } finally {
      for (const pending of attempt.prompts.values()) pending.reject(new Error('attempt ended'))
      attempts.delete(attemptId)
      res.end()
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length)

    if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-site request rejected' }); return }
    if (req.method === 'POST' && !isJsonBody(req)) {
      sendJson(res, 415, { error: 'expected content-type: application/json' })
      return
    }

    if (req.method === 'GET' && path === '/state') {
      sendJson(res, 200, await state())
      return
    }

    if (req.method === 'GET' && path === '/login') {
      await ready
      if (!authorization()) { sendJson(res, 503, { error: 'authorization seam is not mounted' }); return }
      const vendor = vendorFor(url.searchParams.get('vendor') ?? '')
      if (!vendor) { sendJson(res, 400, { error: 'unknown vendor' }); return }
      const method = url.searchParams.get('method')
      // The card only ever offers `SIGN_IN_METHOD`; anything else reaching here
      // is a hand-made request for the api-key flow this plugin does not drive.
      if (method !== null && method !== SIGN_IN_METHOD) { sendJson(res, 400, { error: `this plugin only drives the "${SIGN_IN_METHOD}" method` }); return }
      await login(res, vendor, SIGN_IN_METHOD)
      return
    }

    if (req.method === 'POST' && path === '/answer') {
      const body = await readJson(req)
      const attempt = attempts.get(String(body.attempt))
      const pending = attempt?.prompts.get(String(body.prompt))
      if (!pending) { sendJson(res, 404, { error: 'no such prompt' }); return }
      if (body.decline === true) {
        // Only a human's "no" may use this class — it is what makes the attempt
        // settle as `cancelled` rather than `failed`.
        pending.reject(Declined ? new Declined('user declined') : new Error('user declined'))
      } else {
        pending.resolve(String(body.value ?? ''))
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/cancel') {
      await ready
      const vendor = vendorFor(String((await readJson(req)).vendor ?? ''))
      if (!vendor) { sendJson(res, 400, { error: 'unknown vendor' }); return }
      authorization()?.cancel(vendor.key)
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/signout') {
      const vendor = vendorFor(String((await readJson(req)).vendor ?? ''))
      if (!vendor) { sendJson(res, 400, { error: 'unknown vendor' }); return }
      // Forgets the grant locally; it does not tell the issuer. Revoking the
      // authorization itself is the vendor's own account page.
      await ctx.credentials.deleteRecord(vendor.key)
      await dropRoute(vendor)
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse) => handle(req, res).catch((err: any) => {
      logger.warn?.(`${req.method} ${req.url} failed: ${err?.message}`)
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) })
      else res.end()
    }),
  }))

  // An attempt outlives no fiber: withdraw whatever is running when we unload,
  // so a reload does not leave the seam holding a key nothing will ever settle.
  ctx.effect(() => () => {
    for (const attempt of attempts.values()) attempt.abort.abort()
    attempts.clear()
  })
}

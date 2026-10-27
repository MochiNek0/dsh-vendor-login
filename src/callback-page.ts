import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The page a browser lands on after a vendor's OAuth redirect.
 *
 * That page is not ours to serve: `@earendil-works/pi-ai` runs its own loopback
 * callback server inside the dsh process and answers with a page of its own —
 * pi's logo, English only — through `oauthSuccessHtml` / `oauthErrorHtml`,
 * which it exposes no option to replace. So the replacement happens on the
 * wire: while a sign-in attempt is in flight, servers created through
 * `http.createServer` get their responses checked, and a body that is one of
 * pi-ai's pages is swapped for this plugin's before it is written.
 *
 * Patching `createServer` on the builtin and then `syncBuiltinESMExports()` is
 * what reaches pi-ai at all: it imports `{ createServer } from "node:http"`,
 * an ESM live binding that only that call refreshes.
 *
 * Recognition is by pi-ai's page titles, so a pi-ai that renames them simply
 * falls back to its own page rather than breaking the sign-in.
 */
const PI_TITLES = {
  success: '<title>Authentication successful</title>',
  failure: '<title>Authentication failed</title>',
}

const COPY = {
  en: {
    successTitle: 'Signed in',
    successBody: 'Your account is now connected to dsh. You can close this page and go back to dsh.',
    failureTitle: 'Sign-in failed',
    failureHint: 'Go back to the Models settings page in dsh and try again.',
  },
  zh: {
    successTitle: '登录成功',
    successBody: '账号已连接到 dsh，现在可以关闭这个页面，回到 dsh 继续使用。',
    failureTitle: '登录失败',
    failureHint: '请回到 dsh 的「模型」设置页重试。',
  },
}

/**
 * pi-ai's page markup is `<h1>…</h1><p>…</p>` plus an optional details block,
 * already HTML-escaped by pi-ai — so the captured text goes back out as is.
 */
function capture(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1]?.trim() || undefined
}

function render(html: string, req: IncomingMessage): string {
  const lang = /^zh\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'zh' : 'en'
  const copy = COPY[lang]
  const ok = html.includes(PI_TITLES.success)
  const title = ok ? copy.successTitle : copy.failureTitle
  // On failure pi-ai's own sentence is the useful part (it names the vendor and
  // the reason), so it is kept; on success ours says everything there is.
  const message = ok ? copy.successBody : capture(html, /<p>([\s\S]*?)<\/p>/) ?? ''
  const details = ok ? undefined : capture(html, /<div class="details">([\s\S]*?)<\/div>/)

  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #f5f7fb; --card: #ffffff; --border: #e3e8f0;
      --text: #1f2937; --dim: #6b7280; --code: #f1f4f9;
      --tone: ${ok ? '#16a34a' : '#dc2626'};
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115; --card: #171a21; --border: #262b35;
        --text: #f3f4f6; --dim: #9ca3af; --code: #1f232c;
        --tone: ${ok ? '#4ade80' : '#f87171'};
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px; background: var(--bg); color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    main {
      width: 100%; max-width: 420px; padding: 32px 28px; text-align: center;
      background: var(--card); border: 1px solid var(--border); border-radius: 16px;
      box-shadow: 0 8px 30px rgba(15, 23, 42, .06);
    }
    .status {
      width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent);
    }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 650; }
    p { margin: 0; font-size: 14px; line-height: 1.7; color: var(--dim); }
    .details {
      margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: var(--code);
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--dim); text-align: left; white-space: pre-wrap; word-break: break-word;
    }
    .hint { margin-top: 16px; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="status"><svg width="26" height="26" viewBox="0 0 16 16" fill="none" aria-hidden="true">${ok
      ? '<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'}</svg></div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ''}
    ${ok ? '' : `<p class="hint">${copy.failureHint}</p>`}
  </main>
</body>
</html>`
}

/** Swap pi-ai's page for ours on this one response, leaving every other body untouched. */
function rebrand(req: IncomingMessage, res: ServerResponse): void {
  const end = res.end
  res.end = function (this: ServerResponse, chunk?: any, ...rest: any[]) {
    if (typeof chunk === 'string' && (chunk.includes(PI_TITLES.success) || chunk.includes(PI_TITLES.failure))) {
      chunk = render(chunk, req)
    }
    return (end as any).call(this, chunk, ...rest)
  } as any
}

/**
 * Install the replacement for the plugin's lifetime.
 *
 * @param active - whether a sign-in attempt is in flight; servers created
 *   outside one are passed through untouched.
 * @returns the disposer, which restores `createServer` unless something else
 *   wrapped it after us (unwrapping then would drop their wrapper too).
 */
export function installCallbackPage(active: () => boolean): () => void {
  const original = http.createServer
  const patched = function (this: unknown, ...args: any[]) {
    if (active()) {
      const index = args.findIndex((arg) => typeof arg === 'function')
      if (index >= 0) {
        const listener = args[index]
        args[index] = function (this: unknown, req: IncomingMessage, res: ServerResponse) {
          rebrand(req, res)
          return listener.call(this, req, res)
        }
      }
    }
    return (original as any).apply(this, args)
  }
  ;(http as any).createServer = patched
  syncBuiltinESMExports()
  return () => {
    if ((http as any).createServer !== patched) return
    ;(http as any).createServer = original
    syncBuiltinESMExports()
  }
}

[English](https://github.com/MochiNek0/dsh-vendor-login/blob/main/README.md) | [简体中文](https://github.com/MochiNek0/dsh-vendor-login/blob/main/README.zh-CN.md)

# dsh-vendor-login

[![npm version](https://img.shields.io/npm/v/dsh-vendor-login.svg)](https://www.npmjs.com/package/dsh-vendor-login)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Sign in to AI coding plans that **have no API key at all** — Claude Pro/Max/Team, ChatGPT Plus/Pro, GitHub Copilot, SuperGrok — with your own subscription account, straight from the [dsh](https://github.com/deepseek-ai/deepseek-harness) settings UI. Run each vendor's plan on its included quota instead of paying by token.

Vendors that do hand out API keys are deliberately not covered: configure those with an `apiKeyEnv` on dsh's Models page.

> ⚠️ These OAuth tokens are issued for each vendor's own clients. Reusing them in a third-party harness is a grey area — possible ToS violations, rate limits, or bans. This plugin drives the vendors' own OAuth/device-code flows and tokens stay on your machine. Whether to use it is your call.

## Supported vendors

| Vendor | Sign in with | Why there is no API key |
| --- | --- | --- |
| Anthropic (`anthropic`) | OAuth — loopback port `53692`, or paste back the code | Pro/Max/Team quota works only via Claude sign-in; `ANTHROPIC_API_KEY` bills against Console separately |
| OpenAI (`openai-codex`) | OAuth — loopback port `1455` | ChatGPT Plus/Pro quota works only via "Sign in with ChatGPT"; the API platform bills separately |
| GitHub Copilot (`github-copilot`) | Device code — `github.com/login/device` | Copilot issues no API keys; third parties get device-code OAuth only |
| xAI (`xai`) | Device code — `auth.x.ai` | SuperGrok / X Premium+ quota is OAuth-only; console.x.ai credits are a separate track |

## Requirements

- dsh installed (`dsh` on PATH) and `pnpm` on PATH.
- The `web` profile — the card only appears in the dsh Web UI.
- A browser for authorization. The two loopback flows need ports `53692` and `1455` free on this machine; the two device-code flows listen nowhere, so the browser can be anywhere.

## Install

```sh
dsh plugin --profile web add dsh-vendor-login
```

Then restart `dsh web`. From source: `pnpm install && pnpm build`, then `dsh plugin --profile web add -w .`.

## Use

Open **Settings → Plugins → Vendor Login**:

1. Click a vendor's sign-in button and finish the authorization in your browser.
2. If a flow asks you to paste back a code or pick an account, do it right in the card.
3. On success that vendor's models appear in the model picker immediately — the plugin writes the route into `llm-pi-ai` for you.

*Sign out* deletes the stored credential locally; it does not revoke anything on the vendor side — do that from the vendor's account page. A route you have customized since (your own `baseURL`, `apiKeyEnv`, models edits) survives sign-out.

## Configuration

What the card shows is controlled by `vendors` under the `vendor-login` namespace, defaulting to all four vendors above:

```yaml
vendors: [anthropic, openai-codex, github-copilot, xai]
```

Entries must be provider ids that pi-ai ships a login flow for; anything else shows an inline error instead of a dead button.

## Notes & limitations

- `/plugin/vendor-login/*` has no authentication of its own — unlike `/api`, which sits behind `apiproxy`. What stands in for it is a cross-site check: requests are rejected unless `Sec-Fetch-Site`/`Origin` say they came from dsh's own page, and every POST must be `application/json` (the one content type a page cannot post cross-site without a preflight). That closes drive-by sign-out and drive-by flow-starting from any page you happen to have open. It is not authentication: binding `webServer` beyond localhost still exposes these routes to anyone who can reach the port, and the plugin warns at startup when you do.
- A login lives in an open connection: refreshing the page mid-login restarts that flow.
- One attempt per vendor at a time; a second window gets rejected with `ALREADY_IN_FLIGHT`.
- xAI may gate its OAuth surface by plan tier — some standard SuperGrok accounts can complete login but get HTTP 403 on inference ([example](https://github.com/NousResearch/hermes-agent/issues/26847)). If so, use a `console.x.ai` API key via the Models page instead.

Found a bug, or did a vendor's login policy change? [Open an issue](https://github.com/MochiNek0/dsh-vendor-login/issues).

## License

MIT

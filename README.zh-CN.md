[English](https://github.com/MochiNek0/dsh-vendor-login/blob/main/README.md) | [简体中文](https://github.com/MochiNek0/dsh-vendor-login/blob/main/README.zh-CN.md)

# dsh-vendor-login

[![npm version](https://img.shields.io/npm/v/dsh-vendor-login.svg)](https://www.npmjs.com/package/dsh-vendor-login)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

面向 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的厂商账号登录插件：在设置界面里用你自己的订阅账号，登录那些**根本拿不到 API Key** 的 coding plan——Claude Pro/Max/Team、ChatGPT Plus/Pro、GitHub Copilot、SuperGrok——直接跑套餐内额度，不按 token 付费。

发得出 API Key 的厂商故意不收：那些在 dsh「模型」页配一条 `apiKeyEnv` 就行。

> ⚠️ 这些 OAuth 令牌按各家条款是发给它们自己官方客户端的。在第三方 harness 里复用属于灰色地带，存在违反服务条款、被限流或封号的风险。本插件走的就是各家自己的 OAuth / 设备码流程，令牌只存在你自己机器上——要不要这么用，是你自己的判断。

## 支持的厂商

| 厂商 | 登录方式 | 为什么没有 API Key |
| --- | --- | --- |
| Anthropic（`anthropic`） | OAuth — 本机回调 `53692`，或粘贴授权码 | Pro/Max/Team 额度只认 Claude 账号登录；`ANTHROPIC_API_KEY` 是 Console 的另一套账 |
| OpenAI（`openai-codex`） | OAuth — 本机回调 `1455` | ChatGPT Plus/Pro 额度只认 "Sign in with ChatGPT"；API 平台单独计费 |
| GitHub Copilot（`github-copilot`） | 设备码 — `github.com/login/device` | Copilot 不发 API Key，第三方只能走设备码 OAuth |
| xAI（`xai`） | 设备码 — `auth.x.ai` | SuperGrok / X Premium+ 额度只认 OAuth；console.x.ai 的额度是另一条轨 |

## 前置条件

- dsh **0.1.2-rc.1 及以上**（`dsh` 在 `PATH` 上），`pnpm` 在 `PATH` 上。模型页的扩展插槽是这个版本才有的；更早的版本上本插件什么都不会注册，界面上看不到登录入口。

  **dsh 版本更早的话，请改装 `0.1.x` 那条线**——支持的厂商和登录流程完全一样，只是登录入口是「设置 → 插件」里的一张独立卡片，不在模型页：

  ```sh
  dsh plugin --profile web add dsh-vendor-login@^0.1.1
  ```

- 目标 profile 是 `web`——登录入口只在 dsh Web 界面出现。
- 宿主机能开浏览器完成授权。两家回调流程要求本机 `53692`、`1455` 端口空闲；两家设备码流程不监听任何端口，浏览器在不在这台机器上都行。

## 安装

```sh
dsh plugin --profile web add dsh-vendor-login
```

装完重启 `dsh web`。从源码装：`pnpm install && pnpm build`，然后 `dsh plugin --profile web add -w .`。

## 使用

打开 **设置 → 模型**。上表每一家在那里都有自己的 provider 卡片，本插件往每张卡片底部加一块登录区：

1. 点这张卡片上的登录按钮，在浏览器里完成授权。
2. 流程若要求粘贴授权码或选择账号，直接在这张卡片里操作。
3. 显示成功后，这家的模型立刻出现在模型选择器里——路由已由插件自动写进 `llm-pi-ai`。

pi-ai 自带、但不归本插件管的那些 provider，卡片上不会多出任何东西——那些是能拿到 API Key 的，用卡片自己的 Key 字段配就行。

「登出」只是本地删掉存的凭据，不会通知厂商吊销授权——要真正撤销，去各家账号页面操作。如果你后来给自动写的路由加过自己的配置（换了 `baseURL`、填了 `apiKeyEnv`、裁过 models），登出时它会保留。

## 配置

哪几家会多出登录区，由 `vendor-login` 命名空间的 `vendors` 字段决定，默认就是上表四家。这个字段没有设置卡片，改它请直接编辑 profile 的设置文件：

```yaml
vendors: [anthropic, openai-codex, github-copilot, xai]
```

每一项都得是 pi-ai 自带登录方式的 provider id；填了别的，那一行会直接显示错误，而不是给你一个按不动的按钮。

## 注意与限制

- `/plugin/vendor-login/*` 没有自己的鉴权——这点和 `/api` 不同，`/api` 前面还有 `apiproxy`。替代的是一道跨站检查：`Sec-Fetch-Site`/`Origin` 表明不是来自 dsh 自己页面的请求一律拒绝，POST 还必须是 `application/json`（这是网页无法跨站直接发出、必然触发 preflight 的 content-type）。它挡住的是你随手开着的某个网页对本机做 drive-by 登出、drive-by 启动登录流程。但它不是鉴权：把 `webServer` 绑到本机之外，这些路由对任何能连上该端口的人依然暴露，插件启动时会打 warning。
- 登录流程活在开着的连接里：登录中途刷新页面就得重来。
- 一家同时只能有一次登录尝试；第二个窗口会被以 `ALREADY_IN_FLIGHT` 拒绝。
- xAI 可能按订阅档位限制 OAuth 接口——部分标准档 SuperGrok 账号能完成登录、但推理返回 HTTP 403（[实例](https://github.com/NousResearch/hermes-agent/issues/26847)）。遇到就改用 console.x.ai 的 API Key 走「模型」页配置。

发现 bug，或某家的登录政策变了？[提个 issue](https://github.com/MochiNek0/dsh-vendor-login/issues)。

## 许可证

MIT

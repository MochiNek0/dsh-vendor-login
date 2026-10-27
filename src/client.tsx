import * as React from "react";

/**
 * The settings namespace `@deepseek-ai/dsh-llm-pi-ai` registers under, which is
 * also the `settingsNs` every one of its Models-page rows carries.
 *
 * `settings.models.provider-card` is dispatched keyed on that namespace, so a
 * single registration here receives EVERY pi-ai row — catalog, configured, and
 * hand-declared alike — and the component decides which of them this plugin has
 * anything to say about. Keying on the adapter family rather than on a vendor
 * is the slot's own design: the Models section never learns what the namespace
 * means.
 */
const PI_AI = "llm-pi-ai";

/** Must equal `ROUTE_PREFIX` in the Host half. */
const ROUTE_PREFIX = "/plugin/vendor-login";

/**
 * Every request here is root-relative, which is the whole transport: this card
 * is served by the same `webServer` the Host half registered its routes on.
 * `@deepseek-ai/dsh-api-remotes` is not an option — its capability set is fixed
 * by build-time value imports, so a plugin distributed outside that repository
 * cannot add a method to it. The authorization seam has no remote of its own
 * either, so the Models page gets the surface but not the transport.
 */
async function call(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ROUTE_PREFIX}${path}`, {
    cache: "no-store",
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

interface VendorRow {
  id: string;
  /** The `llm-pi-ai` route this vendor's sign-in makes live. */
  route: string;
  label: string;
  methods: { id: string; label: string }[];
  available: boolean;
  inFlight: boolean;
  signedIn: boolean;
  routed: boolean;
  /** The route exists but carries configuration this plugin did not write. */
  foreignRoute: boolean;
}

interface HostState {
  authorization: boolean;
  /** Why the authorization seam is unusable, when the Host half knows. */
  error: string | null;
  settings: boolean;
  vendors: VendorRow[];
}

interface Notice {
  message: string;
  url?: string;
  code?: string;
}

interface Prompt {
  id: string;
  kind: "text" | "secret" | "select";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

interface Session {
  vendor: string;
  /** The login method this attempt was started with, so a retry repeats it. */
  method?: string;
  attempt?: string;
  notices: Notice[];
  prompt?: Prompt;
  /** `undefined` while the attempt is still running. */
  status?: "authorized" | "cancelled" | "failed";
  error?: string;
  warning?: string;
}

// ---- shared host state -----------------------------------------------------

/**
 * One `/state` read shared by every mounted card.
 *
 * pi-ai declares a Models-page row for its whole installed catalog, so this
 * component mounts a dozen-plus times on one page. A fetch per mount would be
 * that many identical requests on load, and that many again after each sign-in
 * settles; subscribing to one store is what keeps the card's cost independent
 * of how many providers pi-ai happens to ship.
 */
interface Snapshot {
  state: HostState | null;
  error: string;
}

let snapshot: Snapshot = { state: null, error: "" };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-read `/state` into the shared snapshot.
 *
 * Concurrent calls join the request in flight rather than starting a second:
 * a sign-in settling refreshes every subscriber at once, and each of them
 * asking separately would answer the same question N times.
 */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = call("/state")
    .then((state: HostState) => {
      snapshot = { state, error: "" };
    })
    // The last good state is kept beside the error: a failed refresh should
    // leave the rows readable rather than blanking every card on the page.
    .catch((err: any) => {
      snapshot = { state: snapshot.state, error: err?.message ?? String(err) };
    })
    .finally(() => {
      inFlight = null;
      for (const listener of listeners) listener();
    });
  return inFlight;
}

function useHostState(): Snapshot {
  const value = React.useSyncExternalStore(subscribe, () => snapshot);
  React.useEffect(() => {
    if (snapshot.state === null && !inFlight) void refresh();
  }, []);
  return value;
}

// ---- copy --------------------------------------------------------------------

/** The `ctx.locale` namespace this plugin's dictionaries register under. */
const LOCALE_NS = "vendor-login";

/** English strings — the key-set source of truth for this pair. */
const en = {
  connectionLost: "The connection to dsh dropped, so the sign-in was cancelled.",
  submit: "Submit",
  skip: "Skip",
  starting: "Starting sign-in…",
  waiting: "Waiting for you to finish in the browser…",
  openLink: "Open sign-in page",
  copy: "Copy",
  copied: "Copied",
  copyLink: "Copy link",
  authorized: "Signed in. This provider's models are now in the model picker.",
  cancelled: "Sign-in cancelled.",
  failed: "Sign-in failed: {error}",
  unknownError: "unknown error",
  cancelSignIn: "Cancel sign-in",
  retry: "Retry",
  dismiss: "Close",
  notRegistered:
    'No sign-in flow is registered for "{id}" — check the provider ids in vendor-login\'s vendors setting.',
  keyOnly:
    '"{id}" only offers an API key, no account sign-in — use this card\'s own API key field.',
  statusSignedIn: "Signed in",
  statusSignedOut: "Not signed in",
  statusSigningIn: "Signing in…",
  detailRouted: "Models are available in the model picker.",
  detailUnrouted:
    "llm-pi-ai has no matching route, so the models will not appear in the model picker.",
  detailForeign:
    'llm-pi-ai\'s "{route}" route is configured elsewhere; this plugin leaves it alone and the models use that configuration.',
  detailInFlight: "Signing in from another window…",
  detailSignedOut: "No API key for this plan? Sign in with your account.",
  signIn: "Sign in",
  resignIn: "Sign in again",
  signOut: "Sign out",
  confirmSignOut: "Confirm sign-out",
  signingOut: "Signing out…",
  signOutFailed: "Sign-out failed: {error}",
  diagTitle: "Vendor sign-in",
  diagUnavailableTitle: "Vendor sign-in unavailable",
  diagStale: "Status may be stale: {error}",
  diagReadFailed: "Failed to read status: {error}",
  diagUnmounted:
    "The authorization service is not mounted — this plugin's host half could not load @deepseek-ai/dsh-authorization. Check the dsh log.",
};

const zh: typeof en = {
  connectionLost: "与 dsh 的连接中断，登录已取消。",
  submit: "提交",
  skip: "跳过",
  starting: "正在启动登录流程…",
  waiting: "等待你在浏览器中完成登录…",
  openLink: "打开登录页面",
  copy: "复制",
  copied: "已复制",
  copyLink: "复制链接",
  authorized: "登录成功，这个 provider 的模型已可在模型选择器里直接选。",
  cancelled: "登录已取消。",
  failed: "登录失败：{error}",
  unknownError: "未知错误",
  cancelSignIn: "取消登录",
  retry: "重试",
  dismiss: "收起",
  notRegistered:
    '没有为 "{id}" 注册登录流程——检查 vendor-login 的 vendors 设置里的 provider id。',
  keyOnly:
    '"{id}" 只提供 API Key，没有账号登录——用这张卡片自己的 API Key 字段配置即可。',
  statusSignedIn: "已登录",
  statusSignedOut: "未登录",
  statusSigningIn: "登录中…",
  detailRouted: "模型已接入模型选择器。",
  detailUnrouted: "llm-pi-ai 里没有对应路由，模型不会出现在选择器里。",
  detailForeign:
    'llm-pi-ai 的 "{route}" 路由已被别处配置，本插件不会覆盖它；模型走的是那条配置。',
  detailInFlight: "其他窗口正在登录…",
  detailSignedOut: "拿不到 API Key？试试用账号登录。",
  signIn: "登录",
  resignIn: "重新登录",
  signOut: "登出",
  confirmSignOut: "确认登出",
  signingOut: "登出中…",
  signOutFailed: "登出失败：{error}",
  diagTitle: "厂商账号登录",
  diagUnavailableTitle: "厂商账号登录不可用",
  diagStale: "状态可能已过期：{error}",
  diagReadFailed: "读取状态失败：{error}",
  diagUnmounted:
    "授权服务未挂载——本插件的宿主半边没能加载 @deepseek-ai/dsh-authorization。请查看 dsh 日志。",
};

type CopyKey = keyof typeof en;
type T = (key: CopyKey, params?: Record<string, string>) => string;

/** How long a successful sign-in's confirmation stays before it folds away. */
const SUCCESS_DISMISS_MS = 4000;
/** How long the sign-out button stays armed waiting for its confirming click. */
const SIGNOUT_CONFIRM_MS = 3000;

export const inject = ["slots", "locale"];

export function apply(ctx: any) {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    "vendor-login: copy dictionaries",
  );
  // `bind` keeps a stable identity per namespace, and slot-rendered copy follows
  // a language switch live, so one `t` serves every card for the plugin's life.
  const t: T = ctx.locale.bind(LOCALE_NS);
  const injected = () => ({ t });

  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      {
        name: "settings.models.provider-card",
        key: PI_AI,
        inject: injected,
      },
      ProviderSignIn,
    ),
  );

  // The provider cards are the whole UI now, and a card renders nothing at all
  // when the seam did not come up — so the one fact that has no card to live in
  // is "sign-in is unavailable, and here is why". This entry renders nothing
  // whenever there is nothing wrong.
  ctx.slots.inject("settings.models.footer", () =>
    ctx.slots.register(
      {
        name: "settings.models.footer",
        id: "vendor-login-diagnostics",
        inject: injected,
      },
      SignInDiagnostics,
    ),
  );
}

/**
 * The sign-in area inside one pi-ai provider card.
 *
 * @param props - the slot's owner share plus the injected `t`; only
 *   `provider.provider` (the route id, which is also the pi-ai provider id) is
 *   read. `configured` and `keyConfigured` describe the row's settings profile,
 *   whereas every fact this component shows is a credential-store or
 *   authorization-seam fact the Host half already joined.
 */
function ProviderSignIn(props: any) {
  const id: string = props?.provider?.provider ?? "";
  const t: T = props.t;
  const { state } = useHostState();

  const [session, setSession] = React.useState<Session | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  /** The sign-out button was clicked once and waits for a confirming click. */
  const [confirming, setConfirming] = React.useState(false);
  /** The device code most recently copied, for the button's acknowledgement. */
  const [copied, setCopied] = React.useState("");
  /** A failed sign-out, which has no session panel to report itself in. */
  const [actionError, setActionError] = React.useState("");
  const stream = React.useRef<EventSource | null>(null);

  // The stream is the attempt: closing it aborts the flow host-side (the Host
  // half withdraws on the response's `close`), so this doubles as the teardown
  // for a card that unmounts mid-login.
  React.useEffect(
    () => () => {
      stream.current?.close();
    },
    [],
  );

  // A clean success has nothing left to act on — the status row above already
  // says "signed in" — so its panel folds itself. A warning stays until read.
  const settledClean =
    session?.status === "authorized" && session.warning === undefined;
  React.useEffect(() => {
    if (!settledClean) return;
    const timer = setTimeout(() => setSession(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [settledClean]);

  React.useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), SIGNOUT_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const patch = (fn: (prev: Session) => Session) =>
    setSession((prev) => (prev ? fn(prev) : prev));

  /**
   * The payload of one server event, or `undefined` for an event carrying none.
   *
   * Parsing here rather than inside the `patch` updater is deliberate: React
   * calls an updater during the RENDER that follows, so a parse throwing in
   * there is a render-phase crash — and the slot machinery retires an entry
   * whose component crashed, which takes the sign-in off every card at once.
   */
  const payload = (e: any): any => {
    if (typeof e?.data !== "string") return undefined;
    try {
      return JSON.parse(e.data);
    } catch {
      return undefined;
    }
  };

  const startLogin = (method?: string) => {
    stream.current?.close();
    setDraft("");
    setActionError("");
    setConfirming(false);
    setSession({ vendor: id, method, notices: [] });

    const query = new URLSearchParams({ vendor: id });
    if (method) query.set("method", method);
    const es = new EventSource(`${ROUTE_PREFIX}/login?${query.toString()}`);
    stream.current = es;

    // Named `attempt` and not `open`: `EventSource` fires a NATIVE `open` event
    // of its own when the connection is established, and it carries no data —
    // a listener for a server event of that name would receive it too.
    es.addEventListener("attempt", (e: any) => {
      const data = payload(e);
      if (!data) return;
      patch((prev) => ({ ...prev, attempt: data.attempt }));
    });
    es.addEventListener("notice", (e: any) => {
      const notice: Notice | undefined = payload(e);
      if (!notice) return;
      patch((prev) => ({ ...prev, notices: [...prev.notices, notice] }));
    });
    es.addEventListener("prompt", (e: any) => {
      const prompt: Prompt | undefined = payload(e);
      if (!prompt) return;
      setDraft("");
      patch((prev) => ({ ...prev, prompt }));
    });
    // A flow racing a typed code against the browser callback retires the
    // losing question. The attempt is still running, so only the form goes.
    es.addEventListener("prompt-close", (e: any) => {
      const data = payload(e);
      if (!data) return;
      patch((prev) =>
        prev.prompt?.id === data.id ? { ...prev, prompt: undefined } : prev,
      );
    });
    es.addEventListener("warning", (e: any) => {
      const data = payload(e);
      if (!data) return;
      patch((prev) => ({ ...prev, warning: data.message }));
    });
    es.addEventListener("settled", (e: any) => {
      const settled = payload(e);
      es.close();
      patch((prev) => ({
        ...prev,
        prompt: undefined,
        status: settled?.status ?? "failed",
        error: settled?.error,
      }));
      void refresh();
    });
    es.onerror = () => {
      // EventSource reconnects on its own, which would silently start a SECOND
      // attempt against a key the seam allows one attempt on. Close it and say
      // the connection dropped.
      es.close();
      patch((prev) =>
        prev.status
          ? prev
          : {
              ...prev,
              status: "failed",
              prompt: undefined,
              error: t("connectionLost"),
            },
      );
      void refresh();
    };
  };

  const answer = async (value: string) => {
    if (!session?.attempt || !session.prompt) return;
    const prompt = session.prompt.id;
    patch((prev) => ({ ...prev, prompt: undefined }));
    setDraft("");
    await call("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt: session.attempt, prompt, value }),
    }).catch((err: any) =>
      patch((prev) => ({ ...prev, error: err?.message ?? String(err) })),
    );
  };

  const decline = async () => {
    if (!session?.attempt || !session.prompt) return;
    const prompt = session.prompt.id;
    patch((prev) => ({ ...prev, prompt: undefined }));
    await call("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt: session.attempt, prompt, decline: true }),
    }).catch(() => {});
  };

  const cancel = async () => {
    await call("/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vendor: id }),
    }).catch(() => {});
    stream.current?.close();
    patch((prev) =>
      prev.status ? prev : { ...prev, prompt: undefined, status: "cancelled" },
    );
    void refresh();
  };

  const signout = async () => {
    // Signing out drops a credential that took a browser round-trip to get, so
    // the first click only arms the button; a second one within the window
    // goes through.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setActionError("");
    try {
      await call("/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vendor: id }),
      });
      setSession(null);
      await refresh();
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = (code: string) => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(code);
        setTimeout(() => setCopied(""), 2000);
      })
      .catch(() => {});
  };

  const promptForm = (prompt: Prompt) => {
    if (prompt.kind === "select") {
      // One bordered list with dividers, the way a settings page groups
      // choices, rather than a stack of separate boxes.
      return React.createElement(
        "div",
        {
          role: "list",
          style: {
            display: "flex",
            flexDirection: "column",
            borderRadius: 8,
            border: ".5px solid var(--dsw-alias-border-l3)",
            overflow: "hidden",
          },
        },
        ...(prompt.options ?? []).map((option, index) =>
          React.createElement(OptionRow, {
            key: option.id,
            label: option.label,
            description: option.description,
            divider: index > 0,
            onPick: () => void answer(option.id),
          }),
        ),
      );
    }
    return React.createElement(
      "form",
      {
        onSubmit: (e: any) => {
          e.preventDefault();
          if (draft.trim()) void answer(draft.trim());
        },
        style: { display: "flex", gap: 8 },
      },
      React.createElement("input", {
        type: prompt.kind === "secret" ? "password" : "text",
        value: draft,
        autoFocus: true,
        autoComplete: "off",
        "aria-label": prompt.message,
        placeholder: prompt.placeholder ?? "",
        onChange: (e: any) => setDraft(e.target.value),
        style: { ...inputStyle, flex: 1, minWidth: 0 },
      }),
      React.createElement(
        "button",
        {
          type: "submit",
          disabled: draft.trim() === "",
          style: { ...btnPrimaryStyle, opacity: draft.trim() === "" ? 0.4 : 1 },
        },
        t("submit"),
      ),
      React.createElement(
        "button",
        { type: "button", onClick: () => void decline(), style: btnTextStyle },
        t("skip"),
      ),
    );
  };

  const sessionPanel = () => {
    if (!session) return null;
    const children: React.ReactNode[] = [];

    for (const [index, notice] of session.notices.entries()) {
      children.push(
        React.createElement(
          "div",
          {
            key: `n${index}`,
            style: { display: "flex", flexDirection: "column", gap: 8 },
          },
          React.createElement(
            "span",
            { style: bodyTextStyle },
            notice.message,
          ),
          notice.code
            ? React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "8px 8px 8px 14px",
                    borderRadius: 10,
                    border: ".5px solid var(--dsw-alias-border-l2)",
                    background: "var(--dsw-alias-bg-layer-3)",
                  },
                },
                React.createElement(
                  "code",
                  {
                    style: {
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      fontSize: 18,
                      letterSpacing: 3,
                      fontWeight: 600,
                      color: "var(--dsw-alias-label-primary)",
                      userSelect: "all" as const,
                    },
                  },
                  notice.code,
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    onClick: () => copyCode(notice.code!),
                    style: { ...btnOutlineStyle, ...withIcon },
                  },
                  icon(copied === notice.code ? "check" : "copy", 13),
                  copied === notice.code ? t("copied") : t("copy"),
                ),
              )
            : null,
          // Copying stays one click away: a flow whose callback lands on
          // another machine needs the link carried there, not opened here.
          notice.url
            ? React.createElement(
                "div",
                { style: { display: "flex", gap: 8 } },
                React.createElement(
                  "a",
                  {
                    href: notice.url,
                    target: "_blank",
                    rel: "noreferrer",
                    style: {
                      ...btnPrimaryStyle,
                      ...withIcon,
                      textDecoration: "none",
                    },
                  },
                  t("openLink"),
                  icon("external", 12),
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    title: notice.url,
                    onClick: () => copyCode(notice.url!),
                    style: { ...btnOutlineStyle, ...withIcon },
                  },
                  icon(copied === notice.url ? "check" : "copy", 13),
                  copied === notice.url ? t("copied") : t("copyLink"),
                ),
              )
            : null,
        ),
      );
    }

    if (session.prompt) {
      children.push(
        React.createElement(
          "div",
          {
            key: "p",
            style: { display: "flex", flexDirection: "column", gap: 8 },
          },
          React.createElement(
            "span",
            { style: { ...bodyTextStyle, fontWeight: 500 } },
            session.prompt.message,
          ),
          promptForm(session.prompt),
        ),
      );
    }

    // A running attempt with no question open is waiting on something outside
    // the card — the flow starting, or the user in the browser — so say which.
    if (session.status === undefined && !session.prompt) {
      children.push(
        React.createElement(
          "div",
          {
            key: "w",
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              ...captionTextStyle,
            },
          },
          icon("spinner", 14),
          session.notices.length === 0 ? t("starting") : t("waiting"),
        ),
      );
    }

    if (session.status !== undefined) {
      const outcome =
        session.status === "authorized"
          ? session.warning
            ? { tone: WARNING_COLOR, glyph: "alert", text: session.warning }
            : { tone: SUCCESS_COLOR, glyph: "check", text: t("authorized") }
          : session.status === "cancelled"
            ? {
                tone: "var(--dsw-alias-label-tertiary)",
                glyph: "info",
                text: t("cancelled"),
              }
            : {
                tone: ERROR_COLOR,
                glyph: "alert",
                text: t("failed", {
                  error: session.error ?? t("unknownError"),
                }),
              };
      children.push(
        React.createElement(
          "div",
          {
            key: "s",
            style: { display: "flex", alignItems: "flex-start", gap: 8 },
          },
          React.createElement(
            "span",
            { style: { color: outcome.tone, display: "flex", paddingTop: 2 } },
            icon(outcome.glyph as IconName, 14),
          ),
          React.createElement("span", { style: bodyTextStyle }, outcome.text),
        ),
      );
    }

    const actions: React.ReactNode[] = [];
    if (session.status === undefined) {
      actions.push(
        React.createElement(
          "button",
          {
            key: "cancel",
            type: "button",
            onClick: () => void cancel(),
            style: btnOutlineStyle,
          },
          t("cancelSignIn"),
        ),
      );
    } else {
      if (session.status !== "authorized") {
        actions.push(
          React.createElement(
            "button",
            {
              key: "retry",
              type: "button",
              onClick: () => startLogin(session.method),
              style: btnPrimaryStyle,
            },
            t("retry"),
          ),
        );
      }
      actions.push(
        React.createElement(
          "button",
          {
            key: "dismiss",
            type: "button",
            onClick: () => setSession(null),
            style: btnOutlineStyle,
          },
          t("dismiss"),
        ),
      );
    }
    children.push(
      React.createElement(
        "div",
        {
          key: "a",
          style: {
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            paddingTop: 10,
            borderTop: ".5px solid var(--dsw-alias-border-l2)",
          },
        },
        ...actions,
      ),
    );

    return React.createElement(
      "div",
      {
        key: "session",
        "aria-live": "polite",
        style: { ...cardStyle, gap: 12 },
      },
      ...children,
    );
  };

  // Nothing to say about this row until the state is in, and nothing to say at
  // all about the pi-ai rows outside the `vendors` list — which is most of the
  // catalog. Both render as an absent area rather than an empty one.
  const vendor = state?.vendors.find((row) => row.id === id);
  if (!vendor) return null;

  if (!vendor.available) {
    return section(note("info", t("notRegistered", { id: vendor.id })));
  }
  if (vendor.methods.length === 0) {
    return section(note("info", t("keyOnly", { id: vendor.id })));
  }

  const running = session !== null && session.status === undefined;
  const method = vendor.methods[0];

  // The badge answers one question: red signed out, orange signing in, green
  // signed in. A caveat such as a missing route belongs to the detail line.
  const pending = running || vendor.inFlight;
  const title = pending
    ? t("statusSigningIn")
    : vendor.signedIn
      ? t("statusSignedIn")
      : t("statusSignedOut");
  const tone = pending
    ? WARNING_COLOR
    : vendor.signedIn
      ? SUCCESS_COLOR
      : ERROR_COLOR;
  const detail =
    vendor.inFlight && !running
      ? t("detailInFlight")
      : vendor.foreignRoute
        ? t("detailForeign", { route: vendor.route })
        : vendor.signedIn && vendor.routed
          ? t("detailRouted")
          : vendor.signedIn
            ? t("detailUnrouted")
            : t("detailSignedOut");

  const pill = { borderRadius: 14, flex: "none" as const };
  return section(
    React.createElement(
      "div",
      {
        key: "head",
        role: "status",
        style: {
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap" as const,
          gap: 10,
          minWidth: 0,
        },
      },
      React.createElement(
        "div",
        {
          style: {
            flex: 1,
            minWidth: 160,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
          },
        },
        badge(tone, title, pending),
        // The panel below narrates a running attempt; the idle hint would only
        // contradict it.
        running
          ? null
          : React.createElement("span", { style: captionTextStyle }, detail),
      ),
      React.createElement(
        "div",
        { style: { display: "flex", gap: 6, flex: "none" as const } },
        // While this card's attempt runs, its panel below owns the only action
        // (cancel); a greyed-out button up here would just be noise.
        vendor.signedIn && !running
          ? React.createElement(
              "button",
              {
                type: "button",
                disabled: busy,
                onClick: () => void signout(),
                onBlur: () => setConfirming(false),
                style: {
                  ...(confirming ? btnDangerFilledStyle : btnDangerStyle),
                  ...pill,
                  opacity: busy ? 0.4 : 1,
                },
              },
              busy
                ? t("signingOut")
                : confirming
                  ? t("confirmSignOut")
                  : t("signOut"),
            )
          : null,
        running
          ? null
          : React.createElement(
              "button",
              {
                type: "button",
                disabled: busy,
                title: method.label,
                onClick: () => startLogin(method.id),
                style: {
                  ...(vendor.signedIn ? btnOutlineStyle : btnPrimaryStyle),
                  ...pill,
                  opacity: busy ? 0.4 : 1,
                },
              },
              vendor.signedIn ? t("resignIn") : t("signIn"),
            ),
      ),
    ),
    actionError
      ? note("alert", t("signOutFailed", { error: actionError }), ERROR_COLOR)
      : null,
    sessionPanel(),
  );
}

/** One choice of a select prompt: label, optional description, a chevron. */
function OptionRow(props: {
  label: string;
  description?: string;
  divider: boolean;
  onPick: () => void;
}) {
  // Inline styles have no :hover, and a row that does not answer the pointer
  // reads as text rather than as something to click.
  const [hover, setHover] = React.useState(false);
  return React.createElement(
    "button",
    {
      type: "button",
      role: "listitem",
      onClick: props.onPick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "9px 12px",
        font: "inherit",
        textAlign: "left" as const,
        cursor: "pointer",
        border: "none",
        borderTop: props.divider
          ? ".5px solid var(--dsw-alias-border-l2)"
          : "none",
        background: hover ? "var(--dsw-alias-bg-module-platform)" : "none",
        color: "var(--dsw-alias-label-primary)",
      },
    },
    React.createElement(
      "span",
      {
        style: {
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        },
      },
      React.createElement(
        "span",
        { style: { fontSize: 12, lineHeight: "18px", fontWeight: 500 } },
        props.label,
      ),
      props.description
        ? React.createElement(
            "span",
            { style: captionTextStyle },
            props.description,
          )
        : null,
    ),
    React.createElement(
      "span",
      { style: { display: "flex", color: "var(--dsw-alias-label-tertiary)" } },
      icon("chevron", 12),
    ),
  );
}

/**
 * The one thing a provider card cannot report: that sign-in is unavailable
 * everywhere. Renders nothing while it is available.
 */
function SignInDiagnostics(props: any) {
  const t: T = props.t;
  const { state, error } = useHostState();
  // Repeating a shared-store failure inside each of a dozen provider cards is
  // noise; it is one fact about one request, so it is reported once here.
  if (error) {
    return callout(
      t("diagTitle"),
      state ? t("diagStale", { error }) : t("diagReadFailed", { error }),
    );
  }
  if (!state) return null;
  // The Host half checks the seam's contract at startup, so a version skew has
  // a name by the time it gets here — show it instead of sending the user to
  // the log for something already known.
  if (!state.authorization) {
    return callout(
      t("diagUnavailableTitle"),
      state.error ?? t("diagUnmounted"),
      ERROR_COLOR,
    );
  }
  // Mounted, but not speaking what this plugin calls: the provider cards still
  // render (signed-in state is read from the credential store, not the seam),
  // so the reason belongs here rather than in place of them.
  if (state.error) return callout(t("diagTitle"), state.error);
  return null;
}

/**
 * The section-within-a-card treatment the Models page already uses for a row's
 * secondary content, so an injected area reads as part of the card it sits in.
 */
function section(...children: React.ReactNode[]) {
  return React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderTop: ".5px solid var(--dsw-alias-border-l2)",
        paddingTop: 10,
      },
    },
    ...children,
  );
}

/** A one-line remark with a leading glyph, for facts that need no action. */
function note(
  glyph: IconName,
  value: string,
  tone = "var(--dsw-alias-label-tertiary)",
) {
  return React.createElement(
    "div",
    {
      key: "note",
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
    },
    React.createElement(
      "span",
      { style: { color: tone, display: "flex", paddingTop: 2, flex: "none" } },
      icon(glyph, 13),
    ),
    React.createElement("span", null, value),
  );
}

/** A titled, tinted card for the Models-page footer. */
function callout(title: string, message: string, tone = WARNING_COLOR) {
  return React.createElement(
    "div",
    {
      role: "alert",
      style: {
        ...cardStyle,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        border: `.5px solid ${tint(tone, 40)}`,
        background: tint(tone, 8),
      },
    },
    React.createElement(
      "span",
      { style: { color: tone, display: "flex", paddingTop: 1, flex: "none" } },
      icon("alert", 16),
    ),
    React.createElement(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
        },
      },
      React.createElement(
        "span",
        { style: { ...bodyTextStyle, fontWeight: 600 } },
        title,
      ),
      React.createElement(
        "span",
        { style: { ...captionTextStyle, wordBreak: "break-word" as const } },
        message,
      ),
    ),
  );
}

/** A status pill: tinted background, a dot (or spinner while pending), a label. */
function badge(tone: string, label: string, pending: boolean) {
  return React.createElement(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 20,
        padding: "0 8px",
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        color: tone,
        background: tint(tone, 14),
      },
    },
    pending
      ? icon("spinner", 10)
      : React.createElement("span", {
          "aria-hidden": true,
          style: {
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "currentColor",
            cornerShape: "round",
          } as React.CSSProperties,
        }),
    label,
  );
}

type IconName =
  | "check"
  | "copy"
  | "external"
  | "alert"
  | "info"
  | "chevron"
  | "spinner";

/** Line glyphs drawn in `currentColor`, so each takes the tone of its context. */
const ICON_PATHS: Record<Exclude<IconName, "spinner">, string> = {
  check: "M3.5 8.5L6.5 11.5L12.5 4.5",
  chevron: "M6 3.5L10.5 8L6 12.5",
  copy: "M5.5 5.5V3.5C5.5 2.95 5.95 2.5 6.5 2.5H12.5C13.05 2.5 13.5 2.95 13.5 3.5V9.5C13.5 10.05 13.05 10.5 12.5 10.5H10.5M3.5 5.5H9.5C10.05 5.5 10.5 5.95 10.5 6.5V12.5C10.5 13.05 10.05 13.5 9.5 13.5H3.5C2.95 13.5 2.5 13.05 2.5 12.5V6.5C2.5 5.95 2.95 5.5 3.5 5.5Z",
  external: "M9.5 2.5H13.5V6.5M13.5 2.5L7.5 8.5M11.5 9.5V12.5C11.5 13.05 11.05 13.5 10.5 13.5H3.5C2.95 13.5 2.5 13.05 2.5 12.5V5.5C2.5 4.95 2.95 4.5 3.5 4.5H6.5",
  alert: "M8 5.5V8.5M8 10.75V11M8 1.75L14.5 13.25H1.5L8 1.75Z",
  info: "M8 7.5V11M8 5V5.25M14.25 8A6.25 6.25 0 1 1 1.75 8A6.25 6.25 0 0 1 14.25 8Z",
};

function icon(name: IconName, size: number) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": true,
    style: { flex: "none" as const, display: "block" },
  };
  if (name === "spinner") {
    // SMIL rather than a CSS animation: a slot entry has no stylesheet of its
    // own to put a `@keyframes` rule in.
    return React.createElement(
      "svg",
      common,
      React.createElement("circle", {
        cx: 8,
        cy: 8,
        r: 6,
        stroke: "currentColor",
        strokeOpacity: 0.25,
        strokeWidth: 2,
      }),
      React.createElement(
        "path",
        {
          d: "M14 8A6 6 0 0 0 8 2",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
        },
        React.createElement("animateTransform", {
          attributeName: "transform",
          type: "rotate",
          from: "0 8 8",
          to: "360 8 8",
          dur: "0.8s",
          repeatCount: "indefinite",
        }),
      ),
    );
  }
  return React.createElement(
    "svg",
    common,
    React.createElement("path", {
      d: ICON_PATHS[name],
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

/** `tone` at `percent`% over transparent, for badge and callout backgrounds. */
function tint(tone: string, percent: number) {
  return `color-mix(in srgb, ${tone} ${percent}%, transparent)`;
}

const SUCCESS_COLOR = "var(--dsw-alias-state-success-primary)";
const ERROR_COLOR = "var(--dsw-alias-state-error-primary)";
/** Amber for "signing in", warnings and the footer callout; fallback for hosts without the token. */
const WARNING_COLOR = "var(--dsw-alias-state-warning-primary, #f59e0b)";

const bodyTextStyle = {
  fontSize: 13,
  lineHeight: "20px",
  color: "var(--dsw-alias-label-primary)",
};

const captionTextStyle = {
  fontSize: 11,
  lineHeight: "16px",
  color: "var(--dsw-alias-label-tertiary)",
};

const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  borderRadius: 12,
  padding: "12px 14px",
  border: ".5px solid var(--dsw-alias-border-l2)",
  background: "none",
};

const withIcon = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const inputStyle = {
  height: 28,
  padding: "0 10px",
  font: "inherit",
  fontSize: 12,
  borderRadius: 8,
  border: ".5px solid var(--dsw-alias-border-l3)",
  background: "var(--dsw-alias-bg-layer-3)",
  color: "var(--dsw-alias-label-primary)",
};

const btnOutlineStyle = {
  boxSizing: "border-box" as const,
  height: 28,
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 10px",
  borderRadius: 8,
  cursor: "pointer",
  border: ".5px solid var(--dsw-alias-border-l3)",
  background: "none",
  color: "var(--dsw-alias-label-primary)",
};

const btnTextStyle = {
  ...btnOutlineStyle,
  height: 28,
  padding: "0 4px",
  border: "none",
  color: "var(--dsw-alias-label-tertiary)",
};

const btnDangerStyle = {
  boxSizing: "border-box" as const,
  height: 28,
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 10px",
  borderRadius: 8,
  cursor: "pointer",
  border: "none",
  background: "none",
  color: "#ef4444",
};

const btnDangerFilledStyle = {
  ...btnDangerStyle,
  background: "#ef4444",
  color: "#fff",
};

const btnPrimaryStyle = {
  boxSizing: "border-box" as const,
  height: 28,
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 10px",
  borderRadius: 8,
  cursor: "pointer",
  border: "none",
  background: "var(--dsw-alias-button-primary-fill)",
  color: "var(--dsw-alias-label-primary-foreground)",
};

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

export const inject = ["slots"];

export function apply(ctx: any) {
  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      {
        name: "settings.models.provider-card",
        key: PI_AI,
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
      },
      SignInDiagnostics,
    ),
  );
}

/**
 * The sign-in area inside one pi-ai provider card.
 *
 * @param props - the slot's owner share; only `provider.provider` (the route
 *   id, which is also the pi-ai provider id) is read. `configured` and
 *   `keyConfigured` describe the row's settings profile, whereas every fact
 *   this component shows is a credential-store or authorization-seam fact the
 *   Host half already joined.
 */
function ProviderSignIn(props: any) {
  const id: string = props?.provider?.provider ?? "";
  const { state } = useHostState();

  const [session, setSession] = React.useState<Session | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
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
    setSession({ vendor: id, notices: [] });

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
              error: "与 dsh 的连接中断，登录已取消。",
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

  const promptForm = (prompt: Prompt) => {
    if (prompt.kind === "select") {
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        ...(prompt.options ?? []).map((option) =>
          React.createElement(
            "button",
            {
              key: option.id,
              type: "button",
              onClick: () => void answer(option.id),
              style: {
                ...btnOutlineStyle,
                height: "auto",
                padding: "6px 10px",
                textAlign: "left" as const,
              },
            },
            React.createElement(
              "span",
              { style: { color: "var(--dsw-alias-label-primary)" } },
              option.label,
            ),
            option.description
              ? React.createElement(
                  "span",
                  {
                    style: {
                      display: "block",
                      fontSize: 11,
                      color: "var(--dsw-alias-label-tertiary)",
                    },
                  },
                  option.description,
                )
              : null,
          ),
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
        "提交",
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
            style: { display: "flex", flexDirection: "column", gap: 6 },
          },
          React.createElement(
            "span",
            {
              style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
            },
            notice.message,
          ),
          notice.url
            ? React.createElement(
                "a",
                {
                  href: notice.url,
                  target: "_blank",
                  rel: "noreferrer",
                  style: {
                    fontSize: 12,
                    color: "var(--dsw-alias-brand-primary)",
                    wordBreak: "break-all" as const,
                  },
                },
                notice.url,
              )
            : null,
          notice.code
            ? React.createElement(
                "code",
                {
                  style: {
                    alignSelf: "flex-start",
                    fontSize: 15,
                    letterSpacing: 2,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    background: "var(--dsw-alias-bg-module-platform)",
                    color: "var(--dsw-alias-label-primary)",
                  },
                },
                notice.code,
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
            {
              style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
            },
            session.prompt.message,
          ),
          promptForm(session.prompt),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => void decline(),
              style: { ...btnOutlineStyle, alignSelf: "flex-start" as const },
            },
            "不填了",
          ),
        ),
      );
    }

    if (
      session.status === undefined &&
      !session.prompt &&
      session.notices.length === 0
    ) {
      children.push(
        React.createElement(
          "span",
          {
            key: "w",
            style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },
          },
          "正在启动登录流程…",
        ),
      );
    }

    if (session.status === "authorized") {
      children.push(
        React.createElement(
          "span",
          {
            key: "s",
            style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
          },
          session.warning ??
            "登录成功。这个 provider 的模型已可在模型选择器里直接选。",
        ),
      );
    }
    if (session.status === "cancelled") {
      children.push(
        React.createElement(
          "span",
          {
            key: "s",
            style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },
          },
          "登录已取消。",
        ),
      );
    }
    if (session.status === "failed") {
      children.push(
        React.createElement(
          "span",
          {
            key: "s",
            style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
          },
          `登录失败：${session.error ?? "未知错误"}`,
        ),
      );
    }

    children.push(
      React.createElement(
        "div",
        { key: "a", style: { display: "flex", gap: 8 } },
        session.status === undefined
          ? React.createElement(
              "button",
              {
                type: "button",
                onClick: () => void cancel(),
                style: btnOutlineStyle,
              },
              "取消登录",
            )
          : React.createElement(
              "button",
              {
                type: "button",
                onClick: () => setSession(null),
                style: btnOutlineStyle,
              },
              "收起",
            ),
      ),
    );

    return React.createElement(
      "div",
      {
        key: "session",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 10,
          borderRadius: 12,
          padding: "10px 12px",
          background: "var(--dsw-alias-bg-module-platform)",
        },
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
    return section(
      muted(
        `没有为 "${vendor.id}" 注册登录流程——检查 vendor-login 的 vendors 设置里的 provider id。`,
      ),
    );
  }
  if (vendor.methods.length === 0) {
    return section(
      muted(
        `"${vendor.id}" 只提供 API Key，没有账号登录——用这张卡片自己的 API Key 字段配置即可。`,
      ),
    );
  }

  const running = session !== null && session.status === undefined;
  const method = vendor.methods[0];
  const detail =
    vendor.inFlight && !running
      ? "其他窗口正在登录…"
      : vendor.foreignRoute
        ? `llm-pi-ai 的 "${vendor.route}" 路由已被别处配置，本插件不会覆盖它；模型走的是那条配置。`
        : vendor.signedIn && vendor.routed
          ? "已接入模型选择器"
          : vendor.signedIn
            ? "已登录，但 llm-pi-ai 里没有对应路由；模型不会出现在选择器里。"
            : "拿不到 API Key? 试试登陆";
  const roundCorners = { cornerShape: "round" } as React.CSSProperties;
  return section(
    React.createElement(
      "div",
      {
        key: "head",
        style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
      },
      React.createElement("span", {
        style: {
          flex: "none" as const,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: vendor.signedIn
            ? "var(--dsw-alias-state-success-primary)"
            : "var(--dsw-alias-state-error-primary)",
          ...roundCorners,
        },
      }),
      React.createElement(
        "span",
        {
          style: {
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: "var(--dsw-alias-label-tertiary)",
          },
        },
        detail,
      ),
      vendor.signedIn
        ? React.createElement(
            "button",
            {
              type: "button",
              disabled: busy,
              onClick: () => void signout(),
              style: {
                ...btnDangerStyle,
                borderRadius: 14,
                flex: "none" as const,
                opacity: busy ? 0.4 : 1,
              },
            },
            busy ? "登出中…" : "登出",
          )
        : null,
      React.createElement(
        "button",
        {
          type: "button",
          disabled: running,
          onClick: () => startLogin(method.id),
          style: {
            ...btnOutlineStyle,
            borderRadius: 14,
            flex: "none" as const,
            opacity: running ? 0.4 : 1,
          },
        },
        vendor.signedIn ? "重新登录" : method.label,
      ),
    ),
    actionError ? muted(`登出失败：${actionError}`) : null,
    sessionPanel(),
  );
}

/**
 * The one thing a provider card cannot report: that sign-in is unavailable
 * everywhere. Renders nothing while it is available.
 */
function SignInDiagnostics() {
  const { state, error } = useHostState();
  // Repeating a shared-store failure inside each of a dozen provider cards is
  // noise; it is one fact about one request, so it is reported once here.
  if (error) {
    return section(
      muted(
        state
          ? `厂商账号登录：状态可能已过期——${error}`
          : `厂商账号登录：读取状态失败——${error}`,
      ),
    );
  }
  if (!state) return null;
  // The Host half checks the seam's contract at startup, so a version skew has
  // a name by the time it gets here — show it instead of sending the user to
  // the log for something already known.
  if (!state.authorization) {
    return section(
      muted(
        state.error
          ? `厂商账号登录不可用：${state.error}`
          : "厂商账号登录不可用：授权服务未挂载——本插件的宿主半边没能加载 @deepseek-ai/dsh-authorization。请查看 dsh 日志。",
      ),
    );
  }
  // Mounted, but not speaking what this plugin calls: the provider cards still
  // render (signed-in state is read from the credential store, not the seam),
  // so the reason belongs here rather than in place of them.
  if (state.error) return section(muted(`厂商账号登录：${state.error}`));
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

function muted(value: string) {
  return React.createElement(
    "span",
    {
      key: "muted",
      style: {
        fontSize: 12,
        lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary)",
      },
    },
    value,
  );
}

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

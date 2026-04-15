/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, on, onCleanup } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"
import { execFile } from "node:child_process"
const BOGUS = 1_000_000_000_000
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SKIP_ICON = "⊘"
const MAX_ROWS = 4
const SUCCESS_MUTED = "#7aa684"
const PENDING_POLL_MS = 15_000
const BURST_POLL_MS = 5_000
const BURST_WINDOW_MS = 15_000
const IDLE_REFRESH_MS = 60_000
// ── Types ──

type PrData = { url: string; num: string; title: string } | null
type CiOverallState = "fail" | "pending" | "pass" | null
type CiCheck = { name: string; state: string; bucket?: string; workflow: string; link: string; startedAt: string; completedAt: string }
type CiData = { checks: CiCheck[]; ts: number } | null
type RepoData = { dir: string; branch?: string }

const PENDING = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "EXPECTED", "STALE"])
const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"])
const SKIP = new Set(["SKIPPED", "NEUTRAL"])

const isPending = (s: string) => PENDING.has(s)
const isFail = (s: string) => FAIL.has(s)
const isSkip = (s: string) => SKIP.has(s)
const isPass = (s: string) => s === "SUCCESS"
const isReactionFail = (item: CiCheck) => item.bucket ? item.bucket === "fail" : item.state !== "CANCELLED" && isFail(item.state)
const isReactionPending = (item: CiCheck) => item.bucket ? item.bucket === "pending" : isPending(item.state)

// ── Helpers ──

const PATH = (process.env.PATH || "") + ":/opt/homebrew/bin"

const cmd = (bin: string, args: string[], dir: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(bin, args, { cwd: dir, timeout: 10000, env: { ...process.env, PATH } }, (err, stdout) => {
      resolve(err ? null : (stdout?.toString().trim() || null))
    })
  })

const gh = (args: string[], dir: string) => cmd("gh", args, dir)

const git = (args: string[], dir: string) => cmd("git", args, dir)

const openUrl = (url: string) => {
  execFile("open", [url], () => {})
}

const fmtSec = (sec: number): string => {
  if (sec <= 0) return ""
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

const elapsed = (started: string): string => {
  const t = new Date(started).getTime()
  if (t < BOGUS) return "queued"
  return fmtSec(Math.round((Date.now() - t) / 1000)) || "0s"
}

const spanDuration = (items: CiCheck[]): string => {
  let lo = Infinity
  let hi = 0
  for (const c of items) {
    if (!c.startedAt || !c.completedAt) continue
    const s = new Date(c.startedAt).getTime()
    const e = new Date(c.completedAt).getTime()
    if (s < BOGUS) continue
    if (s < lo) lo = s
    if (e > hi) hi = e
  }
  if (!isFinite(lo) || hi <= lo) return ""
  return fmtSec(Math.round((hi - lo) / 1000))
}

const ciOverall = (checks: CiCheck[] | undefined): CiOverallState => {
  if (!checks || checks.length === 0) return null
  if (checks.some((c) => isFail(c.state))) return "fail" as const
  if (checks.some((c) => isPending(c.state))) return "pending" as const
  return "pass" as const
}

const ciReactionOverall = (checks: CiCheck[] | undefined): CiOverallState => {
  if (!checks || checks.length === 0) return null
  if (checks.some(isReactionFail)) return "fail"
  if (checks.some(isReactionPending)) return "pending"
  return "pass"
}

const parse = <T,>(res: T | { data?: T }) => {
  if (res && typeof res === "object" && "data" in res) return res.data
  return res
}

const branch = async (dir: string) => {
  const out = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)
  if (!out || out === "HEAD") return undefined
  return out
}

const sessionDir = async (api: TuiPluginApi, sid: string) => {
  const res = await api.client.session.get({ sessionID: sid }).catch(() => null)
  const data = res ? parse(res as { data?: { directory?: string } }) : null
  if (!data || typeof data !== "object") return null
  return typeof (data as { directory?: string }).directory === "string" ? (data as { directory?: string }).directory : null
}

const parsePr = (out: string | null): PrData => {
  if (!out) return null
  const lines = out.split("\n")
  if (lines.length < 3) return null
  const [title, url, num] = lines
  return title && url && num ? { title, url, num } : null
}

const prViewArgs = ["--json", "title,url,number", "-q", '.title + "\\n" + .url + "\\n" + (.number|tostring)']

const resolvePr = async (dir: string, head?: string) => {
  if (head) {
    const explicit = parsePr(await gh(["pr", "view", head, ...prViewArgs], dir))
    if (explicit) return explicit

    return parsePr(await gh([
      "pr",
      "list",
      "--head",
      head,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "title,url,number",
      "-q",
      '.[0] | if . then .title + "\\n" + .url + "\\n" + (.number|tostring) else empty end',
    ], dir))
  }

  return parsePr(await gh(["pr", "view", ...prViewArgs], dir))
}

const parseCi = (out: string | null): CiData => {
  if (!out) return null
  try {
    return { checks: JSON.parse(out) as CiCheck[], ts: Date.now() }
  } catch {
    return null
  }
}

const ciArgs = ["--json", "name,state,bucket,workflow,link,startedAt,completedAt"]

const resolveCi = async (dir: string, head?: string) => {
  if (head) return parseCi(await gh(["pr", "checks", head, ...ciArgs], dir))
  return parseCi(await gh(["pr", "checks", ...ciArgs], dir))
}

const middle = (txt: string, max = 22) => {
  if (txt.length <= max) return txt
  const keep = max - 3
  const left = Math.min(Math.ceil(keep / 3), keep)
  const right = keep - left
  return txt.slice(0, left) + "..." + txt.slice(-right)
}

const checkLabel = (item: CiCheck) => {
  const wf = item.workflow || ""
  return wf && wf !== item.name ? `${wf} / ${item.name}` : item.name
}

const failurePrompt = (pr: PrData, branch: string | undefined, checks: CiCheck[]) => {
  const lines = [
    `GitHub CI just failed${pr ? ` for PR #${pr.num}` : ""}${branch ? ` on branch ${branch}` : ""}.`,
  ]
  const failing = checks.filter(isReactionFail).slice(0, 5)
  if (failing.length > 0) {
    lines.push("Failing checks:")
    for (const item of failing) {
      const parts = [`- ${checkLabel(item)}`, item.state]
      if (item.link) parts.push(item.link)
      lines.push(parts.join(" - "))
    }
  }
  if (pr?.url) lines.push(`PR: ${pr.url}`)
  lines.push("Investigate the failing checks and take the next appropriate action.")
  return lines.join("\n")
}

const ms = (item: CiCheck & { queued: boolean }) => {
  const s = new Date(item.startedAt).getTime()
  if (s < BOGUS) return -1
  if (isPending(item.state) && !item.queued) return Date.now() - s
  const e = new Date(item.completedAt).getTime()
  if (!isFinite(e) || e <= s) return -1
  return e - s
}

const CheckRow = (props: { item: CiCheck; theme: TuiPluginApi["theme"]["current"]; spin: number; labelMax: number }) => {
  const icon = isFail(props.item.state) ? "✗" : isPending(props.item.state) ? SPINNER[props.spin] : isSkip(props.item.state) ? SKIP_ICON : "✓"
  const color = isFail(props.item.state) ? props.theme.error : isPending(props.item.state) ? props.theme.warning : isSkip(props.item.state) ? props.theme.textMuted : props.theme.success
  const dur = isPending(props.item.state) ? elapsed(props.item.startedAt) : isSkip(props.item.state) ? "" : spanDuration([props.item])
  return (
    <box flexDirection="row" width="100%" justifyContent="space-between" height={1} backgroundColor={props.theme.backgroundPanel}>
      <text fg={props.theme.textMuted} overflow="hidden" flexShrink={1} wrapMode="none">{middle(checkLabel(props.item), props.labelMax)}</text>
      <text fg={props.theme.textMuted} flexShrink={0} wrapMode="none">
        {dur ? `${dur} ` : ""}
        <span style={{ fg: color }}>{icon}</span>
      </text>
    </box>
  )
}

const PlaceholderRow = (props: {
  theme: TuiPluginApi["theme"]["current"]
  left: string
  right?: string
  panel?: boolean
}) => (
  <box
    flexDirection="row"
    width="100%"
    justifyContent="space-between"
    height={1}
    backgroundColor={props.panel ? props.theme.backgroundPanel : undefined}
  >
    <text fg={props.theme.textMuted} wrapMode="none">{props.left}</text>
    {props.right ? <text fg={props.theme.textMuted} wrapMode="none">{props.right}</text> : null}
  </box>
)

const autoReactKey = (sid: string) => `ci_auto_react:${sid}`

const View = (props: { api: TuiPluginApi; session_id: string }) => {
  const [repo, setRepo] = createSignal<RepoData | null>(null)
  const [pr, setPr] = createSignal<PrData>(null)
  const [ci, setCi] = createSignal<CiData>(null)
  const [spin, setSpin] = createSignal(0)
  const [autoReact, setAutoReact] = createSignal(true)
  const [loading, setLoading] = createSignal(true)
  const [collapseHover, setCollapseHover] = createSignal(false)
  const [summaryHover, setSummaryHover] = createSignal(false)
  const [autofixHover, setAutofixHover] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal(false)
  const toggleCollapse = () => setCollapsed(!collapsed())

  const theme = createMemo(() => props.api.theme.current)
  const toggleAutoReact = () => {
    const next = !autoReact()
    setAutoReact(next)
    props.api.kv.set(autoReactKey(props.session_id), next)
  }
  const location = createMemo(() => {
    const dir = repo()?.dir || ""
    const home = process.env.HOME ?? ""
    const display = home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
    return {
      branch: repo()?.branch || "",
      path: display,
    }
  })
  const showPlaceholders = createMemo(() => loading() && !repo() && !pr() && !ci())
  const state = createMemo(() => {
    const data = ci()?.checks ?? []
    let failN = 0, pendN = 0, passN = 0, skipN = 0
    for (const item of data) {
      if (isFail(item.state)) failN++
      else if (isPending(item.state)) pendN++
      else if (isPass(item.state)) passN++
      else if (isSkip(item.state)) skipN++
    }
    const checks = data.map((item) => ({
      ...item,
      queued: isPending(item.state) && new Date(item.startedAt).getTime() < BOGUS,
    }))
    checks.sort((a, b) => {
      const order = (item: typeof checks[0]) =>
        isPending(item.state) && !item.queued ? 0
        : isFail(item.state) ? 1
        : isPending(item.state) && item.queued ? 2
        : isPass(item.state) ? 3
        : 4
      const diff = order(a) - order(b)
      if (diff !== 0) return diff
      const time = ms(b) - ms(a)
      if (time !== 0) return time
      return a.name.localeCompare(b.name)
    })
    const hasChecks = checks.length > 0
    const limit = checks.length > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS
    const visible = checks.slice(0, limit)
    const rest = Math.max(0, checks.length - limit)
    const parts: { count: number; icon: string; color: TuiPluginApi["theme"]["current"]["text"] }[] = []
    if (skipN) parts.push({ count: skipN, icon: SKIP_ICON, color: theme().textMuted })
    if (failN) parts.push({ count: failN, icon: "✗", color: theme().error })
    if (pendN) parts.push({ count: pendN, icon: SPINNER[spin()], color: theme().warning })
    if (passN) parts.push({ count: passN, icon: "✓", color: theme().success })
    let maxDur = 0
    for (const item of visible) {
      const dur = isPending(item.state) ? elapsed(item.startedAt) : isSkip(item.state) ? "" : spanDuration([item])
      if (dur.length > maxDur) maxDur = dur.length
    }
    // right side: "{dur} {icon}" → dur + 1 space + 1 icon; plus 1 space gap from label
    const labelMax = maxDur > 0 ? 38 - maxDur - 3 : 38
    return {
      failN,
      hasChecks,
      labelMax,
      passN,
      pendN,
      parts,
      rest,
      skipN,
      visible,
    }
  })
  const showGithub = createMemo(() => Boolean(pr()) || state().hasChecks)
  const panelRows = createMemo(() => {
    const rows: Array<
      | { kind: "check"; item: CiCheck }
      | { kind: "footer" }
    > = state().visible.map((item) => ({ kind: "check" as const, item }))
    rows.push({ kind: "footer" })
    return rows
  })
  const footerStats = createMemo(() => {
    const items: Array<{
      label: string
      icon: string
      color: TuiPluginApi["theme"]["current"]["text"]
      labelColor?: TuiPluginApi["theme"]["current"]["text"]
    }> = []
    if (state().skipN) items.push({ label: String(state().skipN), icon: SKIP_ICON, color: theme().text })
    if (state().failN) {
      items.push({
        label: String(state().failN),
        icon: "✗",
        color: theme().error,
        labelColor: theme().text,
      })
    }
    if (state().pendN) items.push({ label: String(state().pendN), icon: SPINNER[spin()], color: theme().warning })
    if (state().passN) items.push({ label: String(state().passN), icon: "✓", color: theme().success })
    return (
      <span>
        {items.map((item, index) => (
          <span>
            {index > 0 ? <span style={{ fg: theme().textMuted }}> · </span> : null}
            <span style={{ fg: item.labelColor ?? theme().text }}>{item.label}</span>
            {" "}
            <span style={{ fg: item.color }}>{item.icon}</span>
          </span>
        ))}
      </span>
    )
  })
  const prLinkStatus = createMemo(() => {
    const t = theme()
    if (summaryHover()) return { icon: "↗", color: t.text }
    const overall = ciOverall(ci()?.checks)
    if (overall === "fail") return { icon: "✗", color: t.error }
    if (overall === "pending") return { icon: SPINNER[spin()], color: t.warning }
    if (overall === "pass") return { icon: "✓", color: SUCCESS_MUTED }
    return { icon: "↗", color: t.textMuted }
  })

  let spinTimer: ReturnType<typeof setInterval> | null = null
  let ciTimer: ReturnType<typeof setTimeout> | null = null
  let burst = 0
  let token = 0
  let lastIdleLoad = 0
  let seenReactionState = false
  let lastReactionState: CiOverallState = null

  const stopSpin = () => {
    if (!spinTimer) return
    clearInterval(spinTimer)
    spinTimer = null
  }

  const startSpin = () => {
    if (spinTimer) return
    spinTimer = setInterval(() => {
      setSpin((i) => (i + 1) % SPINNER.length)
    }, 80)
  }

  const stopCi = () => {
    if (!ciTimer) return
    clearTimeout(ciTimer)
    ciTimer = null
  }

  const schedule = (sid: string, dir: string) => {
    stopCi()
    const checks = ci()?.checks
    const hasPending = checks?.some((c) => isPending(c.state))
    if (hasPending) startSpin()
    else stopSpin()
    const now = Date.now()
    const delay = hasPending
      ? PENDING_POLL_MS
      : now < burst
        ? BURST_POLL_MS
        : 0
    if (!delay) return
    ciTimer = setTimeout(() => void poll(sid, dir, token), delay)
  }

  const reactToFailure = async (sid: string, dir: string, nextPr: PrData, nextBranch: string | undefined, next: NonNullable<CiData>) => {
    props.api.ui.toast({
      variant: "error",
      title: "GitHub CI failed",
      message: autoReact() ? "Notifying the agent." : "CI checks entered a failing state.",
    })
    if (!autoReact()) return
    const res = await props.api.client.session.promptAsync({
      sessionID: sid,
      directory: dir,
      parts: [{ type: "text", text: failurePrompt(nextPr, nextBranch, next.checks) }],
    }, { throwOnError: true }).catch(() => null)
    if (!res) {
      props.api.ui.toast({
        variant: "error",
        title: "GitHub CI failed",
        message: "Failed to notify the agent.",
      })
    }
  }

  const applyCi = (sid: string, dir: string, next: CiData, nextPr: PrData = pr(), nextBranch: string | undefined = repo()?.branch) => {
    if (next) {
      // Stabilise the elapsed counter: keep the first-seen startedAt for
      // pending checks so upstream timestamp jitter doesn't make the
      // seconds counter jump backward. Once a check finishes we accept
      // the final upstream timestamps.
      const prev = ci()
      if (prev) {
        const old = new Map(prev.checks.map((c) => [c.name + "\0" + c.workflow, c]))
        for (const c of next.checks) {
          if (!isPending(c.state)) continue
          const o = old.get(c.name + "\0" + c.workflow)
          if (!o) continue
          const oStart = new Date(o.startedAt).getTime()
          const nStart = new Date(c.startedAt).getTime()
          if (oStart >= BOGUS || nStart < BOGUS) continue
          if (oStart <= nStart) c.startedAt = o.startedAt
        }
      }
      const prevReaction = seenReactionState ? lastReactionState : null
      const current = ciReactionOverall(next.checks)
      const shouldReact = seenReactionState && prevReaction !== "fail" && current === "fail"
      seenReactionState = true
      lastReactionState = current
      setCi(next)
      if (shouldReact) void reactToFailure(sid, dir, nextPr, nextBranch, next)
      return
    }
    setCi(next)
  }

  const poll = async (sid: string, dir: string, run: number) => {
    const next = await resolveCi(dir, repo()?.branch)
    if (run !== token) return
    if (next || Date.now() < burst) applyCi(sid, dir, next)
    schedule(sid, dir)
  }

  const load = async (sid: string, noisy: boolean) => {
    const run = ++token
    if (noisy) burst = Date.now() + BURST_WINDOW_MS
    stopCi()
    const dir = await sessionDir(props.api, sid)
    if (run !== token) return
    if (!dir) {
      setRepo(null)
      setPr(null)
      setCi(null)
      setLoading(false)
      stopSpin()
      return
    }
    const head = await branch(dir)
    if (run !== token) return
    const [checks, nextPr] = await Promise.all([
      resolveCi(dir, head),
      resolvePr(dir, head),
    ])
    if (run !== token) return
    setRepo({ dir, branch: head })
    setPr(nextPr)
    props.api.kv.set(`shared:pr:${sid}`, nextPr)
    applyCi(sid, dir, checks, nextPr, head)
    setLoading(false)
    schedule(sid, dir)
  }

  createEffect(on(() => props.session_id, (sid) => {
    setLoading(true)
    setRepo(null)
    setPr(null)
    setCi(null)
    seenReactionState = false
    lastReactionState = null
    setAutoReact(props.api.kv.get(autoReactKey(sid), true))
    void load(sid, true)

    const offIdle = props.api.event.on("session.idle", (evt) => {
      if ((evt as { properties?: { sessionID?: string } }).properties?.sessionID !== sid) return
      if (Date.now() - lastIdleLoad < IDLE_REFRESH_MS) return
      lastIdleLoad = Date.now()
      void load(sid, true)
    })

    const offBranch = props.api.event.on("vcs.branch.updated", () => {
      if (!repo()?.dir) return
      void load(sid, true)
    })

    onCleanup(() => {
      offIdle()
      offBranch()
      token++
      stopCi()
      stopSpin()
    })
  }, { defer: false }))

  return (
    <box>
      {showGithub() ? (
        <box flexDirection="column" backgroundColor={theme().backgroundPanel}>
          <box flexDirection="row" width="100%" justifyContent="space-between" height={1} backgroundColor={theme().backgroundPanel}>
            <box flexDirection="row" flexShrink={1}>
              <text fg={theme().text} flexShrink={0} wrapMode="none" onMouseOver={() => setCollapseHover(true)} onMouseOut={() => setCollapseHover(false)} onMouseUp={toggleCollapse}>
                <span style={{ fg: collapseHover() ? theme().text : theme().textMuted }}>{collapsed() ? "▶" : "▼"}</span>
                {" "}GitHub{" "}
              </text>
              <text fg={autoReact() ? theme().text : autofixHover() ? (theme().textFaded ?? theme().textMuted) : theme().textMuted} wrapMode="none" flexShrink={0} onMouseOver={() => setAutofixHover(true)} onMouseOut={() => setAutofixHover(false)} onMouseUp={toggleAutoReact}>
                {autoReact() ? <span style={{ fg: theme().success }}><b>•</b></span> : <span style={{ fg: theme().textMuted }}>·</span>}
                {" "}Watch
              </text>
            </box>
            {pr() ? (
              <text fg={summaryHover() ? theme().text : theme().textMuted} wrapMode="none" flexShrink={0} onMouseOver={() => setSummaryHover(true)} onMouseOut={() => setSummaryHover(false)} onMouseUp={() => openUrl(pr()!.url)}>
                #{pr()!.num}{" "}
                <span style={{ fg: prLinkStatus().color }}>{prLinkStatus().icon}</span>
              </text>
            ) : (
              <text fg={theme().textMuted} wrapMode="none" flexShrink={0}>
                <span style={{ fg: prLinkStatus().color }}>{prLinkStatus().icon}</span>
              </text>
            )}
          </box>
          {!collapsed() ? (
            <For each={panelRows()}>
              {(row) => row.kind === "check" ? (
                <CheckRow item={row.item} theme={theme()} spin={spin()} labelMax={state().labelMax} />
              ) : (
                <box flexDirection="row" width="100%" justifyContent="flex-end" height={1} backgroundColor={theme().backgroundPanel}>
                  <text fg={theme().textMuted} wrapMode="none">{footerStats()}</text>
                </box>
              )}
            </For>
          ) : null}
        </box>
      ) : null}

      {showPlaceholders() ? (
        <box flexDirection="column" marginTop={1}>
          <PlaceholderRow theme={theme()} left="---" />
          <PlaceholderRow theme={theme()} left="---" />
        </box>
      ) : (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme().textMuted} overflow="hidden" wrapMode="none">{location().path}</text>
          {location().branch ? <text fg={theme().text} wrapMode="none">{location().branch}</text> : null}
        </box>
      )}
      <box marginTop={1}>
        <text fg={theme().textMuted}>
          <span style={{ fg: theme().success }}>•</span> <b>Open</b>
          <span style={{ fg: theme().text }}><b>Code</b></span>{" "}
          <span>{props.api.app.version}</span>
        </text>
      </box>
    </box>
  )
}

// ── Footer slot ──

const footer = (api: TuiPluginApi): TuiSlotPlugin => ({
  order: 50,
  slots: {
    sidebar_footer(_ctx, value) {
      return <View api={api} session_id={value.session_id} />
    },
  },
})

// ── Init ──

const tui: TuiPlugin = async (api) => {
  api.slots.register(footer(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "custom-sidebar-context",
  tui,
}

export default plugin

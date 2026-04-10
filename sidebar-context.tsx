/**
 * OpenCode TUI Plugin — Sidebar Context
 * Displays CI checks, PR info, session cost, and working directory in the sidebar footer.
 */

/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"
import { exec as execCb, execFile } from "node:child_process"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const BOGUS = 1_000_000_000_000
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const MAX_ROWS = 7

// ── Types ──

type PrData = { url: string; num: string } | null
type CiCheck = { name: string; state: string; workflow: string; link: string; startedAt: string; completedAt: string }
type CiData = { checks: CiCheck[]; ts: number } | null

const PENDING = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "EXPECTED", "STALE"])
const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"])
const SKIP = new Set(["SKIPPED", "NEUTRAL"])

const isPending = (s: string) => PENDING.has(s)
const isFail = (s: string) => FAIL.has(s)
const isSkip = (s: string) => SKIP.has(s)
const isPass = (s: string) => s === "SUCCESS"

// ── Helpers ──

const PATH = (process.env.PATH || "") + ":/opt/homebrew/bin"

const gh = (args: string[], dir: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("gh", args, { cwd: dir, timeout: 10000, env: { ...process.env, PATH } }, (err, stdout) => {
      resolve(err ? null : (stdout?.toString().trim() || null))
    })
  })

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

const ciOverall = (checks: CiCheck[] | undefined) => {
  if (!checks || checks.length === 0) return null
  if (checks.some((c) => isFail(c.state))) return "fail" as const
  if (checks.some((c) => isPending(c.state))) return "pending" as const
  return "pass" as const
}

// ── Cost tracking ──

const childCosts: Record<string, { cost: number; count: number }> = {}

const sumCost = (msgs: ReadonlyArray<{ role: string; cost?: number }>): number => {
  let total = 0
  for (const m of msgs) {
    if (m.role === "assistant") total += (m as { cost: number }).cost ?? 0
  }
  return total
}

const fetchChildren = async (api: TuiPluginApi, sid: string) => {
  try {
    const res = await api.client.session.children({ sessionID: sid })
    const children = (res as any).data ?? res
    if (!Array.isArray(children)) return

    let cost = 0
    let count = 0

    for (const child of children) {
      const cid = typeof child === "string" ? child : child?.id
      if (!cid) continue
      count++
      const cached = api.state.session.messages(cid)
      if (cached && cached.length > 0) {
        cost += sumCost(cached)
        continue
      }
      try {
        const r = await api.client.session.messages({ sessionID: cid })
        const items = (r as any).data ?? r
        if (Array.isArray(items)) {
          for (const item of items) {
            const info = (item as any).info ?? item
            if (info.role === "assistant") cost += info.cost ?? 0
          }
        }
      } catch {}
    }

    childCosts[sid] = { cost, count }
  } catch {}
}

// ── Spinner ──

let spinTimer: ReturnType<typeof setInterval> | null = null

const startSpinner = (api: TuiPluginApi) => {
  if (spinTimer) return
  spinTimer = setInterval(() => {
    const i: number = api.kv.get("spin", 0)
    api.kv.set("spin", (i + 1) % SPINNER.length)
  }, 80)
}

const stopSpinner = () => {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null }
}

// ── CI polling ──

let ciTimer: ReturnType<typeof setTimeout> | null = null
let ciFetching = false
let burstUntil = 0

const startBurst = () => { burstUntil = Date.now() + 30_000 }

const stopCi = () => {
  if (ciTimer) { clearTimeout(ciTimer); ciTimer = null }
}

const scheduleCi = (api: TuiPluginApi, dir: string) => {
  stopCi()
  const ci = api.kv.get<CiData>("ci", null)
  const st = ciOverall(ci?.checks)
  if (st === "pending") startSpinner(api)
  else stopSpinner()
  if (st === "pending" || Date.now() < burstUntil) {
    ciTimer = setTimeout(() => fetchCi(api, dir), 1_000)
  }
}

const fetchCi = async (api: TuiPluginApi, dir: string) => {
  if (ciFetching) return
  ciFetching = true
  try {
    const out = await gh(["pr", "checks", "--json", "name,state,workflow,link,startedAt,completedAt"], dir)
    if (out) {
      try { api.kv.set("ci", { checks: JSON.parse(out), ts: Date.now() }) }
      catch { /* keep stale data on parse error */ }
    } else {
      const stale: CiData = api.kv.get("ci", null)
      if (!stale || Date.now() >= burstUntil) api.kv.set("ci", null)
    }
  } finally {
    ciFetching = false
  }
  scheduleCi(api, dir)
}

const fetchPr = async (api: TuiPluginApi, dir: string) => {
  const out = await gh(["pr", "view", "--json", "url,number", "-q", ".url + \" \" + (.number|tostring)"], dir)
  if (!out) {
    const stale: PrData = api.kv.get("pr", null)
    if (!stale || Date.now() >= burstUntil) api.kv.set("pr", null)
    return
  }
  const idx = out.lastIndexOf(" ")
  api.kv.set("pr", { url: out.slice(0, idx), num: out.slice(idx + 1) })
}

// ── Check row component ──

const CheckRow = (props: { name: string; dur: string; icon: string; color: any; fg: any; muted: any; link: string }) => (
  <box flexDirection="row" width="100%" justifyContent="space-between" height={1}>
    <text fg={props.fg} overflow="hidden" flexShrink={1}>{props.name}</text>
    <text fg={props.muted} flexShrink={0}> {props.dur ? `${props.dur} ` : ""}<span style={{ fg: props.color }}>{props.icon}</span> <span {...{ onMouseUp: () => openUrl(props.link) } as any}>↗</span></text>
  </box>
)

// ── Footer slot ──

const footer = (api: TuiPluginApi): TuiSlotPlugin => ({
  order: 50,
  slots: {
    sidebar_footer(_ctx, value) {
      const theme = api.theme.current
      const sid = value.session_id
      const msgs = api.state.session.messages(sid)
      const cc = childCosts[sid]
      const total = sumCost(msgs) + (cc?.cost ?? 0)

      // path
      const dir = api.state.path?.directory || ""
      const home = process.env.HOME ?? ""
      const display = home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
      const branch = api.state.vcs?.branch
      const full = branch ? display + ":" + branch : display
      const slash = full.lastIndexOf("/")
      const parent = slash >= 0 ? full.slice(0, slash) : ""
      const name = slash >= 0 ? full.slice(slash + 1) : full

      // reactive KV
      const pr = api.kv.get<PrData>("pr", null)
      const ci = api.kv.get<CiData>("ci", null)
      const spinIdx = api.kv.get<number>("spin", 0)
      const expanded = api.kv.get<boolean>("ci_expanded", false)

      const st = ciOverall(ci?.checks)
      const badge = st === "fail" ? "✗" : st === "pending" ? SPINNER[spinIdx] : st === "pass" ? "✓" : null
      const badgeColor = st === "fail" ? theme.error : st === "pending" ? theme.warning : theme.success

      // single-pass summary counts
      let failN = 0, pendN = 0, passN = 0, skipN = 0
      if (ci) {
        for (const c of ci.checks) {
          if (isFail(c.state)) failN++
          else if (isPending(c.state)) pendN++
          else if (isPass(c.state)) passN++
          else if (isSkip(c.state)) skipN++
        }
      }
      const summary: string[] = []
      if (failN) summary.push(`${failN} failed`)
      if (pendN) summary.push(`${pendN} pending`)
      if (passN) summary.push(`${passN} passed`)
      if (skipN) summary.push(`${skipN} skipped`)

      // build visible check list
      const hasChecks = ci && ci.checks.length > 0
      let visible: (CiCheck & { queued: boolean })[] = []
      let rest = 0

      if (hasChecks) {
        const checks = ci!.checks.map((c) => ({
          ...c,
          queued: isPending(c.state) && new Date(c.startedAt).getTime() < BOGUS,
        }))
        // in progress → failed → queued → passed → skipped, alpha within each
        checks.sort((a, b) => {
          const order = (c: typeof checks[0]) =>
            isPending(c.state) && !c.queued ? 0
            : isFail(c.state) ? 1
            : isPending(c.state) && c.queued ? 2
            : isPass(c.state) ? 3
            : 4
          const d = order(a) - order(b)
          if (d !== 0) return d
          return a.name.localeCompare(b.name)
        })
        const filtered = expanded ? checks : checks.filter((c) => isFail(c.state) || isPending(c.state))
        visible = filtered.slice(0, MAX_ROWS)
        rest = filtered.length - MAX_ROWS
      }

      const pad = MAX_ROWS - visible.length - (rest > 0 ? 1 : 0)

      return (
        <box gap={1}>
          {/* CI checks — fixed height */}
          <box flexDirection="column" height={MAX_ROWS + 1}>
            <box height={1} flexDirection="row" width="100%" justifyContent="space-between" onMouseUp={() => hasChecks && api.kv.set("ci_expanded", !expanded)}>
              <text fg={theme.text} overflow="hidden" flexShrink={1}>{hasChecks ? (expanded ? "▼" : "▶") : " "} {hasChecks ? summary.join(", ") : " "}</text>
              {hasChecks ? <text fg={badgeColor} flexShrink={0}>{badge}</text> : null}
            </box>
            {visible.map((c) => {
              const wf = c.workflow || ""
              const icon = isFail(c.state) ? "✗" : isPending(c.state) ? SPINNER[spinIdx] : isSkip(c.state) ? "–" : "✓"
              const color = isFail(c.state) ? theme.error : isPending(c.state) ? theme.warning : isSkip(c.state) ? theme.textMuted : theme.success
              const dur = isPending(c.state) ? elapsed(c.startedAt) : isSkip(c.state) ? "" : spanDuration([c])
              const label = wf && wf !== c.name ? `${wf} / ${c.name}` : c.name
              return <CheckRow name={label} dur={dur} icon={icon} color={color} fg={theme.text} muted={theme.textMuted} link={c.link} />
            })}
            {rest > 0 ? (
              <box flexDirection="row" width="100%" justifyContent="space-between" height={1}>
                <text fg={theme.textMuted}>+{rest} more</text>
                <text fg={theme.textMuted} onMouseUp={() => {
                  if (pr) openUrl(pr.url + "/checks")
                  else if (visible[0]) openUrl(visible[0].link)
                }}>↗</text>
              </box>
            ) : null}
            {Array.from({ length: Math.max(0, pad) }, () => <text> </text>)}
          </box>

          {/* Spent + PR */}
          <text> </text>
          <text fg={theme.text}>
            <b>Spent</b> {money.format(total)}
            {pr ? (
              <span>
                {" · "}
                <span {...{ style: { fg: theme.primary }, onMouseUp: () => openUrl(pr.url) } as any}>#{pr.num}</span>
                {" "}
                <span {...{ style: { fg: theme.textMuted }, onMouseUp: () => openUrl(pr.url) } as any}>↗</span>
              </span>
            ) : null}
          </text>

          {/* Path + version */}
          <text>
            <span style={{ fg: theme.textMuted }}>{parent}/</span>
            <span style={{ fg: theme.text }}>{name}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}><b>Code</b></span>{" "}
            <span>{api.app.version}</span>
          </text>
        </box>
      )
    },
  },
})

// ── Init ──

const tui: TuiPlugin = async (api) => {
  api.slots.register(footer(api))
  // clear stale data from previous project/session
  api.kv.set("pr", null)
  api.kv.set("ci", null)

  const dir = api.state.path?.directory
  if (dir) {
    startBurst()
    fetchPr(api, dir)
    fetchCi(api, dir)
  }

  // agent turn finished — refresh costs, conditionally refresh CI/PR
  api.event.on("session.idle", (evt) => {
    const sid = (evt as any).properties?.sessionID
    if (sid) fetchChildren(api, sid)
    const d = api.state.path?.directory
    if (!d) return
    // always burst after agent turn — it may have pushed new code
    startBurst()
    fetchPr(api, d)
    if (!ciTimer) fetchCi(api, d)
  })

  api.event.on("message.updated", (evt) => {
    const sid = (evt as any).properties?.info?.sessionID
    if (sid) fetchChildren(api, sid)
  })

  // branch change — re-fetch everything
  api.event.on("vcs.branch.updated", () => {
    stopCi()
    const d = api.state.path?.directory
    if (d) {
      startBurst()
      fetchPr(api, d)
      fetchCi(api, d)
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "custom-sidebar-context",
  tui,
}

export default plugin

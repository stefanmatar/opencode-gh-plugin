/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"
import { execFile } from "node:child_process"
const BOGUS = 1_000_000_000_000
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SKIP_ICON = "○"
const MAX_ROWS = 7

// ── Types ──

type PrData = { url: string; num: string } | null
type CiCheck = { name: string; state: string; workflow: string; link: string; startedAt: string; completedAt: string }
type CiData = { checks: CiCheck[]; ts: number } | null
type RepoData = { dir: string; branch?: string }

const PENDING = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "REQUESTED", "WAITING", "EXPECTED", "STALE"])
const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"])
const SKIP = new Set(["SKIPPED", "NEUTRAL"])

const isPending = (s: string) => PENDING.has(s)
const isFail = (s: string) => FAIL.has(s)
const isSkip = (s: string) => SKIP.has(s)
const isPass = (s: string) => s === "SUCCESS"

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

const ciOverall = (checks: CiCheck[] | undefined) => {
  if (!checks || checks.length === 0) return null
  if (checks.some((c) => isFail(c.state))) return "fail" as const
  if (checks.some((c) => isPending(c.state))) return "pending" as const
  return "pass" as const
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
  return typeof data?.directory === "string" ? data.directory : null
}

const parsePr = (out: string | null): PrData => {
  if (!out) return null
  const idx = out.lastIndexOf(" ")
  if (idx <= 0 || idx >= out.length - 1) return null
  return { url: out.slice(0, idx), num: out.slice(idx + 1) }
}

const parseCi = (out: string | null): CiData => {
  if (!out) return null
  try {
    return { checks: JSON.parse(out) as CiCheck[], ts: Date.now() }
  } catch {
    return null
  }
}

const middle = (txt: string, max = 22) => {
  if (txt.length <= max) return txt
  const left = Math.ceil((max - 3) / 2)
  const right = Math.floor((max - 3) / 2)
  return txt.slice(0, left) + "..." + txt.slice(-right)
}

// ── Check row component ──

const CheckRow = (props: { name: string; dur: string; icon: string; color: any; fg: any; muted: any; link: string }) => (
  <box flexDirection="row" width="100%" justifyContent="space-between" height={1}>
    <text fg={props.fg} overflow="hidden" flexShrink={1} wrapMode="none">{middle(props.name)}</text>
    <text fg={props.muted} flexShrink={0} wrapMode="none" onMouseUp={() => openUrl(props.link)}>
      {props.dur ? `${props.dur} ` : ""}
      <span style={{ fg: props.color }}>{props.icon}</span>
      {" ↗"}
    </text>
  </box>
)

const expandedKey = (sid: string) => `ci_expanded:${sid}`

const View = (props: { api: TuiPluginApi; session_id: string }) => {
  const [repo, setRepo] = createSignal<RepoData | null>(null)
  const [pr, setPr] = createSignal<PrData>(null)
  const [ci, setCi] = createSignal<CiData>(null)
  const [spin, setSpin] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)

  const theme = createMemo(() => props.api.theme.current)
  const toggleExpanded = () => {
    if (!state().hasChecks) return
    const next = !expanded()
    setExpanded(next)
    props.api.kv.set(expandedKey(props.session_id), next)
  }
  const location = createMemo(() => {
    const dir = repo()?.dir || ""
    const home = process.env.HOME ?? ""
    const display = home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
    const slash = display.lastIndexOf("/")
    return {
      branch: repo()?.branch || "",
      parent: slash >= 0 ? display.slice(0, slash) : "",
      name: slash >= 0 ? display.slice(slash + 1) : display,
    }
  })
  const state = createMemo(() => {
    const data = ci()?.checks ?? []
    let failN = 0, pendN = 0, passN = 0, skipN = 0
    for (const item of data) {
      if (isFail(item.state)) failN++
      else if (isPending(item.state)) pendN++
      else if (isPass(item.state)) passN++
      else if (isSkip(item.state)) skipN++
    }
    const summary: string[] = []
    if (failN) summary.push(`${failN} failed`)
    if (pendN) summary.push(`${pendN} pending`)
    if (passN) summary.push(`${passN} passed`)
    if (skipN) summary.push(`${skipN} skipped`)

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
      return a.name.localeCompare(b.name)
    })
    const hasChecks = checks.length > 0
    const filtered = expanded() ? checks : checks.filter((item) => isFail(item.state) || isPending(item.state))
    const limit = filtered.length > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS
    const visible = filtered.slice(0, limit)
    const rest = Math.max(0, filtered.length - limit)
    const parts: { count: number; icon: string; color: any }[] = []
    if (failN) parts.push({ count: failN, icon: "✗", color: theme().error })
    if (pendN) parts.push({ count: pendN, icon: SPINNER[spin()], color: theme().warning })
    if (passN) parts.push({ count: passN, icon: "✓", color: theme().success })
    if (skipN) parts.push({ count: skipN, icon: SKIP_ICON, color: theme().textMuted })
    return {
      failN,
      hasChecks,
      passN,
      pendN,
      parts,
      rest,
      skipN,
      summary,
      visible,
    }
  })

  let spinTimer: ReturnType<typeof setInterval> | null = null
  let ciTimer: ReturnType<typeof setTimeout> | null = null
  let burst = 0
  let token = 0

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
    const st = ciOverall(ci()?.checks)
    if (st === "pending") startSpin()
    else stopSpin()
    if (st !== "pending" && Date.now() >= burst) return
    ciTimer = setTimeout(() => void poll(sid, dir, token), 1_000)
  }

  const poll = async (sid: string, dir: string, run: number) => {
    const next = parseCi(await gh(["pr", "checks", "--json", "name,state,workflow,link,startedAt,completedAt"], dir))
    if (run !== token) return
    if (next || Date.now() < burst) setCi(next)
    schedule(sid, dir)
  }

  const load = async (sid: string, noisy: boolean) => {
    const run = ++token
    if (noisy) burst = Date.now() + 30_000
    stopCi()
    const dir = await sessionDir(props.api, sid)
    if (run !== token) return
    if (!dir) {
      setRepo(null)
      setPr(null)
      setCi(null)
      stopSpin()
      return
    }
    const [head, pull, checks] = await Promise.all([
      branch(dir),
      gh(["pr", "view", "--json", "url,number", "-q", ".url + \" \" + (.number|tostring)"], dir),
      gh(["pr", "checks", "--json", "name,state,workflow,link,startedAt,completedAt"], dir),
    ])
    if (run !== token) return
    setRepo({ dir, branch: head })
    setPr(parsePr(pull))
    setCi(parseCi(checks))
    schedule(sid, dir)
  }

  createEffect(() => {
    const sid = props.session_id
    setRepo(null)
    setPr(null)
    setCi(null)
    setExpanded(props.api.kv.get(expandedKey(sid), false))
    void load(sid, true)

    const offIdle = props.api.event.on("session.idle", (evt) => {
      if ((evt as { properties?: { sessionID?: string } }).properties?.sessionID !== sid) return
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
  })

  return (
    <box gap={1}>
      <box flexDirection="column" height={MAX_ROWS + 1} justifyContent="flex-end">
        <Show when={expanded()}>
          <For each={state().visible}>
            {(item) => {
              const wf = item.workflow || ""
              const icon = isFail(item.state) ? "✗" : isPending(item.state) ? SPINNER[spin()] : isSkip(item.state) ? SKIP_ICON : "✓"
              const color = isFail(item.state) ? theme().error : isPending(item.state) ? theme().warning : isSkip(item.state) ? theme().textMuted : theme().success
              const dur = isPending(item.state) ? elapsed(item.startedAt) : isSkip(item.state) ? "" : spanDuration([item])
              const label = wf && wf !== item.name ? `${wf} / ${item.name}` : item.name
              return <CheckRow name={label} dur={dur} icon={icon} color={color} fg={theme().text} muted={theme().textMuted} link={item.link} />
            }}
          </For>
          <Show when={state().rest > 0}>
            <box flexDirection="row" width="100%" justifyContent="space-between" height={1}>
              <text fg={theme().textMuted} wrapMode="none">+{state().rest} more</text>
              <text
                fg={theme().textMuted}
                wrapMode="none"
                onMouseUp={() => {
                  if (pr()) openUrl(pr()!.url + "/checks")
                  else if (state().visible[0]) openUrl(state().visible[0].link)
                }}
              >
                ↗
              </text>
            </box>
          </Show>
        </Show>
        <box height={1} flexDirection="row" width="100%" justifyContent="space-between">
          <text fg={theme().text} overflow="hidden" flexShrink={1} wrapMode="none" onMouseUp={toggleExpanded}>
            {state().hasChecks ? (expanded() ? "▼" : "▶") : " "}{" "}
            {state().summary.length ? "GitHub " : null}
            {state().parts.map((part, index) => (
              <span>
                {index > 0 ? <span style={{ fg: theme().textMuted }}> · </span> : null}
                {part.count}{" "}<span style={{ fg: part.color }}>{part.icon}</span>
              </span>
            ))}
            {!state().summary.length ? " " : null}
          </text>
          {pr() ? (
            <text fg={theme().textMuted} flexShrink={0} wrapMode="none" onMouseUp={() => openUrl(pr()!.url)}>
              <span style={{ fg: theme().primary }}>#{pr()!.num}</span>
              {" ↗"}
            </text>
          ) : null}
        </box>
      </box>

      <text> </text>

      <text>
        <span style={{ fg: theme().textMuted }}>{location().parent}/</span>
        <span style={{ fg: theme().textMuted }}>{location().name}</span>
      </text>
      {location().branch ? <text fg={theme().text}>{location().branch}</text> : null}
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}><b>Code</b></span>{" "}
        <span>{props.api.app.version}</span>
      </text>
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

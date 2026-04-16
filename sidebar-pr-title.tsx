/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"
import { execFile } from "node:child_process"

// ── Types ────────────────────────────────────────────────────────────────────

type PrData = { url: string; num: string; title: string } | null

// ── Helpers ──────────────────────────────────────────────────────────────────

const open = (url: string) => execFile("open", [url], () => {})

const truncate = (text: string, max: number) =>
  text.length <= max ? text : text.slice(0, max - 1) + "\u2026"

// ── View ─────────────────────────────────────────────────────────────────────

const SidebarTitle = (props: {
  api: TuiPluginApi
  session_id: string
  title: string
}) => {
  const theme = createMemo(() => props.api.theme.current)
  const [hover, setHover] = createSignal(false)

  // Read PR data written by sidebar-context plugin via shared KV
  const pr = createMemo((): PrData => props.api.kv.get(`shared:pr:${props.session_id}`, null))

  return (
    <box flexDirection="column" width="100%">
      {pr() ? (
        <box flexDirection="column" width="100%">
          <box
            flexDirection="row"
            width="100%"
            height={1}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={() => open(pr()!.url)}
          >
            <text fg={theme().text} wrapMode="none" overflow="hidden" flexShrink={1}>
              {truncate(pr()!.title, 34)}
            </text>
            <text flexShrink={0} wrapMode="none">
              {" "}
              <span style={{ fg: hover() ? theme().text : theme().textMuted, dimmed: !hover() }}>#{pr()!.num}</span>
              {" "}
              <span style={{ fg: hover() ? theme().text : "transparent" }}>↗</span>
            </text>
          </box>
        </box>
      ) : (
        <text fg={theme().text} wrapMode="wrap">
          <b>{props.title}</b>
        </text>
      )}
    </box>
  )
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const slot = (api: TuiPluginApi) => ({
  id: "sidebar-pr-title",
  order: 10,
  slots: {
    sidebar_title: (_ctx: any, value: any) => (
      <SidebarTitle api={api} session_id={value.session_id} title={value.title} />
    ),
  },
})

const tui: TuiPlugin = async (api) => api.slots.register(slot(api))

const plugin: TuiPluginModule & { id: string } = { id: "sidebar-pr-title", tui }
export default plugin

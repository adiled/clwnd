/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, createMemo, Show } from "solid-js"

interface DaemonData {
  status: "connected" | "disconnected"
  procs: number
  sessions: number
  uptimeMin: number
  readDedup: number
  bashCapped: number
  contextWarnings: number
}

const SOCK_PATH = (() => {
  const runtime = process.env.XDG_RUNTIME_DIR
  const sock = process.env.CLWND_SOCKET ?? (runtime ? `${runtime}/clwnd/clwnd.sock` : "/tmp/clwnd/clwnd.sock")
  return sock + ".http"
})()

async function fetchDaemon(): Promise<DaemonData> {
  try {
    const [statusResp, savingsResp] = await Promise.all([
      fetch("http://localhost/status", { unix: SOCK_PATH } as RequestInit),
      fetch("http://localhost/savings", { unix: SOCK_PATH } as RequestInit),
    ])
    const status = (await statusResp.json()) as any
    const savings = (await savingsResp.json()) as any
    const c = savings.counters ?? {}
    return {
      status: "connected",
      procs: (status.procs ?? []).length,
      sessions: status.sessions ?? 0,
      uptimeMin: Math.round((savings.uptimeMs ?? 0) / 60_000),
      readDedup: c.readDedupHits ?? 0,
      bashCapped: c.bashTruncated ?? 0,
      contextWarnings: c.contextOverThreshold ?? 0,
    }
  } catch {
    return {
      status: "disconnected", procs: 0, sessions: 0, uptimeMin: 0,
      readDedup: 0, bashCapped: 0, contextWarnings: 0,
    }
  }
}

function SidebarView(props: { api: any; session_id: string }) {
  const theme = () => props.api.theme.current
  const [data, setData] = createSignal<DaemonData>({
    status: "disconnected", procs: 0, sessions: 0, uptimeMin: 0,
    readDedup: 0, bashCapped: 0, contextWarnings: 0,
  })

  const poll = () => fetchDaemon().then(setData).catch(() => {})
  poll()
  const timer = setInterval(poll, 10_000)
  onCleanup(() => clearInterval(timer))

  const statusLine = createMemo(() => {
    const d = data()
    const dot = d.status === "connected" ? "●" : "○"
    return `${dot} ${d.status} · ${String(d.uptimeMin)}m`
  })

  const procsLine = createMemo(() => {
    const d = data()
    return `${String(d.procs)} proc${d.procs !== 1 ? "s" : ""} · ${String(d.sessions)} session${d.sessions !== 1 ? "s" : ""}`
  })

  const savingsLine = createMemo(() => {
    const d = data()
    if (d.readDedup === 0 && d.bashCapped === 0) return ""
    return `saved: ${String(d.readDedup)} dedup · ${String(d.bashCapped)} capped`
  })

  return (
    <box>
      <text fg={theme().text}><b>clwnd</b></text>
      <text fg={data().status === "connected" ? theme().success : theme().error}>{statusLine()}</text>
      <text fg={theme().textMuted}>{procsLine()}</text>
      <Show when={savingsLine() !== ""}>
        <text fg={theme().textMuted}>{savingsLine()}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <SidebarView api={api} session_id={props.session_id} />
      },
    },
  })
}

export default { id: "@clwnd/opencode", tui } satisfies TuiPluginModule & { id: string }

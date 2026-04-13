/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, createMemo, Show } from "solid-js"

const VERSION = (() => {
  try {
    const fs = require("fs")
    const path = require("path")
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))
    return pkg.version ?? "?"
  } catch {
    return "?"
  }
})()

interface DaemonData {
  status: "connected" | "disconnected"
  procs: number
  sessions: number
  dollarsSaved: number
  compactionsSaved: number
  corruptionsCaught: number
  editsBlocked: number
  jsonlBytesPruned: number
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
    const est = savings.estimated ?? {}
    return {
      status: "connected",
      procs: (status.procs ?? []).length,
      sessions: status.sessions ?? 0,
      dollarsSaved: est.dollarsSaved ?? 0,
      compactionsSaved: est.compactionsSaved ?? 0,
      corruptionsCaught: est.corruptionsCaught ?? 0,
      editsBlocked: est.editsBlocked ?? 0,
      jsonlBytesPruned: est.jsonlBytesPruned ?? 0,
    }
  } catch {
    return {
      status: "disconnected", procs: 0, sessions: 0,
      dollarsSaved: 0, compactionsSaved: 0, corruptionsCaught: 0,
      editsBlocked: 0, jsonlBytesPruned: 0,
    }
  }
}

function SidebarView(props: { api: any; session_id: string }) {
  const theme = () => props.api.theme.current
  const [data, setData] = createSignal<DaemonData>({
    status: "disconnected", procs: 0, sessions: 0,
    dollarsSaved: 0, compactionsSaved: 0, corruptionsCaught: 0,
    editsBlocked: 0, jsonlBytesPruned: 0,
  })

  const poll = () => fetchDaemon().then(setData).catch(() => {})
  poll()
  const timer = setInterval(poll, 10_000)
  onCleanup(() => clearInterval(timer))

  const dotColor = createMemo(() => {
    const d = data()
    if (d.status === "disconnected") return theme().textMuted
    if (d.procs > 0) return theme().success
    return theme().secondary
  })

  const savingsLine = createMemo(() => {
    const d = data()
    if (d.status === "disconnected") return ""
    const parts: string[] = []
    parts.push(`$${String(d.dollarsSaved)} saved`)
    if (d.compactionsSaved > 0) parts.push(`${String(d.compactionsSaved)} curated`)
    if (d.corruptionsCaught > 0) parts.push(`${String(d.corruptionsCaught)} caught`)
    if (d.editsBlocked > 0) parts.push(`${String(d.editsBlocked)} blocked`)
    return parts.join(" · ")
  })

  return (
    <box>
      <text fg={theme().textMuted}>
        <span style={{ fg: dotColor() }}>{"•"}</span>
        {" "}
        <b>{"clwnd"}</b>
        {" "}
        <span>{VERSION}</span>
      </text>
      <text fg={theme().textMuted}>
        {`${String(data().procs)} proc${data().procs !== 1 ? "s" : ""} · ${String(data().sessions)} session${data().sessions !== 1 ? "s" : ""}`}
      </text>
      <Show when={savingsLine() !== ""}>
        <text fg={data().dollarsSaved > 0 ? theme().success : theme().textMuted}>{savingsLine()}</text>
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

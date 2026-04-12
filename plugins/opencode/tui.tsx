/**
 * clwnd TUI plugin — sidebar widget showing daemon status + savings.
 *
 * Renders in OC's sidebar_content slot when the user is in a session.
 * Polls the daemon's HTTP endpoint on the unix socket for live data.
 */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup, createMemo } from "solid-js";

const id = "@clwnd/opencode";

// ─── Daemon data fetcher ────────────────────────────────────────────────────

interface DaemonData {
  status: "connected" | "disconnected";
  procs: number;
  sessions: number;
  uptimeMin: number;
  readDedup: number;
  bashCapped: number;
  contextWarnings: number;
}

const SOCK_PATH = (() => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const sock = process.env.CLWND_SOCKET ?? (runtime ? `${runtime}/clwnd/clwnd.sock` : "/tmp/clwnd/clwnd.sock");
  return sock + ".http";
})();

async function fetchDaemon(): Promise<DaemonData> {
  try {
    const [statusResp, savingsResp] = await Promise.all([
      fetch("http://localhost/status", { unix: SOCK_PATH } as RequestInit),
      fetch("http://localhost/savings", { unix: SOCK_PATH } as RequestInit),
    ]);
    const status = await statusResp.json() as any;
    const savings = await savingsResp.json() as any;
    const c = savings.counters ?? {};
    return {
      status: "connected",
      procs: (status.procs ?? []).length,
      sessions: status.sessions ?? 0,
      uptimeMin: Math.round((savings.uptimeMs ?? 0) / 60_000),
      readDedup: c.readDedupHits ?? 0,
      bashCapped: c.bashTruncated ?? 0,
      contextWarnings: c.contextOverThreshold ?? 0,
    };
  } catch {
    return {
      status: "disconnected",
      procs: 0, sessions: 0, uptimeMin: 0,
      readDedup: 0, bashCapped: 0, contextWarnings: 0,
    };
  }
}

// ─── Sidebar view ───────────────────────────────────────────────────────────

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current;
  const [data, setData] = createSignal<DaemonData>({
    status: "disconnected", procs: 0, sessions: 0, uptimeMin: 0,
    readDedup: 0, bashCapped: 0, contextWarnings: 0,
  });

  // Poll every 10s
  const poll = () => fetchDaemon().then(setData).catch(() => {});
  poll();
  const timer = setInterval(poll, 10_000);
  onCleanup(() => clearInterval(timer));

  const dot = createMemo(() => data().status === "connected" ? "●" : "○");
  const dotColor = createMemo(() => data().status === "connected" ? theme().success : theme().error);

  return (
    <box>
      <text fg={theme().text}>
        <b>clwnd</b>
      </text>
      <text>
        <text fg={dotColor()}>{dot()}</text>
        <text fg={theme().textMuted}> {data().status} · {data().uptimeMin}m uptime</text>
      </text>
      <text fg={theme().textMuted}>
        {data().procs} proc{data().procs !== 1 ? "s" : ""} · {data().sessions} session{data().sessions !== 1 ? "s" : ""}
      </text>
      {data().readDedup > 0 || data().bashCapped > 0 ? (
        <text fg={theme().textMuted}>
          saved: {data().readDedup} dedup · {data().bashCapped} capped
        </text>
      ) : null}
      {data().contextWarnings > 0 ? (
        <text fg={theme().warning}>
          ⚠ {data().contextWarnings} context warning{data().contextWarnings !== 1 ? "s" : ""}
        </text>
      ) : null}
    </box>
  );
}

// ─── Plugin entry ───────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200, // after OC's built-in Context (100), before Footer
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />;
      },
    },
  });
};

const plugin: TuiPluginModule = {
  tui,
};

export default plugin;

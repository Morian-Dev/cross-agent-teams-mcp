import Database from 'better-sqlite3'
import { resolveTmuxSocket, loadBuffer, pasteBuffer, sendEnter } from './tmux-cli.js'

// After a daemon restart, all MCP sessions are lost. Agents that were registered
// before the restart are still in the database but their sessions are orphaned.
// The channel proxy reconnects automatically and sends a startup_bind_hint, but
// idle Claude Code agents won't process the passive channel notification.
//
// This function sends a best-effort tmux poke to each local agent, telling them
// to call reconnect. The poke types text into the terminal, which triggers a new
// Claude Code turn and the agent processes the reconnect hint.
export async function pokeReconnectOnStartup(
  db: Database.Database,
  localDevice: string,
  delayMs = 3000
): Promise<void> {
  // Give the channel proxies time to reconnect and re-register before we poke.
  // If we poke too early, the agent wakes up, tries reconnect, but the proxy
  // hasn't re-registered yet → auto-bind fails.
  await new Promise(r => setTimeout(r, delayMs))

  const socketArgs = await resolveTmuxSocket()
  if (socketArgs.length === 0) return // no tmux server found

  const rows = db
    .prepare(
      `SELECT agent_id, tmux_pane_id, name
       FROM agents
       WHERE device = ?
         AND tmux_pane_id IS NOT NULL
         AND role != '__channel_proxy__'
         AND agent_type = 'claude-code'`
    )
    .all(localDevice) as Array<{ agent_id: string; tmux_pane_id: string; name: string }>

  if (rows.length === 0) return

  for (const row of rows) {
    const hint = `[xats daemon 重启] 请调 reconnect({ui_pid: $PPID})`
    const bufName = `reconnect-${row.agent_id.slice(0, 8)}`
    try {
      await loadBuffer(bufName, hint)
      await pasteBuffer(bufName, row.tmux_pane_id)
      await new Promise(r => setTimeout(r, 400))
      await sendEnter(row.tmux_pane_id)
    } catch {
      // best-effort — agent might be busy, pane might be dead
    }
  }
}
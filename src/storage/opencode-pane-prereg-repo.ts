import type Database from 'better-sqlite3'

export interface OpencodePanePreRegRow {
  pane_id: string
  base_url: string
  session_id: string
  expires_at: string
}

export interface OpencodePanePreRegUpsertInput {
  pane_id: string
  base_url: string
  session_id: string
  expires_at: string
}

export class OpencodePanePreRegRepo {
  constructor(private readonly db: Database.Database) {}

  put(input: OpencodePanePreRegUpsertInput): void {
    this.db
      .prepare(
        `INSERT INTO opencode_pane_pre_registrations (pane_id, base_url, session_id, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET
           base_url = excluded.base_url,
           session_id = excluded.session_id,
           expires_at = excluded.expires_at`
      )
      .run(input.pane_id, input.base_url, input.session_id, input.expires_at)
  }

  get(pane_id: string, now: string): OpencodePanePreRegRow | undefined {
    const row = this.db
      .prepare(
        `SELECT pane_id, base_url, session_id, expires_at
         FROM opencode_pane_pre_registrations
         WHERE pane_id = ? AND expires_at > ?`
      )
      .get(pane_id, now) as OpencodePanePreRegRow | undefined
    return row
  }

  listUnexpired(now: string): OpencodePanePreRegRow[] {
    return this.db
      .prepare(
        `SELECT pane_id, base_url, session_id, expires_at
         FROM opencode_pane_pre_registrations
         WHERE expires_at > ?`
      )
      .all(now) as OpencodePanePreRegRow[]
  }

  consume(pane_id: string, now: string): OpencodePanePreRegRow | undefined {
    const row = this.db
      .prepare(
        `DELETE FROM opencode_pane_pre_registrations
         WHERE pane_id = ? AND expires_at > ?
         RETURNING pane_id, base_url, session_id, expires_at`
      )
      .get(pane_id, now) as OpencodePanePreRegRow | undefined
    return row
  }

  purgeExpired(now: string): number {
    const res = this.db
      .prepare(`DELETE FROM opencode_pane_pre_registrations WHERE expires_at <= ?`)
      .run(now)
    return res.changes
  }
}

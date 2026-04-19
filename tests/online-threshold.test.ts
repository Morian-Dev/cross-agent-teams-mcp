import { describe, it, expect } from 'vitest'
import { ONLINE_MS } from '../src/storage/agents-repo.js'

describe('ONLINE_MS export', () => {
  it('is exported and equals 5 minutes in ms', () => {
    expect(ONLINE_MS).toBe(300000)
  })
})

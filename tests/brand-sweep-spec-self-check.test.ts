import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Build brand token at runtime so this file itself does not match any sweep.
const LEGACY_BRAND = ['ts', 'agent', 'teams'].join('-')
const SPEC_PATH = resolve(
  process.cwd(),
  'openspec/specs/daemon-core/spec.md'
)

describe('brand-sweep spec self-check', () => {
  it('daemon-core main spec file is literal-free', () => {
    const content = readFileSync(SPEC_PATH, 'utf8')
    expect(
      content.includes(LEGACY_BRAND),
      `daemon-core spec must not embed the legacy brand literal as a contiguous substring`
    ).toBe(false)
  })
})

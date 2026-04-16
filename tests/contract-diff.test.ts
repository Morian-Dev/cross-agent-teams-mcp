import { describe, it, expect } from 'vitest'
import { diffSchema } from '../src/lib/schema-diff.js'

describe('contract diff', () => {
  it('nested field uses /properties/.../properties/... pointer', () => {
    const from = { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'string' } } } } }
    const to   = { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'number' } } } } }
    const d = diffSchema(from, to)
    expect(d.changed_fields[0].path).toBe('/properties/user/properties/id')
  })

  it('removed field marks breaking', () => {
    const from = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }
    const to   = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const d = diffSchema(from, to)
    expect(d.removed_fields.map(f => f.path)).toContain('/properties/b')
    expect(d.breaking).toBe(true)
  })

  it('required false→true marks breaking', () => {
    const from = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }
    const to   = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a','b'] }
    const d = diffSchema(from, to)
    expect(d.breaking).toBe(true)
    expect(d.changed_fields.some(c => c.path === '/properties/b' && c.from.required === false && c.to.required === true)).toBe(true)
  })

  it('type change marks breaking', () => {
    const from = { type: 'object', properties: { a: { type: 'string' } } }
    const to   = { type: 'object', properties: { a: { type: 'number' } } }
    const d = diffSchema(from, to)
    expect(d.breaking).toBe(true)
    expect(d.changed_fields[0].from.type).toBe('string')
    expect(d.changed_fields[0].to.type).toBe('number')
  })

  it('adding optional field is non-breaking', () => {
    const from = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const to   = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }
    const d = diffSchema(from, to)
    expect(d.added_fields.map(f => f.path)).toContain('/properties/b')
    expect(d.breaking).toBe(false)
  })
})

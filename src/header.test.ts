// Brand-header projection: the fit policy that decides which parts of the
// header line render at a given width, and how each drops or truncates.
// Reference widths: brand 14, identity 'session a2ab797b' 16, model
// 'deepseek-v4-flash · deepseek-official' 37, cwd below 19.
import { describe, expect, it } from 'vitest'
import { HEADER_BRAND, projectHeader } from './ui.js'
import type { SessionInfo } from './ui.js'

const SESSION: SessionInfo = {
  id: 'a2ab797b-d282-4ddd-ae11-7feec253de57',
  model: 'deepseek-v4-flash',
  provider: 'deepseek-official',
  cwd: '/home/u/deepseek-tui',
}

const kinds = (line: { parts: readonly { kind: string }[] }): string[] => line.parts.map((part) => part.kind)

describe('projectHeader', () => {
  it('keeps brand, identity, model/provider, and cwd when they all fit', () => {
    const line = projectHeader(SESSION, 120)
    expect(text(line)).toBe(`${HEADER_BRAND} · session a2ab797b · deepseek-v4-flash · deepseek-official · /home/u/deepseek-tui`)
    expect(line.width).toBe(96)
  })

  it('clips the cwd from the left before dropping it', () => {
    const clipped = projectHeader(SESSION, 85)
    expect(kinds(clipped)).toEqual(['brand', 'identity', 'model', 'cwd'])
    expect(clipped.parts.find((part) => part.kind === 'cwd')?.text.startsWith('…')).toBe(true)
    expect(clipped.width).toBeLessThanOrEqual(85)
    // Too narrow even for a clipped cwd: the cwd is gone, the rest is whole.
    const dropped = projectHeader(SESSION, 74)
    expect(kinds(dropped)).toEqual(['brand', 'identity', 'model'])
    expect(dropped.width).toBe(73)
  })

  it('drops the model line before the session identity', () => {
    const line = projectHeader(SESSION, 60)
    expect(kinds(line)).toEqual(['brand', 'identity'])
    expect(line.parts.find((part) => part.kind === 'identity')?.text).toBe('session a2ab797b')
    expect(line.width).toBe(33)
  })

  it('clips the identity tail when the model line still fits', () => {
    const line = projectHeader(SESSION, 70)
    expect(kinds(line)).toEqual(['brand', 'identity', 'model'])
    expect(line.parts.find((part) => part.kind === 'identity')?.text).toBe('session a2ab…')
    expect(line.width).toBeLessThanOrEqual(70)
  })

  it('an existing title replaces the session id in the identity slot', () => {
    const line = projectHeader({ ...SESSION, title: 'fix the sidebar flicker' }, 120)
    expect(line.parts.find((part) => part.kind === 'identity')?.text).toBe('fix the sidebar flicker')
  })

  it('an over-long title truncates with the model line giving way first', () => {
    const longTitle = `fix the sidebar flicker and the composer wrap ${'x'.repeat(80)}`
    const line = projectHeader({ ...SESSION, title: longTitle }, 60)
    expect(kinds(line)).toEqual(['brand', 'identity'])
    const identity = line.parts.find((part) => part.kind === 'identity')
    expect(identity?.text.endsWith('…')).toBe(true)
    expect(identity?.text.length).toBeLessThanOrEqual(60 - HEADER_BRAND.length - 3)
  })

  it('a wide-enough line truncates the title while keeping the model line', () => {
    const line = projectHeader({ ...SESSION, title: `fix it ${'y'.repeat(40)}` }, 80)
    expect(kinds(line)).toEqual(['brand', 'identity', 'model'])
    expect(line.parts.find((part) => part.kind === 'identity')?.text.endsWith('…')).toBe(true)
    expect(line.width).toBeLessThanOrEqual(80)
  })

  it('model without a provider renders bare', () => {
    const { provider: _provider, ...noProvider } = SESSION
    const line = projectHeader(noProvider, 120)
    expect(line.parts.find((part) => part.kind === 'model')?.text).toBe('deepseek-v4-flash')
  })

  it('no session renders the connecting identity', () => {
    const line = projectHeader(null, 80)
    expect(kinds(line)).toEqual(['brand', 'identity'])
    expect(line.parts.find((part) => part.kind === 'identity')?.text).toBe('connecting…')
  })

  it('never exceeds the column budget on any width', () => {
    for (const cols of [10, 14, 16, 20, 24, 30, 40, 60, 80, 120]) {
      expect(projectHeader(SESSION, cols).width).toBeLessThanOrEqual(cols)
    }
  })
})

function text(line: { parts: readonly { text: string }[] }): string {
  return line.parts.map((part) => part.text).join(' · ')
}

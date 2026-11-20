import type { AstroComponentFactory } from 'astro/runtime/server/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveBlocks, type BlockComponentMap } from './render'

const Hero = (() => 'hero') as unknown as AstroComponentFactory
const Cta = (() => 'cta') as unknown as AstroComponentFactory
const components: BlockComponentMap = { cta: Cta, hero: Hero }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveBlocks', () => {
  it('keeps document order and maps each slug to its imported renderer', () => {
    const resolved = resolveBlocks(
      [
        { blockType: 'cta', heading: 'Apply now' },
        { blockType: 'hero', heading: 'Welcome' },
      ],
      components,
    )

    expect(resolved.map(({ block }) => block.blockType)).toEqual(['cta', 'hero'])
    expect(resolved.map(({ Component }) => Component)).toEqual([Cta, Hero])
  })

  it('renders nothing for an unknown block and logs it in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolved = resolveBlocks([{ blockType: 'job-search' }], components, { dev: true })

    expect(resolved).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job-search'))
  })

  it('stays quiet outside development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    resolveBlocks([{ blockType: 'job-search' }], components)

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not treat an inherited object key as a renderer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(resolveBlocks([{ blockType: 'constructor' }], components, { dev: true })).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('ignores missing or malformed block values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(resolveBlocks(null, components)).toEqual([])
    expect(resolveBlocks([null as never, { heading: 'no type' }], components, { dev: true })).toEqual(
      [],
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

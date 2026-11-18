import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  classify,
  collectUrls,
  isFailure,
  parseRedirectMap,
  parseSitemap,
  summarize,
  toCsv,
  toPath,
  uniquePaths,
} from './lib.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const files: Record<string, string> = {
  'https://legacy.example/sitemap_index.xml': fx('sitemap_index.xml'),
  'https://legacy.example/page-sitemap.xml': fx('page-sitemap.xml'),
  'https://legacy.example/job_listing-sitemap.xml': fx('job_listing-sitemap.xml'),
}
const fetchText = async (url: string) => {
  const body = files[url]
  if (body === undefined) throw new Error(`unexpected fetch ${url}`)
  return body
}

describe('sitemap parsing', () => {
  it('detects an index and lists child sitemaps', () => {
    const r = parseSitemap(files['https://legacy.example/sitemap_index.xml']!)
    expect(r.kind).toBe('index')
    expect(r.locs).toEqual([
      'https://legacy.example/page-sitemap.xml',
      'https://legacy.example/job_listing-sitemap.xml',
    ])
  })

  it('decodes entities and CDATA in urlsets', () => {
    const r = parseSitemap(fx('page-sitemap.xml'))
    expect(r.kind).toBe('urlset')
    expect(r.locs).toContain('https://legacy.example/search/?a=1&b=2')
    expect(parseSitemap(fx('job_listing-sitemap.xml')).locs).toContain('https://legacy.example/jobs/chef-&-bar/')
  })

  it('follows the index and de-duplicates cross-sitemap URLs', async () => {
    const urls = await collectUrls('https://legacy.example/sitemap_index.xml', fetchText)
    expect(urls.filter((u) => u.endsWith('/jobs/'))).toHaveLength(1)
    expect(urls).toHaveLength(5)
  })

  it('does not loop on self-referencing indexes', async () => {
    const self = '<sitemapindex><sitemap><loc>https://x.example/i.xml</loc></sitemap></sitemapindex>'
    await expect(collectUrls('https://x.example/i.xml', async () => self)).resolves.toEqual([])
  })
})

describe('paths', () => {
  it('keeps the query and upper-cases percent escapes', () => {
    expect(toPath('https://legacy.example/jobs/mason%ef%bc%88x/?p=1')).toBe('/jobs/mason%EF%BC%88x/?p=1')
  })
  it('collapses duplicate paths', () => {
    expect(uniquePaths(['https://a.example/x/', 'https://b.example/x/'])).toEqual(['/x/'])
  })
})

describe('classify', () => {
  const base = 'https://new.example'
  it('200 is ok', () => expect(classify(200, '', undefined, base)).toBe('ok'))
  it('404 and 410 are not-found', () => {
    expect(classify(404, '', undefined, base)).toBe('not-found')
    expect(classify(410, '', undefined, base)).toBe('not-found')
  })
  it('301 to the expected path (relative or absolute) is redirect-ok', () => {
    expect(classify(301, '/employers/', '/employers/', base)).toBe('redirect-ok')
    expect(classify(301, 'https://new.example/employers/', '/employers/', base)).toBe('redirect-ok')
    expect(classify(308, '/employers/', '/employers/', base)).toBe('redirect-ok')
  })
  it('301 elsewhere, to another host, or without Location is redirect-wrong', () => {
    expect(classify(301, '/other/', '/employers/', base)).toBe('redirect-wrong')
    expect(classify(301, 'https://legacy.example/employers/', '/employers/', base)).toBe('redirect-wrong')
    expect(classify(301, '', '/employers/', base)).toBe('redirect-wrong')
  })
  it('301 with no mapping is unmapped, not a failure', () => {
    const r = classify(301, '/x/', undefined, base)
    expect(r).toBe('redirect-unmapped')
    expect(isFailure(r)).toBe(false)
  })
  it('temporary redirects and 5xx are other', () => {
    expect(classify(302, '/employers/', '/employers/', base)).toBe('other')
    expect(classify(500, '', undefined, base)).toBe('other')
  })
  it('only not-found and redirect-wrong fail the run', () => {
    expect(isFailure('not-found')).toBe(true)
    expect(isFailure('redirect-wrong')).toBe(true)
    expect(isFailure('other')).toBe(false)
  })
})

describe('redirect map', () => {
  it('normalises keys and values from paths or URLs', () => {
    const map = parseRedirectMap(
      JSON.stringify({ '/employer/': '/employers/', 'https://legacy.example/wp/jobs/': 'https://new.example/jobs/' }),
    )
    expect(map.get('/employer/')).toBe('/employers/')
    expect(map.get('/wp/jobs/')).toBe('/jobs/')
  })
  it('matches against a looked-up classification', () => {
    const map = parseRedirectMap('{"/contact-2/":"/contact/"}')
    expect(classify(301, '/contact/', map.get('/contact-2/'), 'https://new.example')).toBe('redirect-ok')
  })
  it('rejects malformed maps', () => {
    expect(() => parseRedirectMap('[]')).toThrow()
    expect(() => parseRedirectMap('{"/a/":1}')).toThrow()
  })
})

describe('report', () => {
  const checks = [
    { path: '/a/', status: 200, location: '', expected: '', result: 'ok' as const },
    { path: '/b,"c"/', status: 404, location: '', expected: '', result: 'not-found' as const },
  ]
  it('counts by result', () => {
    expect(summarize(checks)).toMatchObject({ ok: 1, 'not-found': 1, 'redirect-wrong': 0 })
  })
  it('writes CSV with escaping', () => {
    expect(toCsv(checks)).toBe('path,status,result,location,expected\n/a/,200,ok,,\n"/b,""c""/",404,not-found,,\n')
  })
})

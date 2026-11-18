import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type Check,
  type Result,
  checkTarget,
  extractTitle,
  hasFailure,
  titlesMatch,
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

  it('rejects HTML and other non-sitemap documents', () => {
    expect(() => parseSitemap('<!DOCTYPE html><html><body>Error 503</body></html>')).toThrow(/not a sitemap/)
    expect(() => parseSitemap('')).toThrow(/not a sitemap/)
    expect(() => parseSitemap('<rss><channel><loc>x</loc></channel></rss>')).toThrow(/not a sitemap/)
    expect(() => parseSitemap('<urlset><url><loc>https://a.example/</loc></url>')).not.toThrow()
  })
  it('accepts a BOM, comments, a declaration and a namespace prefix', () => {
    const xml = '\uFEFF<?xml version="1.0"?>\n<!-- c -->\n<ns:urlset xmlns:ns="x"><url><loc>https://a.example/</loc></url></ns:urlset>'
    expect(parseSitemap(xml).locs).toEqual(['https://a.example/'])
  })
  it('rejects empty sitemaps and indexes with a clear error', () => {
    expect(() => parseSitemap('<urlset xmlns="x"></urlset>')).toThrow(/empty sitemap/)
    expect(() => parseSitemap('<sitemapindex><sitemap><loc> </loc></sitemap></sitemapindex>')).toThrow(/empty sitemap/)
  })
  it('names the failing sitemap URL when walking', async () => {
    const fetchBad = async (u: string) => (u.endsWith('index.xml') ? files['https://legacy.example/sitemap_index.xml']! : '<html></html>')
    await expect(collectUrls('https://legacy.example/index.xml', fetchBad)).rejects.toThrow(/page-sitemap\.xml: not a sitemap/)
  })
  it('terminates on self-referencing indexes (then reports no pages)', async () => {
    const self = '<sitemapindex><sitemap><loc>https://x.example/i.xml</loc></sitemap></sitemapindex>'
    await expect(collectUrls('https://x.example/i.xml', async () => self)).rejects.toThrow(/no page URLs/)
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
    expect(isFailure('other')).toBe(true)
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
    { path: '/a/', status: 200, location: '', expected: '', result: 'ok' as const, finalStatus: 200 as const },
    { path: '/b,"c"/', status: 404, location: '', expected: '', result: 'not-found' as const, finalStatus: '' as const },
  ]
  it('counts by result', () => {
    expect(summarize(checks)).toMatchObject({ ok: 1, 'not-found': 1, 'redirect-wrong': 0 })
  })
  it('writes CSV with escaping', () => {
    expect(toCsv(checks)).toBe(
      'path,status,result,location,expected,final_status\n/a/,200,ok,,,200\n"/b,""c""/",404,not-found,,,\n',
    )
  })
})

describe('titles', () => {
  it('extracts and decodes', () => {
    expect(extractTitle('<html><TITLE>\n Jobs Archive &#187; Vanuatu&nbsp;Wok &amp; Co </TITLE>')).toBe(
      'Jobs Archive » Vanuatu&nbsp;Wok & Co',
    )
    expect(extractTitle('<p>none</p>')).toBeNull()
  })
  it('ignores a site-name suffix, case and spacing', () => {
    expect(titlesMatch('About us » Vanuatu Wok', 'ABOUT  us | New Site')).toBe(true)
    expect(titlesMatch('About us', 'Contact us')).toBe(false)
    expect(titlesMatch('JOB VACANCY – JUNIOR', 'JOB VACANCY')).toBe(false)
  })
})

const page = (title: string) => ({ status: 200, location: '', body: `<title>${title}</title>` })
const redirect = (to: string, status = 301) => ({ status, location: to, body: '' })

describe('checkTarget', () => {
  const T = 'https://new.example'
  const none = { status: 404, location: '', body: '' }
  const site = (routes: Record<string, { status: number; location: string; body: string }>) => ({
    get: async (url: string) => routes[url] ?? none,
    legacyTitle: async () => 'About us » Vanuatu Wok' as string | null,
  })

  it('200 with matching title is ok', async () => {
    const r = await checkTarget('/about/', T, undefined, site({ [`${T}/about/`]: page('About us') }))
    expect(r.result).toBe('ok')
  })
  it('200 with a different title fails', async () => {
    const r = await checkTarget('/about/', T, undefined, site({ [`${T}/about/`]: page('Welcome') }))
    expect(r.result).toBe('title-mismatch')
    expect(isFailure(r.result)).toBe(true)
  })
  it('200 when the legacy title is unavailable is other, not ok', async () => {
    const deps = { ...site({ [`${T}/about/`]: page('x') }), legacyTitle: async () => null }
    expect((await checkTarget('/about/', T, undefined, deps)).result).toBe('other')
  })
  it('mapped 301 to a 200 is redirect-ok', async () => {
    const r = await checkTarget('/old/', T, '/new/', site({ [`${T}/old/`]: redirect('/new/'), [`${T}/new/`]: page('x') }))
    expect(r).toMatchObject({ result: 'redirect-ok', finalStatus: 200 })
  })
  it('mapped 301 whose destination is 404 is redirect-broken', async () => {
    const r = await checkTarget('/old/', T, '/new/', site({ [`${T}/old/`]: redirect('/new/') }))
    expect(r).toMatchObject({ result: 'redirect-broken', finalStatus: 404 })
  })
  it('follows chains and fails if a later hop has no Location', async () => {
    const ok = await checkTarget('/a/', T, '/b/', site({ [`${T}/a/`]: redirect('/b/'), [`${T}/b/`]: redirect('/c/', 308), [`${T}/c/`]: page('x') }))
    expect(ok.result).toBe('redirect-ok')
    const bad = await checkTarget('/a/', T, '/b/', site({ [`${T}/a/`]: redirect('/b/'), [`${T}/b/`]: redirect('') }))
    expect(bad.result).toBe('redirect-broken')
  })
  it('a hop that leaves the target origin fails and is never fetched', async () => {
    const fetched: string[] = []
    const deps = {
      get: async (url: string) => {
        fetched.push(url)
        return url === `${T}/a/` ? redirect('/b/') : url === `${T}/b/` ? redirect('https://legacy.example/b/') : page('x')
      },
      legacyTitle: async () => null,
    }
    for (const expected of [undefined, '/b/']) {
      fetched.length = 0
      const r = await checkTarget('/a/', T, expected, deps)
      expect(r.result).toBe('redirect-offsite')
      expect(isFailure(r.result)).toBe(true)
      expect(fetched).toEqual([`${T}/a/`, `${T}/b/`])
    }
  })
  it('redirect loops end as redirect-broken', async () => {
    const r = await checkTarget('/a/', T, '/b/', site({ [`${T}/a/`]: redirect('/b/'), [`${T}/b/`]: redirect('/b/') }))
    expect(r.result).toBe('redirect-broken')
  })
  it('301 with no Location always fails, mapped or not', async () => {
    for (const expected of [undefined, '/new/']) {
      const r = await checkTarget('/old/', T, expected, site({ [`${T}/old/`]: redirect('') }))
      expect(isFailure(r.result)).toBe(true)
    }
  })
  it('unmapped 301 to a 200 is unmapped (non-failing); to a 404 fails', async () => {
    const good = await checkTarget('/old/', T, undefined, site({ [`${T}/old/`]: redirect('/n/'), [`${T}/n/`]: page('x') }))
    expect(good.result).toBe('redirect-unmapped')
    expect(isFailure(good.result)).toBe(false)
    const bad = await checkTarget('/old/', T, undefined, site({ [`${T}/old/`]: redirect('/n/') }))
    expect(bad.result).toBe('redirect-broken')
  })
  it('404 and wrong-target redirects keep their classification', async () => {
    expect((await checkTarget('/x/', T, undefined, site({}))).result).toBe('not-found')
    expect((await checkTarget('/old/', T, '/new/', site({ [`${T}/old/`]: redirect('/elsewhere/') }))).result).toBe('redirect-wrong')
  })
})

describe('hasFailure', () => {
  const c = (result: Result): Check => ({ path: '/', status: 0, location: '', expected: '', result, finalStatus: '' })
  it('unverifiable results fail by default and only an explicit flag accepts them', () => {
    expect(hasFailure([c('ok'), c('other')], {})).toBe(true)
    expect(hasFailure([c('ok'), c('other')], { allowUnverifiable: true })).toBe(false)
  })
  it('the flag never excuses real failures', () => {
    for (const r of ['not-found', 'redirect-wrong', 'redirect-broken', 'redirect-offsite', 'title-mismatch'] as const) {
      expect(hasFailure([c(r)], { allowUnverifiable: true })).toBe(true)
    }
  })
  it('unmapped redirects fail only with strict', () => {
    expect(hasFailure([c('redirect-unmapped')], {})).toBe(false)
    expect(hasFailure([c('redirect-unmapped')], { strict: true })).toBe(true)
  })
})

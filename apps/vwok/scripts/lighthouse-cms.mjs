/**
 * A tiny stand-in CMS for the Lighthouse run (PJ-44). `/jobs/{slug}` and a CMS-filled home page
 * need documents, and CI has no Payload, so this serves just enough of the REST API the site's
 * client reads: tenant settings, pages, menus and one live job. Fixed content, no secrets, no
 * network beyond localhost. It is a test fixture and ships nowhere.
 *
 *   node scripts/lighthouse-cms.mjs [port]
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4399)

const paragraph = (text) => ({
  children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
  direction: 'ltr',
  format: '',
  indent: 0,
  type: 'paragraph',
  version: 1,
})
const lexical = (...paragraphs) => ({
  root: { children: paragraphs.map(paragraph), direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
})

const pages = [
  {
    id: 1,
    layout: [
      {
        blockType: 'hero',
        body: 'Vacancies from employers in Port Vila, Luganville and across the islands.',
        heading: 'Find a job in Vanuatu',
        id: 'hero',
        links: [{ href: '/jobs', label: 'Browse all jobs', variant: 'primary' }],
      },
      {
        blockType: 'feature-boxes',
        heading: 'How it works',
        id: 'how',
        items: [
          { body: 'Every live vacancy on one page.', title: 'Browse' },
          { body: 'Apply online with your CV.', title: 'Apply' },
          { body: 'Employers post in minutes.', title: 'Hire' },
        ],
      },
      { blockType: 'rich-text', content: lexical('Vanuatu Wok connects people with work across Vanuatu.'), id: 'text' },
    ],
    role: 'home',
    seo: { description: 'Find a job in Vanuatu: vacancies from employers across the islands.' },
    title: 'Find a job in Vanuatu',
  },
  { id: 2, layout: [], slug: 'about', title: 'About us' },
]
const menus = [
  {
    id: 1,
    items: [
      { label: 'Jobs', linkType: 'custom', url: '/jobs' },
      { label: 'About us', linkType: 'page', page: 2 },
    ],
    location: 'primary',
    name: 'Main',
  },
]
const job = {
  categories: [],
  description: lexical(
    'We are looking for an experienced chef to lead our kitchen in Port Vila.',
    'You will plan menus, manage a small team and keep the kitchen safe and tidy.',
  ),
  expiresAt: '2099-01-01T00:00:00.000Z',
  id: 7,
  organisation: { id: 3, name: 'Harbour Hotel', slug: 'harbour-hotel' },
  publishedAt: '2026-11-01T00:00:00.000Z',
  slug: 'head-chef',
  status: 'published',
  title: 'Head Chef',
}

const list = (docs) => ({ docs, hasNextPage: false, limit: docs.length, page: 1, totalDocs: docs.length, totalPages: 1 })

const answer = (url) => {
  const name = url.pathname.replace(/^\/api\//, '')
  if (name === 'tenant-settings') return { name: 'Vanuatu Wok', slug: 'vwok' }
  if (name === 'pages') return list(pages)
  if (name === 'menus') return list(menus)
  if (name === 'jobs') {
    const slug = url.searchParams.get('where[slug][equals]')
    return list(slug === null || slug === job.slug ? [job] : [])
  }
  return list([])
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (process.env.LH_DEBUG) console.log(request.method, request.url)
  response.setHeader('content-type', 'application/json')
  if (!url.pathname.startsWith('/api/')) {
    response.statusCode = 404
    response.end('{}')
    return
  }
  response.end(JSON.stringify(answer(url)))
}).listen(port, '127.0.0.1', () => console.log(`lighthouse CMS fixture on 127.0.0.1:${port}`))

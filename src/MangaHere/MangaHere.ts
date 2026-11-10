import {
    Chapter,
    ChapterDetails,
    ChapterProviding,
    ContentRating,
    HomePageSectionsProviding,
    HomeSection,
    HomeSectionType,
    MangaProviding,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SearchResultsProviding,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Tag,
    TagSection
} from '@paperback/types'

import * as cheerio from 'cheerio'
import { isPacked, unpack, unpackAll } from './Unpacker'

const DOMAIN = 'https://www.mangahere.cc'
const HOST = 'www.mangahere.cc'

export const MangaHereInfo: SourceInfo = {
    version: '1.0.0',
    name: 'MangaHere',
    description: `Extension that pulls manga from ${DOMAIN}`,
    author: 'Eddydev-ALU',
    authorWebsite: 'https://github.com/Eddydev-ALU',
    icon: 'icon.png',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: DOMAIN,
    sourceTags: [],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

const GENRES: { id: string, label: string }[] = [
    ['1', 'Action'], ['2', 'Adventure'], ['3', 'Comedy'], ['4', 'Fantasy'], ['5', 'Historical'],
    ['6', 'Horror'], ['7', 'Martial Arts'], ['8', 'Mystery'], ['9', 'Romance'], ['10', 'Shounen Ai'],
    ['11', 'Supernatural'], ['12', 'Drama'], ['13', 'Shounen'], ['14', 'School Life'], ['15', 'Shoujo'],
    ['16', 'Gender Bender'], ['17', 'Josei'], ['18', 'Psychological'], ['19', 'Seinen'], ['20', 'Slice of Life'],
    ['21', 'Sci-fi'], ['22', 'Ecchi'], ['23', 'Harem'], ['24', 'Shoujo Ai'], ['25', 'Yuri'],
    ['26', 'Mature'], ['27', 'Tragedy'], ['28', 'Yaoi'], ['29', 'Doujinshi'], ['30', 'Sports'],
    ['31', 'Adult'], ['32', 'One Shot'], ['33', 'Smut'], ['34', 'Mecha'], ['37', 'Webtoons']
].map(([id, label]) => ({ id: id as string, label: label as string }))

const HOME_SECTIONS = [
    { id: 'popular', title: 'Popular', path: '', type: HomeSectionType.singleRowLarge },
    { id: 'latest', title: 'Latest Updates', path: '?latest', type: HomeSectionType.singleRowNormal },
    { id: 'rating', title: 'Top Rated', path: '?rating', type: HomeSectionType.singleRowNormal }
]

const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

/** Pages of a page-by-page chapter are looked up this many at a time. */
const PAGE_LOOKUP_CONCURRENCY = 4

export class MangaHere implements ChapterProviding, HomePageSectionsProviding, MangaProviding, SearchResultsProviding {

    private async prepare(request: Request): Promise<Request> {
        request.headers = {
            ...(request.headers ?? {}),
            // Keep a referer the caller set (chapter page lookups need the chapter URL).
            referer: request.headers?.['referer'] ?? `${DOMAIN}/`,
            'user-agent': await this.requestManager.getDefaultUserAgent()
        }
        // MangaHere hides adult titles behind a one-click confirmation; this cookie is that click.
        request.cookies = [
            ...(request.cookies ?? []),
            App.createCookie({ name: 'isAdult', value: '1', domain: HOST, path: '/' })
        ]
        request.url = request.url.replace(/^http:/, 'https:')
        return request
    }

    /** Used by Paperback for cover and page images, so it is allowed to go faster. */
    requestManager = App.createRequestManager({
        requestsPerSecond: 8,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: (request: Request) => this.prepare(request),
            interceptResponse: async (response: Response) => response
        }
    })

    /** Used for the site's HTML pages, kept slow to stay polite and avoid being rate limited. */
    pageManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: (request: Request) => this.prepare(request),
            interceptResponse: async (response: Response) => response
        }
    })

    // ---------------------------------------------------------------- helpers

    private async fetchHtml(url: string, headers: Record<string, string> = {}): Promise<string> {
        const response = await this.pageManager.schedule(App.createRequest({ url, method: 'GET', headers }), 1)
        this.checkResponse(response)
        return response.data as string
    }

    private checkResponse(response: Response): void {
        const body = typeof response.data === 'string' ? response.data : ''
        if (response.status === 503 || response.status === 403 || /<title>Just a moment|cf-chl-/i.test(body)) {
            throw new Error('MangaHere needs Cloudflare verification. Go to the source settings, run the Cloudflare bypass, then try again.')
        }
        if (response.status >= 400) {
            throw new Error(`MangaHere returned HTTP ${response.status}. Try again later.`)
        }
    }

    private absolute(url: string | undefined): string {
        if (!url) return ''
        if (url.startsWith('//')) return `https:${url}`
        if (url.startsWith('/')) return `${DOMAIN}${url}`
        return url
    }

    /** "/manga/one_piece/" -> "one_piece" */
    private mangaIdFromUrl(url: string | undefined): string | undefined {
        return /\/manga\/([^/?#]+)/.exec(url ?? '')?.[1]
    }

    private parseList($: cheerio.CheerioAPI, itemSelector: string, coverSelector: string, titleSelector: string): PartialSourceManga[] {
        const results: PartialSourceManga[] = []
        const seen = new Set<string>()
        $(itemSelector).each((_, element) => {
            const item = $(element)
            const link = item.find(titleSelector).first()
            const mangaId = this.mangaIdFromUrl(link.attr('href'))
            if (!mangaId || seen.has(mangaId)) return
            seen.add(mangaId)
            const cover = item.find(coverSelector).first()
            const latest = item.find('.manga-list-1-item-subtitle a, .manga-list-4-item-tip a').first().text().trim()
            results.push(App.createPartialSourceManga({
                mangaId,
                title: (link.attr('title') || link.text() || mangaId).trim(),
                image: this.absolute(cover.attr('src') || cover.attr('data-original')),
                ...(latest ? { subtitle: latest } : {})
            }))
        })
        return results
    }

    private hasNextPage($: cheerio.CheerioAPI, page: number): boolean {
        let next = false
        $('div.pager-list-left a').each((_, element) => {
            const target = Number($(element).attr('data-page') ?? /(\d+)\.htm/.exec($(element).attr('href') ?? '')?.[1])
            if (Number.isFinite(target) && target > page) next = true
        })
        return next
    }

    private parseDate(text: string): Date | undefined {
        const value = text.trim().toLowerCase()
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        if (!value) return undefined
        if (value.includes('today') || value.includes(' ago')) return today
        if (value.includes('yesterday')) return new Date(today.getTime() - 86400000)
        const match = /([a-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/.exec(value)
        if (!match) return undefined
        const month = MONTHS[match[1] ?? '']
        if (month === undefined) return undefined
        return new Date(Number(match[3]), month, Number(match[2]))
    }

    // ---------------------------------------------------------------- home

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const sections = HOME_SECTIONS.map((entry) => App.createHomeSection({
            id: entry.id, title: entry.title, type: entry.type, containsMoreItems: true
        }))
        for (const section of sections) sectionCallback(section)

        await Promise.all(HOME_SECTIONS.map(async (entry, index) => {
            const section = sections[index]!
            const $ = cheerio.load(await this.fetchHtml(`${DOMAIN}/directory/1.htm${entry.path}`))
            section.items = this.parseList($, '.manga-list-1-list li', 'img.manga-list-1-cover', 'a')
            sectionCallback(section)
        }))
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1
        const entry = HOME_SECTIONS.find((section) => section.id === homepageSectionId)
        if (!entry) throw new Error(`Unknown section: ${homepageSectionId}`)
        const $ = cheerio.load(await this.fetchHtml(`${DOMAIN}/directory/${page}.htm${entry.path}`))
        const results = this.parseList($, '.manga-list-1-list li', 'img.manga-list-1-cover', 'a')
        return App.createPagedResults({
            results,
            metadata: results.length && this.hasNextPage($, page) ? { page: page + 1 } : undefined
        })
    }

    // ---------------------------------------------------------------- search

    async getSearchTags(): Promise<TagSection[]> {
        return [App.createTagSection({
            id: 'genres',
            label: 'Genres',
            tags: GENRES.map((genre) => App.createTag(genre))
        })]
    }

    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1
        const ids = (tags: Tag[] | undefined) => (tags ?? []).map((tag) => tag.id).join(',')
        const params = [
            `title=${encodeURIComponent((query.title ?? '').trim())}`,
            `genres=${ids(query.includedTags)}`,
            `nogenres=${ids(query.excludedTags)}`,
            'sort=',
            'stype=1',
            `page=${page}`
        ].join('&')
        const $ = cheerio.load(await this.fetchHtml(`${DOMAIN}/search?${params}`))
        const results = this.parseList($, '.manga-list-4-list > li', 'img.manga-list-4-cover', '.manga-list-4-item-title > a')
        return App.createPagedResults({
            results,
            metadata: results.length && this.hasNextPage($, page) ? { page: page + 1 } : undefined
        })
    }

    // ---------------------------------------------------------------- details

    getMangaShareUrl(mangaId: string): string {
        return `${DOMAIN}/manga/${mangaId}/`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = cheerio.load(await this.fetchHtml(`${DOMAIN}/manga/${mangaId}/`))

        const title = $('span.detail-info-right-title-font').first().text().trim() || mangaId
        const statusText = $('span.detail-info-right-title-tip').first().text().toLowerCase()
        const status = statusText.includes('ongoing') ? 'Ongoing' : statusText.includes('complete') ? 'Completed' : 'Unknown'
        const authors = $('.detail-info-right-say > a').map((_, el) => $(el).text().trim()).get().filter(Boolean)
        const desc = ($('.fullcontent').first().text() || $('.detail-info-right-content').first().text()).trim()
        const genreNames = $('.detail-info-right-tag-list > a').map((_, el) => $(el).text().trim()).get().filter(Boolean)
        const tags = genreNames.map((name) => App.createTag({
            id: GENRES.find((genre) => genre.label.toLowerCase() === name.toLowerCase())?.id ?? name,
            label: name
        }))
        const adult = genreNames.some((name) => /^(adult|smut|mature|ecchi|yaoi|yuri)$/i.test(name))
        const rating = Number($('.detail-info-right-title-star .item-score').first().text())

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [title],
                image: this.absolute($('img.detail-info-cover-img').attr('src')),
                desc,
                status,
                author: authors.join(', '),
                artist: authors.join(', '),
                hentai: adult,
                ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
                tags: tags.length ? [App.createTagSection({ id: 'genres', label: 'Genres', tags })] : []
            })
        })
    }

    // ---------------------------------------------------------------- chapters

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const $ = cheerio.load(await this.fetchHtml(`${DOMAIN}/manga/${mangaId}/`))
        const rows = $('ul.detail-main-list > li').toArray()
        const chapters: Chapter[] = []
        const seen = new Set<string>()

        rows.forEach((element, index) => {
            const link = $(element).find('a').first()
            const href = link.attr('href') ?? ''
            // "/manga/slug/v02/c010.5/1.html" -> "v02/c010.5"
            const path = new RegExp(`/manga/${mangaId}/(.+?)/\\d+\\.html`).exec(href)?.[1]
            if (!path || seen.has(path)) return
            seen.add(path)

            const chapNum = Number(/c(\d+(?:\.\d+)?)/.exec(path)?.[1] ?? NaN)
            const volume = Number(/v(\d+(?:\.\d+)?)/.exec(path)?.[1] ?? NaN)
            const name = link.find('p.title3').first().text().trim()
            const time = this.parseDate(link.find('p.title2').first().text())

            chapters.push(App.createChapter({
                id: path,
                chapNum: Number.isFinite(chapNum) ? chapNum : 0,
                ...(Number.isFinite(volume) ? { volume } : {}),
                name: name || `Chapter ${Number.isFinite(chapNum) ? chapNum : path}`,
                langCode: '🇬🇧',
                // The site lists newest first; a higher sortingIndex means newer.
                sortingIndex: rows.length - index,
                ...(time ? { time } : {})
            }))
        })

        if (!chapters.length) throw new Error(`No chapters found for ${mangaId}. The title may be licensed and removed from MangaHere.`)
        return chapters
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const chapterUrl = `${DOMAIN}/manga/${mangaId}/${chapterId}/1.html`
        const html = await this.fetchHtml(chapterUrl)
        const $ = cheerio.load(html)

        // Long-strip chapters list every image in one packed script.
        const scripts = unpackAll(html)
        const strip = scripts.map((script) => /newImgs\s*=\s*\[([^\]]+)\]/.exec(script)?.[1]).find(Boolean)
        if (strip) {
            const pages = (strip.match(/['"]([^'"]+)['"]/g) ?? []).map((quoted) => this.absolute(quoted.slice(1, -1)))
            if (pages.length) return App.createChapterDetails({ id: chapterId, mangaId, pages })
        }

        // Page-by-page chapters: ask the site for each page's image, the same way its reader does.
        const chapterIdMatch = /chapterid\s*=\s*(\d+)/i.exec(html)
        const pageCount = Math.max(0, ...$('.pager-list-left > span a').map((_, el) => Number($(el).attr('data-page'))).get()
            .filter((n: number) => Number.isFinite(n)))
        if (!chapterIdMatch || !pageCount) {
            if ($('p.detail-block-content').text().trim()) {
                throw new Error('This chapter is licensed and has been removed from MangaHere.')
            }
            throw new Error('Could not read this chapter from MangaHere. The page layout may have changed.')
        }

        const key = this.extractKey(scripts)
        const base = chapterUrl.substring(0, chapterUrl.lastIndexOf('/'))
        const pages: string[] = new Array(pageCount)
        let next = 1
        const worker = async () => {
            while (next <= pageCount) {
                const page = next++
                pages[page - 1] = await this.pageImage(base, chapterIdMatch[1]!, page, key, chapterUrl)
            }
        }
        await Promise.all(Array.from({ length: Math.min(PAGE_LOOKUP_CONCURRENCY, pageCount) }, worker))

        return App.createChapterDetails({ id: chapterId, mangaId, pages: this.dropBrokenLastPage(pages) })
    }

    /** The reader builds a key like ''+'a'+'b'+... inside a packed script; join those pieces. */
    private extractKey(scripts: string[]): string {
        for (const script of scripts) {
            const start = script.indexOf("'")
            const end = script.indexOf(';', start)
            if (start < 0 || end < 0) continue
            const expression = script.substring(start, end)
            if (!/^('[^']*'\s*\+?\s*)+$/.test(expression.trim())) continue
            return (expression.match(/'([^']*)'/g) ?? []).map((piece) => piece.slice(1, -1)).join('')
        }
        return ''
    }

    private async pageImage(base: string, cid: string, page: number, key: string, referer: string): Promise<string> {
        const headers = { referer, 'x-requested-with': 'XMLHttpRequest', 'accept-language': 'en-US,en;q=0.9' }
        // The reader retries with an empty key when the first answer is empty; do the same.
        for (const attemptKey of [key, '', '']) {
            const url = `${base}/chapterfun.ashx?cid=${cid}&page=${page}&key=${encodeURIComponent(attemptKey)}`
            const response = await this.requestManager.schedule(App.createRequest({ url, method: 'GET', headers }), 1)
            this.checkResponse(response)
            const body = (response.data as string | undefined)?.trim() ?? ''
            if (!body) continue
            const script = isPacked(body) ? unpack(body) : body
            const host = /pix\s*=\s*["']([^"']+)["']/.exec(script)?.[1]
            const path = /pvalue\s*=\s*\[\s*["']([^"']+)["']/.exec(script)?.[1]
            if (host && path) return this.absolute(`${host}${path}`)
        }
        throw new Error(`MangaHere did not return an image for page ${page}.`)
    }

    /**
     * MangaHere sometimes reports one page too many; the extra one is an ad or a broken image.
     * Image names count up (..._001, ..._002), so drop the last page if it breaks that pattern.
     */
    private dropBrokenLastPage(pages: string[]): string[] {
        if (pages.length < 2) return pages
        const number = (url: string | undefined) => {
            const name = (url ?? '').split('?')[0]!.split('/').pop() ?? ''
            const digits = /(\d{2})\.[a-z]+$/i.exec(name)?.[1]
            return digits === undefined ? NaN : Number(digits)
        }
        const last = number(pages[pages.length - 1])
        const previous = number(pages[pages.length - 2])
        // If the names don't follow the counting pattern, there is nothing to compare; keep every page.
        if (Number.isNaN(last) || Number.isNaN(previous)) return pages
        if (last - previous === 1 || (previous === 99 && last === 0)) return pages
        return pages.slice(0, -1)
    }

    // ---------------------------------------------------------------- cloudflare

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${DOMAIN}/`,
            method: 'GET',
            headers: { referer: `${DOMAIN}/`, 'user-agent': await this.requestManager.getDefaultUserAgent() }
        })
    }
}

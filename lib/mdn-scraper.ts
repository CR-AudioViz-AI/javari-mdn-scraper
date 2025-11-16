// ================================================================================
// MDN SCRAPER - MAIN LOGIC
// ================================================================================
// Scrapes documentation from MDN Web Docs and stores in Supabase
// ================================================================================

import axios from 'axios'
import * as cheerio from 'cheerio'
import crypto from 'crypto'
import { supabaseAdmin } from './supabase'
import type { ScrapeResult, CodeSnippet, ScraperConfig, MDNSection } from './types'

const MDN_BASE = 'https://developer.mozilla.org'

export class MDNScraper {
  private config: ScraperConfig
  private sourceId: string | null = null

  constructor(config?: Partial<ScraperConfig>) {
    this.config = {
      concurrency: config?.concurrency || 3,
      delayMs: config?.delayMs || 1000,
      timeoutMs: config?.timeoutMs || 30000,
      maxRetries: config?.maxRetries || 3,
      rateLimitPerMinute: config?.rateLimitPerMinute || 60,
      rateLimitPerHour: config?.rateLimitPerHour || 1000,
    }
  }

  /**
   * Get predefined MDN sections to scrape
   */
  async getMDNSections(): Promise<MDNSection[]> {
    return [
      {
        title: 'HTML',
        slug: 'html',
        url: `${MDN_BASE}/en-US/docs/Web/HTML`,
        category: 'html',
      },
      {
        title: 'CSS',
        slug: 'css',
        url: `${MDN_BASE}/en-US/docs/Web/CSS`,
        category: 'css',
      },
      {
        title: 'JavaScript',
        slug: 'javascript',
        url: `${MDN_BASE}/en-US/docs/Web/JavaScript`,
        category: 'javascript',
      },
      {
        title: 'Web APIs',
        slug: 'web-apis',
        url: `${MDN_BASE}/en-US/docs/Web/API`,
        category: 'web-apis',
      },
      {
        title: 'HTTP',
        slug: 'http',
        url: `${MDN_BASE}/en-US/docs/Web/HTTP`,
        category: 'http',
      },
      {
        title: 'Web Guides',
        slug: 'guides',
        url: `${MDN_BASE}/en-US/docs/Web/Guide`,
        category: 'guides',
      },
      {
        title: 'Developer Tools',
        slug: 'tools',
        url: `${MDN_BASE}/en-US/docs/Tools`,
        category: 'tools',
      },
    ]
  }

  /**
   * Get pages from a section by crawling links
   */
  async getSectionPages(sectionUrl: string): Promise<string[]> {
    try {
      const response = await axios.get(sectionUrl, {
        timeout: this.config.timeoutMs,
        headers: {
          'User-Agent': 'Javari-MDN-Scraper/1.0',
        },
      })

      const $ = cheerio.load(response.data)
      const urls: string[] = [sectionUrl]

      // Find all documentation links in the page
      $('a[href^="/en-US/docs/"]').each((_, elem) => {
        const href = $(elem).attr('href')
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `${MDN_BASE}${href}`
          if (fullUrl.includes('/en-US/docs/') && !urls.includes(fullUrl)) {
            urls.push(fullUrl)
          }
        }
      })

      return urls.slice(0, 100) // Limit to 100 pages per section for now
    } catch (error) {
      console.error(`Error getting section pages from ${sectionUrl}:`, error)
      return [sectionUrl] // Return at least the section URL
    }
  }

  /**
   * Scrape a single MDN page
   */
  async scrapePage(url: string): Promise<ScrapeResult> {
    try {
      const response = await axios.get(url, {
        timeout: this.config.timeoutMs,
        headers: {
          'User-Agent': 'Javari-MDN-Scraper/1.0',
        },
      })

      const html = response.data
      const $ = cheerio.load(html)

      // Extract title
      const title = $('h1').first().text().trim() || $('title').text().trim()

      // Extract main content
      const content = $('#content article, .main-page-content, article')
        .text()
        .trim()

      // Extract code snippets
      const codeSnippets: CodeSnippet[] = []
      $('pre code').each((_, elem) => {
        const code = $(elem).text().trim()
        const language = $(elem).attr('class')?.match(/language-(\w+)/)?.[1] || 'plaintext'
        if (code) {
          codeSnippets.push({ language, code })
        }
      })

      // Generate simplified markdown
      const markdown = this.htmlToMarkdown($)

      // Extract keywords and topics
      const keywords = this.extractKeywords(content)
      const topics = url.split('/').filter((p) => p && p !== 'en-US' && p !== 'docs')

      // Count words and characters
      const wordCount = content.split(/\s+/).filter(Boolean).length
      const characterCount = content.length

      return {
        success: true,
        url,
        title,
        content,
        markdown,
        codeSnippets,
        wordCount,
        characterCount,
        keywords,
        topics,
      }
    } catch (error) {
      return {
        success: false,
        url,
        title: '',
        content: '',
        codeSnippets: [],
        wordCount: 0,
        characterCount: 0,
        keywords: [],
        topics: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Scrape an entire MDN section
   */
  async scrapeSection(
    section: MDNSection,
    jobId: string,
    onProgress?: (progress: number, total: number) => void
  ): Promise<{ success: number; failed: number; total: number }> {
    console.log(`Starting scrape of ${section.title}...`)

    // Get all pages in this section
    const urls = await this.getSectionPages(section.url)
    const total = urls.length

    console.log(`Found ${total} pages in ${section.title}`)

    let successCount = 0
    let failedCount = 0

    // Update job with total URLs
    await this.updateJob(jobId, {
      total_urls: total,
      status: 'running',
      started_at: new Date().toISOString(),
    })

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += this.config.concurrency) {
      const batch = urls.slice(i, i + this.config.concurrency)

      const results = await Promise.all(batch.map((url) => this.scrapePage(url)))

      // Save results to database
      for (const result of results) {
        if (result.success) {
          await this.saveContent(result, section.slug)
          successCount++
        } else {
          failedCount++
        }

        // Update job progress
        const processed = successCount + failedCount
        const progress = (processed / total) * 100

        await this.updateJob(jobId, {
          urls_processed: processed,
          urls_failed: failedCount,
          progress_percentage: progress,
          items_scraped: successCount,
        })

        // Call progress callback
        if (onProgress) {
          onProgress(processed, total)
        }
      }

      // Delay between batches
      if (i + this.config.concurrency < urls.length) {
        await this.delay(this.config.delayMs)
      }
    }

    // Mark job as complete
    await this.updateJob(jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    })

    return {
      success: successCount,
      failed: failedCount,
      total,
    }
  }

  /**
   * Save scraped content to Supabase
   */
  private async saveContent(result: ScrapeResult, category: string) {
    try {
      // Get or create knowledge source
      if (!this.sourceId) {
        const { data: source } = await supabaseAdmin
          .from('knowledge_sources')
          .select('id')
          .eq('url', MDN_BASE)
          .single()

        this.sourceId = source?.id || null
      }

      if (!this.sourceId) {
        console.error('No source ID found for MDN')
        return
      }

      // Generate content hash
      const contentHash = crypto.createHash('sha256').update(result.content).digest('hex')

      // Check if content already exists
      const { data: existing } = await supabaseAdmin
        .from('knowledge_content')
        .select('id, content_hash')
        .eq('url', result.url)
        .single()

      if (existing && existing.content_hash === contentHash) {
        // Content unchanged, skip
        return
      }

      // Insert or update content
      const contentData = {
        source_id: this.sourceId,
        url: result.url,
        title: result.title,
        content_type: 'documentation_page',
        content: result.content,
        markdown: result.markdown,
        code_snippets: result.codeSnippets,
        word_count: result.wordCount,
        character_count: result.characterCount,
        keywords: result.keywords,
        topics: result.topics,
        content_hash: contentHash,
        processed: false,
      }

      if (existing) {
        await supabaseAdmin.from('knowledge_content').update(contentData).eq('id', existing.id)
      } else {
        await supabaseAdmin.from('knowledge_content').insert(contentData)
      }
    } catch (error) {
      console.error('Error saving content:', error)
    }
  }

  /**
   * Update scraping job status
   */
  private async updateJob(jobId: string, updates: Record<string, any>) {
    try {
      await supabaseAdmin.from('scraping_jobs').update(updates).eq('id', jobId)
    } catch (error) {
      console.error('Error updating job:', error)
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Extract keywords from content
   */
  private extractKeywords(content: string): string[] {
    const words = content
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3)

    const frequency: Record<string, number> = {}
    words.forEach((word) => {
      frequency[word] = (frequency[word] || 0) + 1
    })

    return Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word)
  }

  /**
   * Convert HTML to simplified Markdown
   */
  private htmlToMarkdown($: cheerio.CheerioAPI): string {
    let markdown = ''

    $('h1, h2, h3, h4').each((_, el) => {
      const level = parseInt(el.tagName[1])
      markdown += '#'.repeat(level) + ' ' + $(el).text().trim() + '\n\n'
    })

    $('p').each((_, el) => {
      markdown += $(el).text().trim() + '\n\n'
    })

    $('pre code').each((_, el) => {
      const code = $(el).text().trim()
      const language = $(el).attr('class')?.match(/language-(\w+)/)?.[1] || ''
      markdown += '```' + language + '\n' + code + '\n```\n\n'
    })

    return markdown.trim()
  }
}

// Export singleton instance
export const mdnScraper = new MDNScraper()

// ================================================================================
// TYPE DEFINITIONS FOR JAVARI MDN SCRAPER
// ================================================================================

export interface MDNSection {
  title: string
  slug: string
  url: string
  category: 'html' | 'css' | 'javascript' | 'web-apis' | 'http' | 'guides' | 'tools'
}

export interface MDNPage {
  title: string
  slug: string
  url: string
  mdn_url: string
  locale: string
  summary?: string
}

export interface ScrapeResult {
  success: boolean
  url: string
  title: string
  content: string
  markdown?: string
  codeSnippets: CodeSnippet[]
  wordCount: number
  characterCount: number
  keywords: string[]
  topics: string[]
  error?: string
}

export interface CodeSnippet {
  language: string
  code: string
  description?: string
}

export interface ScraperConfig {
  concurrency: number
  delayMs: number
  timeoutMs: number
  maxRetries: number
  rateLimitPerMinute: number
  rateLimitPerHour: number
}

export interface JobProgress {
  jobId: string
  status: string
  progress: number
  totalUrls: number
  processedUrls: number
  failedUrls: number
  itemsScraped: number
  startedAt: string
  estimatedCompletion?: string
}

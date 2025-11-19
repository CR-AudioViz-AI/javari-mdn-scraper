import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// MDN Web Docs base URL
const MDN_BASE = 'https://developer.mozilla.org';

// Priority documentation paths
const MDN_PATHS = [
  '/en-US/docs/Web/JavaScript/Reference',
  '/en-US/docs/Web/API',
  '/en-US/docs/Web/HTML/Element',
  '/en-US/docs/Web/CSS/Reference',
  '/en-US/docs/Web/HTTP',
  '/en-US/docs/Web/Performance',
  '/en-US/docs/Learn/JavaScript',
  '/en-US/docs/Learn/HTML',
  '/en-US/docs/Learn/CSS'
];

async function scrapePageContent(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Extract main content
    const title = $('h1').first().text().trim();
    const content = $('.main-page-content').text().trim() || 
                   $('#content').text().trim() ||
                   $('article').text().trim();
    
    // Extract summary from first paragraph
    const summary = $('article > p').first().text().trim().slice(0, 500);
    
    return {
      title: title || 'Untitled',
      content: content.slice(0, 10000), // Limit content size
      summary: summary || content.slice(0, 500)
    };
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
    return null;
  }
}

async function getLinksFromIndex(indexPath) {
  try {
    const url = `${MDN_BASE}${indexPath}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Find all documentation links
    const links = [];
    $('a[href*="/docs/"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && href.startsWith('/en-US/docs/')) {
        const fullUrl = `${MDN_BASE}${href}`;
        if (!links.includes(fullUrl)) {
          links.push(fullUrl);
        }
      }
    });
    
    return links.slice(0, 100); // Limit per index
  } catch (error) {
    console.error(`Error getting links from ${indexPath}:`, error.message);
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🚀 MDN scraper started');
    const startTime = Date.now();
    let totalScraped = 0;
    let totalErrors = 0;

    // Get or create source
    const { data: source, error: sourceError } = await supabase
      .from('knowledge_sources')
      .upsert({
        name: 'MDN Web Docs',
        source_type: 'documentation',
        base_url: 'https://developer.mozilla.org',
        scrape_frequency: 'every_12_hours',
        is_active: true,
        last_scraped_at: new Date().toISOString()
      }, {
        onConflict: 'name'
      })
      .select()
      .single();

    if (sourceError) {
      console.error('Source error:', sourceError);
      return res.status(500).json({ error: 'Failed to create source' });
    }

    console.log(`✅ Source: ${source.name} (ID: ${source.id})`);

    // Scrape each documentation path
    for (const path of MDN_PATHS) {
      try {
        console.log(`\n📚 Scraping: ${path}`);
        
        // Get links from index
        const links = await getLinksFromIndex(path);
        console.log(`  Found ${links.length} links`);
        
        // Scrape each page
        for (const url of links) {
          try {
            const pageData = await scrapePageContent(url);
            
            if (pageData) {
              const { error: insertError } = await supabase
                .from('knowledge_content')
                .upsert({
                  source_id: source.id,
                  title: pageData.title,
                  content_type: 'documentation',
                  url: url,
                  content: pageData.content,
                  summary: pageData.summary,
                  metadata: {
                    index_path: path,
                    scraped_at: new Date().toISOString()
                  },
                  scraped_at: new Date().toISOString()
                }, {
                  onConflict: 'url'
                });

              if (insertError) {
                console.error(`  ⚠️  Insert error for ${url}:`, insertError.message);
                totalErrors++;
              } else {
                totalScraped++;
                if (totalScraped % 10 === 0) {
                  console.log(`  ✅ Progress: ${totalScraped} pages`);
                }
              }
            }
            
            // Rate limiting - be nice to MDN
            await new Promise(resolve => setTimeout(resolve, 500));
            
          } catch (error) {
            console.error(`  ❌ Error scraping ${url}:`, error.message);
            totalErrors++;
          }
        }
        
        console.log(`  ✅ Completed ${path}: ${links.length} pages processed`);
        
      } catch (error) {
        console.error(`  ❌ Error with ${path}:`, error.message);
        totalErrors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Update source stats
    await supabase
      .from('knowledge_sources')
      .update({
        last_scraped_at: new Date().toISOString(),
        metadata: {
          last_scrape_duration: duration,
          last_scrape_count: totalScraped,
          last_scrape_errors: totalErrors
        }
      })
      .eq('id', source.id);

    const response = {
      success: true,
      source: 'MDN Web Docs',
      scraped: totalScraped,
      errors: totalErrors,
      duration: `${duration}s`,
      timestamp: new Date().toISOString()
    };

    console.log('\n✅ Scraping complete:', response);
    return res.status(200).json(response);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

import fs from 'fs';
import { ClientConfig } from 'pg';
import { publicIpv4, publicIpv6 } from 'public-ip';
import puppeteerExtra from 'puppeteer-extra';
import { Browser, Page } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import sourceMapSupport from 'source-map-support';
import * as domMonitor from './ads/dom-monitor.js';
import { findArticle, findPageWithAds } from './pages/find-page.js';
import { PageType, scrapePage } from './pages/page-scraper.js';
import DbClient from './util/db.js';
import * as log from './util/log.js';
import { createAsyncTimeout, sleep } from './util/timeout.js';
import { scrapeAdsOnPage } from './ads/ad-scraper.js';
import path from 'path';

sourceMapSupport.install();

export interface CrawlerFlags {
  name?: string,
  jobId: number,
  crawlId: number,
  outputDir: string,
  pgConf: ClientConfig,
  crawlerHostname: string,
  crawlListFile: string,
  // crawlPrevAdLandingPages?: number

  chromeOptions: {
    profileDir?: string,
    headless: boolean | 'new',
  }

  crawlOptions: {
    shuffleCrawlList: boolean,
    crawlAdditionalPageWithAds: boolean,
    crawlAdditionalArticlePage: boolean
  }

  scrapeOptions: {
    scrapeSite: boolean,
    scrapeAds: boolean,
    clickAds: 'noClick' | 'clickAndBlockLoad' | 'clickAndScrapeLandingPage',
    screenshotAdsWithContext: boolean
  }
};

declare global {
  var BROWSER: Browser;
  var FLAGS: CrawlerFlags;
  var OVERALL_TIMEOUT: number;
  var PAGE_CRAWL_TIMEOUT: number;
  var AD_CRAWL_TIMEOUT: number;
  var CLICKTHROUGH_TIMEOUT: number;
  var AD_CLICK_TIMEOUT: number;
  var AD_SLEEP_TIME: number;
  var PAGE_SLEEP_TIME: number;
  var VIEWPORT: { width: number, height: number}
}

function setupGlobals(crawlerFlags: CrawlerFlags, crawlList: string[]) {
  globalThis.FLAGS = crawlerFlags;
  // How long the crawler should spend on the whole crawl (all pages/ads/CTs)
  // 15 min per item in the crawl list
  globalThis.OVERALL_TIMEOUT = crawlList.length * 15 * 60 * 1000;
  // How long the crawler can spend on each clickthrough page
  globalThis.CLICKTHROUGH_TIMEOUT = 30 * 1000;  // 30s
  // How long the crawler should wait for something to happen after clicking an ad
  globalThis.AD_CLICK_TIMEOUT = 10 * 1000;  // 10s
  // How long the crawler can spend waiting for the HTML of a page.
  globalThis.PAGE_CRAWL_TIMEOUT = 60 * 1000;  // 1min
  // How long the crawler can spend waiting for the HTML and screenshot of an ad.
  // must be greater than |AD_SLEEP_TIME|
  globalThis.AD_CRAWL_TIMEOUT = 20 * 1000;  // 20s
  // How long the crawler should sleep before scraping/screenshotting an ad
  globalThis.AD_SLEEP_TIME = 5 * 1000;  // 5s
  // How long the crawler should sleep before crawling a page
  globalThis.PAGE_SLEEP_TIME = 10 * 1000;  // 10s
  // Size of the viewport
  globalThis.VIEWPORT = { width: 1366, height: 768 };
}

export async function crawl(flags: CrawlerFlags) {
  // if (!flags.crawlListFile && !flags.crawlPrevAdLandingPages) {
  //   console.log('Must specific either --crawl_list or --crawl_prev_ad_landing_pages')
  // }

  // Validate arguments
  if (!fs.existsSync(flags.outputDir)) {
    console.log(`${flags.outputDir} is not a valid directory`);
    process.exit(1);
  }

  const db = await DbClient.initialize(flags.pgConf);

  let crawlList: string[] = [];
  let crawlListAdIds: number[] = [];

  // if (flags.crawlListFile) {
    if (!fs.existsSync(flags.crawlListFile)) {
      console.log(`${flags.crawlListFile} does not exist.`);
      process.exit(1);
    }

    crawlList = fs.readFileSync(flags.crawlListFile).toString().trimEnd().split('\n');
    let i = 1;
    for (let url of crawlList) {
      try {
        new URL(url);
      } catch (e) {
        console.log(`Invalid URL in ${flags.crawlListFile}, line ${i}: ${url}`);
        process.exit(1);
      }
    }
  // } else if (flags.crawlPrevAdLandingPages) {
  //   const landingPages = await db.postgres.query(`SELECT id, url FROM ad WHERE crawl_id=$1 AND url IS NOT NULL`, [flags.crawlPrevAdLandingPages])
  //   crawlListAdIds = landingPages.rows.map(row => row.id);
  //   crawlList = landingPages.rows.map(row => row.url);
  // }

  // Initialize global variables and clients
  console.log(flags);
  setupGlobals(flags, crawlList);

  // Set up crawl entry, or resume from previous.
  let crawlId: number;
  let crawlListStartingIndex = 0;
  if (!FLAGS.crawlId) {
    crawlId = await db.insert({
      table: 'crawl',
      returning: 'id',
      data: {
        job_id: FLAGS.jobId,
        name: FLAGS.name,
        start_time: new Date(),
        completed: false,
        crawl_list: FLAGS.crawlListFile, // path.basename(FLAGS.crawlListFile ? FLAGS.crawlListFile : `Crawl ${FLAGS.crawlPrevAdLandingPages} landing pages` ),
        crawl_list_current_index: 0,
        crawl_list_length: crawlList.length,
        profile_dir: FLAGS.chromeOptions.profileDir,
        crawler_hostname: FLAGS.crawlerHostname,
        crawler_ip: await getPublicIp()
      }
    }) as number;
  } else {
    const prevCrawl = await db.postgres.query('SELECT * FROM crawl WHERE id=$1', [FLAGS.crawlId]);
    if (prevCrawl.rowCount !== 1) {
      console.log(`Invalid crawl_id: ${FLAGS.crawlId}`);
      process.exit(1);
    }
    if (prevCrawl.rows[0].crawl_list !== path.basename(FLAGS.crawlListFile)) {// (FLAGS.crawlListFile ? path.basename(FLAGS.crawlListFile) : `Crawl ${FLAGS.crawlPrevAdLandingPages} landing pages`)) {
      console.log(`Crawl list file provided does not the have same name as the original crawl. Expected: ${prevCrawl.rows[0].crawl_list}, actual: ${FLAGS.crawlListFile}`);
      process.exit(1);
    }
    if (prevCrawl.rows[0].crawl_list_length !== crawlList.length) {
      console.log(`Crawl list file provided does not the have same number of URLs as the original crawl. Expected: ${prevCrawl.rows[0].crawl_list_length}, actual: ${crawlList.length}`);
      process.exit(1);
    }
    crawlId = FLAGS.crawlId;
    crawlListStartingIndex = prevCrawl.rows[0].crawl_list_current_index;
  }

  // Open browser
  log.info('Launching browser...');

  puppeteerExtra.default.use(StealthPlugin())

  globalThis.BROWSER = await puppeteerExtra.default.launch({
    args: ['--disable-dev-shm-usage'],
    defaultViewport: VIEWPORT,
    headless: FLAGS.chromeOptions.headless,
    handleSIGINT: false,
    userDataDir: FLAGS.chromeOptions.profileDir
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing browser...');
    await BROWSER.close();
    process.exit();
  });

  const version = await BROWSER.version();
  log.info('Running ' + version);

  try {
    // Main loop through crawl list
    for (let i = crawlListStartingIndex; i < crawlList.length; i++) {
      const url = crawlList[i];
      // let prevAdId = FLAGS.crawlPrevAdLandingPages ? crawlListAdIds[i] : -1;

      // Set overall timeout for this crawl list item
      let [urlTimeout, urlTimeoutId] = createAsyncTimeout(
        `${url}: overall site timeout reached`, OVERALL_TIMEOUT);

      let seedPage = await BROWSER.newPage();

      try {
        let _crawl = (async () => {
          // Insert record for this crawl list item
          try {
            // Open the URL and scrape it (if specified)
            const pageId = await loadAndHandlePage(url, seedPage, PageType.MAIN, crawlId) //, undefined, undefined, FLAGS.crawlPrevAdLandingPages ? prevAdId : undefined);

            // Open additional pages (if specified) and scrape them (if specified)
            if (FLAGS.crawlOptions.crawlAdditionalArticlePage) {
              const articleUrl = await findArticle(seedPage);
              if (articleUrl) {
                const articlePage = await BROWSER.newPage();
                await loadAndHandlePage(articleUrl, articlePage, PageType.SUBPAGE, crawlId, pageId, seedPage.url());
                await articlePage.close();
              } else {
                log.strError(`${url}: Couldn't find article`);
              }
            }

            if (FLAGS.crawlOptions.crawlAdditionalPageWithAds) {
              const urlWithAds = await findPageWithAds(seedPage);
              if (urlWithAds) {
                const adsPage = await BROWSER.newPage();
                await loadAndHandlePage(urlWithAds, adsPage, PageType.SUBPAGE, crawlId, pageId, seedPage.url());
                await adsPage.close();
              } else {
                log.strError(`${url}: Couldn't find article`);
              }
            }
          } catch (e: any) {
            log.error(e);
            throw e;
          } finally {
            clearTimeout(urlTimeoutId);
          }
        })();
        await Promise.race([_crawl, urlTimeout]);
      } catch (e: any) {
        log.error(e);
      } finally {
        await seedPage.close();
        await db.postgres.query('UPDATE crawl SET crawl_list_current_index=$1 WHERE id=$2', [i, crawlId])
      }
    }
    await BROWSER.close();
    await db.postgres.query('UPDATE crawl SET completed=TRUE, completed_time=$1 WHERE id=$2', [new Date(),crawlId]);
  } catch (e) {
    await BROWSER.close();
    throw e;
  }
}

/**
 *
 * @param url URL to visit in the page
 * @param page Tab/Page that the URL should be visited in
 * @param pageType Whether the URL is the one in the crawl list, or an
 * additional URL that was found from a link on the initial page.
 * @param referrerPageId The page id of the page that this URL came from,
 * if this is a subpage of the crawl list page.
 * @param referrerPageUrl: The URL of the page that this URL came from.
 * if this is a subpage of the crawl list page.
 * @param crawlId ID of the crawl
 */
async function loadAndHandlePage(url: string, page: Page, pageType:
    PageType, crawlId: number, referrerPageId?: number, referrerPageUrl?: string, referrerAd?: number) {
  log.info(`${url}: loading page`);
  if (FLAGS.scrapeOptions.scrapeAds) {
    await domMonitor.injectDOMListener(page);
  }
  await page.goto(url, { timeout: 120000 });

  await scrollDownPage(page);

  // Crawl the page
  // TODO: if referrer ad is passed, call with landing page pagetype
  let pageId: number;
  if (FLAGS.scrapeOptions.scrapeSite) {
    pageId = await scrapePage(page, {
      crawlListUrl: url,
      pageType: pageType,
      crawlId: crawlId
      // referrerAd: referrerAd,
    });
  } else {
    // If we're not scraping page, still create a database entry (without)
    // any of the scraped contents
    const db = DbClient.getInstance();
    pageId = await db.archivePage({
      job_id: FLAGS.jobId,
      crawl_id: crawlId,
      timestamp: new Date(),
      url: page.url(),
      crawl_list_url: url,
      page_type: pageType,
      referrer_page: referrerPageId,
      referrer_page_url: referrerPageUrl
    });
  }
  if (FLAGS.scrapeOptions.scrapeAds) {
    await scrapeAdsOnPage(page, {
      crawlId: crawlId,
      crawlListUrl: url,
      pageType: pageType,
      parentPageId: pageId,
    });
  }
  return pageId;
}

async function scrollDownPage(page: Page) {
  let innerHeight = await page.evaluate(() => window.innerHeight);
  let scrollTop = await page.evaluate(() => document.body.scrollTop);
  let scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  let i = 0;
  while (scrollTop + innerHeight < scrollHeight && i < 20) {
    // Perform a random scroll on the Y axis, can
    // be called at regular intervals to surface content on
    // pages

    // set a screen position to scroll from
    let xloc = randrange(50, 100);
    let yloc = randrange(50, 100);

    // Scroll a random amount
    let ydelta = randrange(200, 400);
    // puppeteer provides current mouse position to wheel mouse event
    await page.mouse.move(xloc, yloc);
    await page.mouse.wheel({ deltaY: ydelta });
    await sleep(1000);

    innerHeight = await page.evaluate(() => window.innerHeight);
    scrollTop = await page.evaluate(() => document.body.scrollTop);
    scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    i += 1;
  }
}

function randrange(low: number, high: number): number {
  return Math.random() * (high - low) + low;
}

async function getPublicIp() {
  try {
    let v4 = await publicIpv4();
    if (v4) {
      return v4;
    }
  } catch (e) {
    console.log(e);
    try {
      let v6 = await publicIpv6();
      if (v6) {
        return v6;
      }
    } catch (e) {
      console.log(e);
      return null;
    }
  }
}

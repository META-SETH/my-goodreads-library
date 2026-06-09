#!/usr/bin/env node
/**
 * enrich-covers.mjs  (v2)  —  BUILD-TIME cover pre-fetch. Run on your Mac, by hand.
 * Reads data/library.js, fills a `coverUrl` on each book it can resolve, writes
 * it back. Your live site reads book.coverUrl directly (no runtime API calls).
 *
 * NO API KEY REQUIRED. All sources are keyless. Source chain, in order:
 *   1. Open Library covers by ISBN        (cheap HEAD request; the broad source)
 *   2. Google Books "Dynamic Links"       (the keyless side-door, NOT v1/volumes)
 *   3. Goodreads og:image by BOOK ID      (NEW in v2 — exact-identity lookup of
 *      the very edition you shelved; reaches the no-ISBN and small-press books)
 *   4. Open Library search, full title    (fuzzy; guarded by isTitleAuthorSafe)
 *   5. Open Library search, CORE title    (NEW in v2 — "The Hobbit" instead of
 *      "The Hobbit, or There and Back Again"; recovers subtitle-match misses)
 *   6. bookcover.longitood.com            (fault-tolerant last rung; often down)
 *
 * Why Goodreads-by-id sits ABOVE the fuzzy searches: it is keyed by the exact
 * Goodreads book id from your own export, so it cannot fetch the wrong book.
 * Precision beats recall — and this rung has both.
 *
 * USAGE:   node enrich-covers.mjs
 * SAFE TO RE-RUN: books that already have coverUrl are skipped (idempotent).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const LIBRARY_PATH = './data/library.js';
const OVERRIDES_PATH = './data/cover-overrides.json';   // optional hand-curated map
const PREFIX = 'window.libraryData = ';
const SUFFIX = ';';

// A real browser UA so Goodreads serves the normal HTML page.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function getIsbn(book) {
  return book.isbn13 || book.isbn || null;
}

// ---------------------------------------------------------------------------
// Source 1: Open Library covers. HEAD-only; ?default=false => real 404 on miss.
async function tryOpenLibrary(isbn) {
  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return res.ok ? url : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Source 2: Google Books Dynamic Links (KEYLESS).
// Response is JSONP-ish: var _GBSBookInfo = { "ISBN:...": {thumbnail_url...} };
async function tryGoogleDynamic(isbn) {
  const api = `https://books.google.com/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=viewapi`;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(text.slice(start, end + 1));
    const entry = obj[`ISBN:${isbn}`];
    let url = entry && entry.thumbnail_url;
    if (!url) return null;
    url = url.replace(/zoom=\d+/, 'zoom=1').replace(/^http:\/\//, 'https://');
    return url;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Source 3 (NEW): Goodreads og:image, keyed by the book's own Goodreads id.
// Every row in a Goodreads export has this id, so this rung is structurally
// able to reach EVERY book — including the no-ISBN and small-press tail —
// and it cannot mismatch, because the id names the exact shelved edition.
// We reject Goodreads' "nophoto" placeholder so a missing cover stays an
// honest miss instead of a gray placeholder baked into the data.
async function tryGoodreadsById(book) {
  if (!book.id) return null;
  const api = `https://www.goodreads.com/book/show/${book.id}`;
  // Goodreads throttles bursts. We retry with exponential backoff: the pauses
  // (5s, then 20s) let the rate-limit window reset instead of wasting the rung.
  const backoffs = [0, 5000, 20000];
  for (const wait of backoffs) {
    if (wait) { console.log(`    ...goodreads throttled, backing off ${wait / 1000}s`); await sleep(wait); }
    try {
      const res = await fetch(api, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 429 || res.status === 403 || res.status >= 500) continue; // throttled -> back off, retry
      if (!res.ok) return null;                                                    // real miss (e.g. 404)
      const html = await res.text();
      const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
      if (!m) return null;
      const url = m[1];
      if (/nophoto|no-cover/i.test(url)) return null;
      // Positive check: real Goodreads cover URLs contain a /books/ path
      // segment. Anything else (e.g. the goodreads_wide site banner served
      // as og:image on cover-less editions) is NOT a cover -> honest miss.
      if (!/\/books\//.test(url)) return null;
      // Be a polite scraper: a full second between Goodreads page fetches.
      await sleep(400);
      return url;
    } catch { continue; } // a timeout also smells like throttling -> back off, retry
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard: is this book clean enough to risk a FUZZY title+author match?
// (Only the fuzzy search rungs need this — the Goodreads id rung is exact.)
function isTitleAuthorSafe(book) {
  const author = (book.author || '').trim();
  const title = (book.title || '').trim();
  if (!author || !title) return false;
  if (/^unknown/i.test(author)) return false;
  if (author.replace(/[^a-z]/gi, '').length <= 3) return false;   // "P.T."
  if (/^[\[\(]/.test(title)) return false;                         // "[Selected Writings]..."
  if (/manuscripts|collection|box set|boxed set/i.test(title)) return false;
  return true;
}

// The distinctive CORE of a title: strip "(Series, #N)" parentheticals, then
// cut at the first ':' or ','. "The Hobbit, or There and Back Again" -> "The
// Hobbit". Returns null when there is nothing to trim (so we don't repeat the
// identical query) or when the core would be uselessly short.
function coreTitle(title) {
  let t = (title || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = t.search(/[:,]/);
  if (cut > 0) t = t.slice(0, cut).trim();
  if (t.length < 3) return null;
  if (t.toLowerCase() === (title || '').trim().toLowerCase()) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Sources 4 & 5: Open Library SEARCH by title+author (KEYLESS, fuzzy).
// Returns a numeric cover_i -> image via the /b/id/ endpoint.
async function tryOpenLibrarySearch(book, titleOverride) {
  if (!isTitleAuthorSafe(book)) return null;
  const t = encodeURIComponent(titleOverride || book.title);
  const a = encodeURIComponent(book.author);
  const api = `https://openlibrary.org/search.json?title=${t}&author=${a}&limit=1&fields=cover_i`;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    const cover = data?.docs?.[0]?.cover_i;
    if (!cover) return null;
    return `https://covers.openlibrary.org/b/id/${cover}-M.jpg`;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Source 6: longitood / Goodreads proxy (KEYLESS, fault-tolerant). Last rung;
// it has been down (HTTP 522 / timeouts) but costs nothing to keep.
async function tryLongitood(book) {
  const isbn = getIsbn(book);
  let api;
  if (isbn) {
    api = `https://bookcover.longitood.com/bookcover?isbn=${encodeURIComponent(isbn)}`;
  } else {
    const t = encodeURIComponent(book.title);
    const a = encodeURIComponent(book.author || '');
    api = `https://bookcover.longitood.com/bookcover?book_title=${t}&author_name=${a}`;
  }
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.url ? data.url : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
async function resolveCover(book) {
  const isbn = getIsbn(book);
  if (isbn) {
    const ol = await tryOpenLibrary(isbn);
    if (ol) return { url: ol, source: 'openlibrary' };
    const gd = await tryGoogleDynamic(isbn);
    if (gd) return { url: gd, source: 'google-dynamic' };
  }
  // Exact-identity lookup of the shelved edition — reaches no-ISBN books too.
  const gr = await tryGoodreadsById(book);
  if (gr) return { url: gr, source: 'goodreads-id' };
  // Fuzzy searches, full title first, then the distinctive core.
  const ols = await tryOpenLibrarySearch(book);
  if (ols) return { url: ols, source: 'ol-search-full' };
  const core = coreTitle(book.title);
  if (core) {
    const olc = await tryOpenLibrarySearch(book, core);
    if (olc) return { url: olc, source: 'ol-search-core' };
  }
  const lt = await tryLongitood(book);
  if (lt) return { url: lt, source: 'longitood' };
  return null;
}

async function main() {
  const raw = await readFile(LIBRARY_PATH, 'utf8');
  const jsonText = raw.slice(PREFIX.length, raw.length - SUFFIX.length);
  const books = JSON.parse(jsonText);
  console.log(`Loaded ${books.length} books.`);

  // Hand-curated overrides win over every automated source. Keyed by the
  // Goodreads book id; keys starting with "_" are documentation, not data.
  let overrides = {};
  try { overrides = JSON.parse(await readFile(OVERRIDES_PATH, 'utf8')); } catch { /* no overrides file: fine */ }

  const bySource = {
    'override': 0, 'openlibrary': 0, 'google-dynamic': 0, 'goodreads-id': 0,
    'ol-search-full': 0, 'ol-search-core': 0, 'longitood': 0,
  };
  let filled = 0, skipped = 0, missed = 0;
  const misses = [];

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    if (book.coverUrl) { skipped++; continue; }

    const ovUrl = !String(book.id).startsWith('_') && overrides[String(book.id)];
    const hit = ovUrl ? { url: ovUrl, source: 'override' } : await resolveCover(book);
    if (hit) {
      book.coverUrl = hit.url;
      bySource[hit.source]++;
      filled++;
      console.log(`  ✓ [${hit.source}] ${book.title.slice(0, 55)}`);
    } else {
      missed++;
      misses.push(`${book.id}  ${book.title} | ${book.author}`);
      console.log(`  x [miss]         ${book.title.slice(0, 55)}`);
    }
    // CHECKPOINT: persist progress every 10 processed books, so an interrupted
    // run keeps its hits (the script is idempotent, so re-running resumes).
    if ((filled + missed) % 5 === 0) {
      await writeFile(LIBRARY_PATH, PREFIX + JSON.stringify(books) + SUFFIX, 'utf8');
    }
    await sleep(120);
  }

  const out = PREFIX + JSON.stringify(books) + SUFFIX;
  await writeFile(LIBRARY_PATH, out, 'utf8');

  console.log(`\nDone.`);
  console.log(`  Filled ${filled} new covers:`);
  for (const [k, v] of Object.entries(bySource)) console.log(`    ${k.padEnd(16)} ${v}`);
  console.log(`  Skipped (already had cover): ${skipped}`);
  console.log(`  Still unfound: ${missed}`);
  if (misses.length) {
    console.log(`\n  Unresolved books:`);
    misses.forEach(m => console.log(`    ✗ ${m}`));
  }
}

main();

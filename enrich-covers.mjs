#!/usr/bin/env node
/**
 * enrich-covers.mjs  —  BUILD-TIME cover pre-fetch. Run on your Mac, by hand.
 * Reads data/library.js, fills a `coverUrl` on each book it can resolve, writes
 * it back. Your live site reads book.coverUrl directly (no runtime API calls).
 *
 * NO API KEY REQUIRED. All sources are keyless:
 *   1. Open Library covers (the site's own source)
 *   2. Google Books "Dynamic Links" (books.google.com/books?...jscmd=viewapi) —
 *      the keyless endpoint EBSCO and library catalogs use. NOT the quota-gated
 *      v1/volumes REST API; no key, no daily cap.
 *   3. bookcover.longitood.com (keyless Goodreads scraper; fault-tolerant —
 *      if it's down, we skip it and you re-run later)
 *
 * USAGE:   node enrich-covers.mjs
 * SAFE TO RE-RUN: books that already have coverUrl are skipped.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const LIBRARY_PATH = './data/library.js';
const PREFIX = 'window.libraryData = ';
const SUFFIX = ';';

function getIsbn(book) {
  return book.isbn13 || book.isbn || null;
}

// Source 1: Open Library. HEAD-only; ?default=false => real 404 on a miss.
async function tryOpenLibrary(isbn) {
  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok ? url : null;
  } catch { return null; }
}

// Source 2: Google Books Dynamic Links (KEYLESS).
// Response is JSONP-ish: var _GBSBookInfo = { "ISBN:...": {thumbnail_url...} };
async function tryGoogleDynamic(isbn) {
  const api = `https://books.google.com/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=viewapi`;
  try {
    const res = await fetch(api);
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

// Source 3: longitood / Goodreads (KEYLESS, fault-tolerant). Last resort.
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
    const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.url ? data.url : null;
  } catch { return null; }
}

async function resolveCover(book) {
  const isbn = getIsbn(book);
  if (isbn) {
    const ol = await tryOpenLibrary(isbn);
    if (ol) return { url: ol, source: 'openlibrary' };
    const gd = await tryGoogleDynamic(isbn);
    if (gd) return { url: gd, source: 'google-dynamic' };
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

  const bySource = { openlibrary: 0, 'google-dynamic': 0, longitood: 0 };
  let filled = 0, skipped = 0, missed = 0;
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    if (book.coverUrl) { skipped++; continue; }

    const hit = await resolveCover(book);
    if (hit) {
      book.coverUrl = hit.url;
      bySource[hit.source]++;
      filled++;
      console.log(`  ✓ [${hit.source}] ${book.title.slice(0, 50)}`);
    } else {
      missed++;
    }
    await sleep(120);
    if ((i + 1) % 50 === 0) console.log(`...processed ${i + 1}/${books.length}`);
  }

  const out = PREFIX + JSON.stringify(books) + SUFFIX;
  await writeFile(LIBRARY_PATH, out, 'utf8');

  console.log(`\nDone.`);
  console.log(`  Filled ${filled} new covers:`);
  console.log(`    Open Library:     ${bySource.openlibrary}`);
  console.log(`    Google (keyless): ${bySource['google-dynamic']}`);
  console.log(`    longitood:        ${bySource.longitood}`);
  console.log(`  Skipped (already had cover): ${skipped}`);
  console.log(`  Still unfound: ${missed}`);
}

main();

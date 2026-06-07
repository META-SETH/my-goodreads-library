# 📚 My Goodreads Library

A browsable, searchable gallery of my personal book collection — hosted as a static site via GitHub Pages.

**🔗 [View the Live Gallery](https://meta-seth.github.io/my-goodreads-library/)**

---

## What Is This?

A self-contained web gallery built from a [Goodreads](https://www.goodreads.com/user/show/112315860-mr-meta-seth) library export. It renders 945 books with cover art, search, filtering, sorting, and a detail panel — all client-side with zero backend.

## Features

- **Search** — filter by title, author, or publisher in real time
- **Shelf Filters** — browse by Read, Currently Reading, To Read, or custom shelves
- **Sort** — by title, author, rating, date added, date read, page count, or publication year
- **Grid & List Views** — toggle between a cover art grid and a compact list
- **Detail Panel** — click any book to see metadata, rating, shelves, and a link back to Goodreads
- **Cover Art** — pulled dynamically from the Open Library Covers API via ISBN
- **Responsive** — works on desktop and mobile
- **Offline-Capable** — includes a web app manifest for PWA-style access

## Project Structure

```
.
├── index.html           # Self-contained gallery app
├── data/
│   └── library.js       # Book metadata (JSON from Goodreads CSV export)
├── app.webmanifest      # PWA manifest
├── .nojekyll            # Tells GitHub Pages to skip Jekyll processing
└── README.md
```

## How It Was Built

1. Exported library data as CSV from [Goodreads](https://www.goodreads.com/review/import)
2. Converted the CSV to a JSON data file
3. Built a static gallery app (HTML/CSS/JS) inspired by the [Audible Library Extractor](https://github.com/joonaspaakko/audible-library-extractor) gallery format
4. Deployed to GitHub Pages

## Updating the Gallery

1. Export a fresh CSV from Goodreads
2. Re-run the CSV → JSON conversion
3. Replace `data/library.js`
4. Commit and push:
   ```bash
   git add .
   git commit -m "Update library"
   git push
   ```

## Credits

- Book data from [Goodreads](https://www.goodreads.com/)
- Cover images from [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers)
- Inspired by the [Audible Library Extractor](https://github.com/joonaspaakko/audible-library-extractor) gallery

---

*Last updated: June 2026*

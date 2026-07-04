# web-search

An LM Studio plugin that gives your local models the ability to search the web and read web pages. Built for agentic, iterative research — not just one search and done.

## Features

- **DuckDuckGo search** — scrapes real search results with titles, URLs, and snippets via got-scraping for bot evasion
- **Web page reading** — fetches and cleans page content using [Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown) for clean prose, with [Jina Reader](https://jina.ai/reader/) as fallback
- **YouTube transcripts** — automatically extracts the full transcript when given a YouTube URL instead of scraping the page
- **PDF support** — always routed through Jina for extraction
- **Site-specific handling** — automatic URL rewrites for better content on specific sites:
  - Reddit links use old.reddit.com for clean thread access
  - arXiv abstract links redirect to the PDF version
  - Medium articles route through scribe.rip to bypass the paywall, with fallback to Jina on the original URL if scribe.rip is unavailable
  - AMP pages are de-AMPed to the original URL before fetching
  - Any URL containing "pdf" is routed through Jina
- **Prompt Guidance** — optionally injects research reminders into tool responses to steer the model toward more thorough, iterative research behavior
- **Result caching** — repeated searches within 5 minutes return cached results instantly without hitting the network again

## Installation

Install from the LM Studio Hub via "Run in LM Studio" button

## Configuration

| Setting | Default | Description |
|---|---|---|
| **Search Results Per Page** | 5 | How many results to return per search (1–10, 0 = auto) |
| **Max Content** | 8000 | Maximum characters returned by Visit Website. Increase for long articles, decrease to save context. -1 = auto |
| **Prompt Guidance** | On | When enabled, tool responses include dynamic reminders that track how many searches and page visits have been done and nudge the model to keep researching before answering. Recommended for smaller models. Large capable models may perform better with it off. |

## Tools

**Web Search** — searches DuckDuckGo and returns a list of results with titles, URLs, and snippets. Uses got-scraping for realistic browser fingerprints to evade bot detection. Results for repeated queries are served from cache.

**Visit Website** — fetches a URL and returns cleaned text content. Handles YouTube, PDFs, Reddit, arXiv, Medium, and AMP URLs automatically. Tries Readability + Turndown first for clean, fast results. Falls back to Jina if direct fetch fails or returns poor content. PDFs always use Jina.

## Prompt Guidance

When enabled, every search and page visit returns a `reminder` field alongside the content. This reminder tracks the current research session in real time — how many searches have been done, how many pages visited — and tells the model what to do next. The intended flow is: search → visit one result → visit another → search again → visit one more → visit one more → answer.

This is most useful with smaller models that tend to answer after a single search. Larger models that already do agentic research naturally may work better with it off.

## Notes

- Search results and content fetching depend on DuckDuckGo and Jina being accessible from your machine — both are free services with no API key required
- YouTube transcripts require captions to exist on the video. Auto-generated captions count, but some music videos and very new uploads may not have them
- Direct fetch uses Readability (same engine as Firefox's reader mode) which strips navigation, sidebars, and other non-content elements. Link URLs are removed, keeping only the text.
- Jina is used as fallback when direct fetch fails, and always for PDFs
- Search results are cached per session in memory only — cache does not persist across LM Studio restarts

## Credits

Originally based on [danielsig](https://lmstudio.ai/danielsig)'s DuckDuckGo search and Visit Website plugins for LM Studio.

## License

MIT

import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import * as cheerio from "cheerio";
import { fetchTranscript } from "youtube-transcript-plus";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { configSchematics } from "./config";

type SearchResult = { title: string; url: string; snippet: string };

const td = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-',
	linkStyle: 'inlined',
});
td.remove(['img', 'figure']);

function extractContent(html: string, url: string): { title: string, content: string } {
	const dom = new JSDOM(html, { url });
	const article = new Readability(dom.window.document).parse();
	if (!article || !article.content) return { title: 'Untitled', content: '' };

	// Strip links from article content, keeping only text
	const tmp = new JSDOM(article.content);
	tmp.window.document.querySelectorAll('a').forEach(el => {
		el.replaceWith(...el.childNodes);
	});

	return {
		title: article.title ?? 'Untitled',
		content: td.turndown(tmp.window.document.body.innerHTML).replace(/\n{3,}/g, '\n\n').trim(),
	};
}

let gotScrapingInstance: typeof import('got-scraping').gotScraping | null = null;

async function fetchPage(url: string, signal: AbortSignal): Promise<string> {
	gotScrapingInstance ??= (await import('got-scraping')).gotScraping;
	const response = await gotScrapingInstance({
		url,
		signal,
		timeout: { request: 30000 },
	});
	return response.body as string;
}

export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
	const tools: Tool[] = [];

	const makeRateLimiter = (interval: number) => {
		let lastRequestTimestamp = 0;
		return async () => {
			const now = Date.now();
			const waitMs = interval - (now - lastRequestTimestamp);
			if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
			lastRequestTimestamp = Date.now();
		};
	};

	const waitIfNeededSearch = makeRateLimiter(2000);
	const waitIfNeededJina = makeRateLimiter(1000);

	const getJinaHeaders = (): Record<string, string> => {
		const apiKey = ctl.getPluginConfig(configSchematics).get("jinaApiKey");
		return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	};

	let searchCount = 0;
	let visitCount = 0;

	// In-memory search result cache (session-scoped, LRU)
	const searchCache = new Map<string, { results: SearchResult[], timestamp: number }>();
	const CACHE_TTL = 5 * 60 * 1000;
	const MAX_CACHE_SIZE = 100;

	const evictCacheIfNeeded = () => {
		const now = Date.now();
		for (const [key, entry] of searchCache) {
			if (now - entry.timestamp > CACHE_TTL) searchCache.delete(key);
		}
		while (searchCache.size >= MAX_CACHE_SIZE) {
			const oldest = searchCache.keys().next().value;
			if (oldest) searchCache.delete(oldest);
			else break;
		}
	};

	const getCachedResults = (query: string, pageSize: number): { results: SearchResult[] } | null => {
		const cached = searchCache.get(query);
		if (!cached) return null;
		if (Date.now() - cached.timestamp > CACHE_TTL) {
			searchCache.delete(query);
			return null;
		}
		// Move to end for LRU
		searchCache.delete(query);
		searchCache.set(query, cached);
		return { results: cached.results.slice(0, pageSize) };
	};

	const setCachedResults = (query: string, results: SearchResult[]) => {
		evictCacheIfNeeded();
		searchCache.set(query, { results, timestamp: Date.now() });
	};

	// Search: DuckDuckGo only
	const searchDuckDuckGo = async (query: string, pageSize: number, signal: AbortSignal): Promise<SearchResult[]> => {
		const url = new URL("https://html.duckduckgo.com/html/");
		url.searchParams.append("q", query);

		const html = await fetchPage(url.toString(), signal);
		const $ = cheerio.load(html);
		const results: SearchResult[] = [];

		$('.result__body').each((_, el) => {
			if (results.length >= pageSize) return false;
			const $resultItem = $(el).closest('.result');
			const classes = $resultItem.attr('class') || '';
			if (/\bresult--ad\b|\bresult--sponsored\b|\bad\b/i.test(classes)) return;
			if (/^\s*Ad\b|^\s*Sponsored\b/i.test($resultItem.text() || '')) return;
			const $anchor = $(el).find('a.result__a');
			if (!$anchor.length) return;
			let href = $anchor.attr('href') || '';

			// Skip ad tracking redirects
			if (/duckduckgo\.com\/(aclick|y\.js)/i.test(href)) return;

			// Extract real URL from DDG redirect
			const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
			if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);

			const title = ($anchor.text() || '').replace(/\s+/g, ' ').trim();
			if (!title) return;
			const snippet = $(el).find('.result__snippet').text().replace(/\s+/g, ' ').trim();
			if (!results.some(r => r.url === href)) results.push({ title, url: href, snippet });
		});

		return results;
	};

	const webSearchTool = tool({
		name: "Web Search",
		description: `REQUIRED WORKFLOW: Search → Visit ONE result → Visit ONE result → Search again → Visit ONE result → Visit ONE result → Answer. You must do this exact sequence for every question. Do not skip steps or visit multiple results before searching again. After visiting 2 results from the first search, you MUST search again with a different query before visiting more results. Use 3-6 word queries. If results are poor, rephrase rather than retry the same query.`,
		parameters: {
			query: z.string().describe("The search query - be specific and varied across searches to get diverse results"),
		},
		implementation: async ({ query }, { status, warn, signal }) => {
			try {
				let pageSize = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("pageSize"), 0) ?? 5;

				// Check cache first (no rate limit for cache hits)
				const cached = getCachedResults(query, pageSize);
				if (cached) {
					searchCount++;
					status(`Returning cached results for "${query}".`);
					return { results: cached.results, count: cached.results.length, cached: true };
				}

				// Rate limit only applies to actual network requests
				await waitIfNeededSearch();

				status(`Searching DuckDuckGo for: "${query}"...`);

				let results: SearchResult[] = [];
				let lastError = '';
				const maxRetries = 3;
				for (let attempt = 1; attempt <= maxRetries; attempt++) {
					if (attempt > 1) {
						status(`Retry ${attempt}/${maxRetries}...`);
						await waitIfNeededSearch();
					}
					try {
						results = await searchDuckDuckGo(query, pageSize, signal);
						if (results.length > 0) break;
						lastError = 'DuckDuckGo returned empty results';
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : 'unknown';
						lastError = `DuckDuckGo error: ${msg}`;
						break;
					}
				}

				if (results.length > 0) {
					setCachedResults(query, results);
					searchCount++;
					const guidanceEnabled = ctl.getPluginConfig(configSchematics).get("promptGuidance") ?? true;
					let reminder: string | undefined;
					if (guidanceEnabled) {
						if (searchCount < 2) {
							reminder = "Visit one of these results, then visit one more. After that, search again with a new query. Do NOT answer yet.";
						} else if (visitCount < 4) {
							reminder = `You have done ${searchCount} searches but only visited ${visitCount}/4 pages. Visit one more, then one more after that.`;
						} else {
							reminder = `You have done ${searchCount} searches and visited ${visitCount} pages. You may now synthesize your findings.`;
						}
					}
					status(`Found ${results.length} results.`);
					return { results, count: results.length, ...(reminder && { reminder }) };
				}

				return `No results found. ${lastError}. Try rephrasing your query.`;
			} catch (error: unknown) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Search was cancelled.";
				}
				const msg = error instanceof Error ? error.message : 'Unknown error';
				console.error(error);
				warn(`Search failed: ${msg}`);
				return `Error: ${msg}`;
			}
		},
	});

	const visitWebsiteTool = tool({
		name: "Visit Website",
		description: `Visit a URL and extract its full text content. Read multiple sources per question — aim for 4+ visits on non-trivial topics. After reading, consider what you learned and whether you need to search for more information or verify specific claims. Seek out diverse sources and primary documentation when possible. Don't stop at the first few results — dig deeper for a thorough answer.`,
		parameters: {
			url: z.string().url().describe("The URL of the website to visit"),
		},
		implementation: async ({ url }, { status, warn, signal }) => {
			const originalUrl = url;

			// De-AMP - AMP pages are always worse than the original
			url = url.replace(/\/amp\/?$/, '');
			url = url.replace(/[?&]amp=1/, '');
			const ampMatch = url.match(/google\.com\/amp\/s\/(.+)/);
			if (ampMatch) url = 'https://' + ampMatch[1];

			// URL transformations for better content extraction
			url = url.replace(/arxiv\.org\/abs\//, 'arxiv.org/pdf/');
			const isMedium = /(?:www\.)?medium\.com/.test(url);
			url = url.replace(/(?:www\.)?medium\.com/, 'scribe.rip');
			url = url.replace(/(?:www\.)?reddit\.com/, 'old.reddit.com');

			const shortUrl = url.length > 50 ? url.slice(0, 47) + '...' : url;
			status(`Fetching content from: ${shortUrl}`);

			try {
				let contentLimit = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("contentLimit"), -1) ?? 8000;
				const isPdf = /pdf/i.test(url);

				// Handle YouTube URLs - fetch transcript instead
				const ytMatch = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([\w-]+)/);
				if (ytMatch) {
					status(`Fetching YouTube transcript for: ${ytMatch[1]}`);
					try {
						const transcript = await fetchTranscript(url);
						const text = transcript.map(t => t.text).join(' ').trim();
						const content = smartTruncate(text, contentLimit);
						status(`Retrieved YouTube transcript (${content.length} chars)`);
						visitCount++;
						const guidanceEnabled = ctl.getPluginConfig(configSchematics).get("promptGuidance") ?? true;
						let reminder: string | undefined;
						if (guidanceEnabled) {
							if (visitCount === 1) {
								reminder = "Visit one more from these results, then search again with a new query.";
							} else if (visitCount === 2 && searchCount < 2) {
								reminder = "Now search again with a new query. Do NOT answer yet.";
							} else if (visitCount === 3) {
								reminder = "Visit one more from these results.";
							} else if (visitCount >= 4) {
								reminder = "You may now synthesize your findings.";
							}
						}
						return {
							url,
							title: 'YouTube Video Transcript',
							content,
							...(reminder && { reminder }),
						};
					} catch (ytErr: unknown) {
						const msg = ytErr instanceof Error ? ytErr.message : 'unknown';
						warn(`YouTube transcript unavailable: ${msg}`);
						status('Falling back to Jina for YouTube page (content may be limited)');
					}
				}

				// PDFs always use Jina
				if (isPdf) {
					await waitIfNeededJina();
					const jinaUrl = `https://r.jina.ai/${url}`;
					const jinaResponse = await fetch(jinaUrl, {
						method: "GET",
						headers: getJinaHeaders(),
						signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
					});
					if (jinaResponse.ok) {
						const raw = await jinaResponse.text();
						const content = smartTruncate(raw, contentLimit);
						visitCount++;
						const guidanceEnabled = ctl.getPluginConfig(configSchematics).get("promptGuidance") ?? true;
						let reminder: string | undefined;
						if (guidanceEnabled) {
							if (visitCount === 1) {
								reminder = "Visit one more from these results, then search again with a new query.";
							} else if (visitCount === 2 && searchCount < 2) {
								reminder = "Now search again with a new query. Do NOT answer yet.";
							} else if (visitCount === 3) {
								reminder = "Visit one more from these results.";
							} else if (visitCount >= 4) {
								reminder = "You may now synthesize your findings.";
							}
						}
						status(`Retrieved PDF (${content.length} chars)`);
						return { url, title: 'PDF Document', content, ...(reminder && { reminder }) };
					}
					return `Error: Could not fetch PDF from ${url}`;
				}

				type ExtractOutcome =
					| { ok: true; title: string; content: string }
					| { ok: false; reason: string };

				// Helper: fetch via Jina
				const tryJina = async (): Promise<ExtractOutcome> => {
					await waitIfNeededJina();
					const jinaUrl = `https://r.jina.ai/${url}`;
					let jinaResponse: Response;
					try {
						jinaResponse = await fetch(jinaUrl, {
							method: "GET",
							headers: getJinaHeaders(),
							signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
						});
					} catch (err) {
						return { ok: false, reason: `Jina request threw: ${err instanceof Error ? err.message : String(err)}` };
					}
					if (!jinaResponse.ok && jinaResponse.status !== 451 && jinaResponse.status !== 403) {
						const body = await jinaResponse.text().catch(() => '');
						return { ok: false, reason: `Jina returned HTTP ${jinaResponse.status}${body ? ` — ${body.slice(0, 300)}` : ''}` };
					}
					const raw = await jinaResponse.text();
					const titleMatch = raw.match(/^Title:\s*(.+)$/m);
					const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
					const content = smartTruncate(cleanMarkdown(raw), contentLimit);
					const jinaWarning = raw.includes('This page maybe not yet fully loaded') || raw.includes('Unavailable For Legal Reasons');
					const jinaBlocked = jinaResponse.status === 451 || jinaResponse.status === 403;
					if (jinaBlocked) return { ok: false, reason: `Jina blocked this URL (HTTP ${jinaResponse.status})` };
					if (jinaWarning) return { ok: false, reason: `Jina reported the page was not yet fully loaded` };
					if (content.length < 2000) return { ok: false, reason: `Jina only extracted ${content.length} chars (need >= 2000)` };
					return { ok: true, title, content };
				};

				// Helper: fetch via Readability + Turndown
				const tryDirectFetch = async (): Promise<ExtractOutcome> => {
					let html: string;
					try {
						html = await fetchPage(url, signal);
					} catch (err) {
						return { ok: false, reason: `Direct fetch threw: ${err instanceof Error ? err.message : String(err)}` };
					}
					const { title, content: extracted } = extractContent(html, url);
					const content = smartTruncate(extracted, contentLimit);
					if (content.length < 2000) {
						return { ok: false, reason: `Direct fetch only extracted ${content.length} chars via Readability (need >= 2000)` };
					}
					return { ok: true, title, content };
				};

				// Try direct fetch first, fallback to Jina
				status('Trying direct fetch...');
				const directOutcome = await tryDirectFetch();
				let result: { title: string; content: string } | null = directOutcome.ok ? directOutcome : null;
				const failReasons: string[] = [];
				if (!directOutcome.ok) failReasons.push(`Direct fetch: ${directOutcome.reason}`);

				if (!result) {
					status('Direct fetch failed, trying Jina...');
					const jinaOutcome = await tryJina();
					if (jinaOutcome.ok) result = jinaOutcome;
					else failReasons.push(`Jina: ${jinaOutcome.reason}`);
				}

				// Medium fallback: if scribe.rip failed, try original URL via Jina
				if (!result && isMedium && originalUrl) {
					status('Scribe.rip failed, trying original Medium URL via Jina...');
					try {
						await waitIfNeededJina();
						const fallbackResponse = await fetch(`https://r.jina.ai/${originalUrl}`, {
							method: "GET",
							headers: getJinaHeaders(),
							signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
						});
						if (fallbackResponse.ok) {
							const raw = await fallbackResponse.text();
							const titleMatch = raw.match(/^Title:\s*(.+)$/m);
							const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
							const content = smartTruncate(cleanMarkdown(raw), contentLimit);
							if (content.length >= 500) {
								result = { title, content };
							} else {
								failReasons.push(`Medium fallback: only extracted ${content.length} chars (need >= 500)`);
							}
						} else {
							failReasons.push(`Medium fallback: Jina returned HTTP ${fallbackResponse.status}`);
						}
					} catch (err) {
						failReasons.push(`Medium fallback threw: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				if (!result) {
					const reasonBlock = failReasons.map(r => `  - ${r}`).join('\n');
					return `FAILED TO EXTRACT CONTENT from ${url}\nReport these exact reasons to the user, do not guess or speculate about the cause:\n${reasonBlock}`;
				}

				const { title, content } = result;
				visitCount++;
				const guidanceEnabled = ctl.getPluginConfig(configSchematics).get("promptGuidance") ?? true;
				let reminder: string | undefined;
				if (guidanceEnabled) {
					if (visitCount === 1) {
						reminder = "Visit one more from these results, then search again with a new query.";
					} else if (visitCount === 2 && searchCount < 2) {
						reminder = "Now search again with a new query. Do NOT answer yet.";
					} else if (visitCount === 3) {
						reminder = "Visit one more from these results.";
					} else if (visitCount >= 4) {
						reminder = "You may now synthesize your findings.";
					}
				}
				status(`Retrieved "${title}" (${content.length} chars)`);
				return { url, title, content, ...(reminder && { reminder }) };
			} catch (error: unknown) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Website visit was cancelled.";
				}
				const msg = error instanceof Error ? error.message : 'Unknown error';
				console.error(error);
				warn(`Failed to load website: ${msg}`);
				return `Error: ${msg}`;
			}
		},
	});

	tools.push(webSearchTool);
	tools.push(visitWebsiteTool);
	return tools;
}

const undefinedIfAuto = (value: unknown, autoValue: number): number | undefined =>
	typeof value === 'number' && value === autoValue ? undefined : typeof value === 'number' ? value : undefined;

function cleanMarkdown(md: string): string {
	let text = md;

	// Remove Jina metadata header lines
	text = text.replace(/^(URL Source|Title|Published|Description|Markdown Content):\s*.*\n?/gm, '');

	// Remove Jina footer noise
	text = text.replace(/^(?:Let me know|Scraped|Final URL|Total|To visit).*$/gm, '');
	text = text.replace(/^-{3,}$/gm, '');

	// Convert markdown images ![alt](url) to [Image: alt] (preserve alt text as context)
	text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt) => alt ? `[Image: ${alt}]` : '');

	// Convert markdown links [text](url) to just text (preserve readable text)
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

	// Remove reference-style links [text][ref]
	text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

	// Remove bare URLs on their own line (nav/footer links)
	text = text.replace(/^https?:\/\/\S+$/gm, '');

	// Remove HTML tags
	text = text.replace(/<[^>]+>/g, '');

	// Remove consecutive short single-word lines (nav items) but keep structural content
	text = text.replace(/^(?:\s*\w{1,20}\s*\n){4,}/gm, (match) => {
		const lines = match.split('\n').filter(l => l.trim());
		return lines.length > 6 ? '' : match;
	});

	// Collapse excessive blank lines
	text = text.replace(/\n{3,}/g, '\n\n');

	return text.trim();
}

function smartTruncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const truncated = text.slice(0, limit);

	// Try paragraph boundary first
	const lastPara = truncated.lastIndexOf('\n\n');
	if (lastPara > limit * 0.7) return truncated.slice(0, lastPara).trimEnd();

	// Fall back to sentence boundary
	const lastPeriod = truncated.lastIndexOf('. ');
	const lastExclaim = truncated.lastIndexOf('! ');
	const lastQuestion = truncated.lastIndexOf('? ');
	const lastSentence = Math.max(lastPeriod, lastExclaim, lastQuestion);
	if (lastSentence > limit * 0.7) return truncated.slice(0, lastSentence + 1).trimEnd();

	return truncated;
}

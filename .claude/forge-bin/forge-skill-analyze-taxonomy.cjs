'use strict';
// forge-skill-analyze-taxonomy.cjs — the documented category taxonomy of the skill-corpus analyser.
// A skill gets EVERY category whose keywords match (multi-label):
//   - one keyword hit in the name or the description (weight 2) is enough;
//   - headings of the SKILL.md body count weight 1 each, so headings alone need two distinct keyword hits;
//   - no category reaches a score of 2 -> 'other'.
// Keywords are matched as whole words on lower-cased text where '-', '_' and '/' count as spaces, so "code-review" in a
// name matches the keyword "code review". A keyword ending in '*' is a prefix ("orchestrat*" = orchestrate, orchestration).
// The bare words "skill" / "skills" are NOT keywords of skill-authoring: they occur in nearly every description.

const TAXONOMY = [
  { id: 'agents-orchestration', about: 'multi-agent work: subagents, swarms, delegation, parallel agents, orchestration',
    keywords: ['subagent*', 'sub agent*', 'multi agent', 'multiagent', 'orchestrat*', 'swarm*', 'delegat*', 'parallel agents', 'agent team*', 'coordinator', 'dispatch*', 'agentic workflow*'] },
  { id: 'planning', about: 'plans, specs, PRDs, requirements, brainstorming, task breakdown, architecture decisions',
    keywords: ['plan', 'plans', 'planning', 'planner', 'roadmap*', 'prd', 'prds', 'spec', 'specs', 'specification*', 'requirement*', 'brainstorm*', 'task breakdown', 'architect*', 'design doc*', 'milestone*'] },
  { id: 'tdd-testing', about: 'tests and QA: TDD, unit/e2e tests, test runners, coverage',
    keywords: ['test', 'tests', 'testing', 'tdd', 'unit test*', 'e2e', 'end to end', 'playwright', 'jest', 'pytest', 'vitest', 'cypress', 'coverage', 'qa', 'regression test*', 'test driven'] },
  { id: 'debugging', about: 'finding and fixing bugs: debugging, root cause, troubleshooting, crashes, stack traces',
    keywords: ['debug*', 'bug', 'bugs', 'bugfix*', 'root cause', 'troubleshoot*', 'stack trace*', 'crash*', 'diagnos*', 'bisect', 'failing test*'] },
  { id: 'code-review', about: 'reviewing and improving code: code review, PR review, refactoring, linting, code quality',
    keywords: ['code review*', 'review', 'reviews', 'reviewer', 'reviewing', 'pull request*', 'pr review*', 'refactor*', 'lint', 'linter', 'linting', 'code quality', 'clean code', 'code smell*'] },
  { id: 'security', about: 'security: vulnerabilities, OWASP, auth, secrets, threat models, pentests, compliance',
    keywords: ['security', 'secure', 'vulnerab*', 'owasp', 'auth', 'authentication', 'authorization', 'secret', 'secrets', 'pentest*', 'penetration test*', 'threat*', 'cve', 'xss', 'injection', 'encrypt*', 'compliance', 'sast', 'malware'] },
  { id: 'frontend-design', about: 'UI and web front ends: design systems, CSS, React components, UX, accessibility',
    keywords: ['frontend', 'front end', 'ui', 'ux', 'css', 'tailwind', 'react', 'vue', 'svelte', 'nextjs', 'next js', 'design system*', 'component*', 'web design', 'landing page*', 'figma', 'animation*', 'accessibility', 'a11y', 'html', 'shadcn', 'typography'] },
  { id: 'docs-writing', about: 'writing: documentation, READMEs, technical writing, blog posts, changelogs, copy',
    keywords: ['docs', 'documentation', 'readme*', 'technical writing', 'writing style', 'writing guide*', 'content writ*', 'creative writ*', 'write docs', 'writing docs', 'writer', 'writers', 'blog*', 'copywriting', 'changelog*', 'article*', 'docstring*', 'release notes', 'proofread*', 'editing'] },
  { id: 'devops-deploy', about: 'shipping and operating: deploy, CI/CD, Docker, Kubernetes, cloud, infrastructure, monitoring',
    keywords: ['deploy*', 'docker*', 'kubernetes', 'k8s', 'helm', 'ci', 'cd', 'ci cd', 'cicd', 'github actions', 'pipeline*', 'terraform', 'aws', 'gcp', 'azure', 'infrastructure', 'devops', 'vercel', 'netlify', 'cloudflare', 'monitoring', 'observability', 'sre', 'serverless'] },
  { id: 'data-ml', about: 'data and machine learning: datasets, SQL, analytics, ETL, notebooks, model training, embeddings',
    keywords: ['data', 'dataset*', 'machine learning', 'ml', 'pandas', 'sql', 'database*', 'postgres*', 'analytics', 'etl', 'notebook*', 'jupyter', 'pytorch', 'tensorflow', 'fine tun*', 'embedding*', 'statistic*', 'visualization*', 'spreadsheet*', 'excel', 'csv'] },
  { id: 'memory-context', about: 'memory and context: context windows, persistent memory, recall, knowledge bases, sessions',
    keywords: ['memory', 'memories', 'context window*', 'context engineering', 'context management', 'remember*', 'knowledge base*', 'knowledge graph*', 'recall', 'persistent', 'compaction', 'session handoff*', 'handoff*', 'rag'] },
  { id: 'token-usage', about: 'token and cost discipline: token budgets, usage, cost, compression, prompt caching',
    keywords: ['token', 'tokens', 'token usage', 'cost', 'costs', 'usage limit*', 'rate limit*', 'budget*', 'compress*', 'prompt cach*', 'caching', 'efficien*', 'terse', 'concise'] },
  { id: 'research', about: 'research: investigation, web search, literature review, deep research, citations',
    keywords: ['research*', 'investigat*', 'web search', 'search', 'literature', 'survey*', 'deep dive', 'citation*', 'sources', 'fact check*', 'competitive analysis', 'explore', 'exploration'] },
  { id: 'integrations-mcp', about: 'integrations: MCP servers, APIs, webhooks, OAuth, SDKs and third-party services',
    keywords: ['mcp', 'model context protocol', 'api', 'apis', 'integration*', 'integrate*', 'webhook*', 'oauth', 'sdk', 'slack', 'notion', 'stripe', 'jira', 'linear', 'github api', 'google drive', 'gmail', 'connector*', 'rest api', 'graphql'] },
  { id: 'automation-n8n', about: 'automation: n8n, Zapier, Make, workflow automation, schedulers, bots, scripts that run jobs',
    keywords: ['n8n', 'zapier', 'make com', 'automation*', 'automate*', 'workflow automation', 'cron', 'scheduler', 'scheduled', 'bot', 'bots', 'scrap*', 'crawl*', 'browser automation', 'rpa'] },
  { id: 'mobile', about: 'mobile apps: iOS, Android, Swift, Kotlin, React Native, Flutter, Expo',
    keywords: ['mobile', 'ios', 'android', 'swift', 'swiftui', 'kotlin', 'react native', 'flutter', 'expo', 'xcode', 'app store', 'jetpack compose'] },
  { id: 'business-marketing', about: 'business: marketing, SEO, sales, growth, social media, brand, finance, legal, product',
    keywords: ['marketing', 'seo', 'sales', 'business', 'startup*', 'growth', 'social media', 'ads', 'advertis*', 'campaign*', 'brand*', 'email marketing', 'customer*', 'pricing', 'finance', 'financial', 'legal', 'contract*', 'invoice*', 'product manag*', 'okr*', 'pitch*', 'linkedin', 'newsletter*'] },
  { id: 'skill-authoring', about: 'building the agent tooling itself: writing skills, prompts, plugins, slash commands, hooks, CLAUDE.md',
    keywords: ['skill creat*', 'skill author*', 'skill writ*', 'skill builder', 'skill md', 'creating skills', 'create skills', 'write skills', 'writing skills', 'new skill*', 'build skills', 'skill development',
      'prompt engineer*', 'system prompt*', 'claude code plugin*', 'slash command*', 'claude md', 'agents md', 'claude code hook*', 'meta skill*'] },
  { id: 'other', about: 'no keyword of any category matched the name, description or headings', keywords: [] },
];
const CAT_IDS = TAXONOMY.map((c) => c.id);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(kw) {
  const prefix = kw.endsWith('*');
  const body = esc(prefix ? kw.slice(0, -1) : kw).replace(/ /g, ' +');
  return new RegExp(`(?:^| )${body}${prefix ? '' : '(?= |$)'}`);
}
const COMPILED = TAXONOMY.filter((c) => c.id !== 'other').map((c) => ({ id: c.id, res: c.keywords.map(compile) }));

// Lower-case, '-', '_', '/', '.', ':' and other punctuation become spaces (keeps letters, digits and '+'/'#').
const normText = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()} `;
const hits = (res, text) => res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

function categorize({ name, description, headings }) {
  const head = normText(name) + ' ' + normText(description);
  const heads = normText((headings || []).join(' . '));
  const out = [];
  for (const c of COMPILED) {
    const score = 2 * hits(c.res, head) + hits(c.res, heads);
    if (score >= 2) out.push(c.id);
  }
  return out.length ? out : ['other'];
}

// Markdown ATX headings (#..####) of the body, outside ``` / ~~~ fences; at most `max`, each cut to 120 chars.
function extractHeadings(text, max = 40) {
  const out = []; let fence = null;
  const lines = String(text || '').split(/\r?\n/);
  let i = 0;
  if (/^﻿?---\s*$/.test(lines[0] || '')) { i = 1; while (i < lines.length && !/^---\s*$/.test(lines[i])) i++; i++; }
  for (; i < lines.length && out.length < max; i++) {
    const l = lines[i];
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = null; continue; }
    if (fence) continue;
    const m = /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push(m[1].slice(0, 120));
  }
  return out;
}

const STOP = new Set(('the and for with that this from your you are use used uses using when what which will can into also not but all any '
  + 'its it\'s has have how why who our out more most than then them they their there these those should would could each other '
  + 'about over only just very via per etc may must like such been being were was one two new get gets make makes made run runs '
  + 'skill skills claude code agent agents tool tools task tasks work works user users file files based help helps provide provides '
  + 'including include includes need needs want wants support supports using step steps guide guides way ways set sets let lets '
  + 'example examples overview description name notes note section sections usage instructions instruction reference references '
  + 'http https www com org github md yes no true false null none').split(/\s+/));

// Scripts written without spaces between words: every character counts as a word.
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}';
const CJK_RE = new RegExp(`[${CJK}]`, 'u');
const CJK_RUN_RE = new RegExp(`([${CJK}]+)`, 'u');
// Lower-cased Unicode letter/digit runs; a run in a CJK/Thai script is split into single characters.
function words(text) {
  const out = [];
  for (const run of String(text || '').toLowerCase().match(/[\p{L}\p{N}+#]+/gu) || []) {
    if (!CJK_RE.test(run)) { out.push(run); continue; }
    for (const part of run.split(CJK_RUN_RE)) { if (!part) continue; if (CJK_RE.test(part)) out.push(...part); else out.push(part); }
  }
  return out;
}

// Content words: letter/digit runs of 3..30 chars (not numeric, not a stop word); CJK/Thai text gives character bigrams.
function terms(text) {
  const out = []; const ws = words(text);
  for (let i = 0; i < ws.length; i++) {
    const t = ws[i];
    if (t.length === 1 && CJK_RE.test(t)) { const n = ws[i + 1]; if (n && n.length === 1 && CJK_RE.test(n)) out.push(t + n); continue; }
    if (t.length < 3 || t.length > 30 || STOP.has(t) || /^\d+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

module.exports = { TAXONOMY, CAT_IDS, categorize, extractHeadings, terms, words, normText, STOP };

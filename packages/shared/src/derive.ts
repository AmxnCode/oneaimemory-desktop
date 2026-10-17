import type { ConsciousnessEvent } from '@oneconscious/shared';

/**
 * Derivation of interests and projects from raw activity.
 *
 * docs/PRD-REVIEW.md #5 flagged that get_consciousness() and get_interests()
 * had no component behind them. This is that component.
 *
 * It is deliberately HEURISTIC rather than LLM-based:
 *   - it runs locally, so it works with the E2E architecture,
 *   - it costs nothing per user, which matters because LLM extraction over
 *     every user's daily activity would be the product's dominant COGS,
 *   - it is deterministic and inspectable.
 *
 * The upgrade path is an optional local model (Ollama) or a user-consented
 * cloud call. Quality is meaningfully lower than LLM extraction — this finds
 * *topics*, not *intent*.
 */

const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','is','are','was','were',
  'be','been','how','what','why','when','where','which','who','can','do','does','did','i','my',
  'me','you','your','it','its','this','that','these','those','from','by','as','if','not','no',
  'vs','best','top','free','online','download','tutorial','example','guide','error','fix','use',
  'using','get','set','new','com','www','http','https','html','php','js',
]);

/** Domains that say nothing about interests. */
const GENERIC_DOMAINS = new Set([
  'google.com','www.google.com','duckduckgo.com','bing.com','localhost','127.0.0.1',
  'mail.google.com','calendar.google.com','drive.google.com','accounts.google.com',
  't.co','bit.ly','news.ycombinator.com',
]);

/** Domain → topic label, for signal that a bare hostname wouldn't convey. */
const DOMAIN_TOPICS: Record<string, string> = {
  'github.com': 'software development',
  'stackoverflow.com': 'software development',
  'react.dev': 'React',
  'reactnative.dev': 'React Native',
  'developer.mozilla.org': 'web development',
  'typescriptlang.org': 'TypeScript',
  'nodejs.org': 'Node.js',
  'postgresql.org': 'PostgreSQL',
  'docs.python.org': 'Python',
  'huggingface.co': 'AI/ML',
  'arxiv.org': 'research',
  'kaggle.com': 'data science',
  'modelcontextprotocol.io': 'MCP',
  'docker.com': 'DevOps',
  'kubernetes.io': 'DevOps',
  'aws.amazon.com': 'cloud infrastructure',
  'youtube.com': 'video',
  'www.youtube.com': 'video',
};

export interface Interest {
  topic: string;
  weight: number;
  /** Which event kinds contributed — lets a caller judge the evidence. */
  sources: string[];
}

export interface Project {
  name: string;
  languages: string[];
  files: number;
  lastSeen: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 2 && t.length < 30 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function bump(map: Map<string, { weight: number; sources: Set<string> }>, key: string, w: number, src: string) {
  const cur = map.get(key) ?? { weight: 0, sources: new Set<string>() };
  cur.weight += w;
  cur.sources.add(src);
  map.set(key, cur);
}

/**
 * Recency-weighted topic extraction. An event from an hour ago counts for more
 * than one from last week — "current interests" is the useful signal, not
 * lifetime totals.
 */
export function deriveInterests(events: ConsciousnessEvent[], limit = 15): Interest[] {
  const scores = new Map<string, { weight: number; sources: Set<string> }>();
  const now = Date.now();

  for (const ev of events) {
    const ageDays = Math.max(0, (now - Date.parse(ev.timestamp)) / 86400_000);
    const recency = Math.exp(-ageDays / 7); // ~7-day half-life

    switch (ev.type) {
      case 'search': {
        // Explicit intent — the strongest signal available.
        for (const t of tokenize(ev.payload.query)) bump(scores, t, 3 * recency, 'search');
        break;
      }
      case 'browsing': {
        const topic = DOMAIN_TOPICS[ev.payload.domain];
        if (topic) bump(scores, topic, 2 * recency, 'browsing');
        else if (!GENERIC_DOMAINS.has(ev.payload.domain)) {
          bump(scores, ev.payload.domain, 1 * recency, 'browsing');
        }
        if (ev.payload.title) {
          for (const t of tokenize(ev.payload.title).slice(0, 6)) bump(scores, t, 0.5 * recency, 'browsing');
        }
        break;
      }
      case 'youtube': {
        for (const t of tokenize(ev.payload.title).slice(0, 6)) bump(scores, t, 1 * recency, 'youtube');
        if (ev.payload.channel) bump(scores, ev.payload.channel, 1.5 * recency, 'youtube');
        break;
      }
      case 'code': {
        if (ev.payload.language) bump(scores, ev.payload.language, 3 * recency, 'code');
        if (ev.payload.project) bump(scores, ev.payload.project, 2 * recency, 'code');
        break;
      }
      case 'app': {
        bump(scores, ev.payload.name, 0.5 * recency, 'app');
        break;
      }
      case 'file': {
        if (ev.payload.extension) bump(scores, ev.payload.extension, 0.5 * recency, 'file');
        break;
      }
    }
  }

  return [...scores.entries()]
    .filter(([, v]) => v.weight >= 1) // drop one-off noise
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, limit)
    .map(([topic, v]) => ({
      topic,
      weight: Math.round(v.weight * 100) / 100,
      sources: [...v.sources],
    }));
}

/** Active projects, inferred from code activity. */
export function deriveProjects(events: ConsciousnessEvent[], limit = 8): Project[] {
  const projects = new Map<string, { languages: Set<string>; files: Set<string>; lastSeen: string }>();

  for (const ev of events) {
    if (ev.type !== 'code' || !ev.payload.project) continue;
    const cur = projects.get(ev.payload.project) ?? {
      languages: new Set<string>(),
      files: new Set<string>(),
      lastSeen: ev.timestamp,
    };
    if (ev.payload.language) cur.languages.add(ev.payload.language);
    if (ev.payload.file) cur.files.add(ev.payload.file);
    if (ev.timestamp > cur.lastSeen) cur.lastSeen = ev.timestamp;
    projects.set(ev.payload.project, cur);
  }

  return [...projects.entries()]
    .sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen))
    .slice(0, limit)
    .map(([name, v]) => ({
      name,
      languages: [...v.languages],
      files: v.files.size,
      lastSeen: v.lastSeen,
    }));
}

export function topApps(events: ConsciousnessEvent[], limit = 5) {
  const totals = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== 'app') continue;
    totals.set(ev.payload.name, (totals.get(ev.payload.name) ?? 0) + (ev.payload.durationMs ?? 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, ms]) => ({ name, minutes: Math.round(ms / 60000) }));
}

/** Coarse activity level from events-per-hour over the window. */
export function activityLevel(events: ConsciousnessEvent[], windowHours: number): 'idle' | 'low' | 'moderate' | 'high' {
  const perHour = events.length / Math.max(1, windowHours);
  if (perHour < 0.5) return 'idle';
  if (perHour < 3) return 'low';
  if (perHour < 10) return 'moderate';
  return 'high';
}

// “让 AI 查标签库”用的工具（OpenAI function calling）。仿 DanbooruSearchOnline 的 MCP 工具
// （search_tags / get_related_tags / get_artist_recommendations），但都只查中继内置的标签库，不联网、不花钱。
import { getSettings } from './settings.js';
import { convertText, correctTag, hasCjk, naiTagText, recommendArtists, relatedTags, searchTags } from './tags.js';

const CATEGORY_FILTER = { general: [0, 5], character: [4], copyright: [3] };

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_tags',
      description:
        'Search the Danbooru tag database (Chinese and English). mode "scene" converts a whole image description '
        + '(Chinese works best) into tags: call it first with the user\'s original request. mode "lookup" checks '
        + 'several concepts or candidate tags at once (separate them with commas): it tells whether each tag exists, '
        + 'corrects spelling and deprecated tags, and lists close candidates. Do not use it for artist names.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'scene: the full description, e.g. "一个穿着白色水手服的双马尾少女在雨中奔跑". '
              + 'lookup: comma-separated concepts or tags, e.g. "水手服, twintails, sailor colar".',
          },
          mode: { type: 'string', enum: ['scene', 'lookup'], description: 'Default "scene".' },
          category: {
            type: 'string',
            enum: ['all', 'general', 'character', 'copyright'],
            description: 'Limit candidates to one category. Default "all".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_related_tags',
      description:
        'Tags that often appear together with the given tags on Danbooru (NPMI co-occurrence). Use it to find a '
        + 'character\'s signature hair, eyes and outfit, the characters of a series, or details that go with an '
        + 'attribute. Tags may use spaces or underscores. Not for artists.',
      parameters: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: 'e.g. ["klee (genshin impact)"]' },
          limit: { type: 'integer', description: 'Default 20, at most 40.' },
        },
        required: ['tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_artist_recommendations',
      description:
        'Artists who often draw the given tags (NPMI co-occurrence). Only use it when the user asks for an art '
        + 'style or an artist; never add artists on your own. Returns tags already in "artist:name" form.',
      parameters: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: 'e.g. ["1girl", "flat color"]' },
          limit: { type: 'integer', description: 'Default 10, at most 20.' },
        },
        required: ['tags'],
      },
    },
  },
];

/** 执行一次工具调用，返回要发回给 AI 的结果（尽量精简，省 tokens） */
export function runTool(name, rawArgs) {
  let args;
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs ?? {};
  } catch {
    return { error: 'arguments is not valid JSON' };
  }
  const nsfw = getSettings().promptAssistNsfw;
  const limit = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
  const tags = (value) => (Array.isArray(value) ? value.slice(0, 40).map((t) => String(t).slice(0, 200)) : []);
  switch (name) {
    case 'search_tags':
      return searchTool(args, nsfw);
    case 'get_related_tags':
      return { results: relatedTags(tags(args.tags), { limit: limit(args.limit, 20, 40), nsfw }).map(brief) };
    case 'get_artist_recommendations':
      return {
        results: recommendArtists(tags(args.tags), { limit: limit(args.limit, 10, 20) })
          .map((a) => ({ tag: a.text, ...(a.zh ? { cn: a.zh } : {}), posts: a.posts, score: a.score })),
      };
    default:
      return { error: `unknown tool: ${name}` };
  }
}

function searchTool({ query, mode = 'scene', category = 'all' }, nsfw) {
  const q = String(query ?? '').slice(0, 500);
  if (!q.trim()) return { error: 'query is empty' };
  const categories = CATEGORY_FILTER[category];
  if (mode === 'lookup') {
    const terms = q.split(/[,，、\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
    return {
      results: terms.map((term) => {
        const hit = hasCjk(term) ? null : correctTag(term);
        const ok = hit && (nsfw || !hit.tag.nsfw);
        return {
          term,
          ...(ok ? { tag: naiTagText(hit.tag), status: hit.kind === 'exact' ? 'exists' : `corrected (${hit.kind})` } : {}),
          candidates: searchTags(term, { limit: 5, nsfw, categories }).map(brief),
        };
      }),
    };
  }
  const { tags, unmatched } = convertText(q, { nsfw });
  return {
    tags: tags
      .filter((t) => !categories || categories.includes(t.cat))
      .map((t) => ({ tag: t.text, ...(t.cn ? { cn: t.cn } : {}), from: t.word })),
    ...(unmatched.length ? { unmatched } : {}),
  };
}

const brief = (r) => ({ tag: r.text, ...(r.cn?.[0] ? { cn: r.cn[0] } : {}), category: r.category, posts: r.posts });

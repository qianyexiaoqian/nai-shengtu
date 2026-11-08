"""
生成中继内置提词器用的标签库（assets/tags/*.json.gz）。

数据来源（均为 GPL-3.0 开源项目，这里只做格式转换和裁剪）：
  - DanbooruSearchOnline  https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline
      origin_database/tags_enhanced.csv        标签、中文同义词、中文释义、热度、类别、NSFW 标记
      origin_database/cooccurrence_clean.parquet 标签共现次数 → 关联推荐（NPMI）
      origin_database/tag_artist_cooc.parquet    标签-画师共现 → 推荐画师
      origin_database/tag_aliases.parquet        Danbooru 官方别名（废弃标签 → 现行标签）
  - Auto-NovelAI-Refactor  https://github.com/zhulinyv/Auto-NovelAI-Refactor
      assets/danbooru_tags_full_zh.csv          补充中文译名、英文别名和画师名

用法（需要 pandas + pyarrow，只在生成数据时用，中继运行时不需要 Python）：
  python scripts/build_tag_data.py <DanbooruSearchOnline 目录> <Auto-NovelAI-Refactor 目录>
"""

import gzip
import json
import math
import sys
from pathlib import Path

import pandas as pd

OUT_DIR = Path(__file__).resolve().parent.parent / 'assets' / 'tags'
MIN_ARTIST_POSTS = 100       # 画师只收作品数 ≥ 100 的，供补全和推荐
MIN_META_POSTS = 10_000      # meta 类只留 highres / absurdres 这类常用的
RELATED_PER_TAG = 40         # 每个标签保留 NPMI 最高的关联标签数
ARTISTS_PER_TAG = 30         # 每个标签保留 NPMI 最高的画师数
MIN_COOC = 3                 # 共现次数太少的不算
WIKI_MAX = 120               # 中文释义截断长度（只用于悬浮提示）

# 与 DanbooruSearch 一致：类别 0 通用 / 1 画师 / 3 作品 / 4 角色 / 5 meta
CATEGORIES = {0, 1, 3, 4, 5}


def split_list(text):
    return [p.strip() for p in str(text or '').split(',') if p.strip()]


def write_gz(name, data):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    path = OUT_DIR / name
    with gzip.open(path, 'wb', compresslevel=9) as f:
        f.write(raw)
    print(f'  {name}: {len(raw) / 1e6:.1f} MB → 压缩后 {path.stat().st_size / 1e6:.1f} MB')


def main(ds_dir: Path, anr_dir: Path):
    db = ds_dir / 'origin_database'

    # ── 标签表：以 DanbooruSearch 为主（中文同义词、释义、NSFW 都比较全） ──
    ds = pd.read_csv(db / 'tags_enhanced.csv', encoding='gb18030', dtype=str, keep_default_na=False)
    anr = pd.read_csv(
        anr_dir / 'assets' / 'danbooru_tags_full_zh.csv', header=None,
        names=['name', 'cat', 'posts', 'aliases', 'zh'], dtype={'name': str, 'aliases': str, 'zh': str},
        keep_default_na=False,
    )
    anr_by_name = {r.name: r for r in anr.itertuples(index=False)}

    tags = {}
    for r in ds.itertuples(index=False):
        cat = int(r.category or 0)
        if cat not in CATEGORIES:
            continue
        # DanbooruSearch 的中文同义词：第一个是核心词，最后一个常是“发型”“表情”这类上位类别词
        cn = split_list(r.cn_name)
        extra = anr_by_name.get(r.name)
        aliases = split_list(extra.aliases) if extra is not None else []
        zh = (extra.zh if extra is not None else '').strip()
        tags[r.name] = {
            'name': r.name, 'cat': cat, 'posts': int(float(r.post_count or 0)), 'nsfw': int(r.nsfw or 0),
            'cn': cn, 'zh': '' if zh in cn or zh == r.name else zh, 'aliases': aliases,
            'wiki': r.wiki.strip()[:WIKI_MAX],
        }

    # 补充画师和常用 meta 标签（DanbooruSearch 不收这两类）
    for r in anr.itertuples(index=False):
        if r.name in tags:
            continue
        if (r.cat == 1 and r.posts >= MIN_ARTIST_POSTS) or (r.cat == 5 and r.posts >= MIN_META_POSTS):
            zh = r.zh.strip()
            tags[r.name] = {
                'name': r.name, 'cat': int(r.cat), 'posts': int(r.posts), 'nsfw': 0, 'cn': [],
                'zh': zh if zh and zh.lower() != r.name.replace('_', ' ').lower() else '',
                'aliases': split_list(r.aliases), 'wiki': '',
            }

    # 官方别名：废弃标签 → 现行标签（只收目标在库里的）
    alias_df = pd.read_parquet(db / 'tag_aliases.parquet')
    alias_df = alias_df[(alias_df.status == 'active') & alias_df.consequent_name.isin(tags.keys())]
    for r in alias_df.itertuples(index=False):
        if r.antecedent_name not in tags and r.antecedent_name not in tags[r.consequent_name]['aliases']:
            tags[r.consequent_name]['aliases'].append(r.antecedent_name)

    ordered = sorted(tags.values(), key=lambda t: -t['posts'])
    index = {t['name']: i for i, t in enumerate(ordered)}
    print(f'标签 {len(ordered)} 个（其中画师 {sum(t["cat"] == 1 for t in ordered)}）')

    # ── 关联推荐：与 DanbooruSearch 相同的 NPMI 算法，预先算好每个标签的前 N 个 ──
    total = float(max(max(t['posts'] for t in ordered), 7_000_000))
    cooc = pd.read_parquet(db / 'cooccurrence_clean.parquet')
    cooc = cooc[cooc.tag_a.isin(index.keys()) & cooc.tag_b.isin(index.keys()) & (cooc['count'] >= MIN_COOC)]
    posts = {t['name']: max(t['posts'], 1) for t in ordered}
    neighbours = {}
    for a, b, cnt in zip(cooc.tag_a, cooc.tag_b, cooc['count']):
        pa, pb = posts[a], posts[b]
        c = min(float(cnt), pa, pb)
        numerator = c * total / (pa * pb)
        if numerator <= 1.0:
            continue
        p_ab = c / total
        npmi = 1.0 if p_ab >= 1.0 else math.log(numerator) / -math.log(p_ab)
        score = round(npmi * 1000)
        neighbours.setdefault(index[a], []).append((score, index[b]))
        neighbours.setdefault(index[b], []).append((score, index[a]))
    related = {}
    for i, items in neighbours.items():
        items.sort(reverse=True)
        related[i] = [v for score, j in items[:RELATED_PER_TAG] for v in (j, score)]

    # ── 推荐画师：直接用 DanbooruSearch 算好的 NPMI ──
    ta = pd.read_parquet(db / 'tag_artist_cooc.parquet')
    ta = ta[ta.tag.isin(index.keys()) & (ta.cooc_count >= MIN_COOC)]
    artist_names = sorted(set(ta.artist))
    artist_index = {a: i for i, a in enumerate(artist_names)}
    artist_posts = ta.groupby('artist').artist_post_count.max().to_dict()
    tag_artists = {}
    for tag, group in ta.sort_values('npmi', ascending=False).groupby('tag', sort=False):
        top = group.head(ARTISTS_PER_TAG)
        tag_artists[index[tag]] = [
            v for a, s in zip(top.artist, top.npmi) for v in (artist_index[a], round(float(s) * 1000))
        ]

    print('写出：')
    write_gz('tags.json.gz', {
        'version': 1,
        'sources': ['DanbooruSearchOnline (GPL-3.0)', 'Auto-NovelAI-Refactor (GPL-3.0)'],
        # 每行：[名称, 类别, 作品数, NSFW, DanbooruSearch 中文同义词(| 分隔), Auto-NovelAI 中文译名, 别名(| 分隔), 中文释义]
        'tags': [
            [t['name'], t['cat'], t['posts'], t['nsfw'], '|'.join(t['cn']), t['zh'], '|'.join(t['aliases']), t['wiki']]
            for t in ordered
        ],
    })
    write_gz('related.json.gz', {'total': total, 'related': related})
    write_gz('artists.json.gz', {
        'artists': [[a, int(artist_posts.get(a, 0))] for a in artist_names],
        'tag_artists': tag_artists,
    })


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))

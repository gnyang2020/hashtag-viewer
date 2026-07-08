// 카카오 이모티콘 인기 순위 → 해시태그 집계 스크립트
// Node 18+ (내장 fetch 사용). GitHub Actions에서 매일 1회 실행되어 public/data.json 생성.
//
// 파이프라인:
//  1) 6개 연령대(전체/10~50대+)의 인기 순위 50위 목록 수집
//  2) 등장한 모든 이모티콘의 상세 API에서 해시태그(similarStyle.groups[].title) 수집
//     - slug→해시태그는 잘 안 바뀌므로 cache/hashtags.json에 캐시 → 신규 항목만 재조회
//  3) 연령대별로 해시태그 등장횟수 + 순위가중점수 집계 → data.json 저장

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = 'https://e.kakao.com';
const SIZE = 200; // 순위 상위 몇 위까지 볼지 (카카오 최대 200)
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://e.kakao.com/popular',
  'Accept': 'application/json',
};

// 연령대 파라미터(카카오 내부값) → 화면 라벨
const AGE_BANDS = [
  { key: 'ALL', param: '', label: '전체' },
  { key: 'TEENS', param: 'TEENS', label: '10대' },
  { key: 'TWENTIES', param: 'TWENTIES', label: '20대' },
  { key: 'THIRTIES', param: 'THIRTIES', label: '30대' },
  { key: 'FORTIES', param: 'FORTIES', label: '40대' },
  { key: 'FIFTIES_PLUS', param: 'FIFTIES_PLUS', label: '50대 이상' },
];

// categoryId → 사람이 읽는 분류명(카카오가 공식명을 안 주므로 예시 태그로 추정)
const CATEGORY_LABELS = {
  1: '그림체·분위기',
  2: '그림 스타일',
  4: '동물·소재',
  5: '메시지',
  10: '받는 대상',
  11: '컨셉·공감',
  12: '형태',
  13: '유명인·IP',
  21: '캐릭터',
  23: '미니 이모티콘',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

async function fetchRanking(band) {
  const q = band.param ? `ageBand=${band.param}&` : '';
  const j = await getJSON(`${BASE}/api/items/hot?${q}miniOnly=false&page=0&size=${SIZE}`);
  return (j?.items || []).map((it) => ({
    slug: it.slug,
    title: it.title,
    creator: it.creatorName,
    image: it.stillImageUrl,
    isMini: !!it.isMini,
    isBig: !!it.isBig,
  }));
}

async function fetchHashtags(slug) {
  const d = await getJSON(`${BASE}/api/items/${slug}`);
  const groups = d?.similarStyle?.groups || [];
  // 중복 제거하며 [{categoryId, tag}]
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    if (!g?.title || seen.has(g.title)) continue;
    seen.add(g.title);
    out.push({ categoryId: g.categoryId ?? 0, tag: g.title });
  }
  return out;
}

// MD추천 = 카카오 MD가 직접 추천한 큐레이션(스타일 그룹 11). 해시태그가 아니라 별도 추천 목록.
// slug 집합만 모아서, 순위에 든 이모티콘이 MD추천인지 표시하는 데 사용.
async function fetchMdPickSlugs() {
  const set = new Set();
  for (let page = 0; page < 12; page++) {
    const j = await getJSON(`${BASE}/api/styles/11?page=${page}&size=100&sort=NEW`);
    (j?.items || []).forEach((it) => it.slug && set.add(it.slug));
    if (!j?.hasNext) break;
    await sleep(150);
  }
  return set;
}

async function main() {
  const cacheDir = new URL('./cache/', import.meta.url);
  const cachePath = new URL('./cache/hashtags.json', import.meta.url);
  let cache = {};
  if (existsSync(cachePath)) {
    try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch {}
  }

  // 1) 연령대별 순위 수집
  const rankings = {};      // key -> [ {slug,title,...}, ... ] (rank 순)
  const itemMeta = {};      // slug -> {title, creator, image, isMini, isBig}
  for (const band of AGE_BANDS) {
    const list = await fetchRanking(band);
    rankings[band.key] = list;
    for (const it of list) {
      itemMeta[it.slug] = { title: it.title, creator: it.creator, image: it.image, isMini: it.isMini, isBig: it.isBig };
    }
    console.log(`[rank] ${band.label}: ${list.length}개`);
    await sleep(300);
  }

  // 1-b) MD추천 목록 수집 (순위 이모티콘에 MD추천 배지 표시용)
  const mdSet = await fetchMdPickSlugs();
  console.log(`[md] MD추천 총 ${mdSet.size}개 수집`);

  // 2) 등장한 모든 이모티콘 해시태그 수집(캐시 활용)
  const allSlugs = [...new Set(Object.values(rankings).flat().map((i) => i.slug))];
  let fetched = 0;
  const tagsBySlug = {};
  for (const slug of allSlugs) {
    if (cache[slug]) { tagsBySlug[slug] = cache[slug]; continue; }
    tagsBySlug[slug] = await fetchHashtags(slug);
    cache[slug] = tagsBySlug[slug];
    fetched++;
    await sleep(200);
  }
  console.log(`[detail] 총 ${allSlugs.length}개 중 신규 ${fetched}개 조회`);

  // 캐시 저장
  if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 0));

  // 3) 연령대별 집계: 등장횟수 + 순위가중점수
  const agg = {};
  for (const band of AGE_BANDS) {
    const list = rankings[band.key];
    const N = list.length;
    const map = {}; // tag -> {tag, categoryId, count, score, bestRank}
    list.forEach((it, idx) => {
      const rank = idx + 1;
      const weight = N - idx; // 1위=N점 ... N위=1점
      for (const { categoryId, tag } of tagsBySlug[it.slug] || []) {
        if (!map[tag]) map[tag] = { tag, categoryId, count: 0, score: 0, bestRank: rank };
        map[tag].count += 1;
        map[tag].score += weight;
        map[tag].bestRank = Math.min(map[tag].bestRank, rank);
      }
    });
    const hashtags = Object.values(map).sort((a, b) => b.score - a.score);
    // 카테고리별 합계
    const byCategory = {};
    for (const h of hashtags) {
      const c = h.categoryId;
      if (!byCategory[c]) byCategory[c] = { categoryId: c, count: 0, score: 0, tags: 0 };
      byCategory[c].count += h.count;
      byCategory[c].score += h.score;
      byCategory[c].tags += 1;
    }
    agg[band.key] = { totalItems: N, hashtags, byCategory: Object.values(byCategory).sort((a, b) => b.score - a.score) };
  }

  // 순위 목록은 slug 배열로 압축(메타는 items에 1회만)
  const compactRankings = {};
  for (const band of AGE_BANDS) compactRankings[band.key] = rankings[band.key].map((i) => i.slug);

  const out = {
    updatedAt: new Date().toISOString(),
    size: SIZE,
    ageBands: AGE_BANDS.map(({ key, label }) => ({ key, label })),
    categories: CATEGORY_LABELS,
    items: Object.fromEntries(allSlugs.map((s) => [s, { ...itemMeta[s], md: mdSet.has(s), tags: tagsBySlug[s] || [] }])),
    mdCount: allSlugs.filter((s) => mdSet.has(s)).length,
    rankings: compactRankings,
    agg,
  };

  await writeFile(new URL('./public/data.json', import.meta.url), JSON.stringify(out));
  console.log(`[done] public/data.json 저장 (이모티콘 ${allSlugs.length}개, 갱신 ${out.updatedAt})`);
}

main().catch((e) => { console.error(e); process.exit(1); });

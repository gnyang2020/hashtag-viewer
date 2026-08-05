// 카카오 이모티콘 데이터 수집 (해시태그 분석 + 인사이트, 한 번의 크롤로 둘 다 생성)
// Node 18+ (내장 fetch 사용). GitHub Actions에서 주 1회 실행.
//
// 출력 3종:
//  public/data.json     — [인기 분석] 해시태그 집계. 기존 화면이 쓰던 구조를 그대로 유지한다.
//  public/insight.json  — [인사이트] 작가 파워 / 제작 아이디어용. 상세 API가 주던 필드를 보존.
//  history/<날짜>.json  — 순위 스냅샷. 매 실행분이 쌓여 '순위 변동' 시계열이 된다.
//
// 파이프라인:
//  1) 6개 연령대의 인기 순위 200위 수집           → 수요
//  2) 카테고리 10종의 신상 100개씩 수집(sort=NEW) → 공급
//  3) 등장한 이모티콘의 상세 API 수집
//     - 해시태그/시안 수처럼 잘 안 변하는 값은 cache/details.json에 영구 캐시
//     - 관심수·가격처럼 변하는 값은 순위권에 한해 매번 재조회
//  4) 연령대별 해시태그 집계(기존 로직 그대로) + 인사이트/스냅샷 저장

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = 'https://e.kakao.com';
const SIZE = 200;         // 순위 상위 몇 위까지 볼지 (카카오 최대 200)
const SUPPLY_SIZE = 100;  // 카테고리별 신상 수집 개수 (공급 표본)
const CONCURRENCY = 4;    // 상세 API 동시 요청 수

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

// 수집할 스타일(카테고리) id. 이름은 하드코딩하지 않는다 — API가 실제 title을 준다.
const STYLE_IDS = [1, 2, 4, 5, 10, 11, 12, 13, 21, 23];

// MD추천 = 카카오 MD가 직접 고른 큐레이션(스타일 그룹 11). 해시태그가 아니라 별도 추천 목록.
const MD_STYLE_ID = 11;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      if (res.status === 404 || res.status === 400) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) { console.warn(`[warn] ${url} 실패: ${e.message}`); return null; }
      await sleep(800 * (i + 1));
    }
  }
}

/** 동시 실행 수를 제한하며 순회 */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    })
  );
}

const listItem = (it) => ({
  slug: it.slug,
  title: it.title,
  creator: it.creatorName,
  creatorId: it.creatorId ?? null,
  image: it.stillImageUrl,
  isNew: !!it.isNew,
  isMini: !!it.isMini,
  isBig: !!it.isBig,
  isSound: !!it.isSound,
});

async function fetchRanking(band) {
  const q = band.param ? `ageBand=${band.param}&` : '';
  const j = await getJSON(`${BASE}/api/items/hot?${q}miniOnly=false&page=0&size=${SIZE}`);
  return (j?.items || []).map(listItem);
}

/** 카테고리별 신상 목록(공급 표본). title은 카카오가 주는 실제 카테고리명. */
async function fetchStyle(styleId) {
  const j = await getJSON(`${BASE}/api/styles/${styleId}?page=0&size=${SUPPLY_SIZE}&sort=NEW`);
  if (!j) return null;
  return { id: styleId, title: j.title, items: (j.items || []).map(listItem) };
}

/** MD추천 slug 집합. 순위에 든 이모티콘이 MD추천인지 표시하는 데 쓴다. */
async function fetchMdPickSlugs() {
  const set = new Set();
  for (let page = 0; page < 12; page++) {
    const j = await getJSON(`${BASE}/api/styles/${MD_STYLE_ID}?page=${page}&size=100&sort=NEW`);
    (j?.items || []).forEach((it) => it.slug && set.add(it.slug));
    if (!j?.hasNext) break;
    await sleep(150);
  }
  return set;
}

/** 상세 API에서 뽑을 수 있는 건 다 뽑는다(해시태그 포함). */
async function fetchDetail(slug) {
  const d = await getJSON(`${BASE}/api/items/${slug}`);
  if (!d) return null;

  const seen = new Set();
  const tags = [];
  for (const g of d.similarStyle?.groups || []) {
    if (!g?.title || seen.has(g.title)) continue;
    seen.add(g.title);
    tags.push({ categoryId: g.categoryId ?? 0, tag: g.title });
  }

  const price = d.hero?.price || {};
  const contents = d.contents?.items || [];
  const cd = d.creator?.detail || {};

  return {
    tags,
    // 정적 — 캐시해서 재사용
    contentCount: contents.length,
    isMini: !!d.contents?.isMini,
    isBig: !!d.contents?.isBig,
    isSound: !!d.contents?.isSound,
    creatorId: cd.id ?? null,
    creatorName: d.creator?.name ?? null,
    // 동적 — 순위권은 매번 갱신
    interestCount: cd.interestCount ?? null,   // 작가 관심(팔로워) 수
    itemCount: cd.itemCount ?? null,           // 작가 총 출시 수
    price: price.value ? Number(price.value) : null,
    originalPrice: price.discount?.originalValue ? Number(price.discount.originalValue) : null,
  };
}

/** 제목에서 2글자 이상 토큰 추출 (제목 키워드 트렌드용) */
const STOPWORDS = new Set(['이모티콘', '그리고', '우리의', '나의', '너의', '있는', '하는', '되는', '가득', '시즌']);
function titleTokens(title = '') {
  return [...new Set(
    title.replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  )];
}

async function main() {
  const cacheDir = new URL('./cache/', import.meta.url);
  const detailCachePath = new URL('./cache/details.json', import.meta.url);
  const legacyCachePath = new URL('./cache/hashtags.json', import.meta.url);

  let cache = {};
  if (existsSync(detailCachePath)) {
    try { cache = JSON.parse(await readFile(detailCachePath, 'utf8')); } catch {}
  }
  // 구버전 캐시(해시태그만 저장)는 상세 조회 실패 시의 태그 보루로 남겨둔다.
  let legacy = {};
  if (existsSync(legacyCachePath)) {
    try { legacy = JSON.parse(await readFile(legacyCachePath, 'utf8')); } catch {}
  }

  // 1) 수요: 연령대별 인기 순위
  const rankings = {};   // key -> [{slug,...}] (rank 순)
  const meta = {};       // slug -> 목록 API 메타
  for (const band of AGE_BANDS) {
    const list = await fetchRanking(band);
    rankings[band.key] = list;
    list.forEach((it) => { meta[it.slug] = it; });
    console.log(`[rank] ${band.label}: ${list.length}개`);
    await sleep(300);
  }
  const rankedSlugs = [...new Set(Object.values(rankings).flat().map((i) => i.slug))];

  // 1-b) MD추천 목록
  const mdSet = await fetchMdPickSlugs();
  console.log(`[md] MD추천 총 ${mdSet.size}개 수집`);

  // 2) 공급: 카테고리별 신상
  const styles = [];
  const supplySlugs = new Set();
  for (const id of STYLE_IDS) {
    const s = await fetchStyle(id);
    if (!s) continue;
    s.items.forEach((it) => { meta[it.slug] = meta[it.slug] || it; supplySlugs.add(it.slug); });
    styles.push({ id: s.id, title: s.title });
    console.log(`[supply] ${s.title}(${id}): 신상 ${s.items.length}개`);
    await sleep(250);
  }

  // 3) 상세 수집 — 순위권은 매번 재조회(관심수·가격이 변함), 신상은 캐시 우선
  const rankedSet = new Set(rankedSlugs);
  const supplyOnly = [...supplySlugs].filter((s) => !rankedSet.has(s) && !cache[s]);
  console.log(`[detail] 재조회 ${rankedSlugs.length}개 + 신규 ${supplyOnly.length}개 (캐시 ${Object.keys(cache).length}개)`);

  const details = {};
  let done = 0;
  await mapLimit([...rankedSlugs, ...supplyOnly], CONCURRENCY, async (slug) => {
    const d = await fetchDetail(slug);
    if (d) { details[slug] = d; cache[slug] = d; }
    else if (cache[slug]) details[slug] = cache[slug];
    if (++done % 200 === 0) console.log(`  ...${done}개 완료`);
    await sleep(60);
  });
  for (const slug of supplySlugs) if (!details[slug] && cache[slug]) details[slug] = cache[slug];

  if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true });
  await writeFile(detailCachePath, JSON.stringify(cache));

  // 상세 조회에 실패해도 구버전 캐시의 태그가 있으면 그걸로 대체한다.
  const tagsOf = (slug) => details[slug]?.tags || legacy[slug] || [];

  // 4-a) [인기 분석] 연령대별 해시태그 집계 — 기존 화면이 쓰던 구조 그대로
  const agg = {};
  for (const band of AGE_BANDS) {
    const list = rankings[band.key];
    const N = list.length;
    const map = {}; // tag -> {tag, categoryId, count, score, bestRank}
    list.forEach((it, idx) => {
      const rank = idx + 1;
      const weight = N - idx; // 1위=N점 ... N위=1점
      for (const { categoryId, tag } of tagsOf(it.slug)) {
        if (!map[tag]) map[tag] = { tag, categoryId, count: 0, score: 0, bestRank: rank };
        map[tag].count += 1;
        map[tag].score += weight;
        map[tag].bestRank = Math.min(map[tag].bestRank, rank);
      }
    });
    const hashtags = Object.values(map).sort((a, b) => b.score - a.score);
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

  // 카테고리 라벨은 추정하지 않고 API가 준 실제 이름을 쓴다.
  const categories = Object.fromEntries(styles.map((s) => [s.id, s.title]));

  const compactRankings = {};
  for (const band of AGE_BANDS) compactRankings[band.key] = rankings[band.key].map((i) => i.slug);

  const updatedAt = new Date().toISOString();

  await writeFile(new URL('./public/data.json', import.meta.url), JSON.stringify({
    updatedAt,
    size: SIZE,
    ageBands: AGE_BANDS.map(({ key, label }) => ({ key, label })),
    categories,
    items: Object.fromEntries(rankedSlugs.map((s) => [s, {
      title: meta[s].title, creator: meta[s].creator, image: meta[s].image,
      isMini: meta[s].isMini, isBig: meta[s].isBig,
      md: mdSet.has(s), tags: tagsOf(s),
    }])),
    mdCount: rankedSlugs.filter((s) => mdSet.has(s)).length,
    rankings: compactRankings,
    agg,
  }));
  console.log(`[done] public/data.json (이모티콘 ${rankedSlugs.length}개)`);

  // 4-b) [인사이트] 작가 파워 / 제작 아이디어용
  const allSlugs = [...new Set([...rankedSlugs, ...supplySlugs])];
  await writeFile(new URL('./public/insight.json', import.meta.url), JSON.stringify({
    updatedAt,
    rankSize: SIZE,
    supplySize: SUPPLY_SIZE,
    ageBands: AGE_BANDS.map(({ key, label }) => ({ key, label })),
    styles,
    rankings: compactRankings,
    supplySlugs: [...supplySlugs],
    items: Object.fromEntries(allSlugs.map((s) => {
      const m = meta[s] || {};
      const d = details[s] || {};
      return [s, {
        title: m.title, creator: d.creatorName || m.creator, creatorId: d.creatorId || m.creatorId,
        image: m.image, isMini: d.isMini ?? m.isMini, isBig: d.isBig ?? m.isBig,
        interestCount: d.interestCount ?? null, itemCount: d.itemCount ?? null,
        price: d.price ?? null, contentCount: d.contentCount ?? null,
        tags: (d.tags || []).map((t) => t.tag),
        tokens: titleTokens(m.title),
      }];
    })),
  }));
  console.log(`[done] public/insight.json (순위 ${rankedSlugs.length} / 신상 ${supplySlugs.size} / 총 ${allSlugs.length}개)`);

  // 4-c) 순위 스냅샷 — '순위 변동' 시계열로 누적
  // 파일명은 KST 날짜로 붙인다. UTC를 쓰면 밤늦게 수동 실행했을 때 전날 파일을 덮어쓴다.
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const histDir = new URL('./history/', import.meta.url);
  if (!existsSync(histDir)) await mkdir(histDir, { recursive: true });
  await writeFile(new URL(`./${date}.json`, histDir), JSON.stringify({
    date, updatedAt, size: SIZE, source: 'live',
    rankings: compactRankings,
    items: Object.fromEntries(rankedSlugs.map((s) => [s, {
      title: meta[s].title, creator: meta[s].creator, isMini: meta[s].isMini, isBig: meta[s].isBig,
    }])),
  }));
  console.log(`[done] history/${date}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });

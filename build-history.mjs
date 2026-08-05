// history/*.json (일자별 스냅샷)을 프런트가 한 번에 받을 수 있는 public/history.json으로 병합.
//
// 스냅샷마다 items 메타가 중복되므로 slug→메타를 한 곳에 모으고,
// 날짜별로는 순위(slug 배열)만 남겨 용량을 줄인다.

import { readdir, readFile, writeFile } from 'node:fs/promises';

const HIST = new URL('./history/', import.meta.url);

async function main() {
  const files = (await readdir(HIST)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  const snapshots = [];
  const items = {}; // slug -> {title, creator, isMini, isBig}

  for (const f of files) {
    const s = JSON.parse(await readFile(new URL(f, HIST), 'utf8'));
    for (const [slug, m] of Object.entries(s.items || {})) {
      // 최신 스냅샷의 메타가 이기도록 덮어쓴다(제목 변경 반영)
      items[slug] = m;
    }
    snapshots.push({ date: s.date, updatedAt: s.updatedAt, source: s.source, rankings: s.rankings });
  }

  const out = { dates: snapshots.map((s) => s.date), snapshots, items };
  await writeFile(new URL('./public/history.json', import.meta.url), JSON.stringify(out));

  const kb = Math.round(JSON.stringify(out).length / 1024);
  console.log(`[history] ${snapshots.length}개 스냅샷 병합 (${out.dates.join(', ')}) → public/history.json ${kb}KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });

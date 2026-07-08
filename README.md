# 카카오 이모티콘 인기 해시태그 분석

카카오 이모티콘샵 **인기 순위**(전체 + 연령별)에 오른 이모티콘들이 어떤 **스타일 해시태그**를 달고 있는지 집계해서, "어떤 스타일이 상위권에 많이 포진하는가"를 보여주는 사이트입니다.

## 어떻게 동작하나

```
GitHub Actions (매일 오전 10시)
   └─ node scrape.mjs
        ├─ 카카오 인기 순위 API 6개(전체/10~50대+) × 50위 수집
        ├─ 각 이모티콘 상세 API에서 해시태그 수집 (cache/hashtags.json 캐시)
        └─ 연령대별 해시태그 집계 → public/data.json 저장·커밋
   └─ Vercel 이 커밋 감지 → 자동 재배포
사이트 방문 시 public/data.json(최대 하루 전 데이터) 로드
```

- **CORS 때문에** 브라우저가 직접 카카오를 실시간으로 못 긁습니다. 그래서 서버(GitHub Actions)가 하루 한 번 대신 긁어 저장하는 구조입니다.
- 해시태그(스타일)는 잘 안 바뀌므로 `cache/hashtags.json`에 캐시 → 다음 날엔 **신규 진입 이모티콘만** 조회.

## 집계 방식

- **순위가중점수**: 1위=50점 … 50위=1점. 해당 해시태그를 가진 인기 이모티콘들의 순위 점수를 합산 → 상위권에 많이 있을수록 높음.
- **등장 횟수**: 상위 50위 안에 그 태그를 가진 이모티콘이 몇 개인지.

## 로컬에서 보기

```bash
node scrape.mjs          # 데이터 갱신 (public/data.json 생성)
cd public && python3 -m http.server 8877
# http://localhost:8877
```

## 배포 (Vercel + GitHub)

1. GitHub 리포 생성 후 push
2. Vercel에서 이 리포를 Import → `vercel.json` 설정(정적, `public/`)대로 배포
3. GitHub 저장소 Settings → Actions → 워크플로 권한을 "Read and write"로 (자동 커밋용)
4. 이후 매일 오전 10시 자동 갱신

## 데이터 구조 (public/data.json)

| 필드 | 설명 |
|---|---|
| `updatedAt` | 갱신 시각(ISO) |
| `ageBands` | 연령대 탭 목록 |
| `categories` | categoryId → 분류명 |
| `items` | slug → {제목, 작가, 이미지, tags[]} |
| `rankings` | 연령대별 순위(slug 배열) |
| `agg` | 연령대별 해시태그/카테고리 집계 |

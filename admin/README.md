# 오잉게임 관리자 대시보드

기능별 파일 분리 + 탭 지연 로딩 + Firebase 읽기 최소화 구조.

## 배포 전 테스트 (기존 관리자 배포는 건드리지 않기)

기존 관리자 사이트(fascinating-pika-…)는 그대로 두고, 새 대시보드는
**별도 URL에서 먼저 검증**하세요. 두 방법 중 하나:

1. **Netlify Drop (가장 간단)** — https://app.netlify.com/drop 에
   이 `admin/` 폴더를 드래그&드롭 → 임시 URL이 즉시 발급됩니다.
2. **새 Netlify 사이트 연결** — "Add new site → Import from Git"에서
   이 저장소의 `claude/admin-page-refactor-ra1aiv` 브랜치를 선택하고
   **Publish directory를 `admin`** 으로 지정. (기존 사이트 설정은 변경하지 않음)

검증이 끝난 뒤에만 기존 관리자 사이트를 새 버전으로 교체하세요.
게임 본체(`../index.html`)와는 완전히 분리되어 있어 게임에는 영향이 없습니다.

### 실 운영 환경에서 확인할 체크리스트

- [ ] 익명 로그인 상태에서 홈 타일이 전부 채워지는가 (권한 오류 카드 확인)
- [ ] 우측 상단 "추정 읽기" 수치가 예상 범위인가 (홈 진입 ≈ 쿼리 10~15회)
- [ ] 분석 탭 최초 클릭 시 14일 백필이 완료되고, 재클릭 시 조회가 없는가
- [ ] 분석 탭 상단에 "dailyStats 저장이 막혔다"는 경고가 뜨는지 (뜨면 아래 규칙 추가 권장)
- [ ] 유저 30명 페이지네이션 / 검색 / 상세 모달
- [ ] Firebase 콘솔 → 사용량에서 실제 읽기 수와 카운터 추정치 비교

## 파일 구조와 역할

```
admin/
├── index.html      화면 뼈대 (로그인 게이트 + 6개 탭 섹션)
├── admin.css       스타일 (게임과 동일한 다크 팔레트)
└── js/
    ├── firebase.js    Firebase 초기화 · 인증 · 공통 조회 헬퍼(count 집계, 커서 페이지네이션, 세션 캐시)
    ├── admin.js       로그인 · 탭 전환 · 지연 로딩 제어 · 새로고침 버튼
    ├── stats.js       날짜별 집계(dailyStats) 공용 모듈 — 홈/분석이 공유
    ├── dashboard.js   홈 탭 (오늘의 핵심 지표)
    ├── users.js       유저 탭 (30명씩 페이지네이션, 검색, 상세, 랭킹 삭제)
    ├── analytics.js   분석 탭 (14일 그래프, 시간대별, 유입경로/추천인)
    ├── security.js    보안 탭 (의심 기록 탐지, 백업, 초기화 3종)
    ├── rewards.js     후원·리워드 탭 (스킨/쪽지/젤리 지급, 클릭 로그, 후원 쪽지함)
    └── operations.js  운영 탭 (피드백 답글, 감사메시지, 명예의전당, 챔피언 동기화)
```

## 데이터 로딩 규칙 (비용 설계)

- **최초 진입 시 홈 데이터만 조회** — 오늘 방문 세션 1쿼리 + count 집계 몇 개.
- 각 탭은 **처음 클릭했을 때 1회만** 조회. 재클릭 시 세션 캐시 재사용 (재조회 없음).
- 각 탭 상단의 **↻ 새로고침 버튼**만 해당 탭 데이터를 다시 조회.
- 목록(유저/로그/피드백)은 전부 `orderBy + limit(30) + startAfter` **커서 페이지네이션**.
- 개수만 필요한 지표는 `getCountFromServer` **count 집계** (문서 다운로드 없음).
- 14일 그래프는 `dailyStats/{날짜}` **집계 문서** — 지난 날짜는 최초 1회만 원본에서
  백필하고 이후엔 날짜당 문서 1개만 읽음. 오늘만 라이브 계산.
- **onSnapshot(실시간 리스너)은 사용하지 않음** — 새로고침 버튼으로 대체.

## 비활성 기능 처리 원칙 (feature flag)

게임에서 꺼져 있는 기능은 관리자에서도 숨긴다 — UI가 렌더링되지 않고
관련 Firestore 조회도 실행되지 않는다. 코드는 삭제하지 않는다.
플래그는 `js/firebase.js`의 `FEATURES`에 모여 있다:

```js
export const FEATURES = {
  skinRequests: false, // 스킨 꾸미기 신청 — 게임에서 다시 켜면 true로 변경
};
```

`skinRequests: true`로 바꾸면 클릭 기록 셀렉트에 "스킨 꾸미기 신청"이
다시 나타나고, 대기/처리됨 표시와 "처리 완료" 버튼이 그대로 동작한다.

※ 단순히 오늘 사용량이 0인 **활성** 기능은 숨기지 않는다 — "0회"로 표시.
(예: 카톡 공유가 오늘 0회여도 홈 클릭 현황에 0회로 보인다)

## 기능을 추가/수정하려면

| 하고 싶은 것 | 고칠 파일 |
|---|---|
| 홈에 지표 타일 추가 | `js/dashboard.js` (TILES 배열 + 로직) |
| 유저 목록/정렬/상세 변경 | `js/users.js` |
| 그래프·분석 추가 | `js/analytics.js` (+ 집계 항목은 `js/stats.js`) |
| 초기화·백업·의심탐지 | `js/security.js` |
| 스킨/젤리/후원 로그 | `js/rewards.js` |
| 피드백/명예의전당/감사메시지 | `js/operations.js` |
| 탭 자체를 추가 | `index.html`(섹션+버튼) + `js/admin.js`(TABS 등록) |
| Firebase 설정·공통 헬퍼 | `js/firebase.js` |

## 인증과 보안 규칙 — 반드시 이해하고 배포할 것

### 관리자 암호(SHA-256 게이트)의 실제 역할

관리자 암호는 **프런트엔드 화면 잠금일 뿐, 데이터 보호 장치가 아닙니다.**
해시가 클라이언트 JS에 그대로 들어 있어(누구나 소스에서 볼 수 있음),
Firestore 데이터를 실제로 보호하는 것은 **오직 Security Rules**입니다.
악의적 사용자는 이 페이지 없이도 Firebase SDK로 직접 쿼리할 수 있으므로,
"관리자만 가능해야 하는 작업"은 전부 규칙에서 막혀 있어야 합니다.

### 게임 코드에서 확인된 규칙의 성격 (규칙 원문은 이 저장소에 없음)

게임 본체 주석 기준으로, 현재 규칙은 이미 다음을 차단하고 있습니다:

- `nickname_skins`의 소유권 필드(cat·ownedSkins·bubblePurchased)와
  `user_stats.jelly` **증가**는 일반 클라이언트 쓰기 차단 (서버 함수 shopAction만 가능)
- `feedback` 원문 읽기는 "어드민 또는 글쓴이 본인(uid 일치)"만 가능
- 옛 관리자 기능이 게임 안에서 "새 보안규칙상 작동 불가"가 되어 분리됨

→ 즉 규칙에 이미 "어드민" 개념이 존재하며, **이 대시보드의 관리자 쓰기
(스킨 지급/해제, 젤리 지급, 피드백 답글, 랭킹/왕관 초기화, meta 쓰기)는
익명 인증으로는 거부되고, 규칙이 인정하는 관리자 신원으로 로그인해야
동작할 가능성이 높습니다.** 로그인 화면의 이메일 로그인을 사용하세요.

### Firebase Console에서 확인할 것 (Firestore → 규칙 탭)

1. **어드민을 무엇으로 판별하는가** — 특정 UID? 이메일? custom claim?
   (예: `request.auth.uid == '...'` / `request.auth.token.email == '...'`)
   → 그 신원과 로그인 화면에 입력할 계정이 일치해야 합니다.
2. `feedback`, `feedback_donate` **read**가 어드민에게 허용되는가
3. `rankings`, `weekly_rankings/*/scores`, `user_stats`, `champions`의
   **delete**가 어드민에게 허용되는가 (초기화/기록삭제 기능의 전제)
4. `nickname_skins` **write**(cat·notifyPending·thanksPending)와
   `user_stats.jelly` **증가**가 어드민에게 허용되는가
5. `meta/*` (weeklyThanks·currentChampion·rankSnapshot 등) **write** 허용 여부
6. `dailyStats` 컬렉션에 대한 match가 없으면 기본 거부 → 아래 규칙 추가

### dailyStats 권장 규칙 — 절대 "로그인한 모든 사용자"에게 열지 말 것

게임 유저도 전부 (익명) 로그인 상태이므로 `request.auth != null` 조건은
사실상 전체 공개와 같습니다. 반드시 관리자 신원으로 제한하세요:

```
// 기존 규칙에 이미 isAdmin() 같은 함수가 있으면 그걸 그대로 재사용하는 게 최선
function isAdminUid() {
  return request.auth != null
      && request.auth.uid == '여기에_관리자_계정_UID';
}

match /dailyStats/{date} {
  allow read, write: if isAdminUid();   // ❌ if request.auth != null 금지
}
```

관리자 계정 UID는 Firebase Console → Authentication → Users에서
관리자 이메일 계정의 UID를 복사하면 됩니다.

### 동작 방식 요약

1. 관리자 암호(화면 잠금) 입력 후,
2. **관리자 이메일 계정으로 로그인 권장** (규칙이 요구하는 신원).
   비워두면 게임과 동일한 익명 인증 — 읽기 일부는 되더라도
   관리자 쓰기 작업은 규칙에서 거부될 가능성이 높습니다.
3. 권한이 부족한 작업은 해당 카드에만 "권한 없음"이 표시되고
   나머지 기능은 정상 동작합니다.

## dailyStats 컬렉션

`dailyStats/{YYYY-MM-DD}` 는 이 대시보드가 만드는 **추가 전용** 집계 캐시입니다.
기존 컬렉션/데이터는 일절 수정하지 않습니다.

- **백필은 분석 탭에서만** 실행됩니다. 홈은 이미 존재하는 dailyStats 문서만
  읽고(최대 6읽기), 없으면 "미집계"로 표시합니다.
- 백필은 전체 스캔이 아니라 **날짜별 쿼리**(`visit_sessions where date == D`,
  날짜당 최대 1,000건 + count 집계 5회)로, 최근 13일만 처리합니다.
- 쓰기가 보안 규칙에 막히면 localStorage 캐시로 자동 대체됩니다.
  ⚠️ **한계**: localStorage는 기기·브라우저별로 분리되어 있어, 다른 기기에서
  접속하면 그 기기에서 백필(원본 재조회)이 반복됩니다. 분석 탭에 경고가
  표시되며, 아래 규칙을 추가하면 모든 기기가 캐시를 공유해 이 문제가 사라집니다:

```
match /dailyStats/{date} {
  allow read, write: if <관리자 조건>;  // 예: request.auth.token.email == '관리자이메일'
}
```

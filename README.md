# 생활선택연구소 — 블로그 초안 도구 (웹사이트 버전)

네이버/토스 쇼핑커넥트 링크를 넣으면 서버가 실제로 상품 페이지에 접속해
상품명·설명·이미지를 가져오고, Gemini가 `Creator_Assistant1_글작성규칙_
콘텐츠설계_기준서_v1.1`의 규칙에 따라 블로그 초안을 생성하는 개인용 도구입니다.

claude.ai artifact 버전과 달리 **진짜 서버**를 가지고 있어서 외부 사이트에
직접 접속할 수 있습니다. 그 대신 AI 기능은 Gemini API 키가 있어야
동작합니다 (아래 참고).

## 폴더 구조

```
server/          Express 백엔드
  index.js       라우트 정의, 서버 진입점
  scrape.js      상품 페이지 접속 + og:meta 태그 추출
  gemini.js      Gemini API 호출
  prompts.js     AI 초안 생성 프롬프트 (기준서 v1.1 반영)
  store.js       JSON 파일 기반 임시 저장소 (data/drafts.json)
public/          프런트엔드 (순수 HTML/CSS/JS, 빌드 도구 없음)
  index.html
  app.js
  style.css
data/            drafts.json이 여기에 생성됩니다 (git에는 올라가지 않음)
```

## 로컬에서 실행하기

```bash
npm install
cp .env.example .env
# .env 파일을 열어 GEMINI_API_KEY=... 를 채워 넣으세요
npm start
```

브라우저에서 http://localhost:3000 접속.

**API 키가 아직 없어도 서버는 정상 실행됩니다.** 상품 정보 자동 확인
(스크래핑)은 바로 동작하고, "AI 초안 생성" 버튼만 키가 없다는 안내와
함께 비활성 상태로 남습니다.

## Gemini API 키 발급

1. https://aistudio.google.com/apikey 접속 (구글 계정으로 로그인)
2. "Create API key" 클릭
3. 발급된 키를 `.env`의 `GEMINI_API_KEY`에 붙여넣기
4. 무료 등급(분당·일일 요청 수 제한)으로도 개인 사용 수준은 충분히
   커버됩니다. 한도를 넘기면 유료 등급으로 전환하거나 다음 분/일까지
   기다리면 됩니다.

## Railway에 배포하기 (나중에 진행할 때)

1. 이 프로젝트를 GitHub 저장소로 올리기
2. Railway 대시보드에서 New Project → Deploy from GitHub repo 선택
3. Variables 탭에서 `GEMINI_API_KEY` 추가 (PORT는 Railway가 자동 주입)
4. 배포 후 Railway가 주는 도메인으로 접속

`data/drafts.json` 파일 저장 방식은 로컬 개발용입니다. Railway처럼
컨테이너가 재배포마다 초기화되는 환경에서 데이터를 계속 유지하려면,
Railway의 Volume을 `data/` 폴더에 연결하거나, 이후 Postgres 같은
실제 데이터베이스로 `server/store.js`만 교체하면 됩니다 (다른 파일은
store의 함수 시그니처만 그대로 쓰기 때문에 손댈 필요가 없습니다).

## 알아두면 좋은 점

- `scrape.js`는 og:title / og:description / og:image 메타 태그만 읽습니다.
  일부 쇼핑몰은 이 태그를 비워두거나 로그인·자바스크립트 렌더링이 필요할
  수 있어, 그런 경우 상품명·설명이 비어서 돌아올 수 있습니다. 이때는
  화면에서 직접 채워 넣으면 됩니다.
- AI는 입력된 정보에 없는 사실을 만들어내지 않도록 프롬프트에서
  명시적으로 금지하고 있습니다 (기준서 3장 Source Priority, 15장 금지사항).
- 최종 점검(Quality Gate)의 일부 항목은 자동 검사가 가능하지만
  (과장 표현, 제휴 고지, 이미지 등록 등), 상품 사실성·실사용 진실성처럼
  판단이 필요한 항목은 사람이 직접 확인하도록 남겨두었습니다.

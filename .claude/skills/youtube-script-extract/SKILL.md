---
name: youtube-script-extract
description: >
  유튜브 영상 링크 하나를 받아 제목·설명·자막(스크립트) 전문을 추출해 정리된
  마크다운으로 정리한다. "유튜브 링크에서 스크립트 뽑아줘", "이 영상 자막 정리해줘",
  "유튜브 대본 추출" 류 요청에 발동. 로그인·영상 재생·API 키 없이 동작(브라우저가
  유튜브 자체 스크립트 패널을 읽는 방식 + yt-dlp 폴백). 영상 다운로드나 더빙/번역
  영상 제작 파이프라인은 다루지 않는다 — 순수 텍스트 추출·정리만.
---

# youtube-script-extract — 유튜브 링크 → 스크립트 추출

유튜브 영상 링크를 던지면 제목 + 설명 + 자막 전문을 한 번에 뽑아 마크다운으로
정리한다. `carousel-mag` 프로젝트의 소재 수집 기능(링크 붙여넣기 → 자동 자막 추출)에서
그 부분만 떼어낸 독립 스킬.

## 준비 (최초 1회)

```bash
cd ~/.claude/skills/youtube-script-extract
npm install
npx playwright install chromium
```

`yt-dlp`가 있으면 폴백으로 자동 사용된다(없어도 브라우저 방식만으로 대부분 커버).
```bash
brew install yt-dlp   # 없으면 설치 권장(1순위가 실패했을 때만 쓰임)
```

## 사용법

```bash
node ~/.claude/skills/youtube-script-extract/scripts/extract.mjs "<유튜브URL>"
```

출력 파일을 지정하면 stdout 대신 파일에 저장:
```bash
node ~/.claude/skills/youtube-script-extract/scripts/extract.mjs "<유튜브URL>" ~/Desktop/script.md
```

출력 형식:
```markdown
# {영상 제목}

원본: {URL}

## 설명
{영상 설명란 텍스트}

## 스크립트 ({언어}, {글자수}자)
{자막 전문(공백 정규화, 최대 12,000자)}
```

## 작동 방식 (2단계 폴백)

1. **브라우저 방식 (1순위, `scripts/yt-transcript.mjs`)** — Playwright로 헤드리스
   Chromium을 띄워 영상 페이지를 열고, 유튜브 자체 "스크립트 표시" 패널을 클릭해
   내부 `get_transcript` API 응답 또는 DOM 세그먼트를 읽는다. 브라우저 확장프로그램과
   같은 원리라 서버 단독 호출과 달리 IP 레이트리밋(429)에 안 걸리고, 로그인·재생·API
   키가 필요 없다.
2. **yt-dlp 폴백 (2순위)** — 1순위가 실패하면(자막 패널이 없는 영상, playwright
   미설치 등) `yt-dlp --write-auto-subs --sub-format json3`로 언어를 `ko` →
   `ko-en`(영어 자동번역) → `en` 순서로 시도한다.
3. 둘 다 실패하면 자막 없이 영상 설명란 텍스트만 반환한다(성공 위장 금지 — 실패는
   `## 스크립트\n(자막 추출 실패...)`로 명시).

## 제약 / 함정

- **첫 실행은 느리다.** Chromium 콜드스타트 + 패널 로딩 대기로 영상당 10~30초 걸린다.
  75초 넘으면 브라우저 방식은 자동 포기하고 yt-dlp로 넘어간다.
- **`~/.claude/skills/youtube-script-extract/.chrome-profile`**에 영구 프로필을
  저장해 재사용한다(매번 새 프로필을 만들면 느려짐). 삭제해도 자동 재생성되니
  문제 생기면 지우고 재시도해도 안전하다.
- 비공개/연령제한/자막 자체가 없는 영상은 두 방식 모두 실패할 수 있다 — 그 경우
  설명란 텍스트만 나온다.
- 자막 전문은 12,000자에서 잘린다(긴 영상 대응). 더 필요하면 `extract.mjs`의
  `.slice(0, 12000)`을 조정.
- 이 스킬은 **텍스트 추출만** 한다. 영상 다운로드, 음성 인식(Whisper), 자막
  번인, 쇼츠 편집은 범위 밖 — 그건 별도 파이프라인(NewApe.mag 유튜브 탭 등).

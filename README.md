# bbob

텍스트 항목과 확률을 자유롭게 정하는 나만의 뽑기. 아이보리와 민트 색상, 반투명 유리 패널, 부드러운 뽑기 애니메이션을 사용하는 한국어 반응형 웹 앱입니다.

## 기능

- 항목 이름 입력, 추가·수정·삭제
- 가중치 조정과 실제 뽑기 확률 자동 계산
- Web Crypto 난수 기반 추첨과 결과 애니메이션
- 당첨 항목 제외 옵션과 뽑기 기록
- 브라우저 내 설정·기록 저장
- 모바일·데스크톱 대응과 모션 감소 설정 지원

확률은 각 항목의 가중치 ÷ 현재 뽑을 수 있는 항목의 전체 가중치로 계산합니다. 모든 수치의 합을 100으로 맞출 필요가 없습니다. 0인 항목은 뽑히지 않습니다.

## 로컬 실행

Node.js 24와 npm을 사용합니다.

```sh
git clone https://github.com/Heedo-Kim0624/bbkk.git
cd bbkk
npm ci
npm run dev
```

터미널에 표시되는 로컬 주소를 엽니다. 기본 주소는 `http://127.0.0.1:5173`입니다. Windows PowerShell 실행 정책으로 `npm` 명령이 차단되면 `npm.cmd`를 사용합니다.

## 검증 및 빌드

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

프로덕션 산출물은 `dist/`에 생성됩니다. 검증 결과는 `docs/progress.md`에 실제 실행 기준으로 기록하며, 실행하지 않은 항목은 통과로 간주하지 않습니다.

Windows에서는 다음 검증 스크립트가 lint, 타입 검사, 단위 테스트, 프로덕션 빌드를 순서대로 실행하고 실패 시 중단합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

브라우저 테스트를 처음 실행하기 전에는 Chromium을 설치합니다.

```sh
npx playwright install chromium
npm run test:e2e
```

전체 검증 스크립트에 Playwright 브라우저 테스트까지 포함하려면 `-WithBrowser`를 추가합니다. 브라우저 테스트 실행 환경과 검증 범위는 `docs/verification.md`를 참고합니다.

## Vercel 배포

1. Vercel에서 **Add New → Project**를 선택하고 `Heedo-Kim0624/bbkk` 저장소를 가져옵니다.
2. 프로젝트 루트는 이 폴더를 선택합니다. 프레임워크는 **Vite**, Node.js는 **24.x**를 사용합니다.
3. `vercel.json`의 설치 명령 `npm ci`, 빌드 명령 `npm run build`, 출력 폴더 `dist` 설정을 확인합니다. 환경 변수는 필요하지 않습니다.
4. 배포 후 항목 추가, 확률 변경, 뽑기와 모바일 화면을 확인합니다.

`.vercelignore`는 로컬 에이전트 기록과 문서·검증 산출물을 업로드에서 제외합니다. 이 저장소에 배포 설정이 있다는 사실은 실제 배포 완료를 의미하지 않습니다. 계정 연결 및 공개 배포는 프로젝트의 승인 경계를 따릅니다.

## 기술 구성

React 19 · TypeScript · Vite · Astryx Design System · Lucide · Vitest. Astryx는 패키지의 사전 빌드 CSS와 neutral 테마를 사용합니다. 별도의 서버와 데이터베이스는 없습니다.

사용자 설정과 기록은 현재 브라우저의 localStorage에만 보관됩니다. 다른 기기와 동기화되지 않으며 브라우저 데이터를 지우면 사라집니다. 저장이 제한된 환경에서는 현재 탭에서 계속 사용할 수 있습니다.

제품 요구사항은 `docs/prd.md`, 구조는 `docs/architecture.md`, 로컬 검증 명령은 `quality_gates.yaml`을 참고합니다.

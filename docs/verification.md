# 검증 안내

## 기본 검증

Node.js 24에서 `npm ci`로 의존성을 설치한 뒤 프로젝트 루트에서 실행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

스크립트는 `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`를 순서대로 실행한다. Windows의 `npm.cmd`를 우선 사용하고 각 네이티브 명령의 종료 코드를 확인한다. 명령이 실패하거나 `dist/index.html`이 생성되지 않으면 실패 처리한다. 검증이 설정되지 않은 명령을 통과로 표시하지 않는다.

## 브라우저 검증

첫 실행에서는 Chromium 브라우저를 설치한다. 테스트만 개별 실행할 수도 있다.

```sh
npx playwright install chromium
npm run test:e2e
```

다음 명령으로 기본 검증과 브라우저 검증을 함께 실행한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -WithBrowser
```

`test:e2e` 스크립트가 없으면 `not configured` 오류로 중단한다. 기본 검증은 브라우저 검증을 생략했다는 사실을 출력한다. 브라우저 검증에서는 데스크톱·모바일 배치, 항목 입력과 삭제, 가중치 변경, 결과 표시, 당첨 항목 제외, 저장과 복원을 확인한다.

최종 결과는 Chromium 7/7 통과다. 테스트는 `tests/e2e/studio.spec.ts`, 검증 보고서는 `outputs/browser/validation.md`, 스크린샷과 HTML 보고서는 `outputs/browser/`에 보관한다. 빌드된 페이지의 HTTP 200·뽑기·기록 복원·모바일 배치 검증은 `outputs/browser/production-smoke.json`에 기록했다. 실제 iOS Safari는 별도 수동 검증이 필요하다.

## 결과 해석과 경계

- `outputs/browser/`는 Git에서 제외되는 로컬 산출물이다. 새 clone에서는 `npm run test:e2e`로 테스트·HTML 보고서·스크린샷을 재생성한다. 위 `validation.md`와 `production-smoke.json`은 첫 구현 때 별도 작성한 로컬 증거로, 해당 명령이 자동 생성하지 않는다.

- 단위 테스트는 가중치 선택 경계, 제외와 0 가중치, 확률 계산, 저장 데이터 검증 등 추첨 규칙을 검사한다.
- 빌드 성공은 정적 배포 산출물 생성까지를 의미한다. Vercel 로그인·업로드·프로덕션 배포는 별도 작업이다.
- 번들 크기 경고는 오류와 구분하여 기록한다. 경고를 숨기기 위해 임계값만 올리지 않는다.
- 수동으로 검토한 항목을 자동 검증 결과로 기록하지 않는다.
- `.env`, 토큰, 쿠키와 개인 계정 데이터는 검증 대상으로 읽지 않는다.

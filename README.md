# Dual Printer Controller (테스트 프론트)

Electron + React 기반 듀얼 프린터 컨트롤러. 실서버가 아닌 테스트용 프론트엔드입니다.

## 프린터 구성

| 프린터 | 모델 | SDK | DLL 위치 |
|--------|------|-----|----------|
| PRINTER 1 | HiTi P525T (포토 프린터) | HTRTApi | `dll/HTRTApi.dll` |
| PRINTER 2 | Rtai LUCA-40KM (카드 프린터) | Retransfer 600 SDK | `dll/r600/` |

## 카드 프린터 (Rtai LUCA-40KM) 오버레이 출력

### 동작 방식

홀로그램 카드에 이미지를 인쇄할 때, 같은 이미지를 **YMC(컬러)** + **F/S/W(White 패널 마스크)** 두 용도로 사용합니다.

- **White 패널**: 이미지의 어두운 부분에 흰색 잉크를 깔아서 홀로그램을 가림 -> 컬러가 선명하게 보임
- **투명 부분**: 이미지의 밝은 부분(threshold 이상)은 White 패널 없음 -> 홀로그램이 비침

### Threshold 설정

- UI 슬라이더로 0~255 조절 가능 (기본값: 220)
- **값 높이면**: 더 많은 영역에 White 패널 (더 많이 가림)
- **값 낮추면**: 어두운 부분만 White 패널 (더 많이 뚫림)

### SDK 호출 순서 (핵심)

데모(`Retransfer600Demo.exe`)의 로그 분석으로 확인된 정확한 호출 순서:

```
R600LibInit()
R600EnumUsbPrt() -> R600UsbSetTimeout() -> R600SelectPrt()
R600CardInject(0)                          // 카드 투입
R600SetRibbonOpt(1, 0, "2", 2)            // disabled 모드
R600SetCanvasPortrait(1)                   // 세로 모드
R600PrepareCanvas(0, 0)                    // 캔버스 시작
R600SetAddImageMode_Rtai(0, true, true, null, threshold)  // Rtai 전용
R600DrawImage(0, 0, 54, 86, imagePath, 1)  // 컬러 이미지 (YMC)
R600SetAddImageMode_Rtai(0, true, true, null, threshold)
R600DrawWaterMark(0, 0, 54, 86, imagePath) // F/S/W 마스크 (이것이 핵심!)
R600SetAddImageMode_Rtai(0, true, true, null, threshold)
R600CommitCanvas(buf, len)                 // 캔버스 커밋
R600PrintDraw(buf, null)                   // 출력 (buf는 CommitCanvas 결과 Buffer 그대로)
R600CardEject(0)                           // 카드 배출
R600LibClear()                             // 종료
```

### 주의사항

- **`R600DrawLayerWhite`는 이 프린터에서 동작하지 않음.** `R600DrawWaterMark`가 F/S/W 레이어 역할을 함
- **`R600SetAddImageMode_Rtai`**를 DrawImage 전, DrawWaterMark 전후로 3번 호출해야 함
- **`R600PrintDraw`에는 CommitCanvas의 Buffer를 문자열 변환 없이 그대로 전달** (koffi에서 `uint8 *` 타입 사용)
- 한글 파일명 경로는 SDK가 인식 못함 -> 임시 영문 경로로 복사 후 전달
- R600 워커의 **cwd가 `dll/r600/`이어야 함** (설정 파일, 색상 프로파일 등이 DLL과 같은 폴더에 필요)
- 세로 모드 캔버스 크기: **54 x 86mm** (CR80 portrait)
- 가로 모드 캔버스 크기: 86 x 54mm (CR80 landscape)

## DLL 파일 구조

```
dll/
├── HTRTApi.dll                    # HiTi P525T SDK
├── SmartComm2.dll                 # (구 SMART-81, 미사용)
└── r600/                          # Retransfer 600 SDK (Rtai LUCA-40KM)
    ├── libDSRetransfer600App.dll  # 메인 SDK DLL
    ├── lcms2.dll                  # 색상 관리
    ├── dcrf32.dll                 # 드라이버
    ├── Retransfer600_SDKCfg.xml   # SDK 설정 (로그 레벨 등)
    ├── DSRCPCLR_44_V2_1.icm      # 색상 프로파일
    ├── RSWOP.icm                  # 색상 프로파일
    ├── EWL                        # 설정
    └── R600StatusReference        # 상태 코드 참조
```

## 아키텍처

```
App.js (React UI)
  ↓ IPC (preload.js)
electron.js (메인 프로세스)
  ↓ stdin/stdout JSON
sdkWorker.js (SDK 워커 프로세스, koffi로 DLL 바인딩)
  ↓ FFI
libDSRetransfer600App.dll / HTRTApi.dll
```

- 각 SDK(HiTi, R600)는 별도 워커 프로세스로 실행
- R600 워커의 cwd는 `dll/r600/` (SDK 설정 파일 접근 필요)
- HiTi 워커의 cwd는 프로젝트 루트

## 카드 프린터 상태 조회

10초 주기 폴링으로 다음 정보를 표시:

- 프린터 상태 (정상/에러/동작 중)
- 리본 잔량 (%)
- 전사필름 잔량 (%)
- 총 출력 수
- 카드 피더 상태
- 본체/헤드 온도

## 실행

```bash
npm install
npm run electron-dev
```

## 기타 기능

- **결제 단말기**: NVC-1000 (나이스페이먼츠), KIS (KIS정보통신)
- **카메라**: 웹캠 연결 테스트 + 밝기/대비/채도/따뜻함 보정

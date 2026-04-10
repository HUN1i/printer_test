const path = require('path');
const fs = require('fs');
const os = require('os');
const koffi = require('koffi');
const sharp = require('sharp');

const DLL_DIR = path.join(__dirname, '..', 'dll');
const R600_DLL_DIR = path.join(__dirname, '..', 'dll', 'r600');
const SDK_TYPE = process.argv[2] || 'hiti'; // 'hiti' or 'r600'

// ===== HiTi SDK =====
let HITI_CheckPrinterStatusW = null;
let HITI_GetDeviceInfoW = null;

const HITI_STATUS_MAP = {
  0x00000000: { key: 'ready', label: '정상 (대기)' },
  0x00000002: { key: 'printing', label: '출력 중' },
  0x00000005: { key: 'processing', label: '데이터 처리 중' },
  0x00000006: { key: 'sending', label: '데이터 전송 중' },
  0x00080000: { key: 'busy', label: '프린터 사용 중' },
  0x00000080: { key: 'offline', label: '오프라인 (연결 끊김)' },
  0x00008000: { key: 'paper_out', label: '용지 없음' },
  0x00008001: { key: 'paper_low', label: '용지 부족' },
  0x00030000: { key: 'paper_jam', label: '용지 걸림' },
  0x000100FE: { key: 'paper_mismatch', label: '용지 타입 불일치' },
  0x00008010: { key: 'tray_mismatch', label: '용지함 불일치' },
  0x00008008: { key: 'tray_missing', label: '용지함 없음' },
  0x00000400: { key: 'paper_out', label: '용지 없음' },
  0x00000401: { key: 'paper_out', label: '용지 없음' },
  0x00000402: { key: 'paper_not_ready', label: '용지 준비 안 됨' },
  0x00000606: { key: 'paper_empty', label: '용지 비었음' },
  0x00000608: { key: 'no_paper', label: '용지 없음' },
  0x00050001: { key: 'cover_open', label: '커버 열림' },
  0x00050101: { key: 'cover_open', label: '커버 열림' },
  0x00000100: { key: 'cover_open', label: '커버 열림' },
  0x00080004: { key: 'ribbon_missing', label: '리본 없음' },
  0x00080103: { key: 'ribbon_out', label: '리본 소진' },
  0x00080200: { key: 'ribbon_mismatch', label: '리본 타입 불일치' },
  0x000802FE: { key: 'ribbon_error', label: '리본 오류' },
  0x00000201: { key: 'ribbon_missing', label: '리본 없음' },
  0x00000300: { key: 'ribbon_out', label: '리본 소진' },
  0x00000301: { key: 'ribbon_out', label: '리본 소진' },
};
const HITI_RIBBON_MAP = { 1: '4x6', 2: '5x7', 3: '6x9', 4: '6x8', 6: '8x10', 7: '8x12' };

function initHiti() {
  const lib = koffi.load(path.join(DLL_DIR, 'HTRTApi.dll'));
  HITI_CheckPrinterStatusW = lib.func('uint32 __stdcall HITI_CheckPrinterStatusW(str16, _Out_ uint32 *)');
  HITI_GetDeviceInfoW = lib.func('uint32 __stdcall HITI_GetDeviceInfoW(str16, uint32, _Out_ uint8 *, _Inout_ uint32 *)');
}

function handleHiti(printerName) {
  const sBuf = new Uint32Array(1);
  HITI_CheckPrinterStatusW(printerName, sBuf);
  const parsed = HITI_STATUS_MAP[sBuf[0]]
    || (sBuf[0] >= 0x500 && sBuf[0] <= 0x56F
      ? { key: 'paper_jam', label: `용지 걸림 (0x${sBuf[0].toString(16).toUpperCase()})` }
      : { key: 'unknown', label: `알 수 없는 상태 (0x${sBuf[0].toString(16).toUpperCase()})` });

  let ribbon;
  try {
    const iBuf = Buffer.alloc(64), lBuf = new Uint32Array([64]);
    HITI_GetDeviceInfoW(printerName, 4, iBuf, lBuf);
    const rType = iBuf.readUInt32LE(0), rRemain = iBuf.readUInt32LE(4);
    ribbon = { success: true, ribbonType: rType, remainCount: rRemain,
      ribbonName: HITI_RIBBON_MAP[rType] || (rType === 255 ? '리본 없음/미지원' : `타입 ${rType}`) };
  } catch { ribbon = { success: false, error: '리본 조회 실패' }; }

  let printCount;
  try {
    const iBuf = Buffer.alloc(64), lBuf = new Uint32Array([64]);
    HITI_GetDeviceInfoW(printerName, 5, iBuf, lBuf);
    printCount = { success: true, printCount: iBuf.readUInt32LE(0) };
  } catch { printCount = { success: false, error: '출력 카운트 조회 실패' }; }

  return { status: { success: true, rawStatus: sBuf[0], ...parsed }, ribbon, printCount };
}


// ===== Retransfer 600 SDK =====
let R600LibInit = null;
let R600LibClear = null;
let R600EnumUsbPrt = null;
let R600UsbSetTimeout = null;
let R600SelectPrt = null;
let R600QueryPrtStatus = null;
let R600GetPrtInfo = null;
let R600GetPrtManufInfo = null;
let R600GetRbnAndFilmRemaining = null;
let R600RibbonSettingsRW = null;
let R600IsFeederNoEmpty = null;
let R600GetCardPos = null;
let R600GetErrorOuterInfo = null;
// 캔버스/오버레이 출력 함수
let R600SetCanvasPortrait = null;
let R600PrepareCanvas = null;
let R600DrawImage = null;
let R600SetImagePara = null;
let R600CommitCanvas = null;
let R600ClearCanvas = null;
let R600PrintDraw = null;
let R600CardInject = null;
let R600CardEject = null;
let R600SetRibbonOpt = null;
let R600SetCoatRgn = null;
let R600DrawLayerWhite = null;
let R600SetAddImageMode = null;
let R600SetLayerWhiteThreshold = null;
let R600DrawLayerFluor = null;
let R600SetLayerFluorThreshold = null;
let R600DrawWaterMark = null;
let R600SetWaterMarkThreshold = null;
let R600SetAddImageMode_Rtai = null;
let R600SetYmcRgn = null;
let R600SetKRgn = null;

let r600Initialized = false;
let r600SelectedPrinter = null;

function initR600() {
  const lib = koffi.load(path.join(R600_DLL_DIR, 'libDSRetransfer600App.dll'));

  // 라이브러리 초기화/해제
  R600LibInit = lib.func('uint32 __stdcall R600LibInit()');
  R600LibClear = lib.func('uint32 __stdcall R600LibClear()');

  // 프린터 열거/선택
  R600EnumUsbPrt = lib.func('uint32 __stdcall R600EnumUsbPrt(_Out_ uint8 *, _Inout_ uint32 *, _Out_ int *)');
  R600UsbSetTimeout = lib.func('uint32 __stdcall R600UsbSetTimeout(int, int)');
  R600SelectPrt = lib.func('uint32 __stdcall R600SelectPrt(str)');

  // 상태 조회
  R600QueryPrtStatus = lib.func('uint32 __stdcall R600QueryPrtStatus(_Out_ int16 *, _Out_ int16 *, _Out_ int16 *, _Out_ uint32 *, _Out_ uint32 *, _Out_ uint32 *, _Out_ uint32 *, _Out_ uint8 *, _Out_ uint8 *)');
  R600GetPrtInfo = lib.func('uint32 __stdcall R600GetPrtInfo(_Out_ uint32 *, _Out_ uint32 *, _Out_ uint32 *, _Out_ uint32 *, _Out_ uint32 *)');
  R600GetPrtManufInfo = lib.func('uint32 __stdcall R600GetPrtManufInfo(_Out_ uint8 *, _Inout_ int *, _Out_ uint8 *, _Inout_ int *, _Out_ uint8 *, _Inout_ int *, _Out_ uint8 *, _Inout_ int *, _Out_ uint8 *, _Inout_ int *)');
  R600GetRbnAndFilmRemaining = lib.func('uint32 __stdcall R600GetRbnAndFilmRemaining(_Out_ uint16 *, _Out_ uint16 *)');
  R600RibbonSettingsRW = lib.func('uint32 __stdcall R600RibbonSettingsRW(int, _Out_ uint8 *, _Out_ uint8 *, _Inout_ uint8 *, _Inout_ uint8 *)');
  R600IsFeederNoEmpty = lib.func('uint32 __stdcall R600IsFeederNoEmpty(_Out_ int *)');
  R600GetCardPos = lib.func('uint32 __stdcall R600GetCardPos(_Out_ int *)');
  R600GetErrorOuterInfo = lib.func('uint32 __stdcall R600GetErrorOuterInfo(uint32, _Out_ uint8 *, _Inout_ int *)');

  // 캔버스/드로잉/출력
  R600SetCanvasPortrait = lib.func('uint32 __stdcall R600SetCanvasPortrait(int)');
  R600PrepareCanvas = lib.func('uint32 __stdcall R600PrepareCanvas(int, int)');
  R600DrawImage = lib.func('uint32 __stdcall R600DrawImage(double, double, double, double, str, int)');
  R600SetImagePara = lib.func('uint32 __stdcall R600SetImagePara(int, int, float)');
  R600CommitCanvas = lib.func('uint32 __stdcall R600CommitCanvas(_Out_ uint8 *, _Inout_ int *)');
  R600ClearCanvas = lib.func('uint32 __stdcall R600ClearCanvas()');
  R600PrintDraw = lib.func('uint32 __stdcall R600PrintDraw(_In_ uint8 *, _In_ uint8 *)');
  R600CardInject = lib.func('uint32 __stdcall R600CardInject(uint8)');
  R600CardEject = lib.func('uint32 __stdcall R600CardEject(uint8)');
  R600SetRibbonOpt = lib.func('uint32 __stdcall R600SetRibbonOpt(uint8, uint32, str, uint32)');
  R600SetCoatRgn = lib.func('uint32 __stdcall R600SetCoatRgn(double, double, double, double, uint8, uint8)');
  R600DrawLayerWhite = lib.func('uint32 __stdcall R600DrawLayerWhite(double, double, double, double, str)');
  R600SetAddImageMode = lib.func('uint32 __stdcall R600SetAddImageMode(int, int)');
  R600SetLayerWhiteThreshold = lib.func('uint32 __stdcall R600SetLayerWhiteThreshold(int)');
  R600DrawLayerFluor = lib.func('uint32 __stdcall R600DrawLayerFluor(double, double, double, double, str)');
  R600SetLayerFluorThreshold = lib.func('uint32 __stdcall R600SetLayerFluorThreshold(int)');
  R600DrawWaterMark = lib.func('uint32 __stdcall R600DrawWaterMark(double, double, double, double, str)');
  R600SetWaterMarkThreshold = lib.func('uint32 __stdcall R600SetWaterMarkThreshold(int)');
  R600SetAddImageMode_Rtai = lib.func('uint32 __stdcall R600SetAddImageMode_Rtai(int, bool, bool, str, int)');
  R600SetYmcRgn = lib.func('uint32 __stdcall R600SetYmcRgn(double, double, double, double, uint8, uint8, uint8)');
  R600SetKRgn = lib.func('uint32 __stdcall R600SetKRgn(double, double, double, double, uint8, uint8)');
}

function r600GetErrorMsg(code) {
  try {
    const buf = Buffer.alloc(512);
    const lenBuf = [512];
    R600GetErrorOuterInfo(code, buf, lenBuf);
    return buf.toString('utf8', 0, lenBuf[0]).replace(/\0/g, '').trim() || `에러코드 ${code}`;
  } catch {
    return `에러코드 ${code}`;
  }
}

function r600Connect() {
  if (r600Initialized && r600SelectedPrinter) return true;

  // SDK 초기화
  if (!r600Initialized) {
    const initRet = R600LibInit();
    if (initRet !== 0) {
      throw new Error(`SDK 초기화 실패: ${r600GetErrorMsg(initRet)}`);
    }
    r600Initialized = true;
  }

  // USB 프린터 열거
  const enumBuf = Buffer.alloc(256);
  const enumLen = [256];
  const numBuf = [0];
  const enumRet = R600EnumUsbPrt(enumBuf, enumLen, numBuf);
  if (enumRet !== 0) {
    throw new Error(`프린터 열거 실패: ${r600GetErrorMsg(enumRet)}`);
  }
  if (numBuf[0] === 0) {
    throw new Error('USB 프린터를 찾을 수 없음');
  }

  // 첫 번째 프린터 이름 추출 (\\n으로 구분)
  const enumStr = enumBuf.toString('utf8', 0, enumLen[0]).replace(/\0/g, '');
  const printerName = enumStr.split('\n')[0].trim();
  if (!printerName) {
    throw new Error('프린터 이름 파싱 실패');
  }

  // USB 타임아웃 설정
  R600UsbSetTimeout(5000, 5000);

  // 프린터 선택
  const selRet = R600SelectPrt(printerName);
  if (selRet !== 0) {
    throw new Error(`프린터 선택 실패: ${r600GetErrorMsg(selRet)}`);
  }

  r600SelectedPrinter = printerName;
  return true;
}

async function handleR600(cmd) {
  // 오버레이 출력 명령
  if (cmd.action === 'overlay-print') {
    return await handleR600OverlayPrint(cmd);
  }

  // 기본: 상태 조회
  try {
    r600Connect();
  } catch (err) {
    return { success: false, error: err.message };
  }

  // 프린터 상태 조회
  let statusInfo;
  try {
    const chassisTemp = [0], headTemp = [0], heaterTemp = [0];
    const mainStatus = [0], subStatus = [0], errorStatus = [0], warningStatus = [0];
    const mainCode = [0], subCode = [0];
    const ret = R600QueryPrtStatus(chassisTemp, headTemp, heaterTemp, mainStatus, subStatus, errorStatus, warningStatus, mainCode, subCode);
    if (ret !== 0) {
      statusInfo = { success: false, error: r600GetErrorMsg(ret) };
    } else {
      // errorStatus 3001 = 정상
      let key = 'ready', label = '정상 (대기)';
      if (errorStatus[0] !== 3001) {
        key = 'error';
        label = `프린터 에러 (에러상태: ${errorStatus[0]}, 메인: ${mainCode[0]}, 서브: ${subCode[0]})`;
      } else if (mainStatus[0] !== 0) {
        key = 'printing';
        label = `동작 중 (메인상태: ${mainStatus[0]})`;
      }
      statusInfo = {
        success: true,
        key,
        label,
        chassisTemp: chassisTemp[0] / 100,
        headTemp: headTemp[0] / 100,
        heaterTemp: heaterTemp[0] / 100,
        mainStatus: mainStatus[0],
        subStatus: subStatus[0],
        errorStatus: errorStatus[0],
        warningStatus: warningStatus[0],
      };
    }
  } catch (err) {
    statusInfo = { success: false, error: err.message };
  }

  // 리본 잔량 조회
  let ribbonInfo;
  try {
    const rbnBuf = Buffer.alloc(4), filmBuf = Buffer.alloc(4);
    const ret = R600GetRbnAndFilmRemaining(rbnBuf, filmBuf);
    process.stderr.write(`[r600] ribbon raw: ret=${ret} rbn=[${rbnBuf.toString('hex')}] film=[${filmBuf.toString('hex')}]\n`);
    if (ret !== 0) {
      ribbonInfo = { success: false, error: r600GetErrorMsg(ret) };
    } else {
      const rbnRemain = rbnBuf.readUInt16LE(0);
      const filmRemain = filmBuf.readUInt16LE(0);
      // 리본 타입 조회
      let ribbonType = 0, filmType = 0;
      try {
        const rTypeBuf = Buffer.alloc(1), fTypeBuf = Buffer.alloc(1);
        const rNearEnd = Buffer.alloc(1), fNearEnd = Buffer.alloc(1);
        R600RibbonSettingsRW(0, rTypeBuf, fTypeBuf, rNearEnd, fNearEnd);
        ribbonType = rTypeBuf[0];
        filmType = fTypeBuf[0];
      } catch {}
      ribbonInfo = {
        success: true,
        ribbonRemainPercent: rbnRemain,
        filmRemainPercent: filmRemain,
        ribbonType,
        filmType,
        ribbonName: `리본 0x${ribbonType.toString(16).toUpperCase()}`,
      };
    }
  } catch (err) {
    ribbonInfo = { success: false, error: err.message };
  }

  // 출력 카운트 조회
  let printCountInfo;
  try {
    const headCount = [0], cardCount = [0], mainFW = [0], subFW = [0], fpga = [0];
    const ret = R600GetPrtInfo(headCount, cardCount, mainFW, subFW, fpga);
    if (ret !== 0) {
      printCountInfo = { success: false, error: r600GetErrorMsg(ret) };
    } else {
      printCountInfo = {
        success: true,
        printCount: cardCount[0],
        headPrintCount: headCount[0],
      };
    }
  } catch (err) {
    printCountInfo = { success: false, error: err.message };
  }

  // 카드 피더 상태
  let feederInfo;
  try {
    const flag = [0];
    R600IsFeederNoEmpty(flag);
    feederInfo = { hasCard: flag[0] === 1 };
  } catch {
    feederInfo = { hasCard: null };
  }

  return {
    success: true,
    status: statusInfo,
    ribbon: ribbonInfo,
    printCount: printCountInfo,
    feeder: feederInfo,
    printerName: r600SelectedPrinter,
  };
}

// 흰색/근사 흰색 픽셀 → 투명으로 변환한 PNG 생성
async function makeWhiteTransparent(inputPath, threshold = 240) {
  const ext = path.extname(inputPath).toLowerCase();
  const outPath = path.join(os.tmpdir(), `r600_alpha_${Date.now()}.png`);

  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // RGBA 버퍼: 흰색(R,G,B 모두 threshold 이상)이면 alpha=0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
      data[i + 3] = 0; // alpha = 투명
    }
  }

  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outPath);

  return outPath;
}

// 오버레이 출력 처리
async function handleR600OverlayPrint(cmd) {
  const log = (msg) => process.stderr.write(`[r600-overlay] ${msg}\n`);
  const progress = (detail) => process.stdout.write(JSON.stringify({ type: 'progress', detail }) + '\n');

  progress('프린터 연결 중...');
  try { r600Connect(); } catch (err) { return { success: false, error: err.message }; }

  const { overlayImagePath, threshold = 220, backImagePath } = cmd;
  if (!overlayImagePath) return { success: false, error: '이미지 경로가 필요합니다' };
  log(`threshold: ${threshold}, 양면: ${!!backImagePath}`);

  // 한글 경로 대응
  let tempFiles = [];
  function safePath(filePath, tag) {
    if (/[^\x00-\x7F]/.test(filePath)) {
      const ext = path.extname(filePath);
      const tmp = path.join(os.tmpdir(), `r600_${tag}_${Date.now()}${ext}`);
      fs.copyFileSync(filePath, tmp);
      tempFiles.push(tmp);
      return tmp;
    }
    return filePath;
  }
  const imgPath = safePath(overlayImagePath, 'front');
  const backPath = backImagePath ? safePath(backImagePath, 'back') : null;
  log(`앞면: ${imgPath}${backPath ? `, 뒷면: ${backPath}` : ''}`);

  try {
    progress('프린터 상태 확인 중...');
    const cardPos = [0];
    R600GetCardPos(cardPos);
    if (cardPos[0] !== 0) R600CardEject(0);

    const errStatus = [0];
    R600QueryPrtStatus(null, null, null, null, null, errStatus, null, null, null);
    if (errStatus[0] !== 3001) return { success: false, error: `프린터 에러 (${errStatus[0]})` };

    const feederFlag = [0];
    R600IsFeederNoEmpty(feederFlag);
    if (feederFlag[0] === 0) return { success: false, error: '카드 피더 비어있음' };

    progress('앞면 이미지 준비 중...');

    let ret = R600SetRibbonOpt(1, 0, '2', 2);
    log(`RibbonOpt: ${ret}`);

    // 세로 캔버스
    R600SetCanvasPortrait(1);

    ret = R600PrepareCanvas(0, 0);
    log(`PrepareCanvas: ${ret}`);
    if (ret !== 0) return { success: false, error: `캔버스 준비 실패: ${r600GetErrorMsg(ret)}` };

    // === 오버레이 마스크 생성 (살구색 등 밝은 피부톤 보호) ===
    const sharp = require('sharp');

    // RGB 채널 모두 threshold 이상인 픽셀만 흰색으로 처리한 마스크 생성
    progress('오버레이 마스크 생성 중...');
    const maskPath = imgPath.replace(/(\.\w+)$/, '_mask$1');
    tempFiles.push(maskPath);

    const { data: rawPixels, info } = await sharp(imgPath)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const maskPixels = Buffer.alloc(rawPixels.length);
    const channels = info.channels;
    for (let i = 0; i < rawPixels.length; i += channels) {
      const r = rawPixels[i], g = rawPixels[i + 1], b = rawPixels[i + 2];
      // 진짜 흰색: R, G, B 모두 threshold 이상 + 채도가 낮음 (색차 작음)
      const minCh = Math.min(r, g, b);
      const maxCh = Math.max(r, g, b);
      const isWhite = minCh >= threshold && (maxCh - minCh) < 40;
      const val = isWhite ? 255 : 0;
      maskPixels[i] = val;
      maskPixels[i + 1] = val;
      maskPixels[i + 2] = val;
      if (channels === 4) maskPixels[i + 3] = rawPixels[i + 3]; // alpha 유지
    }

    await sharp(maskPixels, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .toFile(maskPath);
    log(`오버레이 마스크 생성 완료: ${maskPath} (threshold=${threshold}, 채도제한=40)`);

    // === 데모 로그와 동일한 순서 ===

    // 1) SetAddImageMode_Rtai (None 모드 = 기본)
    ret = R600SetAddImageMode_Rtai(0, true, true, maskPath, threshold);
    log(`SetAddImageMode_Rtai(1): ${ret}`);

    // 2) 컬러 이미지 (YMC) — 세로 54 x 86
    ret = R600DrawImage(-0.5, -0.5, 55, 87, imgPath, 1);
    log(`DrawImage: ${ret}`);
    if (ret !== 0) { R600ClearCanvas(); return { success: false, error: `이미지 실패: ${r600GetErrorMsg(ret)}` }; }

    // 3) SetAddImageMode_Rtai (두 번째 - F/S/W 처리용, 마스크 사용)
    ret = R600SetAddImageMode_Rtai(0, true, true, maskPath, threshold);
    log(`SetAddImageMode_Rtai(2): ${ret}`);

    // 4) F/S/W 마스크를 WaterMark로 그리기
    ret = R600DrawWaterMark(-0.5, -0.5, 55, 87, maskPath);
    log(`DrawWaterMark: ${ret}`);
    if (ret !== 0) { R600ClearCanvas(); return { success: false, error: `WaterMark 실패: ${r600GetErrorMsg(ret)}` }; }

    // 5) SetAddImageMode_Rtai (세 번째)
    ret = R600SetAddImageMode_Rtai(0, true, true, maskPath, threshold);
    log(`SetAddImageMode_Rtai(3): ${ret}`);

    // 앞면 캔버스 커밋
    const frontBuf = Buffer.alloc(512);
    const frontBufLen = [512];
    ret = R600CommitCanvas(frontBuf, frontBufLen);
    log(`CommitCanvas(front): ${ret}, len=${frontBufLen[0]}`);
    if (ret !== 0) return { success: false, error: `앞면 커밋 실패: ${r600GetErrorMsg(ret)}` };

    // 뒷면 처리 (180도 회전)
    let backBuf = null;
    if (backPath) {
      progress('뒷면 이미지 준비 중 (180도 회전)...');

      // 뒷면 이미지 180도 회전
      const sharp = require('sharp');
      const rotatedBackPath = backPath.replace(/(\.\w+)$/, '_rotated$1');
      await sharp(backPath).rotate(180).toFile(rotatedBackPath);
      tempFiles.push(rotatedBackPath);
      log(`뒷면 180도 회전 완료: ${rotatedBackPath}`);

      R600SetCanvasPortrait(1);
      ret = R600PrepareCanvas(0, 0);
      log(`PrepareCanvas(back): ${ret}`);
      if (ret !== 0) return { success: false, error: `뒷면 캔버스 준비 실패: ${r600GetErrorMsg(ret)}` };

      ret = R600SetAddImageMode_Rtai(0, true, true, null, threshold);
      ret = R600DrawImage(0, 0, 54, 86, rotatedBackPath, 1);
      log(`DrawImage(back): ${ret}`);
      if (ret !== 0) { R600ClearCanvas(); return { success: false, error: `뒷면 이미지 실패: ${r600GetErrorMsg(ret)}` }; }

      ret = R600SetAddImageMode_Rtai(0, true, true, null, threshold);
      ret = R600DrawWaterMark(-0.5, -0.5, 55, 87, rotatedBackPath);
      log(`DrawWaterMark(back): ${ret}`);
      if (ret !== 0) { R600ClearCanvas(); return { success: false, error: `뒷면 WaterMark 실패: ${r600GetErrorMsg(ret)}` }; }

      ret = R600SetAddImageMode_Rtai(0, true, true, null, threshold);

      backBuf = Buffer.alloc(512);
      const backBufLen = [512];
      ret = R600CommitCanvas(backBuf, backBufLen);
      log(`CommitCanvas(back): ${ret}, len=${backBufLen[0]}`);
      if (ret !== 0) return { success: false, error: `뒷면 커밋 실패: ${r600GetErrorMsg(ret)}` };
    }

    progress('카드 투입 중...');
    ret = R600CardInject(0);
    log(`CardInject: ${ret}`);
    if (ret !== 0) return { success: false, error: `카드 투입 실패: ${r600GetErrorMsg(ret)}` };

    progress('출력 중...');
    ret = R600PrintDraw(frontBuf, backBuf);
    log(`PrintDraw: ${ret} (${backBuf ? '양면' : '단면'})`);
    if (ret !== 0) { try { R600CardEject(0); } catch {} return { success: false, error: `출력 실패: ${r600GetErrorMsg(ret)}` }; }

    progress('카드 배출 중...');
    R600CardEject(0);

    progress('출력 완료');
    return { success: true, message: '오버레이 출력 완료' };
  } catch (err) {
    log(`에러: ${err.message}`);
    try { R600CardEject(0); } catch {}
    return { success: false, error: err.message };
  } finally {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
  }
}


// ===== Init =====
try {
  if (SDK_TYPE === 'hiti') initHiti();
  else if (SDK_TYPE === 'r600') initR600();
  else { process.stderr.write('Usage: node sdkWorker.js [hiti|r600]\n'); process.exit(1); }
} catch (err) {
  process.stderr.write(`[${SDK_TYPE}] Init failed: ${err.message}\n`);
  process.exit(1);
}

// R600 종료 시 정리
if (SDK_TYPE === 'r600') {
  process.on('exit', () => {
    try { if (r600Initialized) R600LibClear(); } catch {}
  });
}

// ===== stdin/stdout =====
process.stdin.setEncoding('utf8');
let inputBuf = '';
process.stdin.on('data', (chunk) => {
  inputBuf += chunk;
  let idx;
  while ((idx = inputBuf.indexOf('\n')) !== -1) {
    const line = inputBuf.slice(0, idx).trim();
    inputBuf = inputBuf.slice(idx + 1);
    if (!line) continue;
    (async () => {
      try {
        const cmd = JSON.parse(line);
        let result;
        try {
          result = SDK_TYPE === 'hiti' ? handleHiti(cmd.printerName) : await handleR600(cmd);
        } catch (err) { result = { success: false, error: err.message }; }
        process.stdout.write(JSON.stringify({ id: cmd.id, result }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({ id: null, result: { success: false, error: err.message } }) + '\n');
      }
    })();
  }
});

process.stderr.write(`[${SDK_TYPE} worker] Ready\n`);

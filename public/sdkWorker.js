const path = require('path');
const koffi = require('koffi');

const DLL_DIR = path.join(__dirname, '..', 'dll');
const SDK_TYPE = process.argv[2] || 'hiti'; // 'hiti' or 'smart'

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


// ===== Smart SDK =====
let SC_GetDeviceList = null;
let SC_OpenDevice2 = null;
let SC_CloseDevice = null;
let SC_GetStatus = null;
let SC_GetRibbonInfo = null;
let SC_GetRibbonRemain = null;
let SC_GetRibbonType = null;

// SMART-81 모션 비트 (M_ = 실제 동작 중)
const S81_MOTION_BITS = [
  [0x0000000000000001n, 'init', '초기화 중'],
  [0x0000000000000002n, 'card_in', '카드 삽입 중'],
  [0x0000000000000004n, 'card_move', '카드 이동 중'],
  [0x0000000000000010n, 'card_out', '카드 배출 중'],
  [0x0000000000000020n, 'card_flip', '카드 뒤집기 중'],
  [0x0000000000000100n, 'printing', '출력 중'],
  [0x0000000000000400n, 'ribbon_search', '리본 탐색 중'],
  [0x0000000000000800n, 'ribbon_wind', '리본 감기 중'],
  [0x0000000002000000n, 'mag_rw', '마그네틱 읽기/쓰기 중'],
  [0x0800000000000000n, 'sbs_cmd', 'SBS 명령 실행 중'],
];
// SMART-81 상태 비트 (S_ = 경고/에러 상태)
const S81_STATE_BITS = [
  [0x0008000000000000n, 'cover_open', '커버 열림'],
  [0x0000400000000000n, 'hopper_empty', '호퍼 비어있음'],
  [0x0000200000000000n, 'hopper_near_empty', '호퍼 거의 비어있음'],
  [0x0000001000000000n, 'cardbin_full', '카드빈 가득 참'],
];

function initSmart() {
  const lib = koffi.load(path.join(DLL_DIR, 'SmartComm2.dll'));
  SC_GetDeviceList = lib.func('int SmartComm_GetDeviceList(_Out_ uint8 *, int)');
  SC_OpenDevice2 = lib.func('int SmartComm_OpenDevice2(_Out_ void **, str16, int)');
  SC_CloseDevice = lib.func('int SmartComm_CloseDevice(void *)');
  SC_GetStatus = lib.func('int SmartComm_GetStatus(void *, _Out_ uint8 *)');
  SC_GetRibbonInfo = lib.func('int SmartComm_GetRibbonInfo(void *, _Out_ int *, _Out_ int *, _Out_ int *, _Out_ int *)');
  SC_GetRibbonRemain = lib.func('int SmartComm_GetRibbonRemain(void *, _Out_ int *)');
  SC_GetRibbonType = lib.func('int SmartComm_GetRibbonType(void *, _Out_ int *)');
}

function getSmartDeviceId() {
  const buf = Buffer.alloc(4096);
  SC_GetDeviceList(buf, 4096);
  const count = buf.readUInt32LE(0);
  if (count === 0) return null;
  let pos = 4, end = pos;
  while (end < buf.length - 1 && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
  return buf.slice(pos, end).toString('utf16le');
}

function parseSmartStatus(statusBuf) {
  // SMART-81: ms(8bytes) + ef(8bytes)
  const ms = statusBuf.readBigUInt64LE(0);
  const ef = statusBuf.readBigUInt64LE(8);

  if (ef !== 0n) {
    return { key: 'error', label: `에러 (0x${ef.toString(16)})` };
  }

  // 경고 상태 체크 (커버 열림, 호퍼 비어있음 등)
  for (const [bit, key, label] of S81_STATE_BITS) {
    if (ms & bit) return { key, label };
  }

  // 모션 비트 체크 (실제 동작 중)
  for (const [bit, key, label] of S81_MOTION_BITS) {
    if (ms & bit) return { key, label };
  }

  return { key: 'ready', label: '정상 (대기)' };
}

function handleSmart() {
  const deviceId = getSmartDeviceId();
  if (!deviceId) {
    return { success: false, error: '프린터를 찾을 수 없음' };
  }

  const hBuf = [null];
  const ret = SC_OpenDevice2(hBuf, deviceId, 0); // BYID
  if (!hBuf[0]) {
    return { success: false, error: `연결 실패 (ret=${ret})` };
  }

  const handle = hBuf[0];
  try {
    // 상태
    const sBuf = Buffer.alloc(16);
    SC_GetStatus(handle, sBuf);
    const statusParsed = parseSmartStatus(sBuf);

    // 리본 정보
    const typeBuf = [0], maxBuf = [0], remainBuf = [0], gradeBuf = [0];
    SC_GetRibbonInfo(handle, typeBuf, maxBuf, remainBuf, gradeBuf);

    SC_CloseDevice(handle);

    return {
      success: true,
      status: { success: true, ...statusParsed },
      ribbon: {
        success: true,
        ribbonType: typeBuf[0],
        ribbonName: `타입 ${typeBuf[0]}`,
        remainCount: remainBuf[0],
        maxCount: maxBuf[0],
      },
      printCount: { success: true, printCount: maxBuf[0] - remainBuf[0] },
    };
  } catch (err) {
    try { SC_CloseDevice(handle); } catch {}
    return { success: false, error: err.message };
  }
}


// ===== Init =====
try {
  if (SDK_TYPE === 'hiti') initHiti();
  else if (SDK_TYPE === 'smart') initSmart();
  else { process.stderr.write('Usage: node sdkWorker.js [hiti|smart]\n'); process.exit(1); }
} catch (err) {
  process.stderr.write(`[${SDK_TYPE}] Init failed: ${err.message}\n`);
  process.exit(1);
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
    try {
      const cmd = JSON.parse(line);
      let result;
      try {
        result = SDK_TYPE === 'hiti' ? handleHiti(cmd.printerName) : handleSmart();
      } catch (err) { result = { success: false, error: err.message }; }
      process.stdout.write(JSON.stringify({ id: cmd.id, result }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ id: null, result: { success: false, error: err.message } }) + '\n');
    }
  }
});

process.stderr.write(`[${SDK_TYPE} worker] Ready\n`);

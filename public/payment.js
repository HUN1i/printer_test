const { SerialPort } = require('serialport');

/**
 * 나이스페이먼츠 NVC-1000 CAT 단말기 시리얼 통신 모듈
 *
 * 프로토콜: STX(1) + 전문데이터(가변) + ETX(1) + LRC(1)
 * 인코딩: EUC-KR (단말기 기본)
 * 통신: RS-232 시리얼 (USB-Serial)
 */

const STX = 0x02;
const ETX = 0x03;
const ACK = 0x06;
const FS = 0x1c;
const TIMEOUT_MS = 60000; // 카드 투입 대기 포함 60초

// 거래구분 코드
const TRAN_CODES = {
  CREDIT_APPROVAL: 'D1',   // 신용카드 승인
  CREDIT_CANCEL: 'D2',     // 신용카드 취소
  CASH_RECEIPT: 'E1',      // 현금영수증 승인
  CASH_RECEIPT_CANCEL: 'E2', // 현금영수증 취소
};

/**
 * LRC (Longitudinal Redundancy Check) 계산
 * STX 다음 바이트부터 ETX까지 XOR
 */
function calcLRC(buffer) {
  let lrc = 0;
  for (let i = 1; i < buffer.length; i++) {
    lrc ^= buffer[i];
  }
  return lrc;
}

/**
 * 오른쪽 정렬, 왼쪽 채움 문자열
 */
function padLeft(str, len, ch = ' ') {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : ch.repeat(len - s.length) + s;
}

/**
 * 왼쪽 정렬, 오른쪽 공백 채움
 */
function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

/**
 * 승인 요청 전문 생성 (FS 구분자 방식)
 *
 * NVC-1000 시리얼 전문 구조:
 * 거래구분 + FS + 금액 + FS + 세금 + FS + 봉사료 + FS + 할부 + FS + ...
 */
function buildApprovalRequest({ amount, tax = 0, tip = 0, installment = 0, taxFree = 0, merchantId = '', trackingNo = '' }) {
  const sep = String.fromCharCode(FS);
  const fields = [
    TRAN_CODES.CREDIT_APPROVAL,   // 거래구분
    String(amount),                // 금액
    String(tax),                   // 세금
    String(tip || ''),             // 봉사료
    padLeft(installment, 2, '0'), // 할부개월 (00: 일시불)
    String(taxFree || ''),         // 비과세
    merchantId || '',              // 가맹점번호
    trackingNo || generateTrackingNo(), // 전문관리번호
  ];

  const dataStr = fields.join(sep);
  return buildPacket(dataStr);
}

/**
 * 취소 요청 전문 생성 (FS 구분자 방식)
 */
function buildCancelRequest({ amount, tax = 0, tip = 0, taxFree = 0, merchantId = '', orgApprovalNo, orgApprovalDate, trackingNo = '' }) {
  const sep = String.fromCharCode(FS);
  const fields = [
    TRAN_CODES.CREDIT_CANCEL,     // 거래구분
    String(amount),                // 금액
    String(tax),                   // 세금
    String(tip || ''),             // 봉사료
    '00',                          // 할부개월
    String(taxFree || ''),         // 비과세
    merchantId || '',              // 가맹점번호
    trackingNo || generateTrackingNo(), // 전문관리번호
    orgApprovalNo || '',           // 원거래 승인번호
    orgApprovalDate || '',         // 원거래 승인일자
  ];

  const dataStr = fields.join(sep);
  return buildPacket(dataStr);
}

/**
 * STX + Data + ETX + LRC 패킷 생성
 */
function buildPacket(dataStr) {
  const dataBuf = Buffer.from(dataStr, 'ascii');
  const packet = Buffer.alloc(dataBuf.length + 3); // STX(1) + data + ETX(1) + LRC(1)

  packet[0] = STX;
  dataBuf.copy(packet, 1);
  packet[packet.length - 2] = ETX;

  // LRC: STX 제외, 데이터+ETX를 XOR
  const lrc = calcLRC(packet.slice(0, packet.length - 1));
  packet[packet.length - 1] = lrc;

  return packet;
}

/**
 * 전문관리번호 생성 (YYMMDD + 6자리 시퀀스)
 */
function generateTrackingNo() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = padLeft(now.getMonth() + 1, 2, '0');
  const dd = padLeft(now.getDate(), 2, '0');
  const seq = padLeft(Math.floor(Math.random() * 999999), 6, '0');
  return `${yy}${mm}${dd}${seq}`;
}

/**
 * 응답 전문 파싱
 *
 * NVC-1000 시리얼 응답 구조:
 * - 먼저 ACK 패킷 (02 06 03) 수신
 * - 이후 실제 응답: STX + FS(0x1C) 구분 필드들 + ETX + LRC
 *
 * FS 구분 필드 순서:
 * [0] 거래구분 (D1/D2 등)
 * [1] 응답구분
 * [2] 응답메시지 (EUC-KR)
 * [3] 거래일시 (YYMMDDHHmmss)
 * [4] 금액
 * [5] 세금
 * [6] 봉사료
 * [7] 할부개월
 * [8] 응답코드 (0000=성공)
 * [9] 승인번호
 * [10] 카드사명/매입사명 (EUC-KR)
 * [11] 카드번호
 * [12] 발급사명
 * [13] (예비)
 * [14] 할부개월
 * [15] IC구분
 * [16] 거래번호
 * [17] 가맹점번호(TID)
 */
function parseResponse(buffer) {
  // ACK 패킷 건너뛰기 - 실제 응답 데이터만 추출
  let dataBuffer = buffer;

  // ACK 패킷(02 06 03)이 앞에 있으면 건너뛴다
  if (dataBuffer.length >= 3 && dataBuffer[0] === STX && dataBuffer[1] === ACK && dataBuffer[2] === ETX) {
    dataBuffer = dataBuffer.slice(3);
  }

  if (dataBuffer.length === 0 || dataBuffer[0] !== STX) {
    return { success: false, error: 'STX 없음 - 잘못된 응답' };
  }

  const etxIdx = dataBuffer.indexOf(ETX, 1);
  if (etxIdx === -1) {
    return { success: false, error: 'ETX 없음 - 불완전한 응답' };
  }

  // LRC 검증
  if (dataBuffer.length > etxIdx + 1) {
    const receivedLRC = dataBuffer[etxIdx + 1];
    const calculatedLRC = calcLRC(dataBuffer.slice(0, etxIdx + 1));
    if (receivedLRC !== calculatedLRC) {
      console.warn('LRC 불일치 - 수신:', receivedLRC, '계산:', calculatedLRC);
    }
  }

  // STX와 ETX 사이 데이터를 FS(0x1C)로 분할
  const rawData = dataBuffer.slice(1, etxIdx);
  const fields = [];
  let start = 0;
  for (let i = 0; i < rawData.length; i++) {
    if (rawData[i] === FS) {
      fields.push(rawData.slice(start, i));
      start = i + 1;
    }
  }
  fields.push(rawData.slice(start)); // 마지막 필드

  // EUC-KR 디코딩 헬퍼 (바이너리 → 문자열)
  const toStr = (buf) => {
    try {
      // EUC-KR 한글이 포함된 필드
      const decoder = new TextDecoder('euc-kr');
      return decoder.decode(buf).trim();
    } catch {
      return buf.toString('ascii').trim();
    }
  };

  const toAscii = (buf) => buf.toString('ascii').trim();

  try {
    const f = (i) => fields[i] || Buffer.alloc(0);
    const responseType = toAscii(f(1)); // A=승인, B=거절

    const result = {
      tranCode: toAscii(f(0)),          // 거래구분 (D1/D2)
      responseType,                      // A=승인, B=거절
      replyMessage: toStr(f(2)),         // 응답메시지 (정상승인, 거래금액오류 등)
      approvalDateTime: toAscii(f(3)),   // 거래일시 (YYMMDDHHmmss)
      amount: toAscii(f(4)),             // 금액
      tax: toAscii(f(5)),                // 세금
      tip: toAscii(f(6)),                // 봉사료
      approvalNo: toAscii(f(7)),         // 승인번호
      responseCode: toAscii(f(8)),       // 응답코드
      responseCode2: toAscii(f(9)),      // 응답코드2
      acquirerName: toStr(f(10)),        // 매입사명
      issuerName: toStr(f(11)),          // 발급사명
      merchantNo: toAscii(f(12)),        // 가맹점번호
      cardNo: toAscii(f(13)),            // 카드번호 (마스킹)
      installment: toAscii(f(14)),       // 할부개월
      icType: toAscii(f(15)),            // IC구분
      tranNo: toAscii(f(16)),            // 거래번호
      merchantId: toAscii(f(17)),        // 단말기번호 (TID)
      vanKey: toAscii(f(18)),            // VanKey (취소용)
    };

    // 응답구분으로 성공 여부 판단: A=승인 성공
    result.success = responseType === 'A';
    result.message = result.success ? '승인 완료' : `거절 (코드: ${result.responseCode}) ${result.replyMessage}`;

    console.log('[NVC-1000] 필드 수:', fields.length);
    fields.forEach((f, i) => {
      console.log(`[NVC-1000] 필드[${i}]:`, toStr(f), `(hex: ${f.toString('hex')})`);
    });

    return result;
  } catch (err) {
    return {
      success: false,
      error: '응답 파싱 실패: ' + err.message,
      rawHex: rawData.toString('hex'),
    };
  }
}

/**
 * NVC-1000 단말기와 시리얼 통신
 */
function sendToTerminal(comPort, baudRate, packet) {
  return new Promise((resolve, reject) => {
    let responseBuffer = Buffer.alloc(0);
    let resolved = false;

    const port = new SerialPort({
      path: comPort,
      baudRate: baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        port.close();
        reject(new Error('단말기 응답 시간 초과 (60초)'));
      }
    }, TIMEOUT_MS);

    port.open((err) => {
      if (err) {
        clearTimeout(timer);
        reject(new Error('시리얼 포트 열기 실패: ' + err.message));
        return;
      }

      console.log(`[NVC-1000] 시리얼 연결 성공 ${comPort} (${baudRate}bps)`);
      console.log('[NVC-1000] 송신 패킷 (hex):', packet.toString('hex'));
      console.log('[NVC-1000] 송신 패킷 (ascii):', packet.toString('ascii').replace(/[\x00-\x1f]/g, '.'));
      port.write(packet);
      console.log('[NVC-1000] 전문 전송 완료, 응답 대기 중...');
    });

    port.on('data', (data) => {
      console.log('[NVC-1000] 수신 데이터 (hex):', data.toString('hex'));
      responseBuffer = Buffer.concat([responseBuffer, data]);

      // ACK 패킷(02 06 03) 만 받은 상태면 계속 대기
      if (responseBuffer.length === 3 && responseBuffer[0] === STX && responseBuffer[1] === ACK && responseBuffer[2] === ETX) {
        console.log('[NVC-1000] ACK 수신, 실제 응답 대기 중...');
        return;
      }

      // ACK 이후 실제 응답에서 ETX를 찾으면 완료
      const searchStart = (responseBuffer.length > 3 && responseBuffer[0] === STX && responseBuffer[1] === ACK) ? 4 : 1;
      const etxIdx = responseBuffer.indexOf(ETX, searchStart);
      if (etxIdx !== -1 && responseBuffer.length >= etxIdx + 2) {
        clearTimeout(timer);
        resolved = true;
        console.log('[NVC-1000] 전체 응답 수신 완료, 길이:', responseBuffer.length);
        const result = parseResponse(responseBuffer);
        console.log('[NVC-1000] 파싱 결과:', JSON.stringify(result, null, 2));
        port.close();
        resolve(result);
      }
    });

    port.on('error', (err) => {
      console.error('[NVC-1000] 시리얼 오류:', err.message);
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    port.on('close', () => {
      console.log('[NVC-1000] 시리얼 포트 닫힘, 수신바이트:', responseBuffer.length);
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        if (responseBuffer.length > 0) {
          const result = parseResponse(responseBuffer);
          console.log('[NVC-1000] 종료 시 파싱 결과:', JSON.stringify(result, null, 2));
          resolve(result);
        } else {
          reject(new Error('단말기 연결 종료 (응답 없음)'));
        }
      }
    });
  });
}

/**
 * 결제 승인 요청
 */
async function requestPayment(comPort, baudRate, { amount, tax, tip, installment, taxFree, merchantId }) {
  const packet = buildApprovalRequest({ amount, tax, tip, installment, taxFree, merchantId });
  console.log('[NVC-1000] 승인 요청 -', { amount, installment: installment || '일시불' });
  return sendToTerminal(comPort, baudRate, packet);
}

/**
 * 결제 취소 요청
 */
async function requestCancel(comPort, baudRate, { amount, tax, tip, taxFree, merchantId, orgApprovalNo, orgApprovalDate }) {
  const packet = buildCancelRequest({ amount, tax, tip, taxFree, merchantId, orgApprovalNo, orgApprovalDate });
  console.log('[NVC-1000] 취소 요청 -', { amount, orgApprovalNo });
  return sendToTerminal(comPort, baudRate, packet);
}

/**
 * 단말기 연결 테스트 (시리얼 포트 열기 확인)
 */
function testConnection(comPort, baudRate) {
  return new Promise((resolve) => {
    const port = new SerialPort({
      path: comPort,
      baudRate: baudRate,
      autoOpen: false,
    });

    const timer = setTimeout(() => {
      port.close();
      resolve({ success: false, error: '연결 시간 초과' });
    }, 5000);

    port.open((err) => {
      clearTimeout(timer);
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        port.close();
        resolve({ success: true, message: `${comPort} (${baudRate}bps) 연결 성공` });
      }
    });
  });
}

module.exports = {
  requestPayment,
  requestCancel,
  testConnection,
  TRAN_CODES,
};

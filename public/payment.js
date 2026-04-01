const net = require('net');

/**
 * 나이스페이먼츠 NVC-1000 CAT 단말기 TCP 통신 모듈
 *
 * 프로토콜: STX(1) + 전문데이터(가변) + ETX(1) + LRC(1)
 * 인코딩: EUC-KR (단말기 기본)
 */

const STX = 0x02;
const ETX = 0x03;
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
 * 승인 요청 전문 생성
 *
 * NVC-1000 기본 전문 구조 (나이스 연동규격 기준):
 * - 거래구분(2) + 금액(12) + 세금(12) + 봉사료(12) + 할부(2) + 비과세(12)
 *   + 가맹점번호(15) + 전문관리번호(12) + 추가데이터(가변)
 */
function buildApprovalRequest({ amount, tax = 0, tip = 0, installment = 0, taxFree = 0, merchantId = '', trackingNo = '' }) {
  const fields = [
    TRAN_CODES.CREDIT_APPROVAL,                // 거래구분 (2)
    padLeft(amount, 12, '0'),                  // 금액 (12)
    padLeft(tax, 12, '0'),                     // 세금 (12)
    padLeft(tip, 12, '0'),                     // 봉사료 (12)
    padLeft(installment, 2, '0'),              // 할부개월 (2) - 00: 일시불
    padLeft(taxFree, 12, '0'),                 // 비과세 (12)
    padRight(merchantId, 15),                  // 가맹점번호 (15)
    padRight(trackingNo || generateTrackingNo(), 12), // 전문관리번호 (12)
  ];

  const dataStr = fields.join('');
  return buildPacket(dataStr);
}

/**
 * 취소 요청 전문 생성
 */
function buildCancelRequest({ amount, tax = 0, tip = 0, taxFree = 0, merchantId = '', orgApprovalNo, orgApprovalDate, trackingNo = '' }) {
  const fields = [
    TRAN_CODES.CREDIT_CANCEL,                  // 거래구분 (2)
    padLeft(amount, 12, '0'),                  // 금액 (12)
    padLeft(tax, 12, '0'),                     // 세금 (12)
    padLeft(tip, 12, '0'),                     // 봉사료 (12)
    padLeft(0, 2, '0'),                        // 할부개월 (2)
    padLeft(taxFree, 12, '0'),                 // 비과세 (12)
    padRight(merchantId, 15),                  // 가맹점번호 (15)
    padRight(trackingNo || generateTrackingNo(), 12), // 전문관리번호 (12)
    padRight(orgApprovalNo || '', 12),         // 원거래 승인번호 (12)
    padRight(orgApprovalDate || '', 8),        // 원거래 승인일자 (8) YYYYMMDD
  ];

  const dataStr = fields.join('');
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
 * 응답 구조 (일반적):
 * - 응답코드(4) + 거래구분(2) + 승인번호(12) + 승인일시(14) + 가맹점번호(15)
 *   + 카드번호(20) + 매입사명(20) + 발급사명(20) + 금액(12) + ...
 */
function parseResponse(buffer) {
  // STX/ETX/LRC 제거 후 데이터 추출
  if (buffer[0] !== STX) {
    return { success: false, error: 'STX 없음 - 잘못된 응답' };
  }

  const etxIdx = buffer.indexOf(ETX, 1);
  if (etxIdx === -1) {
    return { success: false, error: 'ETX 없음 - 불완전한 응답' };
  }

  const data = buffer.slice(1, etxIdx).toString('ascii');

  // LRC 검증
  if (buffer.length > etxIdx + 1) {
    const receivedLRC = buffer[etxIdx + 1];
    const calculatedLRC = calcLRC(buffer.slice(0, etxIdx + 1));
    if (receivedLRC !== calculatedLRC) {
      console.warn('LRC 불일치 - 수신:', receivedLRC, '계산:', calculatedLRC);
    }
  }

  let pos = 0;
  const read = (len) => {
    const val = data.slice(pos, pos + len).trim();
    pos += len;
    return val;
  };

  try {
    const result = {
      responseCode: read(4),      // 응답코드 (0000: 정상)
      tranCode: read(2),          // 거래구분
      approvalNo: read(12),       // 승인번호
      approvalDateTime: read(14), // 승인일시 (YYYYMMDDHHmmss)
      merchantId: read(15),       // 가맹점번호
      cardNo: read(20),           // 카드번호 (마스킹됨)
      acquirerName: read(20),     // 매입사명
      issuerName: read(20),       // 발급사명
      amount: read(12),           // 금액
    };

    result.success = result.responseCode === '0000';
    result.message = result.success ? '승인 완료' : `거절 (코드: ${result.responseCode})`;

    // 나머지 데이터가 있으면 추가 정보로 저장
    if (pos < data.length) {
      result.extra = data.slice(pos);
    }

    return result;
  } catch (err) {
    return {
      success: false,
      error: '응답 파싱 실패',
      rawData: data,
    };
  }
}

/**
 * NVC-1000 단말기와 TCP 통신
 */
function sendToTerminal(host, port, packet) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let responseBuffer = Buffer.alloc(0);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(new Error('단말기 응답 시간 초과 (60초)'));
      }
    }, TIMEOUT_MS);

    client.connect(port, host, () => {
      console.log(`[NVC-1000] 연결 성공 ${host}:${port}`);
      console.log('[NVC-1000] 송신 패킷 (hex):', packet.toString('hex'));
      console.log('[NVC-1000] 송신 패킷 (ascii):', packet.toString('ascii').replace(/[\x00-\x1f]/g, '.'));
      client.write(packet);
      console.log('[NVC-1000] 전문 전송 완료, 응답 대기 중...');
    });

    client.on('data', (data) => {
      console.log('[NVC-1000] 수신 데이터 (hex):', data.toString('hex'));
      console.log('[NVC-1000] 수신 데이터 (ascii):', data.toString('ascii').replace(/[\x00-\x1f]/g, '.'));
      responseBuffer = Buffer.concat([responseBuffer, data]);

      // ETX를 찾으면 응답 완료로 판단
      const etxIdx = responseBuffer.indexOf(ETX, 1);
      if (etxIdx !== -1 && responseBuffer.length >= etxIdx + 2) {
        clearTimeout(timer);
        resolved = true;
        console.log('[NVC-1000] 전체 응답 수신 완료, 길이:', responseBuffer.length);
        const result = parseResponse(responseBuffer);
        console.log('[NVC-1000] 파싱 결과:', JSON.stringify(result, null, 2));
        client.destroy();
        resolve(result);
      }
    });

    client.on('error', (err) => {
      console.error('[NVC-1000] 소켓 오류:', err.code, err.message);
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    client.on('close', (hadError) => {
      console.log('[NVC-1000] 연결 종료 (에러여부:', hadError, ', 수신바이트:', responseBuffer.length, ')');
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
async function requestPayment(host, port, { amount, tax, tip, installment, taxFree, merchantId }) {
  const packet = buildApprovalRequest({ amount, tax, tip, installment, taxFree, merchantId });
  console.log('[NVC-1000] 승인 요청 -', { amount, installment: installment || '일시불' });
  return sendToTerminal(host, port, packet);
}

/**
 * 결제 취소 요청
 */
async function requestCancel(host, port, { amount, tax, tip, taxFree, merchantId, orgApprovalNo, orgApprovalDate }) {
  const packet = buildCancelRequest({ amount, tax, tip, taxFree, merchantId, orgApprovalNo, orgApprovalDate });
  console.log('[NVC-1000] 취소 요청 -', { amount, orgApprovalNo });
  return sendToTerminal(host, port, packet);
}

/**
 * 단말기 연결 테스트 (TCP 연결만 확인)
 */
function testConnection(host, port) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const timer = setTimeout(() => {
      client.destroy();
      resolve({ success: false, error: '연결 시간 초과' });
    }, 5000);

    client.connect(port, host, () => {
      clearTimeout(timer);
      client.destroy();
      resolve({ success: true, message: `${host}:${port} 연결 성공` });
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

module.exports = {
  requestPayment,
  requestCancel,
  testConnection,
  TRAN_CODES,
};

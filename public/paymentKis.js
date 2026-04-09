const WebSocket = require('ws');

/**
 * KIS정보통신 카드단말기 WebSocket CAT 통신 모듈
 *
 * KIS Agent가 로컬에서 실행 중이어야 함 (ws://localhost:1516)
 * 프로토콜: WebSocket + JSON
 */

const TIMEOUT_MS = 60000; // 카드 투입 대기 포함 60초

/**
 * 왼쪽 채움
 */
function padLeft(str, len, ch = '0') {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : ch.repeat(len - s.length) + s;
}

/**
 * KIS 응답을 NVC-1000과 동일한 형태로 정규화
 */
function normalizeResponse(res) {
  const success = res.outReplyCode === '0000';
  const authDate = res.outReplyDate || '';

  return {
    success,
    responseCode: res.outReplyCode || '',
    approvalNo: res.outAuthNo || '',
    
    approvalDateTime: authDate,
    cardNo: res.outCardNo || '',
    acquirerName: res.outAccepterName || '',
    issuerName: res.outIssuerName || '',
    merchantId: res.outMerchantRegNo || '',
    amount: res.outTranAmt || '',
    message: success ? '승인 완료' : `거절 (코드: ${res.outReplyCode})`,
    replyMsg1: res.outReplyMsg1 || '',
    replyMsg2: res.outReplyMsg2 || '',
    vanKey: res.outVanKey || '',
    // 원본 응답 보존
    _raw: res,
  };
}

/**
 * KIS Agent에 WebSocket 요청 전송 및 응답 대기
 */
function sendToKisAgent(wsPort, endpoint, message) {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${wsPort}/${endpoint}`;
    console.log(`[KIS] WebSocket 연결: ${url}`);

    const ws = new WebSocket(url);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('KIS Agent 응답 시간 초과 (60초)'));
      }
    }, TIMEOUT_MS);

    ws.on('open', () => {
      console.log('[KIS] WebSocket 연결 성공');
      const msgStr = JSON.stringify(message);
      console.log('[KIS] 송신:', msgStr);
      ws.send(msgStr);
      console.log('[KIS] 전문 전송 완료, 응답 대기 중...');
    });

    ws.on('message', (data) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const resStr = data.toString();
      console.log('[KIS] 수신:', resStr);

      try {
        const res = JSON.parse(resStr);
        const result = normalizeResponse(res);
        console.log('[KIS] 파싱 결과:', JSON.stringify(result, null, 2));
        ws.close();
        resolve(result);
      } catch (err) {
        ws.close();
        reject(new Error('KIS 응답 파싱 실패: ' + err.message));
      }
    });

    ws.on('error', (err) => {
      console.error('[KIS] WebSocket 오류:', err.message);
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ws.on('close', () => {
      console.log('[KIS] WebSocket 연결 종료');
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(new Error('KIS Agent 연결 종료 (응답 없음)'));
      }
    });
  });
}

/**
 * 결제 승인 요청
 */
async function requestPaymentKis(wsPort, endpoint, { amount, tax, installment }) {
  const message = {
    KIS_ICApproval: {
      inTranCode: 'UC',
      inTradeType: 'D1',
      inTranAmt: String(amount),
      inVatAmt: String(tax || 0),
      inSvcAmt: '',
      inInstallment: padLeft(installment || 0, 2),
      inOrgAuthDate: '',
      inOrgAuthNo: '',
      inUnitLockYN: 'Y',
      inUnitUIMode: '1',
      inCatTranGubun: '',
      inBlockPin: '',
    },
  };

  console.log('[KIS] 승인 요청 -', { amount, installment: installment || '일시불' });
  return sendToKisAgent(wsPort, endpoint, message);
}

/**
 * 결제 취소 요청
 */
async function requestCancelKis(wsPort, endpoint, { amount, tax, orgApprovalNo, orgApprovalDate }) {
  // 원거래일자: YYYYMMDD → YYMMDD 변환 (KIS 규격)
  let kisDate = orgApprovalDate || '';
  if (kisDate.length === 8) {
    kisDate = kisDate.substring(2);
  }

  const message = {
    KIS_ICApproval: {
      inTranCode: 'UC',
      inTradeType: 'D2',
      inTranAmt: String(amount),
      inVatAmt: String(tax || 0),
      inSvcAmt: '',
      inInstallment: '00',
      inOrgAuthDate: kisDate,
      inOrgAuthNo: orgApprovalNo || '',
      inUnitLockYN: 'Y',
      inUnitUIMode: '1',
      inCatTranGubun: '',
      inBlockPin: '',
    },
  };

  console.log('[KIS] 취소 요청 -', { amount, orgApprovalNo });
  return sendToKisAgent(wsPort, endpoint, message);
}

/**
 * KIS Agent 연결 테스트 (WebSocket 연결 가능 여부 확인)
 */
function testConnectionKis(wsPort, endpoint) {
  return new Promise((resolve) => {
    const url = `ws://localhost:${wsPort}/${endpoint}`;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: '연결 시간 초과' });
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve({ success: true, message: `KIS Agent (localhost:${wsPort}) 연결 성공` });
    });

    ws.on('error', (err) => {
      console.error('[KIS] 연결 테스트 오류:', err.code, err.message, err);
      clearTimeout(timer);
      resolve({ success: false, error: err.code + ': ' + err.message });
    });

    ws.on('close', (code, reason) => {
      console.log('[KIS] 연결 테스트 종료:', code, reason?.toString());
    });
  });
}

module.exports = {
  requestPaymentKis,
  requestCancelKis,
  testConnectionKis,
};

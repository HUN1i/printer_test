import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const PRINTER_CONFIG = {
  printer1: { label: 'PRINTER 1', name: 'HiTi P525T' },
  printer2: { label: 'PRINTER 2', name: 'Rtai LUCA-40KM' },
};

function App() {
  const [printers, setPrinters] = useState([]);
  const [files, setFiles] = useState({ printer1: null, printer2: null });
  const [filePaths, setFilePaths] = useState({ printer1: null, printer2: null });
  const [status, setStatus] = useState({ printer1: 'idle', printer2: 'idle' });
  const [messages, setMessages] = useState({ printer1: '', printer2: '' });
  const [progress, setProgress] = useState({ printer1: null, printer2: null });
  const [bothPrinting, setBothPrinting] = useState(false);
  const [hitiStatus, setHitiStatus] = useState(null); // HiTi SDK 상태
  const [r600Status, setR600Status] = useState(null); // Retransfer 600 SDK 상태 (카드 프린터)
  const [overlayPrinting, setOverlayPrinting] = useState(false);
  const [overlayResult, setOverlayResult] = useState(null);
  const [overlayProgress, setOverlayProgress] = useState(null);
  const [overlayThreshold, setOverlayThreshold] = useState(220);
  const [backFile, setBackFile] = useState(null); // 뒷면 파일명
  const [backFilePath, setBackFilePath] = useState(null); // 뒷면 파일 경로

  // 결제 상태
  const [terminalType, setTerminalType] = useState('nvc'); // 'nvc' | 'kis'
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentInstallment, setPaymentInstallment] = useState('0');
  const [paymentStatus, setPaymentStatus] = useState('idle'); // idle, connecting, processing, success, error
  const [paymentResult, setPaymentResult] = useState(null);
  const [paymentTerminalConnected, setPaymentTerminalConnected] = useState(null);
  // 취소용
  const [cancelApprovalNo, setCancelApprovalNo] = useState('');
  const [cancelApprovalDate, setCancelApprovalDate] = useState('');
  const [cancelAmount, setCancelAmount] = useState('');

  // 카메라 상태
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState('');
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraStatus, setCameraStatus] = useState('idle'); // idle, connecting, connected, error
  const [cameraError, setCameraError] = useState('');
  // 보정 필터
  const [filters, setFilters] = useState({
    brightness: 100,
    contrast: 100,
    saturation: 100,
    warmth: 0,
  });

  const videoRef = useRef(null);

  const isElectron = !!window.electronAPI;

  const handleProgress = useCallback((data) => {
    const { printerKey, status: pStatus, detail, totalPages, pagesPrinted } = data;

    if (pStatus === 'printing') {
      setStatus((prev) => ({ ...prev, [printerKey]: 'printing' }));
      setProgress((prev) => ({
        ...prev,
        [printerKey]: { detail, totalPages, pagesPrinted },
      }));
      const pageInfo = totalPages ? ` (${pagesPrinted}/${totalPages} 페이지)` : '';
      setMessages((prev) => ({
        ...prev,
        [printerKey]: `${detail}${pageInfo}`,
      }));
    } else if (pStatus === 'done') {
      setStatus((prev) => ({ ...prev, [printerKey]: 'success' }));
      setProgress((prev) => ({ ...prev, [printerKey]: null }));
      setMessages((prev) => ({ ...prev, [printerKey]: '프린터에서 출력이 완료되었습니다' }));
      setBothPrinting(false);
    } else if (pStatus === 'timeout') {
      setStatus((prev) => ({ ...prev, [printerKey]: 'warning' }));
      setProgress((prev) => ({ ...prev, [printerKey]: null }));
      setMessages((prev) => ({ ...prev, [printerKey]: detail }));
      setBothPrinting(false);
    }
  }, []);

  // HiTi SDK 상태 조회
  const fetchHitiStatus = useCallback(async () => {
    if (!isElectron || !window.electronAPI.getHitiStatus) return;
    try {
      const result = await window.electronAPI.getHitiStatus(PRINTER_CONFIG.printer1.name);
      setHitiStatus(result);
    } catch (err) {
      console.error('HiTi status fetch error:', err);
    }
  }, [isElectron]);

  // R600 SDK 상태 조회 (카드 프린터)
  const fetchR600Status = useCallback(async () => {
    if (!isElectron || !window.electronAPI.getR600Status) return;
    try {
      const result = await window.electronAPI.getR600Status();
      setR600Status(result);
    } catch (err) {
      console.error('R600 status fetch error:', err);
    }
  }, [isElectron]);

  // 뒷면 파일 선택
  const handleSelectBack = useCallback(async () => {
    if (!isElectron || !window.electronAPI.selectBackFile) return;
    const result = await window.electronAPI.selectBackFile();
    if (result.success) {
      setBackFile(result.fileName);
      setBackFilePath(result.filePath);
    }
  }, [isElectron]);

  // 오버레이 출력
  const handleOverlayPrint = useCallback(async () => {
    if (!isElectron || !window.electronAPI.r600OverlayPrint) return;
    if (!files.printer2) {
      alert('앞면 이미지를 먼저 선택하세요.');
      return;
    }
    setOverlayPrinting(true);
    setOverlayResult(null);
    setOverlayProgress('준비 중...');
    try {
      const result = await window.electronAPI.r600OverlayPrint(overlayThreshold, backFilePath);
      setOverlayResult(result);
    } catch (err) {
      setOverlayResult({ success: false, error: err.message });
    } finally {
      setOverlayPrinting(false);
      setOverlayProgress(null);
    }
  }, [isElectron, files.printer2, overlayThreshold, backFilePath]);

  useEffect(() => {
    if (isElectron) {
      window.electronAPI.getPrinters().then((result) => {
        if (result.success) {
          setPrinters(result.printers);
        }
      });
      window.electronAPI.onPrintProgress(handleProgress);
      if (window.electronAPI.onOverlayProgress) {
        window.electronAPI.onOverlayProgress((detail) => setOverlayProgress(detail));
      }

      // SDK 상태 최초 조회 + 10초 주기 폴링
      fetchHitiStatus();
      fetchR600Status();
      const hitiInterval = setInterval(fetchHitiStatus, 10000);
      const r600Interval = setInterval(fetchR600Status, 10000);

      return () => {
        window.electronAPI.removePrintProgress();
        if (window.electronAPI.removeOverlayProgress) window.electronAPI.removeOverlayProgress();
        clearInterval(hitiInterval);
        clearInterval(r600Interval);
      };
    }
  }, [isElectron, handleProgress, fetchHitiStatus, fetchR600Status]);

  const getStatusColor = (s) => {
    if (s === 'sending') return '#9b59b6';
    if (s === 'printing') return '#f0ad4e';
    if (s === 'success') return '#5cb85c';
    if (s === 'error') return '#d9534f';
    if (s === 'warning') return '#e67e22';
    return '#888';
  };

  const getStatusText = (s) => {
    if (s === 'sending') return '스풀러로 전송 중...';
    if (s === 'printing') return '프린터 출력 중...';
    if (s === 'success') return '출력 완료';
    if (s === 'error') return '출력 실패';
    if (s === 'warning') return '상태 확인 불가';
    return '대기';
  };

  const handleSelectFile = async (printerKey) => {
    if (!isElectron) return;
    const result = await window.electronAPI.selectFile(printerKey);
    if (result.success) {
      setFiles((prev) => ({ ...prev, [printerKey]: result.fileName }));
      setFilePaths((prev) => ({ ...prev, [printerKey]: result.filePath }));
      // 파일 선택하면 상태 초기화
      setStatus((prev) => ({ ...prev, [printerKey]: 'idle' }));
      setMessages((prev) => ({ ...prev, [printerKey]: '' }));
      setOverlayResult(null);
    }
  };

  const handlePrint = async (printerKey) => {
    if (!isElectron) {
      alert('Electron 환경에서만 프린터 직접 출력이 가능합니다.');
      return;
    }
    if (!files[printerKey]) {
      alert('먼저 출력할 파일을 선택하세요.');
      return;
    }

    setStatus((prev) => ({ ...prev, [printerKey]: 'sending' }));
    setMessages((prev) => ({ ...prev, [printerKey]: '프린트 스풀러로 전송 중...' }));
    setProgress((prev) => ({ ...prev, [printerKey]: null }));

    const result = await window.electronAPI.printFile(printerKey);

    if (result.success) {
      setStatus((prev) => ({ ...prev, [printerKey]: 'printing' }));
      setMessages((prev) => ({
        ...prev,
        [printerKey]: `${result.file} → ${result.printer} 전송 완료, 출력 대기 중...`,
      }));
    } else {
      setStatus((prev) => ({ ...prev, [printerKey]: 'error' }));
      setMessages((prev) => ({ ...prev, [printerKey]: result.error }));
    }
  };

  const handlePrintBoth = async () => {
    if (!isElectron) {
      alert('Electron 환경에서만 프린터 직접 출력이 가능합니다.');
      return;
    }
    if (!files.printer1 || !files.printer2) {
      alert('두 프린터 모두 출력할 파일을 선택하세요.');
      return;
    }

    setBothPrinting(true);
    setStatus({ printer1: 'sending', printer2: 'sending' });
    setMessages({ printer1: '프린트 스풀러로 전송 중...', printer2: '프린트 스풀러로 전송 중...' });
    setProgress({ printer1: null, printer2: null });

    const result = await window.electronAPI.printBoth();

    setStatus({
      printer1: result.printer1.success ? 'printing' : 'error',
      printer2: result.printer2.success ? 'printing' : 'error',
    });
    setMessages({
      printer1: result.printer1.success
        ? `${result.printer1.file} → ${result.printer1.printer} 전송 완료, 출력 대기 중...`
        : result.printer1.error,
      printer2: result.printer2.success
        ? `${result.printer2.file} → ${result.printer2.printer} 전송 완료, 출력 대기 중...`
        : result.printer2.error,
    });

    if (!result.printer1.success && !result.printer2.success) {
      setBothPrinting(false);
    }
  };

  const isAnyPrinting = status.printer1 === 'printing' || status.printer1 === 'sending'
    || status.printer2 === 'printing' || status.printer2 === 'sending';

  const isPrinter1Connected = printers.some((p) => p.name === PRINTER_CONFIG.printer1.name);
  // Retransfer 600은 SDK로 직접 통신하므로 SDK 상태로 연결 여부 판단
  const isPrinter2Connected = r600Status?.success === true;

  // 카메라 목록 조회
  const fetchCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      setCameras(videoDevices);
      if (videoDevices.length > 0 && !selectedCamera) {
        setSelectedCamera(videoDevices[0].deviceId);
      }
    } catch (err) {
      console.error('카메라 목록 조회 실패:', err);
    }
  }, [selectedCamera]);

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  // 현재 스트림을 ref로도 추적 (비동기 정리용)
  const streamRef = useRef(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraStream(null);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraStatus('idle');
  }, []);

  // 카메라 연결 테스트
  const testCamera = async () => {
    // 기존 스트림 정리
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (!selectedCamera) {
      setCameraError('카메라를 선택하세요.');
      setCameraStatus('error');
      return;
    }

    setCameraStatus('connecting');
    setCameraError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedCamera } },
      });
      streamRef.current = stream;
      setCameraStream(stream);
      setCameraStatus('connected');
    } catch (err) {
      setCameraError(err.message || '카메라 연결에 실패했습니다.');
      setCameraStatus('error');
    }
  };

  // CSS 필터 문자열
  const cssFilter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%) sepia(${Math.max(0, filters.warmth)}%) hue-rotate(${Math.min(0, filters.warmth) * -1}deg)`;

  const resetFilters = () => {
    setFilters({ brightness: 100, contrast: 100, saturation: 100, warmth: 0 });
  };

  // 컴포넌트 언마운트 시 카메라 정리
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // 결제 단말기 연결 테스트
  const testPaymentConnection = async () => {
    if (!isElectron) return;
    setPaymentStatus('connecting');
    const result = terminalType === 'kis'
      ? await window.electronAPI.kisPaymentTestConnection()
      : await window.electronAPI.paymentTestConnection();
    setPaymentTerminalConnected(result.success);
    setPaymentStatus('idle');
    setPaymentResult(result);
  };

  // 결제 승인
  const handlePaymentApprove = async () => {
    if (!isElectron) return;
    const amount = parseInt(paymentAmount, 10);
    if (!amount || amount <= 0) {
      alert('결제 금액을 입력하세요.');
      return;
    }
    setPaymentStatus('processing');
    setPaymentResult(null);
    try {
      const params = {
        amount,
        tax: Math.floor(amount / 11), // 부가세 자동 계산
        installment: parseInt(paymentInstallment, 10) || 0,
      };
      const result = terminalType === 'kis'
        ? await window.electronAPI.kisPaymentApprove(params)
        : await window.electronAPI.paymentApprove(params);
      setPaymentStatus(result.success ? 'success' : 'error');
      setPaymentResult(result);
    } catch (err) {
      setPaymentStatus('error');
      setPaymentResult({ success: false, error: err.message });
    }
  };

  // 결제 취소
  const handlePaymentCancel = async () => {
    if (!isElectron) return;
    const amount = parseInt(cancelAmount, 10);
    if (!amount || !cancelApprovalNo) {
      alert('취소 금액과 원거래 승인번호를 입력하세요.');
      return;
    }
    setPaymentStatus('processing');
    setPaymentResult(null);
    try {
      const params = {
        amount,
        tax: Math.floor(amount / 11),
        orgApprovalNo: cancelApprovalNo,
        orgApprovalDate: cancelApprovalDate,
      };
      const result = terminalType === 'kis'
        ? await window.electronAPI.kisPaymentCancel(params)
        : await window.electronAPI.paymentCancel(params);
      setPaymentStatus(result.success ? 'success' : 'error');
      setPaymentResult(result);
    } catch (err) {
      setPaymentStatus('error');
      setPaymentResult({ success: false, error: err.message });
    }
  };

  // 단말기 타입 변경 시 연결 상태 초기화
  const handleTerminalTypeChange = (type) => {
    setTerminalType(type);
    setPaymentTerminalConnected(null);
    setPaymentResult(null);
    setPaymentStatus('idle');
  };

  const renderPrinterCard = (printerKey, cardClass) => {
    const config = PRINTER_CONFIG[printerKey];
    const isConnected = printerKey === 'printer1' ? isPrinter1Connected : isPrinter2Connected;
    const s = status[printerKey];
    const msg = messages[printerKey];
    const prog = progress[printerKey];
    const isBusy = s === 'printing' || s === 'sending';
    const selectedFile = files[printerKey];

    return (
      <div className={`printer-card ${cardClass}`}>
        <div className="printer-badge">{config.label}</div>
        <div className="printer-info">
          <h2>{config.name}</h2>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            <span className="dot" />
            {isConnected ? '연결됨' : '연결 안 됨'}
          </div>
        </div>

        {printerKey === 'printer1' && hitiStatus && (
          <div className="hiti-status-panel">
            <div className="hiti-status-row">
              <span className="hiti-label">프린터 상태</span>
              <span className={`hiti-value ${hitiStatus.status?.success ? hitiStatus.status.key : 'error'}`}>
                {hitiStatus.status?.success ? hitiStatus.status.label : (hitiStatus.status?.error || 'SDK 연결 실패')}
              </span>
            </div>
            <div className="hiti-status-row">
              <span className="hiti-label">리본</span>
              <span className="hiti-value">
                {hitiStatus.ribbon?.success
                  ? `${hitiStatus.ribbon.ribbonName} — 잔량 ${hitiStatus.ribbon.remainCount}매`
                  : (hitiStatus.ribbon?.error || '조회 실패')}
              </span>
            </div>
            {hitiStatus.ribbon?.success && (
              <div className="ribbon-bar-container">
                <div
                  className="ribbon-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(3, (hitiStatus.ribbon.remainCount / 700) * 100))}%` }}
                />
                <span className="ribbon-bar-text">{hitiStatus.ribbon.remainCount}매 남음</span>
              </div>
            )}
            <div className="hiti-status-row">
              <span className="hiti-label">총 출력 수</span>
              <span className="hiti-value">
                {hitiStatus.printCount?.success
                  ? `${hitiStatus.printCount.printCount.toLocaleString()}매`
                  : (hitiStatus.printCount?.error || '조회 실패')}
              </span>
            </div>
          </div>
        )}

        {printerKey === 'printer2' && r600Status && (
          <div className="hiti-status-panel">
            <div className="hiti-status-row">
              <span className="hiti-label">프린터 상태</span>
              <span className={`hiti-value ${r600Status.status?.success ? r600Status.status.key : 'error'}`}>
                {r600Status.status?.success ? r600Status.status.label : (r600Status.error || '연결 실패')}
              </span>
            </div>
            {r600Status.ribbon?.success && (
              <>
                <div className="hiti-status-row">
                  <span className="hiti-label">리본</span>
                  <span className="hiti-value">
                    {`잔량 ${r600Status.ribbon.ribbonRemainPercent}%`}
                  </span>
                </div>
                <div className="ribbon-bar-container">
                  <div
                    className="ribbon-bar-fill"
                    style={{ width: `${Math.min(100, Math.max(3, r600Status.ribbon.ribbonRemainPercent))}%` }}
                  />
                  <span className="ribbon-bar-text">{r600Status.ribbon.ribbonRemainPercent}% 남음</span>
                </div>
                <div className="hiti-status-row">
                  <span className="hiti-label">전사필름</span>
                  <span className="hiti-value">
                    {`잔량 ${r600Status.ribbon.filmRemainPercent}%`}
                  </span>
                </div>
              </>
            )}
            <div className="hiti-status-row">
              <span className="hiti-label">총 출력 수</span>
              <span className="hiti-value">
                {r600Status.printCount?.success
                  ? `${r600Status.printCount.printCount.toLocaleString()}매`
                  : (r600Status.error || '조회 실패')}
              </span>
            </div>
            {r600Status.feeder && (
              <div className="hiti-status-row">
                <span className="hiti-label">카드 피더</span>
                <span className="hiti-value">
                  {r600Status.feeder.hasCard === true ? '카드 있음' : r600Status.feeder.hasCard === false ? '비어있음' : '확인 불가'}
                </span>
              </div>
            )}
            {r600Status.status?.success && (
              <div className="hiti-status-row">
                <span className="hiti-label">온도</span>
                <span className="hiti-value">
                  {`본체 ${r600Status.status.chassisTemp}°C / 헤드 ${r600Status.status.headTemp}°C`}
                </span>
              </div>
            )}
          </div>
        )}

        {printerKey === 'printer2' && (
          <div className="overlay-section" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <button
                className="file-select-btn printer-2"
                onClick={handleSelectBack}
                disabled={overlayPrinting}
                style={{ fontSize: 12 }}
              >
                뒷면 선택
              </button>
              <span style={{ fontSize: 12, color: '#666' }}>
                {backFile || '뒷면 없음 (단면)'}
              </span>
              {backFile && (
                <button
                  onClick={() => { setBackFile(null); setBackFilePath(null); }}
                  style={{ fontSize: 11, color: '#999', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  X
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>Threshold</label>
              <input
                type="range" min="0" max="255" value={overlayThreshold}
                onChange={(e) => setOverlayThreshold(Number(e.target.value))}
                disabled={overlayPrinting}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, fontWeight: 600, minWidth: 28 }}>{overlayThreshold}</span>
            </div>
            <button
              className="print-btn btn-2"
              onClick={handleOverlayPrint}
              disabled={overlayPrinting || !selectedFile}
            >
              {overlayPrinting ? '오버레이 출력 중...' : (backFilePath ? '오버레이 양면 출력' : '오버레이 출력')}
            </button>
            {overlayPrinting && overlayProgress && (
              <div style={{ marginTop: 6, fontSize: 13, color: '#f0ad4e', fontWeight: 600 }}>
                {overlayProgress}
              </div>
            )}
            {overlayResult && (
              <div className={`status-message ${overlayResult.success ? 'success' : 'error'}`} style={{ marginTop: 6 }}>
                {overlayResult.success ? overlayResult.message : overlayResult.error}
              </div>
            )}
          </div>
        )}

        <div className="file-section">
          <div className="file-info">
            <label>출력 파일</label>
            <div className="file-name">
              {selectedFile || '파일을 선택하세요'}
            </div>
          </div>
          <button
            className={`file-select-btn ${cardClass}`}
            onClick={() => handleSelectFile(printerKey)}
            disabled={isBusy}
          >
            파일 선택
          </button>
        </div>

        <div className="status-section">
          <div className="status-indicator" style={{ color: getStatusColor(s) }}>
            <span className={`status-dot ${isBusy ? 'pulse' : ''}`} style={{ background: getStatusColor(s) }} />
            {getStatusText(s)}
          </div>

          {prog && prog.totalPages && (
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.max(5, (prog.pagesPrinted / prog.totalPages) * 100)}%` }}
              />
              <span className="progress-text">{prog.pagesPrinted} / {prog.totalPages} 페이지</span>
            </div>
          )}

          {isBusy && (
            <div className="spinner-container">
              <div className={`spinner ${cardClass}`} />
            </div>
          )}

          {msg && (
            <div className={`status-message ${s}`}>{msg}</div>
          )}
        </div>

        <button
          className={`print-btn btn-${printerKey === 'printer1' ? '1' : '2'}`}
          onClick={() => handlePrint(printerKey)}
          disabled={isBusy || !selectedFile}
        >
          {isBusy ? '출력 중...' : `${config.label} 출력`}
        </button>
      </div>
    );
  };

  return (
    <div className="App">
      <header className="app-header">
        <h1>Dual Printer Controller</h1>
        <p>두 프린터에 각각 다른 파일을 동시에 출력합니다</p>
        {!isElectron && (
          <div className="electron-warning">
            Electron 환경이 아닙니다. <code>npm run electron-dev</code>로 실행하세요.
          </div>
        )}
      </header>

      <div className="printer-grid">
        {renderPrinterCard('printer1', 'printer-1')}
        {renderPrinterCard('printer2', 'printer-2')}
      </div>

      <button
        className="print-both-btn"
        onClick={handlePrintBoth}
        disabled={isAnyPrinting || bothPrinting || !files.printer1 || !files.printer2}
      >
        {isAnyPrinting ? '출력 중...' : '두 프린터 동시 출력'}
      </button>

      {printers.length > 0 && (
        <div className="printer-list">
          <h3>시스템 프린터 목록</h3>
          <div className="printer-tags">
            {printers.map((p) => (
              <span key={p.name} className={`printer-tag ${p.status}`}>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 결제 단말기 */}
      <div className="payment-section">
        <h2 className="payment-title">카드 결제 단말기</h2>

        <div className="payment-form-row" style={{ marginBottom: 12 }}>
          <label>단말기 선택</label>
          <select
            className="payment-select"
            value={terminalType}
            onChange={(e) => handleTerminalTypeChange(e.target.value)}
            disabled={paymentStatus === 'processing'}
          >
            <option value="nvc">NVC-1000 (나이스페이먼츠)</option>
            <option value="kis">KIS (KIS정보통신)</option>
          </select>
        </div>

        <div className="payment-connection">
          <button className="payment-test-btn" onClick={testPaymentConnection} disabled={paymentStatus === 'processing'}>
            단말기 연결 테스트
          </button>
          <span className={`payment-conn-status ${paymentTerminalConnected === true ? 'connected' : paymentTerminalConnected === false ? 'disconnected' : ''}`}>
            <span className="dot" />
            {paymentTerminalConnected === true ? '연결됨' : paymentTerminalConnected === false ? '연결 안 됨' : '미확인'}
          </span>
        </div>

        {/* 승인 */}
        <div className="payment-form">
          <h3>카드 결제 승인</h3>
          <div className="payment-form-row">
            <label>결제 금액 (원)</label>
            <input
              type="number"
              className="payment-input"
              placeholder="예: 10000"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              disabled={paymentStatus === 'processing'}
            />
          </div>
          <div className="payment-form-row">
            <label>할부 개월</label>
            <select
              className="payment-select"
              value={paymentInstallment}
              onChange={(e) => setPaymentInstallment(e.target.value)}
              disabled={paymentStatus === 'processing'}
            >
              <option value="0">일시불</option>
              <option value="2">2개월</option>
              <option value="3">3개월</option>
              <option value="4">4개월</option>
              <option value="5">5개월</option>
              <option value="6">6개월</option>
              <option value="9">9개월</option>
              <option value="12">12개월</option>
            </select>
          </div>
          <button
            className="payment-approve-btn"
            onClick={handlePaymentApprove}
            disabled={paymentStatus === 'processing' || !paymentAmount}
          >
            {paymentStatus === 'processing' ? '처리 중... (카드를 투입하세요)' : '결제 승인'}
          </button>
        </div>

        {/* 취소 */}
        <div className="payment-form">
          <h3>결제 취소</h3>
          <div className="payment-form-row">
            <label>취소 금액 (원)</label>
            <input
              type="number"
              className="payment-input"
              placeholder="예: 10000"
              value={cancelAmount}
              onChange={(e) => setCancelAmount(e.target.value)}
              disabled={paymentStatus === 'processing'}
            />
          </div>
          <div className="payment-form-row">
            <label>원거래 승인번호</label>
            <input
              type="text"
              className="payment-input"
              placeholder="승인번호"
              value={cancelApprovalNo}
              onChange={(e) => setCancelApprovalNo(e.target.value)}
              disabled={paymentStatus === 'processing'}
            />
          </div>
          <div className="payment-form-row">
            <label>원거래 승인일자</label>
            <input
              type="text"
              className="payment-input"
              placeholder="YYYYMMDD"
              value={cancelApprovalDate}
              onChange={(e) => setCancelApprovalDate(e.target.value)}
              disabled={paymentStatus === 'processing'}
            />
          </div>
          <button
            className="payment-cancel-btn"
            onClick={handlePaymentCancel}
            disabled={paymentStatus === 'processing' || !cancelAmount || !cancelApprovalNo}
          >
            {paymentStatus === 'processing' ? '처리 중...' : '결제 취소'}
          </button>
        </div>

        {/* 결과 표시 */}
        {paymentResult && (
          <div className={`payment-result ${paymentResult.success ? 'success' : 'error'}`}>
            <h4>{paymentResult.success ? '승인 완료' : '처리 실패'}</h4>
            {paymentResult.success ? (
              <div className="payment-result-detail">
                <p><strong>승인번호:</strong> {paymentResult.approvalNo}</p>
                <p><strong>승인일시:</strong> {paymentResult.approvalDateTime}</p>
                <p><strong>카드번호:</strong> {paymentResult.cardNo}</p>
                <p><strong>매입사:</strong> {paymentResult.acquirerName}</p>
                <p><strong>발급사:</strong> {paymentResult.issuerName}</p>
                <p><strong>금액:</strong> {Number(paymentResult.amount).toLocaleString()}원</p>
              </div>
            ) : (
              <p className="payment-error-msg">{paymentResult.error || paymentResult.message}</p>
            )}
            {/* 디버그 정보 */}
            <details className="payment-debug">
              <summary>응답 상세 (디버그)</summary>
              <pre>{JSON.stringify(paymentResult, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>

      {/* 카메라 연결 테스트 */}
      <div className="camera-section">
        <h2 className="camera-title">Camera Connection Test</h2>
        <div className="camera-controls">
          <div className="camera-select-wrapper">
            <label className="camera-label">카메라 선택</label>
            <select
              className="camera-select"
              value={selectedCamera}
              onChange={(e) => setSelectedCamera(e.target.value)}
              disabled={cameraStatus === 'connecting'}
            >
              {cameras.length === 0 && <option value="">감지된 카메라 없음</option>}
              {cameras.map((cam) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `카메라 ${cameras.indexOf(cam) + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="camera-buttons">
            <button
              className="camera-test-btn"
              onClick={testCamera}
              disabled={cameras.length === 0 || cameraStatus === 'connecting'}
            >
              {cameraStatus === 'connecting' ? '연결 중...' : '연결 테스트'}
            </button>
            {cameraStatus === 'connected' && (
              <button className="camera-stop-btn" onClick={stopCamera}>
                중지
              </button>
            )}
            <button className="camera-refresh-btn" onClick={fetchCameras}>
              새로고침
            </button>
          </div>
        </div>

        <div className="camera-status-bar">
          <span
            className={`status-dot ${cameraStatus === 'connecting' ? 'pulse' : ''}`}
            style={{
              background:
                cameraStatus === 'connected' ? '#5cb85c' :
                cameraStatus === 'connecting' ? '#f0ad4e' :
                cameraStatus === 'error' ? '#d9534f' : '#888',
            }}
          />
          <span style={{
            color:
              cameraStatus === 'connected' ? '#5cb85c' :
              cameraStatus === 'connecting' ? '#f0ad4e' :
              cameraStatus === 'error' ? '#d9534f' : '#888',
            fontWeight: 600,
          }}>
            {cameraStatus === 'connected' && '연결 성공'}
            {cameraStatus === 'connecting' && '연결 중...'}
            {cameraStatus === 'error' && '연결 실패'}
            {cameraStatus === 'idle' && '대기'}
          </span>
          {cameraError && <span className="camera-error-text">{cameraError}</span>}
        </div>

        {/* 보정 컨트롤 */}
        {cameraStatus === 'connected' && (
          <div className="filter-panel">
            <div className="filter-group filter-group-full">
              <h3 className="filter-title">보정</h3>
              <div className="filter-sliders">
                <div className="filter-slider-row">
                  <label>밝기</label>
                  <input type="range" min="50" max="200" value={filters.brightness}
                    onChange={(e) => setFilters((f) => ({ ...f, brightness: Number(e.target.value) }))} />
                  <span>{filters.brightness}%</span>
                </div>
                <div className="filter-slider-row">
                  <label>대비</label>
                  <input type="range" min="50" max="200" value={filters.contrast}
                    onChange={(e) => setFilters((f) => ({ ...f, contrast: Number(e.target.value) }))} />
                  <span>{filters.contrast}%</span>
                </div>
                <div className="filter-slider-row">
                  <label>채도</label>
                  <input type="range" min="0" max="200" value={filters.saturation}
                    onChange={(e) => setFilters((f) => ({ ...f, saturation: Number(e.target.value) }))} />
                  <span>{filters.saturation}%</span>
                </div>
                <div className="filter-slider-row">
                  <label>따뜻함</label>
                  <input type="range" min="-30" max="60" value={filters.warmth}
                    onChange={(e) => setFilters((f) => ({ ...f, warmth: Number(e.target.value) }))} />
                  <span>{filters.warmth > 0 ? `+${filters.warmth}` : filters.warmth}</span>
                </div>
              </div>
              <button className="filter-reset-btn" onClick={resetFilters}>초기화</button>
            </div>
          </div>
        )}

        <div className="camera-preview">
          {cameraStatus === 'connected' ? (
            <video
              ref={(el) => {
                videoRef.current = el;
                if (el && cameraStream) {
                  el.srcObject = cameraStream;
                }
              }}
              autoPlay
              playsInline
              muted
              className="camera-video"
              style={{ filter: cssFilter }}
            />
          ) : (
            <div className="camera-placeholder">
              {cameras.length === 0
                ? '연결된 카메라가 없습니다'
                : '연결 테스트 버튼을 눌러 카메라를 확인하세요'}
            </div>
          )}
        </div>
      </div>

      <footer className="app-footer">
        <p>프린터가 연결되어 있는지 확인 후 출력하세요</p>
      </footer>
    </div>
  );
}

export default App;

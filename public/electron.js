const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const { print } = require('pdf-to-printer');
const { requestPayment, requestCancel, testConnection } = require('./payment');
const { requestPaymentKis, requestCancelKis, testConnectionKis } = require('./paymentKis');

let mainWindow;

const PRINTERS = {
  printer1: 'HiTi P525T',
  printer2: 'Rtai LUCA-40KM',
};

const selectedFiles = { printer1: null, printer2: null };

// ===== SDK Workers (각 DLL별 별도 프로세스) =====
const workers = {};

function startWorker(type) {
  // R600 워커는 SDK DLL 폴더를 cwd로 사용 (설정파일, 색상프로파일 등 필요)
  const workerCwd = type === 'r600'
    ? path.join(__dirname, '..', 'dll', 'r600')
    : path.join(__dirname, '..');
  const proc = spawn('node', [path.join(__dirname, 'sdkWorker.js'), type], {
    cwd: workerCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const w = { proc, pending: new Map(), buffer: '', reqId: 0 };

  proc.stdout.on('data', (data) => {
    w.buffer += data.toString();
    let idx;
    while ((idx = w.buffer.indexOf('\n')) !== -1) {
      const line = w.buffer.slice(0, idx).trim();
      w.buffer = w.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress' && mainWindow) {
          mainWindow.webContents.send('overlay-progress', msg.detail);
        } else {
          const p = w.pending.get(msg.id);
          if (p) {
            p.resolve(msg.result);
            w.pending.delete(msg.id);
          }
        }
      } catch {}
    }
  });
  proc.stderr.on('data', (d) => console.log(`[${type}]`, d.toString().trim()));
  proc.on('exit', (code) => {
    console.log(`[${type} worker] exit`, code);
    for (const [, p] of w.pending)
      p.resolve({ success: false, error: `${type} worker crashed` });
    w.pending.clear();
    delete workers[type];
  });
  workers[type] = w;
}

function sdkRequest(type, printerName) {
  return new Promise((resolve) => {
    if (!workers[type]) startWorker(type);
    const w = workers[type];
    const id = ++w.reqId;
    w.pending.set(id, { resolve });
    w.proc.stdin.write(JSON.stringify({ id, printerName }) + '\n');
  });
}

// ===== Window =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const isDev = !app.isPackaged;
  if (isDev) mainWindow.loadURL('http://localhost:3000');
  else mainWindow.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
}

// ===== Print Queue =====
function checkPrintQueue(printerName) {
  return new Promise((resolve) => {
    exec(
      `powershell -Command "Get-PrintJob -PrinterName '${printerName}' | Select-Object Id,DocumentName,JobStatus,TotalPages,PagesPrinted | ConvertTo-Json"`,
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const p = JSON.parse(stdout);
          resolve(Array.isArray(p) ? p : [p]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function watchPrintJob(printerKey, printerName) {
  // printer2(카드 프린터)는 큐를 안 거치므로 SDK 상태로 모니터링
  if (printerKey === 'printer2') {
    watchPrintJobBySdk(printerKey);
    return;
  }

  let attempts = 0,
    jobFound = false;
  const DONE_STATUSES = [
    'Printed',
    'Complete',
    'Completed',
    'Sent to printer',
    'Sent',
  ];
  const poll = setInterval(async () => {
    attempts++;
    const jobs = await checkPrintQueue(printerName);
    if (jobs.length > 0) {
      jobFound = true;
      const job = jobs[jobs.length - 1];
      const jobStatus = job.JobStatus || '';

      if (DONE_STATUSES.some((s) => jobStatus.includes(s))) {
        clearInterval(poll);
        mainWindow.webContents.send('print-progress', {
          printerKey,
          status: 'done',
          detail: '출력 완료',
        });
        return;
      }

      mainWindow.webContents.send('print-progress', {
        printerKey,
        status: 'printing',
        detail: jobStatus || 'Spooling',
        totalPages: job.TotalPages || null,
        pagesPrinted: job.PagesPrinted || 0,
      });
    } else if (jobFound) {
      clearInterval(poll);
      mainWindow.webContents.send('print-progress', {
        printerKey,
        status: 'done',
        detail: '출력 완료',
      });
    }
    if (attempts > 600) {
      clearInterval(poll);
      mainWindow.webContents.send('print-progress', {
        printerKey,
        status: jobFound ? 'done' : 'timeout',
        detail: jobFound ? '출력 완료 (추정)' : '프린트 큐 확인 시간 초과',
      });
    }
  }, 500);
}

// R600 SDK 상태 폴링으로 카드 프린터 출력 완료 감지
function watchPrintJobBySdk(printerKey) {
  let attempts = 0,
    wasPrinting = false;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const result = await sdkRequest('r600', '');
      const key = result?.status?.key;

      if (key === 'printing') {
        wasPrinting = true;
        mainWindow.webContents.send('print-progress', {
          printerKey,
          status: 'printing',
          detail: result.status.label,
        });
      } else if (wasPrinting && key === 'ready') {
        clearInterval(poll);
        mainWindow.webContents.send('print-progress', {
          printerKey,
          status: 'done',
          detail: '출력 완료',
        });
      }
    } catch {}

    if (attempts > 600) {
      clearInterval(poll);
      mainWindow.webContents.send('print-progress', {
        printerKey,
        status: wasPrinting ? 'done' : 'timeout',
        detail: wasPrinting ? '출력 완료 (추정)' : '프린트 상태 확인 시간 초과',
      });
    }
  }, 1000);
}

// ===== IPC =====
ipcMain.handle('select-file', async (_, { printerKey }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `${PRINTERS[printerKey]} - 출력할 파일 선택`,
    filters: [
      {
        name: '인쇄 가능 파일',
        extensions: ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'gif', 'tiff', 'tif'],
      },
      { name: '모든 파일', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length)
    return { success: false, canceled: true };
  selectedFiles[printerKey] = result.filePaths[0];
  return {
    success: true,
    filePath: result.filePaths[0],
    fileName: path.basename(result.filePaths[0]),
  };
});

ipcMain.handle('get-printers', async () => {
  try {
    const printers = mainWindow.webContents.getPrintersAsync
      ? await mainWindow.webContents.getPrintersAsync()
      : mainWindow.webContents.getPrinters();
    return {
      success: true,
      printers: printers.map((p) => ({
        name: p.name,
        status: p.status === 0 ? 'ready' : 'busy',
        isDefault: p.isDefault,
      })),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('print-file', async (_, { printerKey }) => {
  const printerName = PRINTERS[printerKey],
    filePath = selectedFiles[printerKey];
  if (!printerName) return { success: false, error: '잘못된 프린터 키' };
  if (!filePath) return { success: false, error: '파일을 먼저 선택하세요' };
  try {
    await print(filePath, { printer: printerName });
    watchPrintJob(printerKey, printerName);
    return {
      success: true,
      printer: printerName,
      file: path.basename(filePath),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('print-both', async () => {
  if (!selectedFiles.printer1 || !selectedFiles.printer2) {
    return {
      printer1: {
        success: false,
        error: !selectedFiles.printer1 ? '파일을 선택하세요' : null,
      },
      printer2: {
        success: false,
        error: !selectedFiles.printer2 ? '파일을 선택하세요' : null,
      },
    };
  }
  const results = await Promise.allSettled([
    print(selectedFiles.printer1, { printer: PRINTERS.printer1 }),
    print(selectedFiles.printer2, { printer: PRINTERS.printer2 }),
  ]);
  const res = {
    printer1: {
      success: results[0].status === 'fulfilled',
      printer: PRINTERS.printer1,
      file: path.basename(selectedFiles.printer1),
      error: results[0].reason?.message || null,
    },
    printer2: {
      success: results[1].status === 'fulfilled',
      printer: PRINTERS.printer2,
      file: path.basename(selectedFiles.printer2),
      error: results[1].reason?.message || null,
    },
  };
  if (res.printer1.success) watchPrintJob('printer1', PRINTERS.printer1);
  if (res.printer2.success) watchPrintJob('printer2', PRINTERS.printer2);
  return res;
});

ipcMain.handle('get-hiti-status', (_, { printerName }) =>
  sdkRequest('hiti', printerName),
);
ipcMain.handle('get-r600-status', () =>
  sdkRequest('r600', ''),
);

// 뒷면 파일 선택
ipcMain.handle('select-back-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '뒷면 이미지 선택',
    filters: [
      { name: '이미지 파일', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  return { success: true, filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
});

// R600 오버레이 출력 (같은 이미지로 YMC + F/S/W, 양면 지원)
ipcMain.handle('r600-overlay-print', async (_, { threshold = 220, backImagePath } = {}) => {
  const imagePath = selectedFiles.printer2;
  if (!imagePath) return { success: false, error: '이미지를 먼저 선택하세요' };

  if (!workers['r600']) startWorker('r600');
  const w = workers['r600'];
  const id = ++w.reqId;
  return new Promise((resolve) => {
    w.pending.set(id, { resolve });
    w.proc.stdin.write(JSON.stringify({ id, action: 'overlay-print', overlayImagePath: imagePath, threshold, backImagePath: backImagePath || null }) + '\n');
  });
});

// ===== NVC-1000 결제 단말기 (시리얼) =====
const PAYMENT_TERMINAL = { comPort: 'COM3', baudRate: 115200 };

ipcMain.handle('payment-test-connection', async () => {
  console.log(
    `[NVC-1000] 연결 테스트: ${PAYMENT_TERMINAL.comPort} (${PAYMENT_TERMINAL.baudRate}bps)`,
  );
  const result = await testConnection(
    PAYMENT_TERMINAL.comPort,
    PAYMENT_TERMINAL.baudRate,
  );
  console.log('[NVC-1000] 연결 테스트 결과:', JSON.stringify(result));
  return result;
});

ipcMain.handle('payment-approve', async (_, params) => {
  console.log('[NVC-1000] 승인 요청:', JSON.stringify(params));
  try {
    const result = await requestPayment(
      PAYMENT_TERMINAL.comPort,
      PAYMENT_TERMINAL.baudRate,
      params,
    );
    console.log('[NVC-1000] 승인 응답:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('[NVC-1000] 승인 오류:', err.message, err.stack);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('payment-cancel', async (_, params) => {
  console.log('[NVC-1000] 취소 요청:', JSON.stringify(params));
  try {
    const result = await requestCancel(
      PAYMENT_TERMINAL.comPort,
      PAYMENT_TERMINAL.baudRate,
      params,
    );
    console.log('[NVC-1000] 취소 응답:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('[NVC-1000] 취소 오류:', err.message, err.stack);
    return { success: false, error: err.message };
  }
});

// ===== KIS 카드단말기 (WebSocket CAT) =====
const KIS_TERMINAL = { wsPort: 1516, endpoint: '' };

ipcMain.handle('kis-payment-test-connection', async () => {
  console.log(`[KIS] 연결 테스트: localhost:${KIS_TERMINAL.wsPort}`);
  const result = await testConnectionKis(KIS_TERMINAL.wsPort, KIS_TERMINAL.endpoint);
  console.log('[KIS] 연결 테스트 결과:', JSON.stringify(result));
  return result;
});

ipcMain.handle('kis-payment-approve', async (_, params) => {
  console.log('[KIS] 승인 요청:', JSON.stringify(params));
  try {
    const result = await requestPaymentKis(KIS_TERMINAL.wsPort, KIS_TERMINAL.endpoint, params);
    console.log('[KIS] 승인 응답:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('[KIS] 승인 오류:', err.message, err.stack);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('kis-payment-cancel', async (_, params) => {
  console.log('[KIS] 취소 요청:', JSON.stringify(params));
  try {
    const result = await requestCancelKis(KIS_TERMINAL.wsPort, KIS_TERMINAL.endpoint, params);
    console.log('[KIS] 취소 응답:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('[KIS] 취소 오류:', err.message, err.stack);
    return { success: false, error: err.message };
  }
});

app.whenReady().then(() => {
  // 카메라/마이크 권한 자동 허용
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
      } else {
        callback(true);
      }
    },
  );

  startWorker('hiti');
  startWorker('r600');
  createWindow();
});
app.on('window-all-closed', () => {
  for (const w of Object.values(workers)) w.proc.kill();
  app.quit();
});

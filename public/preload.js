const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  selectFile: (printerKey) => ipcRenderer.invoke('select-file', { printerKey }),
  printFile: (printerKey) => ipcRenderer.invoke('print-file', { printerKey }),
  printBoth: () => ipcRenderer.invoke('print-both'),
  onPrintProgress: (callback) => {
    ipcRenderer.on('print-progress', (event, data) => callback(data));
  },
  removePrintProgress: () => {
    ipcRenderer.removeAllListeners('print-progress');
  },
  // HiTi SDK
  getHitiStatus: (printerName) => ipcRenderer.invoke('get-hiti-status', { printerName }),
  // Retransfer 600 SDK (카드 프린터)
  getR600Status: () => ipcRenderer.invoke('get-r600-status'),
  r600OverlayPrint: (threshold, backImagePath) => ipcRenderer.invoke('r600-overlay-print', { threshold, backImagePath }),
  onOverlayProgress: (callback) => {
    ipcRenderer.on('overlay-progress', (_, detail) => callback(detail));
  },
  removeOverlayProgress: () => {
    ipcRenderer.removeAllListeners('overlay-progress');
  },
  selectBackFile: () => ipcRenderer.invoke('select-back-file'),
  // NVC-1000 결제 단말기
  paymentTestConnection: () => ipcRenderer.invoke('payment-test-connection'),
  paymentApprove: (params) => ipcRenderer.invoke('payment-approve', params),
  paymentCancel: (params) => ipcRenderer.invoke('payment-cancel', params),
  // KIS 카드단말기
  kisPaymentTestConnection: () => ipcRenderer.invoke('kis-payment-test-connection'),
  kisPaymentApprove: (params) => ipcRenderer.invoke('kis-payment-approve', params),
  kisPaymentCancel: (params) => ipcRenderer.invoke('kis-payment-cancel', params),
});

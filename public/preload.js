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
  // Smart SDK (카드 프린터)
  getSmartStatus: (printerName) => ipcRenderer.invoke('get-smart-status', { printerName }),
  // NVC-1000 결제 단말기
  paymentTestConnection: () => ipcRenderer.invoke('payment-test-connection'),
  paymentApprove: (params) => ipcRenderer.invoke('payment-approve', params),
  paymentCancel: (params) => ipcRenderer.invoke('payment-cancel', params),
});

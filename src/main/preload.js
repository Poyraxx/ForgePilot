import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cokgizlicoder', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  chooseWorkspace: (defaultPath) => ipcRenderer.invoke('app:choose-workspace', defaultPath),
  refreshModels: (payload) => ipcRenderer.invoke('app:refresh-models', payload),
  saveAppState: (payload) => ipcRenderer.invoke('app:save-state', payload),
  createSession: (payload) => ipcRenderer.invoke('session:create', payload),
  getSession: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  importAttachments: (sessionId, attachments) =>
    ipcRenderer.invoke('session:import-attachments', sessionId, attachments),
  updateSessionConfig: (sessionId, payload) =>
    ipcRenderer.invoke('session:update-config', sessionId, payload),
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
  cancelActiveRun: (sessionId) => ipcRenderer.invoke('session:cancel-run', sessionId),
  sendUserMessage: (sessionId, content) => ipcRenderer.invoke('session:send', sessionId, content),
  resolveApproval: (sessionId, approved) =>
    ipcRenderer.invoke('session:resolve-approval', sessionId, approved),
  onSessionStateChange: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('session:state-changed', listener);
    return () => ipcRenderer.removeListener('session:state-changed', listener);
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getState: () => ipcRenderer.invoke('window:get-state'),
    onStateChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('window:state-changed', listener);
      return () => ipcRenderer.removeListener('window:state-changed', listener);
    },
  },
});

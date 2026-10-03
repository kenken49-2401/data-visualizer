'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageOverlay', {
  getState: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  login: () => ipcRenderer.invoke('usage:login'),
  cancelLogin: () => ipcRenderer.invoke('usage:cancel-login'),
  setMode: mode => ipcRenderer.invoke('usage:mode', mode),
  quit: () => ipcRenderer.invoke('usage:quit'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('usage:state', listener);
    return () => ipcRenderer.removeListener('usage:state', listener);
  },
});

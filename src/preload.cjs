'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageOverlay', {
  history: () => ipcRenderer.invoke('usage:history'),
  getState: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  login: () => ipcRenderer.invoke('usage:login'),
  cancelLogin: () => ipcRenderer.invoke('usage:cancel-login'),
  hide: () => ipcRenderer.invoke('usage:hide'),
  minimize: () => ipcRenderer.invoke('usage:minimize'),
  menu: () => ipcRenderer.invoke('usage:menu'),
  restart: () => ipcRenderer.invoke('usage:restart'),
  quit: () => ipcRenderer.invoke('usage:quit'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('usage:state', listener);
    return () => ipcRenderer.removeListener('usage:state', listener);
  },
});

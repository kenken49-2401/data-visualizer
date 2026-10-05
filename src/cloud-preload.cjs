'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cloudRecording', {
  get: () => ipcRenderer.invoke('cloud:get'),
  generate: () => ipcRenderer.invoke('cloud:generate'),
  install: key => ipcRenderer.invoke('cloud:install', key),
  disable: () => ipcRenderer.invoke('cloud:disable'),
  check: () => ipcRenderer.invoke('cloud:check'),
  open: target => ipcRenderer.invoke('cloud:open', target),
  subscribe: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('cloud:state', listener); return () => ipcRenderer.removeListener('cloud:state', listener); },
});

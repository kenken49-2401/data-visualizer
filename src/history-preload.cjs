'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageHistory', {
  cloud: () => ipcRenderer.invoke('history:cloud'),
  get: () => ipcRenderer.invoke('history:get'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('history:state', listener);
    return () => ipcRenderer.removeListener('history:state', listener);
  },
});

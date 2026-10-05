'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageHistory', {
  get: () => ipcRenderer.invoke('history:get'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('history:state', listener);
    return () => ipcRenderer.removeListener('history:state', listener);
  },
});

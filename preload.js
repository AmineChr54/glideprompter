const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tp', {
  ready: (who) => ipcRenderer.send('ready', who),
  action: (a) => ipcRenderer.send('action', a),
  report: (r) => ipcRenderer.send('report', r),
  settings: (s) => ipcRenderer.send('settings', s),
  saveScript: (file, text) => ipcRenderer.invoke('saveScript', { file, text }),
  newSpeaker: (name) => ipcRenderer.invoke('newSpeaker', name),
  changeFolder: () => ipcRenderer.invoke('changeFolder'),
  info: () => ipcRenderer.invoke('info'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, data) => fn(data)),
});

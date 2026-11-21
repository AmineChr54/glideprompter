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
  follow: true,                 // Follow mode exists here (the web version has no speech engine)
});
// Follow mode: the main process hands the Control window a MessagePort to the speech engine.
// Ports can't cross the context bridge as arguments, so they go over window.postMessage.
ipcRenderer.on('followPort', (e, data) => window.postMessage({ type: 'glideprompter-follow-port', data }, '*', e.ports));

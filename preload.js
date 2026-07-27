const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sola', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  launchGame: (payload) => ipcRenderer.invoke('game:launch', payload),
  pickJava: () => ipcRenderer.invoke('game:pickJava'),
  pickSkin: () => ipcRenderer.invoke('skin:pick'),
  getSkin: () => ipcRenderer.invoke('skin:get'),
  clearSkin: () => ipcRenderer.invoke('skin:clear'),
  listVersions: () => ipcRenderer.invoke('versions:list'),
  openGameFolder: () => ipcRenderer.invoke('game:openFolder'),
  downloadVersion: (payload) => ipcRenderer.invoke('versions:download', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (nickname) => ipcRenderer.invoke('accounts:add', nickname),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  setActiveAccount: (id) => ipcRenderer.invoke('accounts:setActive', id),
  onLaunchProgress: (cb) => ipcRenderer.on('launch:progress', (e, payload) => cb(payload)),
  onLaunchLog: (cb) => ipcRenderer.on('launch:log', (e, line) => cb(line))
});

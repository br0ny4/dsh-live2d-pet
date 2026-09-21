const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer never touches the bridge directly: it has no filesystem, no
 * discovery secret, and no network. Everything crosses this one narrow surface.
 */
contextBridge.exposeInMainWorld('dshPet', {
  onAssets: (callback) => ipcRenderer.on('pet:assets', (_event, assets) => callback(assets)),
  onState: (callback) => ipcRenderer.on('pet:state', (_event, state) => callback(state)),
  onStatus: (callback) => ipcRenderer.on('pet:status', (_event, status) => callback(status)),
  send: (args) => ipcRenderer.invoke('pet:send', args),
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  setInteractive: (interactive) => ipcRenderer.send('pet:set-interactive', Boolean(interactive)),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', { dx, dy }),
  openHarness: () => ipcRenderer.send('pet:open-harness'),
})

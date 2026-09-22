const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer never touches the bridge directly: it has no filesystem, no
 * discovery secret, and no network. Everything crosses this one narrow surface.
 */
contextBridge.exposeInMainWorld('dshPet', {
  onCharacter: (callback) => ipcRenderer.on('pet:character', (_event, character) => callback(character)),
  onCharacters: (callback) => ipcRenderer.on('pet:characters', (_event, characters) => callback(characters)),
  listCharacters: () => ipcRenderer.invoke('pet:characters'),
  setCharacter: (id) => ipcRenderer.invoke('pet:set-character', id),
  onState: (callback) => ipcRenderer.on('pet:state', (_event, state) => callback(state)),
  onStatus: (callback) => ipcRenderer.on('pet:status', (_event, status) => callback(status)),
  send: (args) => ipcRenderer.invoke('pet:send', args),
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  setInteractive: (interactive) => ipcRenderer.send('pet:set-interactive', Boolean(interactive)),
  canvasReady: () => ipcRenderer.send('pet:canvas-ready'),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', { dx, dy }),
  openHarness: () => ipcRenderer.send('pet:open-harness'),
})

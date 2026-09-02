const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('clipperrr', {
  platform: process.platform,
  tools: () => ipcRenderer.invoke('tools:status'),
  installYtDlp: () => ipcRenderer.invoke('tools:installYtDlp'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (defaultName, ext) => ipcRenderer.invoke('dialog:saveFile', { defaultName, ext }),
  load: (file) => ipcRenderer.invoke('media:load', file),
  proxy: (id) => ipcRenderer.invoke('media:proxy', id),
  download: (url, jobId, force) => ipcRenderer.invoke('media:download', { url, jobId, force }),
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    open: (id) => ipcRenderer.invoke('library:open', id),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    clear: () => ipcRenderer.invoke('library:clear'),
    openFolder: () => ipcRenderer.invoke('library:openFolder'),
  },
  exportClip: (opts) => ipcRenderer.invoke('media:export', opts),
  cancel: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u),
  pathForFile: (file) => require('electron').webUtils.getPathForFile(file),
  onProgress: on('job:progress'),
  onOpen: on('app:open'),
  ready: () => ipcRenderer.send('app:ready'),
});

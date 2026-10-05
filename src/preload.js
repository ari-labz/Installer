const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("installer", {
    getPlatform:        ()                     => ipcRenderer.invoke("get-platform"),
    needsToken:         ()                     => ipcRenderer.invoke("needs-token"),
    getToken:           ()                     => ipcRenderer.invoke("get-token"),
    saveToken:          (t)                    => ipcRenderer.invoke("save-token", t),
    fetchReleases:      (c, t)                 => ipcRenderer.invoke("fetch-releases", c, t),
    installedInfo:      (c)                    => ipcRenderer.invoke("installed-info", c),
    downloadAndInstall: (c, t, rel, opts)      => ipcRenderer.invoke("download-and-install", c, t, rel, opts),
    launch:             (c, v)                 => ipcRenderer.invoke("launch", c, v),
    onProgress:         (cb)                   => ipcRenderer.on("download-progress", (_, d) => cb(d)),
    onStatus:           (cb)                   => ipcRenderer.on("status", (_, s) => cb(s)),
})

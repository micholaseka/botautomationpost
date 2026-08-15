const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Invoke (request/response)
    openBrowser: () => ipcRenderer.invoke('open-browser'),
    closeBrowser: () => ipcRenderer.invoke('close-browser'),
    startPost: (listing) => ipcRenderer.invoke('start-post', listing),
    cancelPost: () => ipcRenderer.invoke('cancel-post'),
    continueAfterManualPublish: () => ipcRenderer.invoke('continue-after-manual-publish'),
    checkSession: () => ipcRenderer.invoke('check-session'),
    getFilePath: (file) => webUtils.getPathForFile(file),

    // Listen (events from main)
    onLog: (callback) => {
        const listener = (_event, msg, level) => callback(msg, level);
        ipcRenderer.on('bot-log', listener);
        return () => ipcRenderer.removeListener('bot-log', listener);
    },
    onStatus: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('bot-status', listener);
        return () => ipcRenderer.removeListener('bot-status', listener);
    },
    onLoginStatus: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('bot-login-status', listener);
        return () => ipcRenderer.removeListener('bot-login-status', listener);
    },
    onComplete: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('bot-complete', listener);
        return () => ipcRenderer.removeListener('bot-complete', listener);
    },
    onCancelled: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('bot-cancelled', listener);
        return () => ipcRenderer.removeListener('bot-cancelled', listener);
    },
    onManualActionRequired: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('bot-manual-action-required', listener);
        return () => ipcRenderer.removeListener('bot-manual-action-required', listener);
    },
    onManualLocationSelected: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('bot-manual-location-selected', listener);
        return () => ipcRenderer.removeListener('bot-manual-location-selected', listener);
    },
    onError: (callback) => {
        const listener = (_event, err) => callback(err);
        ipcRenderer.on('bot-error', listener);
        return () => ipcRenderer.removeListener('bot-error', listener);
    }
});

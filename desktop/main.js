import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutomationService } from './services/automation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
// Each Windows account gets an independent login session.  In a packaged app
// this resolves to AppData\Roaming\<app name>, not the installed application.
const automation = new AutomationService({ sessionDirectory: app.getPath('userData') });

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 900,
        minHeight: 600,
        title: 'Marketplace AutoPost Bot',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

automation.on('log', (msg, level = '') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-log', msg, level);
    }
});

automation.on('status', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-status', data);
    }
});

automation.on('login_status', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-login-status', data);
    }
});

automation.on('complete', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-complete');
    }
});

automation.on('cancelled', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-cancelled');
    }
});

automation.on('manual_action_required', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-manual-action-required', data);
    }
});

automation.on('manual_location_selected', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-manual-location-selected', data);
    }
});

automation.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot-error', typeof err === 'string' ? err : (err.message || 'Unknown error'));
    }
});

ipcMain.handle('open-browser', async () => {
    try {
        await automation.openBrowser();
        return { success: true, isLoggedIn: automation.isLoggedIn };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('close-browser', async () => {
    try {
        await automation.close();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('start-post', async (_event, listing) => {
    try {
        const result = await automation.postBatch(listing);
        return { success: true, ...result };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-post', async () => {
    try {
        const cancelled = automation.cancelBatch();
        return { success: true, cancelled };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('continue-after-manual-publish', async () => {
    try {
        const continued = automation.continueAfterManualPublish();
        return { success: true, continued };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('check-session', async () => {
    try {
        const isLoggedIn = await automation.checkLoginStatus();
        return { success: true, isLoggedIn };
    } catch {
        return { success: true, isLoggedIn: false };
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', async () => {
    await automation.close();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    await automation.close();
});

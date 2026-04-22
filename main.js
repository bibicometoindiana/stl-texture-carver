'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const carve = require('./carve');

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1500,
    height: 860,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());

// Default sample paths (relative to app root)
const DEFAULT_STL = path.join(__dirname, 'samples', 'laubstopp_mesh.stl');
const DEFAULT_PNG = path.join(__dirname, 'patterns', 'gitter.png');

ipcMain.handle('get-defaults', () => ({
  stl: fs.existsSync(DEFAULT_STL) ? DEFAULT_STL : null,
  png: fs.existsSync(DEFAULT_PNG) ? DEFAULT_PNG : null,
}));

ipcMain.handle('open-stl', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open STL file',
    defaultPath: fs.existsSync(DEFAULT_STL) ? path.dirname(DEFAULT_STL) : undefined,
    filters: [{ name: 'STL Files', extensions: ['stl'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('open-png', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open texture',
    defaultPath: fs.existsSync(DEFAULT_PNG) ? path.dirname(DEFAULT_PNG) : undefined,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('save-stl', async (_, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save output STL',
    defaultPath: defaultName || 'output.stl',
    filters: [{ name: 'STL Files', extensions: ['stl'] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('run-carve', async (_, { stlPath, pngPath, outputPath, selectedGroups, textureParams }) => {
  try {
    await carve.run(stlPath, pngPath, outputPath, selectedGroups, textureParams);
    return { ok: true };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
});

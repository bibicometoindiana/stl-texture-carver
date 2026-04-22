'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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

ipcMain.handle('open-stl', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open STL file',
    filters: [{ name: 'STL Files', extensions: ['stl'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('open-png', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open texture',
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

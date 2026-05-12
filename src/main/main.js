import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Menu, app, BrowserWindow, dialog, ipcMain, screen } from 'electron';

import { SessionService } from './session-service.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const appRoot = path.resolve(currentDir, '..', '..');
const rendererEntry = path.join(appRoot, 'src', 'renderer', 'index.html');
const preloadEntry = path.join(currentDir, 'preload.js');
const appIconEntry = path.join(appRoot, 'ChatGPT Image 12 May 2026 20_29_11.ico');

const sessionService = new SessionService({ appRoot });
const managedWindowStates = new WeakMap();
let isShuttingDown = false;
let shutdownComplete = false;

function getManagedWindowState(window) {
  let state = managedWindowStates.get(window);

  if (!state) {
    state = {
      pseudoMaximized: false,
      restoreBounds: null,
      suppressNextUnmaximize: false,
      applyingPseudoBounds: false,
    };
    managedWindowStates.set(window, state);
  }

  return state;
}

function isWindowMaximized(window) {
  const state = getManagedWindowState(window);
  return state.pseudoMaximized || window.isMaximized();
}

function getWorkAreaBounds(window) {
  return screen.getDisplayMatching(window.getBounds()).workArea;
}

function isMaxLikeBounds(window) {
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const workAreaBottom = workArea.y + workArea.height;
  const windowBottom = bounds.y + bounds.height;

  return (
    bounds.x <= workArea.x + 2 &&
    bounds.y <= workArea.y + 2 &&
    bounds.width >= workArea.width - 2 &&
    windowBottom > workAreaBottom + 2
  );
}

function enforceWorkAreaBounds(window) {
  if (process.platform !== 'win32' || window.isDestroyed()) {
    return;
  }

  const state = getManagedWindowState(window);

  if (state.applyingPseudoBounds || !isMaxLikeBounds(window)) {
    return;
  }

  if (!state.pseudoMaximized) {
    state.restoreBounds = window.getNormalBounds?.() ?? state.restoreBounds ?? window.getBounds();
  }

  state.pseudoMaximized = true;
  applyPseudoMaxBounds(window);
  emitWindowState(window);
}

function getWindowContentInsets(window) {
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const displayBounds = display.bounds;
  const displayBottom = displayBounds.y + displayBounds.height;
  const workAreaBottom = workArea.y + workArea.height;
  const windowBottom = bounds.y + bounds.height;
  const overlapsBottomTaskbar = Math.max(0, windowBottom - workAreaBottom);
  const bottomTaskbarHeight = Math.max(0, displayBottom - workAreaBottom);
  const maximizedBottomInset =
    process.platform === 'win32' && isWindowMaximized(window) ? bottomTaskbarHeight : 0;

  return {
    bottomSafeArea: Math.max(overlapsBottomTaskbar, maximizedBottomInset),
  };
}

function applyPseudoMaxBounds(window) {
  const workArea = getWorkAreaBounds(window);
  const state = getManagedWindowState(window);
  state.applyingPseudoBounds = true;
  window.setBounds({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
  });
  setImmediate(() => {
    state.applyingPseudoBounds = false;
  });
}

function maximizeWindowSafely(window) {
  if (process.platform !== 'win32') {
    window.maximize();
    return;
  }

  const state = getManagedWindowState(window);

  if (window.isMaximized()) {
    window.unmaximize();
  }

  if (!state.pseudoMaximized) {
    state.restoreBounds = window.getBounds();
  }

  state.pseudoMaximized = true;
  applyPseudoMaxBounds(window);
}

function restoreWindowSafely(window) {
  const state = getManagedWindowState(window);

  if (process.platform !== 'win32') {
    if (window.isMaximized()) {
      window.unmaximize();
    }
    return;
  }

  if (window.isMaximized()) {
    window.unmaximize();
  }

  if (state.pseudoMaximized) {
    const restoreBounds = state.restoreBounds;
    state.pseudoMaximized = false;
    state.restoreBounds = null;

    if (restoreBounds) {
      window.setBounds(restoreBounds);
      return;
    }
  }
}

function emitWindowState(window) {
  if (window.isDestroyed()) {
    return;
  }

  window.webContents.send('window:state-changed', {
    isMaximized: isWindowMaximized(window),
    isFocused: window.isFocused(),
    ...getWindowContentInsets(window),
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: '#111317',
    title: 'ForgePilot',
    icon: appIconEntry,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.setMenuBarVisibility(false);
  window.removeMenu();
  bindWindowStateEvents(window);
  window.loadFile(rendererEntry);
}

function bindWindowStateEvents(window) {
  const managedState = getManagedWindowState(window);
  const emitState = () => emitWindowState(window);
  const handleNativeMaximize = () => {
    if (process.platform !== 'win32' || managedState.pseudoMaximized) {
      emitState();
      return;
    }

    managedState.restoreBounds = window.getNormalBounds?.() ?? window.getBounds();
    managedState.pseudoMaximized = true;
    managedState.suppressNextUnmaximize = true;

    setImmediate(() => {
      if (window.isDestroyed()) {
        return;
      }

      if (window.isMaximized()) {
        window.unmaximize();
      }

      applyPseudoMaxBounds(window);
      emitState();
    });
  };
  const syncPseudoMaxBounds = () => {
    if (managedState.pseudoMaximized) {
      applyPseudoMaxBounds(window);
    }
  };
  const enforceBoundsSoon = () => {
    setImmediate(() => enforceWorkAreaBounds(window));
  };
  const clearPseudoMaxState = () => {
    if (managedState.suppressNextUnmaximize) {
      managedState.suppressNextUnmaximize = false;
      return;
    }

    if (!window.isMaximized() && !managedState.applyingPseudoBounds) {
      managedState.pseudoMaximized = false;
    }
  };

  window.on('maximize', handleNativeMaximize);
  window.on('unmaximize', () => {
    clearPseudoMaxState();
    emitState();
  });
  window.on('resize', () => {
    enforceBoundsSoon();
    emitState();
  });
  window.on('move', () => {
    enforceBoundsSoon();
    emitState();
  });
  window.on('focus', emitState);
  window.on('blur', emitState);
  window.on('restore', emitState);
  window.webContents.on('did-finish-load', emitState);

  const handleDisplayMetricsChanged = (_event, _display) => {
    syncPseudoMaxBounds();
    emitState();
  };

  screen.on('display-metrics-changed', handleDisplayMetricsChanged);
  window.on('closed', () => {
    screen.removeListener('display-metrics-changed', handleDisplayMetricsChanged);
  });
}

function registerIpc() {
  sessionService.onSessionUpdate((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('session:state-changed', payload);
      }
    }
  });

  ipcMain.handle('app:bootstrap', async () => sessionService.bootstrap());
  ipcMain.handle('app:choose-workspace', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog({
      title: 'Select Workspace',
      defaultPath: defaultPath || appRoot,
      properties: ['openDirectory'],
    });

    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('app:refresh-models', async (_event, payload) =>
    sessionService.listModelsSafe(payload?.providerId, payload?.providerConfig ?? null)
  );
  ipcMain.handle('app:save-state', async (_event, payload) => sessionService.saveAppState(payload));
  ipcMain.handle('session:create', async (_event, payload) => sessionService.createSession(payload));
  ipcMain.handle('session:get', async (_event, sessionId) => sessionService.getSession(sessionId));
  ipcMain.handle('session:import-attachments', async (_event, sessionId, attachments) =>
    sessionService.importAttachments(sessionId, attachments)
  );
  ipcMain.handle('session:update-config', async (_event, sessionId, payload) =>
    sessionService.updateSessionConfig(sessionId, payload)
  );
  ipcMain.handle('session:delete', async (_event, sessionId) =>
    sessionService.deleteSession(sessionId)
  );
  ipcMain.handle('session:cancel-run', async (_event, sessionId) =>
    sessionService.cancelActiveRun(sessionId)
  );
  ipcMain.handle('session:send', async (_event, sessionId, content) =>
    sessionService.sendUserMessage(sessionId, content)
  );
  ipcMain.handle('session:resolve-approval', async (_event, sessionId, approved) =>
    sessionService.resolveApproval(sessionId, approved)
  );
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window) {
      return { isMaximized: false, isFocused: false };
    }

    if (isWindowMaximized(window)) {
      restoreWindowSafely(window);
    } else {
      maximizeWindowSafely(window);
    }

    emitWindowState(window);
    return {
      isMaximized: isWindowMaximized(window),
      isFocused: window.isFocused(),
    };
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:get-state', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return {
      isMaximized: window ? isWindowMaximized(window) : false,
      isFocused: window?.isFocused() ?? false,
      ...(window ? getWindowContentInsets(window) : { bottomSafeArea: 0 }),
    };
  });
}

app.setName('ForgePilot');
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (shutdownComplete || isShuttingDown) {
    return;
  }

  event.preventDefault();
  isShuttingDown = true;
  void sessionService
    .shutdown()
    .catch(() => {})
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

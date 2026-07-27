const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { httpsGetJson, downloadFile } = require('./lib/http-utils');
const launcherCore = require('./lib/launcher-core');
const discordRpc = require('./lib/discord-rpc');

let mainWindow;
let runningChild = null;

const USER_DATA = app.getPath('userData');
const SETTINGS_FILE = path.join(USER_DATA, 'launcher-settings.json');
const SKIN_FILE = path.join(USER_DATA, 'local-skin.png');
const ACCOUNTS_FILE = path.join(USER_DATA, 'accounts.json');

// Everything the actual Minecraft install needs lives under GAME_ROOT.
const GAME_ROOT = path.join(USER_DATA, 'minecraft');
const VERSIONS_DIR = path.join(GAME_ROOT, 'versions'); // <version>/client.jar + <version>.json (Mojang meta)
const LIBRARIES_DIR = path.join(GAME_ROOT, 'libraries');
const ASSETS_DIR = path.join(GAME_ROOT, 'assets');
const RUNTIMES_DIR = path.join(GAME_ROOT, 'runtime'); // автоскачанные Java (по одной на нужный компонент/версию)

const DEFAULT_SETTINGS = {
  ram: '4 GB',
  gradientPrimary: '#ff2d78',
  gradientSecondary: '#8a1f5c',
  javaPath: '' // empty = лаунчер сам подберёт и скачает нужную Java под версию игры
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 820,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0a0509',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  discordRpc.connect();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (runningChild && !runningChild.killed) {
    try { runningChild.kill(); } catch (e) {}
  }
});

// window controls (custom titlebar, since frame:false)
ipcMain.on('win:minimize', () => mainWindow.minimize());
ipcMain.on('win:close', () => mainWindow.close());

// ---------- Корневая папка игры (.minecraft) ----------

ipcMain.handle('game:openFolder', async () => {
  try {
    fs.mkdirSync(GAME_ROOT, { recursive: true });
    const err = await shell.openPath(GAME_ROOT);
    return { ok: !err, message: err || '' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// ---------- Реальный запуск Minecraft ----------

function sendProgress(payload) {
  if (mainWindow) mainWindow.webContents.send('launch:progress', payload);
}
function sendLog(line) {
  if (mainWindow) mainWindow.webContents.send('launch:log', line);
}

ipcMain.handle('game:launch', async (event, { nickname, version, ram }) => {
  if (runningChild && !runningChild.killed) {
    return { ok: false, message: 'Игра уже запущена' };
  }

  const clientJarPath = path.join(VERSIONS_DIR, version, 'client.jar');
  if (!fs.existsSync(clientJarPath)) {
    return { ok: false, message: `client.jar для ${version} не найден — сначала скачай версию` };
  }

  const settings = loadSettings();
  // Пусто (по умолчанию) — лаунчер сам подберёт и скачает нужную версию Java
  // под выбранную версию игры. Путь используется только если задан вручную.
  const javaPath = settings.javaPath && settings.javaPath.trim() ? settings.javaPath.trim() : null;
  const ramGb = parseInt(ram, 10) || 4;

  try {
    const child = await launcherCore.launch({
      versionId: version,
      clientJarPath,
      gameRoot: GAME_ROOT,
      librariesDir: LIBRARIES_DIR,
      assetsDir: ASSETS_DIR,
      runtimesDir: RUNTIMES_DIR,
      nickname,
      ramGb,
      javaPath,
      onProgress: sendProgress,
      onLog: sendLog
    });

    runningChild = child;
    sendProgress({ stage: 'running', message: `Minecraft ${version} запущен` });
    discordRpc.setPlayingActivity(version, nickname);

    child.on('close', (code) => {
      sendProgress({ stage: 'closed', message: `Minecraft закрыт (код ${code})`, code });
      runningChild = null;
      discordRpc.setIdleActivity();
    });
    child.on('error', (err) => {
      sendLog(`[SolaLauncher] Ошибка процесса java: ${err.message}`);
      sendProgress({ stage: 'error', message: `Не удалось запустить java: ${err.message}` });
      runningChild = null;
      discordRpc.setIdleActivity();
    });

    return { ok: true, message: `Запуск ${version} для ${nickname} (${ramGb} GB)` };
  } catch (e) {
    sendLog(`[SolaLauncher] Ошибка запуска: ${e.message}`);
    return { ok: false, message: `Не удалось подготовить запуск: ${e.message}` };
  }
});

ipcMain.handle('game:pickJava', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери java / javaw',
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- Версии (GitHub: MagicDippyEgg/Minecraft-Version-Archive) ----------

const VERSIONS_REPO = 'MagicDippyEgg/Minecraft-Version-Archive';

ipcMain.handle('versions:list', async () => {
  // У GitHub жёсткий лимit в 100 элементов на страницу. В архиве уже больше
  // 100 релизов (там вся официальная история от 1.0 до последней версии),
  // поэтому без пагинации самые старые версии просто не попадут в список.
  // Идём по страницам, пока не получим "неполную" страницу (< 100 записей).
  const allReleases = [];
  for (let page = 1; page <= 20; page++) {
    const pageReleases = await httpsGetJson(
      `https://api.github.com/repos/${VERSIONS_REPO}/releases?per_page=100&page=${page}`,
      { 'User-Agent': 'SolaLauncher', Accept: 'application/vnd.github+json' }
    );
    if (!Array.isArray(pageReleases) || pageReleases.length === 0) break;
    allReleases.push(...pageReleases);
    if (pageReleases.length < 100) break; // это была последняя страница
  }

  const list = allReleases
    .map(rel => {
      const clientAsset = (rel.assets || []).find(a => a.name === 'client.jar');
      if (!clientAsset) return null;
      return {
        version: rel.tag_name,
        publishedAt: rel.published_at,
        clientUrl: clientAsset.browser_download_url,
        downloaded: fs.existsSync(path.join(VERSIONS_DIR, rel.tag_name, 'client.jar'))
      };
    })
    .filter(Boolean);

  // Некоторые версии могут лежать в папке versions локально (например,
  // скачанные раньше и больше не попадающие в список релизов, или
  // добавленные вручную), но отсутствовать среди релизов GitHub. Их тоже
  // нужно показать в списке — иначе фильтр "установленные" их потеряет.
  try {
    const knownVersions = new Set(list.map(v => v.version));
    const localDirs = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true });
    for (const dirent of localDirs) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      if (knownVersions.has(name)) continue;
      if (!fs.existsSync(path.join(VERSIONS_DIR, name, 'client.jar'))) continue;
      list.push({
        version: name,
        publishedAt: null,
        clientUrl: null,
        downloaded: true
      });
    }
  } catch (e) {
    // папки versions ещё может не существовать при первом запуске — это нормально
  }

  return list;
});

ipcMain.handle('versions:download', async (event, { version, clientUrl }) => {
  const dest = path.join(VERSIONS_DIR, version, 'client.jar');
  if (fs.existsSync(dest)) return { ok: true, path: dest, cached: true };
  const savedPath = await downloadFile(clientUrl, dest);
  return { ok: true, path: savedPath, cached: false };
});

// ---------- Настройки лаунчера ----------

ipcMain.handle('settings:get', async () => loadSettings());

ipcMain.handle('settings:save', async (event, settings) => {
  const merged = { ...loadSettings(), ...settings };
  saveSettings(merged);
  return merged;
});

// ---------- Локальный скин игрока ----------
// Никакого стороннего сервиса авторизации/скинов — просто выбор PNG-файла
// с диска пользователя, который хранится локально и показывается в лаунчере.

ipcMain.handle('skin:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери файл скина (PNG, 64x64 или 64x32)',
    filters: [{ name: 'PNG изображения', extensions: ['png'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;

  const src = res.filePaths[0];
  const buf = fs.readFileSync(src);
  fs.mkdirSync(path.dirname(SKIN_FILE), { recursive: true });
  fs.writeFileSync(SKIN_FILE, buf);

  return `data:image/png;base64,${buf.toString('base64')}`;
});

ipcMain.handle('skin:get', async () => {
  try {
    const buf = fs.readFileSync(SKIN_FILE);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('skin:clear', async () => {
  try { fs.unlinkSync(SKIN_FILE); } catch (e) {}
  return { ok: true };
});

// ---------- Офлайн-аккаунты (список, как в Legacy Launcher) ----------
// Каждый аккаунт — это просто ник (никакой авторизации, всё офлайн).
// Храним список + id текущего выбранного, чтобы можно было быстро
// переключаться между "профилями" без перепечатывания ника.

const NICK_RE = /^[A-Za-z0-9_]{1,16}$/;

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!Array.isArray(data.accounts)) data.accounts = [];
    return data;
  } catch (e) {
    return { accounts: [], activeId: null };
  }
}

function saveAccounts(data) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data));
}

ipcMain.handle('accounts:list', async () => loadAccounts());

ipcMain.handle('accounts:add', async (event, nickname) => {
  const nick = (nickname || '').trim();
  if (!NICK_RE.test(nick)) {
    throw new Error('Ник должен быть 1-16 символов: латинские буквы, цифры и _');
  }
  const data = loadAccounts();
  if (data.accounts.some(a => a.nickname.toLowerCase() === nick.toLowerCase())) {
    throw new Error('Такой аккаунт уже добавлен');
  }
  const account = { id: crypto.randomUUID(), nickname: nick };
  data.accounts.push(account);
  data.activeId = account.id; // новый аккаунт сразу становится выбранным
  saveAccounts(data);
  return data;
});

ipcMain.handle('accounts:remove', async (event, id) => {
  const data = loadAccounts();
  data.accounts = data.accounts.filter(a => a.id !== id);
  if (data.activeId === id) {
    data.activeId = data.accounts.length ? data.accounts[0].id : null;
  }
  saveAccounts(data);
  return data;
});

ipcMain.handle('accounts:setActive', async (event, id) => {
  const data = loadAccounts();
  if (data.accounts.some(a => a.id === id)) {
    data.activeId = id;
    saveAccounts(data);
  }
  return data;
});

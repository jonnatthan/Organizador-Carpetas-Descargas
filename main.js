const { app, BrowserWindow, ipcMain, shell, Notification, Tray, Menu, nativeImage, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const E = require('./engine');

const DOWNLOADS = app.getPath('downloads');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

let win = null, promptWin = null, tray = null, watcher = null;
let config = {
  auto: true, promptOnDownload: true, destRoot: DOWNLOADS, duplicates: 'archivar', rename: true,
  telegram: { enabled: false, chatId: '', tokenEnc: '' }, telegramQueue: [],
  rules: [], history: [], pending: [],
};
const settling = new Map();
const busy = new Set();
const textCache = new Map(); // name -> { key, text }
const promptQueue = []; // cola de archivos esperando renombrado en ventana emergente

// ================= Configuración =================
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
  if (typeof config.promptOnDownload !== 'boolean') config.promptOnDownload = true;
  config.rules = config.rules.map(r => r.searchIn ? r : { ...r, searchIn: r.type === 'extension' ? 'extension' : 'nombre' });
  if (!fs.existsSync(config.destRoot)) config.destRoot = DOWNLOADS;
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  config.history = config.history.slice(-1000);
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}
const ui = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
const getToken = () => {
  try { return config.telegram.tokenEnc ? safeStorage.decryptString(Buffer.from(config.telegram.tokenEnc, 'base64')) : ''; } catch { return ''; }
};

// ================= Utilidades de archivos =================
function uniqueTarget(dir, name) {
  let t = path.join(dir, name);
  const { name: b, ext } = path.parse(name);
  let i = 2;
  while (fs.existsSync(t)) t = path.join(dir, `${b}_${i++}${ext}`);
  return t;
}
function moveSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(src, dest); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(src, dest); fs.unlinkSync(src); }
}
function isLocked(file) {
  try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); return false; } catch { return true; }
}
const safeFolder = n => String(n || '').split(/[\\/]/).map(s => s.replace(/[<>:"|?*]/g, '').trim()).filter(Boolean).join(path.sep);
const safeFileName = n => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();

async function getText(name) {
  const full = path.join(DOWNLOADS, name);
  let st; try { st = fs.statSync(full); } catch { return ''; }
  const key = st.size + ':' + st.mtimeMs;
  const c = textCache.get(name);
  if (c && c.key === key) return c.text;
  const text = await E.extractText(full);
  textCache.set(name, { key, text });
  return text;
}

async function listFiles() {
  const out = [];
  for (const d of fs.readdirSync(DOWNLOADS, { withFileTypes: true })) {
    if (!d.isFile() || E.isTemp(d.name)) continue;
    const full = path.join(DOWNLOADS, d.name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    const text = st.size < 30e6 ? await getText(d.name) : '';
    const c = E.classify(d.name, text, config.rules);
    out.push({ name: d.name, size: st.size, mtime: st.mtimeMs, folder: c?.folder || null, reason: c?.reason || null, priority: !!c?.rule?.priority });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function listFolders() {
  const root = config.destRoot;
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => {
      let count = 0; try { count = fs.readdirSync(path.join(root, d.name)).length; } catch {}
      return { name: d.name, count };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// ================= Historial / duplicados =================
function record(entry) {
  const e = { id: (config.history.at(-1)?.id || 0) + 1, at: Date.now(), reverted: false, ...entry };
  config.history.push(e);
  saveConfig();
  return e;
}
function knownHash(hash) {
  for (let i = config.history.length - 1; i >= 0; i--) {
    const e = config.history[i];
    if (e.hash === hash && !e.reverted && e.action === 'movido' && fs.existsSync(e.dest)) return e;
  }
  return null;
}

// ================= Ventana emergente para renombrar al descargar =================
async function buildPromptPayload(name) {
  const src = path.join(DOWNLOADS, name);
  if (!fs.existsSync(src)) return null;
  const st = fs.statSync(src);
  const text = st.size < 30e6 ? await getText(name) : '';
  const c = E.classify(name, text, config.rules);
  const parsed = path.parse(name);
  const v = E.variables(src, text, c?.rule, st.mtimeMs);
  const folder = c ? E.render(c.rule?.folder || c.folder, v, true) : 'Documentos';
  let suggestedName = name;
  if (config.rename && c?.rule?.template) suggestedName = E.render(c.rule.template, v);
  const suggestedBase = path.parse(suggestedName).name;
  const folders = [...new Set([...listFolders().map(f => f.name), ...Object.keys(E.CATEGORIES)])].sort();
  return {
    name,
    baseName: parsed.name,
    ext: parsed.ext,
    suggestedBase,
    folder,
    reason: c?.reason || 'Sin regla previa · elige carpeta',
    size: st.size,
    folders,
  };
}

function showPromptWindow() {
  if (!promptQueue.length) {
    if (promptWin && !promptWin.isDestroyed()) promptWin.close();
    return;
  }
  const current = { ...promptQueue[0], queueLen: promptQueue.length };
  if (!promptWin || promptWin.isDestroyed()) {
    promptWin = new BrowserWindow({
      width: 520, height: 430, resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, backgroundColor: '#0b2236',
      title: 'Nueva descarga detectada', autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#0f172a', height: 32 },
      icon: path.join(__dirname, 'renderer', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    promptWin.loadFile(path.join(__dirname, 'renderer', 'prompt.html'));
    promptWin.on('closed', () => { promptWin = null; });
  } else {
    promptWin.show();
    promptWin.focus();
    promptWin.webContents.send('prompt-data', current);
  }
}

async function enqueuePrompt(name) {
  if (promptQueue.some(p => p.name === name)) return;
  const payload = await buildPromptPayload(name);
  if (!payload) return;
  promptQueue.push(payload);
  showPromptWindow();
}

// ================= Procesamiento principal =================
/** Procesa un archivo de Descargas: duplicado → contenido → regla → renombrar → mover → Telegram. */
async function processFile(name, { manualFolder = null, customNewName = null, auto = false } = {}) {
  if (busy.has(name)) return null;
  busy.add(name);
  try {
    const src = path.join(DOWNLOADS, name);
    if (!fs.existsSync(src) || E.isTemp(name)) return null;
    if (isLocked(src)) { if (auto) scheduleCheck(name, 3000); return null; }

    const hash = await E.sha256(src);
    const prev = knownHash(hash);
    if (prev && config.duplicates !== 'ignorar') {
      if (config.duplicates === 'eliminar') {
        await shell.trashItem(src);
        record({ action: 'duplicado_eliminado', src, dest: null, name, folder: 'Papelera', hash, original: prev.dest, auto });
      } else {
        const dest = uniqueTarget(path.join(config.destRoot, '_Duplicados'), name);
        moveSafe(src, dest);
        record({ action: 'duplicado_archivado', src, dest, name, folder: '_Duplicados', hash, original: prev.dest, auto });
      }
      ui('toast', { msg: `♻️ "${name}" es duplicado de ${path.basename(prev.dest)}`, warn: true });
      config.pending = config.pending.filter(p => p !== name);
      return { duplicate: true };
    }

    const text = await getText(name);
    const c = E.classify(name, text, config.rules);
    let folder, newName = name, reason, rule = c?.rule || null;

    if (manualFolder) {
      folder = safeFolder(manualFolder);
      reason = c?.reason || 'Asignado al descargar';
    } else {
      if (!c) {
        if (!config.pending.includes(name)) {
          config.pending.push(name); saveConfig();
          new Notification({ title: 'Archivo no identificado', body: `"${name}" no coincide con ninguna regla. Ábrelo en el Organizador para asignarle una carpeta.` })
            .on('click', showWindow).show();
          ui('unknown', { name });
        }
        return null;
      }
      reason = c.reason;
      const st = fs.statSync(src);
      const v = E.variables(src, text, rule, st.mtimeMs);
      folder = E.render(rule?.folder || c.folder, v, true);
      if (config.rename && rule?.template) newName = E.render(rule.template, v);
    }

    if (customNewName) {
      const cleaned = safeFileName(customNewName);
      if (cleaned) newName = cleaned;
    }

    const dest = uniqueTarget(path.join(config.destRoot, folder), newName);
    moveSafe(src, dest);
    config.pending = config.pending.filter(p => p !== name);
    const entry = record({ action: 'movido', src, dest, name, newName: path.basename(dest), folder, hash, reason, auto });
    if (rule?.priority) sendTelegram(dest, rule, folder, reason);
    return entry;
  } finally {
    busy.delete(name);
  }
}

// Espera a que el tamaño se estabilice (descarga terminada).
function scheduleCheck(name, delay = 1500) {
  const s = settling.get(name);
  clearTimeout(s?.t);
  const t = setTimeout(async () => {
    const full = path.join(DOWNLOADS, name);
    let size; try { size = fs.statSync(full).size; } catch { settling.delete(name); return; }
    if (size !== settling.get(name)?.size || size === 0) { settling.set(name, { size }); return scheduleCheck(name, delay); }
    if (isLocked(full)) { settling.set(name, { size }); return scheduleCheck(name, 2000); }
    settling.delete(name);

    try {
      if (config.promptOnDownload) {
        await enqueuePrompt(name);
      } else {
        const r = await processFile(name, { auto: true });
        if (r && !r.duplicate) ui('toast', { msg: `🤖 ${name} → ${r.folder}${r.newName !== name ? ` (${r.newName})` : ''}` });
      }
    } catch (e) { console.error(e); }
    ui('refresh');
  }, delay);
  settling.set(name, { size: s?.size, t });
}
function startWatcher() {
  if (watcher) watcher.close();
  watcher = fs.watch(DOWNLOADS, (evt, name) => {
    if (!name || name.includes(path.sep) || E.isTemp(name)) return;
    if (config.auto) scheduleCheck(name); else ui('refresh');
  });
}
async function organizeAll() {
  const r = { moved: 0, duplicates: 0, unknown: [] };
  const files = (await listFiles()).sort((a, b) => /\(\d+\)$/.test(path.parse(a.name).name) - /\(\d+\)$/.test(path.parse(b.name).name));
  for (const f of files) {
    try {
      const res = await processFile(f.name);
      if (res?.duplicate) r.duplicates++; else if (res) r.moved++; else r.unknown.push(f.name);
    } catch (e) { console.error(e); }
  }
  return r;
}

// ================= Telegram =================
async function telegramCall(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${getToken()}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(j.description || res.statusText); err.status = res.status; err.retry = j.parameters?.retry_after; throw err; }
  return j;
}
async function sendTelegramTask(task) {
  const f = new FormData();
  f.append('chat_id', config.telegram.chatId);
  f.append('parse_mode', 'HTML');
  const exists = fs.existsSync(task.file);
  if (exists && fs.statSync(task.file).size <= 45 * 1024 * 1024) {
    f.append('caption', task.caption.slice(0, 1024));
    f.append('document', new Blob([fs.readFileSync(task.file)]), path.basename(task.file));
    await telegramCall('sendDocument', f);
  } else {
    f.append('text', task.caption + '\n\n(archivo no adjuntado: supera 45 MB)');
    await telegramCall('sendMessage', f);
  }
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function sendTelegram(file, rule, folder, reason) {
  if (!config.telegram.enabled || !getToken() || !config.telegram.chatId) return;
  const caption = `📄 <b>${esc(rule.entity || rule.pattern)}</b> ${esc(rule.detail || '')}\nArchivo: <code>${esc(path.basename(file))}</code>\nCarpeta: ${esc(folder)}\nMotivo: ${esc(reason)}`;
  config.telegramQueue.push({ file, caption, tries: 0 });
  saveConfig();
  flushTelegram();
}
let flushing = false;
async function flushTelegram() {
  if (flushing || !config.telegram.enabled || !getToken()) return;
  flushing = true;
  while (config.telegramQueue.length) {
    const task = config.telegramQueue[0];
    try {
      await sendTelegramTask(task);
      config.telegramQueue.shift(); saveConfig();
      ui('toast', { msg: `📨 Enviado a Telegram: ${path.basename(task.file)}` });
    } catch (e) {
      task.tries++;
      if ((e.status >= 400 && e.status < 500 && e.status !== 429) || task.tries > 6) {
        config.telegramQueue.shift(); saveConfig();
        ui('toast', { msg: `Telegram: ${e.message}`, warn: true });
        continue;
      }
      saveConfig();
      const wait = (e.retry || Math.min(2 ** task.tries * 5, 300)) * 1000;
      flushing = false;
      setTimeout(flushTelegram, wait);
      return;
    }
  }
  flushing = false;
}

// ================= IPC =================
ipcMain.handle('state', async () => {
  config.pending = config.pending.filter(n => fs.existsSync(path.join(DOWNLOADS, n)));
  return {
    downloads: DOWNLOADS, destRoot: config.destRoot, files: await listFiles(), folders: listFolders(),
    rules: config.rules, auto: config.auto, promptOnDownload: config.promptOnDownload, pending: config.pending,
    history: config.history.slice(-50).reverse(), categories: Object.keys(E.CATEGORIES),
    settings: {
      duplicates: config.duplicates, rename: config.rename, promptOnDownload: config.promptOnDownload,
      telegram: { enabled: config.telegram.enabled, chatId: config.telegram.chatId, hasToken: !!getToken() },
      queue: config.telegramQueue.length,
    },
  };
});
ipcMain.handle('create-folder', (_, n) => { const s = safeFolder(n); if (s) fs.mkdirSync(path.join(config.destRoot, s), { recursive: true }); return s; });
ipcMain.handle('move', async (_, names, folder) => {
  const out = [];
  for (const n of names) { try { out.push(await processFile(n, { manualFolder: folder })); } catch (e) { out.push({ error: e.message }); } }
  return out;
});
ipcMain.handle('organize-all', () => organizeAll());
ipcMain.handle('set-auto', (_, v) => { config.auto = !!v; saveConfig(); return config.auto; });
ipcMain.handle('set-prompt-download', (_, v) => { config.promptOnDownload = !!v; saveConfig(); return config.promptOnDownload; });
ipcMain.handle('open-prompt-for', (_, name) => enqueuePrompt(name));
ipcMain.handle('get-prompt-data', () => promptQueue.length ? { ...promptQueue[0], queueLen: promptQueue.length } : null);
ipcMain.handle('resolve-prompt', async (_, d) => {
  const idx = promptQueue.findIndex(p => p.name === d.origName);
  if (idx !== -1) promptQueue.splice(idx, 1);
  if (d.action === 'save') {
    if (d.rememberExt && d.folder) {
      config.rules.unshift({ id: Date.now(), searchIn: 'extension', pattern: d.rememberExt, folder: safeFolder(d.folder) });
      saveConfig();
    }
    const r = await processFile(d.origName, { manualFolder: d.folder, customNewName: d.newName, auto: true });
    if (r && !r.duplicate) ui('toast', { msg: `✅ Guardado como "${r.newName}" en ${r.folder}` });
  }
  ui('refresh');
  showPromptWindow();
  return true;
});
ipcMain.handle('add-rule', (_, rule) => {
  rule.id = Date.now() + Math.random();
  config.rules.unshift(rule); saveConfig(); return config.rules;
});
ipcMain.handle('delete-rule', (_, id) => { config.rules = config.rules.filter(r => r.id !== id); saveConfig(); return config.rules; });
ipcMain.handle('assign', async (_, name, folder, searchIn, pattern) => {
  if (searchIn && pattern) config.rules.unshift({ id: Date.now(), searchIn, pattern, folder: safeFolder(folder) });
  saveConfig();
  return processFile(name, { manualFolder: folder });
});
ipcMain.handle('undo', () => {
  const last = [...config.history].reverse().find(e => !e.reverted && e.dest);
  if (!last) return null;
  try {
    if (!fs.existsSync(last.dest)) return { error: 'El archivo ya no existe en el destino' };
    const back = fs.existsSync(last.src) ? uniqueTarget(DOWNLOADS, path.basename(last.src)) : last.src;
    moveSafe(last.dest, back);
    last.reverted = true; saveConfig();
    return last;
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('open-file', (_, n) => shell.openPath(path.join(DOWNLOADS, n)));
ipcMain.handle('reveal-file', (_, n) => shell.showItemInFolder(path.join(DOWNLOADS, n)));
ipcMain.handle('open-folder', (_, rel) => shell.openPath(path.join(config.destRoot, rel || '')));
ipcMain.handle('reveal-path', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('choose-dest', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Carpeta destino (puede ser Google Drive / OneDrive)', defaultPath: config.destRoot, properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled && r.filePaths[0]) { config.destRoot = r.filePaths[0]; saveConfig(); }
  return config.destRoot;
});
ipcMain.handle('save-settings', (_, s) => {
  if (s.duplicates) config.duplicates = s.duplicates;
  if (typeof s.rename === 'boolean') config.rename = s.rename;
  if (typeof s.promptOnDownload === 'boolean') config.promptOnDownload = s.promptOnDownload;
  if (s.telegram) {
    config.telegram.enabled = !!s.telegram.enabled;
    config.telegram.chatId = String(s.telegram.chatId || '').trim();
    if (s.telegram.token) config.telegram.tokenEnc = safeStorage.encryptString(s.telegram.token.trim()).toString('base64');
  }
  saveConfig();
  flushTelegram();
  return true;
});
ipcMain.handle('test-telegram', async () => {
  try {
    const f = new FormData();
    f.append('chat_id', config.telegram.chatId);
    f.append('text', '✅ Organizador de Descargas conectado correctamente.');
    await telegramCall('sendMessage', f);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ================= Ventana / bandeja =================
function showWindow() { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } }
function createWindow() {
  win = new BrowserWindow({
    width: 1340, height: 860, minWidth: 1020, minHeight: 680, backgroundColor: '#070910',
    title: 'Organizador de Descargas', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e2e8f0', height: 34 },
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    app.setAppUserModelId('com.dydjo.organizadordescargas');
    loadConfig();
    createWindow();
    startWatcher();
    flushTelegram();
    const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Organizador de Descargas');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir', click: showWindow },
      { label: 'Organizar ahora', click: async () => { await organizeAll(); ui('refresh'); } },
      { type: 'separator' },
      { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  });
}

/**
 * background.js  (Service Worker – Manifest V3)
 *
 * Responsabilidades:
 *  1. Recibir nuevas imágenes del content-script y almacenarlas por tabId.
 *  2. Exponer el estado al popup (GET_IMAGES, DELETE_IMAGE, CLEAR_ALL).
 *  3. Gestionar descargas con chrome.downloads.download.
 *  4. Persistir la lista en chrome.storage.session (se borra al cerrar el navegador)
 *     para que el popup pueda abrirse sin que el service worker esté activo.
 */

'use strict';

// ─── Estado en memoria ─────────────────────────────────────────────────────
/**
 * Mapa { tabId → Map<url, ImageEntry> }
 * ImageEntry: { url, thumbnail, timestamp, id }
 */
const tabImages = new Map();

let globalIdCounter = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Devuelve (creando si no existe) el mapa de imágenes de una pestaña.
 * @param {number} tabId
 * @returns {Map<string, object>}
 */
function getTabMap(tabId) {
  if (!tabImages.has(tabId)) {
    tabImages.set(tabId, new Map());
  }
  return tabImages.get(tabId);
}

/**
 * Añade una imagen al mapa de la pestaña si no existe ya.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {object|null}  La entrada creada, o null si ya existía.
 */
/**
 * Actualiza la insignia (badge) en el icono de la extensión para la pestaña.
 * @param {number} tabId
 */
function updateBadge(tabId) {
  if (!tabId) return;
  const count = getImages(tabId).length;
  try {
    chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? (count > 99 ? '99+' : String(count)) : ''
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#E11D48' });
  } catch (_) {}
}

/**
 * Añade una imagen al mapa de la pestaña si no existe ya.
 * Mantiene un límite máximo de 300 elementos por pestaña (FIFO).
 * @param {number} tabId
 * @param {string} url
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @returns {object|null}  La entrada creada, o null si ya existía.
 */
function addImage(tabId, url, width = 0, height = 0) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('https://') && !url.startsWith('http://') && !url.startsWith('data:image/')) return null;

  const map = getTabMap(tabId);
  if (map.has(url)) return null;

  // Límite FIFO: si supera las 300 imágenes, eliminar la más antigua
  const MAX_PER_TAB = 300;
  if (map.size >= MAX_PER_TAB) {
    const oldestKey = map.keys().next().value;
    if (oldestKey) map.delete(oldestKey);
  }

  const entry = {
    id: ++globalIdCounter,
    url,
    thumbnail: url,   // usamos la misma URL como thumbnail (se muestra en <img>)
    timestamp: Date.now(),
    width,
    height,
  };
  map.set(url, entry);
  persistTab(tabId);
  updateBadge(tabId);
  return entry;
}

/**
 * Elimina una imagen del mapa de la pestaña por URL.
 * @param {number} tabId
 * @param {string} url
 */
function deleteImage(tabId, url) {
  const map = getTabMap(tabId);
  map.delete(url);
  persistTab(tabId);
  updateBadge(tabId);
}

/**
 * Vacía todas las imágenes de una pestaña.
 * @param {number} tabId
 */
function clearTab(tabId) {
  tabImages.set(tabId, new Map());
  persistTab(tabId);
  updateBadge(tabId);
}

/**
 * Devuelve el array de entradas de una pestaña, ordenado por timestamp.
 * @param {number} tabId
 * @returns {object[]}
 */
function getImages(tabId) {
  const map = getTabMap(tabId);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Persistencia (chrome.storage.session) ────────────────────────────────

/**
 * Guarda el estado de una pestaña en chrome.storage.session.
 * Esto permite que el popup pueda leer los datos aunque el SW esté inactivo.
 * @param {number} tabId
 */
function persistTab(tabId) {
  const data = getImages(tabId);
  const key = `tab_${tabId}`;
  chrome.storage.session.set({ [key]: data }).catch(() => {
    // chrome.storage.session puede no estar disponible en algunos builds de Chrome
    // Fallback: solo memoria
  });
}

/**
 * Restaura el estado de una pestaña desde chrome.storage.session.
 * Llamado cuando el SW se reactiva y recibe un mensaje de una pestaña conocida.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function restoreTab(tabId) {
  if (tabImages.has(tabId)) return; // ya en memoria
  try {
    const key = `tab_${tabId}`;
    const result = await chrome.storage.session.get(key);
    const entries = result[key] || [];
    const map = new Map();
    for (const entry of entries) {
      map.set(entry.url, entry);
      if (entry.id > globalIdCounter) globalIdCounter = entry.id;
    }
    tabImages.set(tabId, map);
  } catch (_) {
    // Sin acceso a session storage; trabajamos solo en memoria
  }
}

// ─── Descarga de imágenes ─────────────────────────────────────────────────

/**
 * Descarga una lista de URLs usando chrome.downloads.
 * Cada archivo se nombra: imgsaver_<timestamp>_<n>.<ext>
 * @param {string[]} urls
 * @returns {Promise<{ok: string[], failed: string[]}>}
 */
async function downloadImages(urls) {
  const results = { ok: [], failed: [] };
  const ts = Date.now();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ext = url.match(/\.(jpg|jpeg|png|webp|gif|avif)/i)?.[1] || 'jpg';
    const filename = `imgsaver_${ts}_${i + 1}.${ext}`;

    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            reject(chrome.runtime.lastError?.message || 'Download failed');
          } else {
            resolve(downloadId);
          }
        });
      });
      results.ok.push(url);
    } catch (err) {
      console.error('[ImgSaver] Error al descargar', url, err);
      results.failed.push(url);
    }
  }

  return results;
}

// ─── Listener de mensajes ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  if (!tabId && message.type !== 'DOWNLOAD_IMAGES') {
    sendResponse({ error: 'No tabId' });
    return false;
  }

  switch (message.type) {

    // Desde content-script: nueva imagen detectada
    case 'NEW_IMAGE': {
      if (!sender.tab?.id) {
        sendResponse({ error: 'Unauthorized sender' });
        return false;
      }
      restoreTab(tabId).then(() => {
        const entry = addImage(tabId, message.url, message.width || 0, message.height || 0);
        if (entry) {
          // Notificar al popup si está abierto (broadcast al runtime)
          chrome.runtime.sendMessage({ type: 'IMAGE_ADDED', tabId, entry }).catch(() => {
            // El popup no está abierto; ignorar
          });
        }
        sendResponse({ ok: true });
      });
      return true; // respuesta asíncrona
    }

    // Desde popup: obtener lista de imágenes de la pestaña activa
    case 'GET_IMAGES': {
      restoreTab(tabId).then(() => {
        sendResponse({ images: getImages(tabId) });
      });
      return true;
    }

    // Desde popup: capturar pantalla de la pestaña activa
    case 'CAPTURE_SCREENSHOT': {
      restoreTab(tabId).then(() => {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            sendResponse({ error: chrome.runtime.lastError?.message || 'Error al capturar pantalla' });
            return;
          }
          const entry = addImage(tabId, dataUrl, 0, 0);
          if (entry) {
            chrome.runtime.sendMessage({ type: 'IMAGE_ADDED', tabId, entry }).catch(() => {});
          }
          sendResponse({ ok: true, dataUrl, entry });
        });
      });
      return true; // respuesta asíncrona
    }

    // Desde popup: eliminar una imagen
    case 'DELETE_IMAGE': {
      deleteImage(tabId, message.url);
      sendResponse({ ok: true });
      return false;
    }

    // Desde popup: limpiar todas las imágenes de la pestaña
    case 'CLEAR_ALL': {
      clearTab(tabId);
      sendResponse({ ok: true });
      return false;
    }

    // Desde popup: descargar imágenes seleccionadas
    case 'DOWNLOAD_IMAGES': {
      downloadImages(message.urls).then((results) => {
        sendResponse(results);
      });
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// ─── Limpiar datos cuando se cierra una pestaña ───────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabImages.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
});

console.log('[Photo radar] background service worker iniciado.');

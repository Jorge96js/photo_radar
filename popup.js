/**
 * popup.js  –  Photo radar Chrome Extension
 *
 * Responsabilidades:
 *  1. Obtener la pestaña activa y solicitar su lista de imágenes al background.
 *  2. Renderizar las tarjetas de imagen en el grid.
 *  3. Gestionar selección, descarga, borrado y limpieza.
 *  4. Escuchar mensajes IMAGE_ADDED del background para actualización en tiempo real.
 */

'use strict';

// ─── Estado local del popup ────────────────────────────────────────────────
/** @type {Map<string, {url:string, thumbnail:string, timestamp:number, id:number}>} */
const images = new Map();

/** @type {Set<string>} URLs actualmente seleccionadas */
const selected = new Set();

/** @type {number} ID de la pestaña activa */
let activeTabId = null;

// ─── Referencias al DOM ────────────────────────────────────────────────────
const imgGrid        = document.getElementById('imgGrid');
const emptyState     = document.getElementById('emptyState');
const imgCount       = document.getElementById('imgCount');
const selectionInfo  = document.getElementById('selectionInfo');
const btnSelectAll   = document.getElementById('btnSelectAll');
const btnDeselectAll = document.getElementById('btnDeselectAll');
const btnCaptureScreen = document.getElementById('btnCaptureScreen');
const btnDeleteSel   = document.getElementById('btnDeleteSelected');
const btnClearAll    = document.getElementById('btnClearAll');
const btnDownload    = document.getElementById('btnDownload');
const btnDownloadZip = document.getElementById('btnDownloadZip');

// ─── Inicialización ────────────────────────────────────────────────────────

(async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    activeTabId = tab.id;

    // Solicitar lista actual al background
    const response = await sendMessage({ type: 'GET_IMAGES', tabId: activeTabId });
    if (response?.images) {
      for (const entry of response.images) {
        images.set(entry.url, entry);
      }
      renderAll();
    }

    // Escuchar nuevas imágenes en tiempo real
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (err) {
    console.error('[Photo radar popup] Error en init:', err);
  }
})();

// ─── Comunicación con el background ───────────────────────────────────────

/**
 * Envía un mensaje al background y devuelve la promesa de respuesta.
 * @param {object} msg
 * @returns {Promise<any>}
 */
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Listener para mensajes del background (ej: IMAGE_ADDED).
 * @param {object} message
 */
function onRuntimeMessage(message) {
  if (message.type === 'IMAGE_ADDED' && message.tabId === activeTabId) {
    if (!images.has(message.entry.url)) {
      images.set(message.entry.url, message.entry);
      addCard(message.entry);
      updateUI();
    }
  }
}

// ─── Renderizado ───────────────────────────────────────────────────────────

/** Renderiza todas las imágenes del estado desde cero. */
function renderAll() {
  imgGrid.innerHTML = '';
  for (const entry of [...images.values()].sort((a, b) => a.timestamp - b.timestamp)) {
    addCard(entry);
  }
  updateUI();
}

/**
 * Crea y añade una tarjeta de imagen al grid.
 * @param {{url:string, thumbnail:string, id:number}} entry
 */
function addCard(entry) {
  const { url, thumbnail } = entry;
  if (!url || typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://') && !url.startsWith('data:image/'))) return;
  const safeThumb = (thumbnail && typeof thumbnail === 'string' && (thumbnail.startsWith('https://') || thumbnail.startsWith('http://') || thumbnail.startsWith('data:image/'))) ? thumbnail : url;

  const card = document.createElement('div');
  card.className = 'img-card';
  card.dataset.url = url;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', 'Imagen detectada');
  card.setAttribute('tabindex', '0');

  // Checkmark
  card.innerHTML = `
    <div class="card-check" aria-hidden="true">
      <svg viewBox="0 0 12 12" fill="none">
        <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <img data-loading src="${escapeHtml(safeThumb)}" alt="Imagen detectada" crossorigin="anonymous"/>
    <a class="card-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
       title="Abrir en nueva pestaña" aria-label="Abrir imagen en nueva pestaña"
       id="open_${entry.id}">
      <svg viewBox="0 0 14 14" fill="none">
        <path d="M5 2H2v10h10v-3M8 2h4v4M12 2L7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </a>
  `;

  // Fade-in al cargar la imagen
  const img = card.querySelector('img');
  img.addEventListener('load', () => {
    img.removeAttribute('data-loading');
    img.classList.add('loaded');
  });
  img.addEventListener('error', () => {
    // Mostrar un placeholder degradado si la imagen no carga (CORS, etc.)
    img.removeAttribute('data-loading');
    img.classList.add('loaded');
    img.style.opacity = '0.2';
    card.classList.add('shimmer');
  });

  // Click para seleccionar/deseleccionar (pero no si se hace clic en "abrir")
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-open')) return; // dejar que navegue
    toggleSelect(url, card);
  });

  // Soporte teclado
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleSelect(url, card);
    }
  });

  imgGrid.appendChild(card);
}

// ─── Selección ─────────────────────────────────────────────────────────────

/**
 * Alterna la selección de una imagen.
 * @param {string} url
 * @param {HTMLElement} card
 */
function toggleSelect(url, card) {
  if (selected.has(url)) {
    selected.delete(url);
    card.classList.remove('selected');
  } else {
    selected.add(url);
    card.classList.add('selected');
  }
  updateUI();
}

/** Selecciona todas las imágenes visibles. */
function selectAll() {
  for (const card of imgGrid.querySelectorAll('.img-card')) {
    const url = card.dataset.url;
    selected.add(url);
    card.classList.add('selected');
  }
  updateUI();
}

/** Deselecciona todas las imágenes. */
function deselectAll() {
  selected.clear();
  for (const card of imgGrid.querySelectorAll('.img-card')) {
    card.classList.remove('selected');
  }
  updateUI();
}

// ─── Actualizaciones de UI ─────────────────────────────────────────────────

/** Actualiza contadores, botones y visibilidad del empty state. */
function updateUI() {
  const total = images.size;
  const selCount = selected.size;

  imgCount.textContent = `${total} imagen${total !== 1 ? 'es' : ''}`;
  selectionInfo.textContent = `${selCount} seleccionada${selCount !== 1 ? 's' : ''}`;

  btnDownload.disabled    = selCount === 0;
  btnDownloadZip.disabled = selCount === 0;
  btnDeleteSel.disabled   = selCount === 0;

  emptyState.classList.toggle('visible', total === 0);
  imgGrid.style.display = total > 0 ? 'grid' : 'none';
}

// ─── Acciones ──────────────────────────────────────────────────────────────

/**
 * Descarga una URL como blob para evitar el problema del .txt.
 * Usa fetch() desde el contexto del popup (que tiene host_permissions sobre los CDN)
 * para obtener los bytes reales y forzar el tipo MIME correcto.
 * @param {string} url
 * @param {string} filename
 */
async function downloadAsBlob(url, filename) {
  // 1. Obtener la imagen como blob (soporta http/https y data URLs)
  let blob;
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    blob = await res.blob();
  } else {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  }

  // 2. Determinar extensión real desde el Content-Type
  const mime = blob.type || 'image/jpeg';
  const extFromMime = {
    'image/jpeg': 'jpg',
    'image/jpg':  'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/gif':  'gif',
  }[mime] || 'jpg';

  // Reemplazar cualquier extensión en el filename con la correcta
  const finalFilename = filename.replace(/\.[^.]+$/, `.${extFromMime}`);

  // 3. Crear un objeto URL temporal y disparar la descarga
  const blobUrl = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: blobUrl, filename: finalFilename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(chrome.runtime.lastError?.message || 'Download failed');
        } else {
          resolve(downloadId);
        }
      }
    );
  });

  // 4. Revocar después de que el navegador haya iniciado la descarga
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
}

/** Descarga las imágenes seleccionadas como blobs reales (no .txt). */
async function downloadSelected() {
  if (selected.size === 0) return;

  const urls = [...selected];
  const ts = Date.now();
  btnDownload.disabled = true;
  btnDownload.textContent = `Descargando 0/${urls.length}…`;

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < urls.length; i++) {
    btnDownload.textContent = `Descargando ${i + 1}/${urls.length}…`;
    const filename = `imgsaver_${ts}_${i + 1}.jpg`; // la extensión real se sobreescribe en downloadAsBlob
    try {
      await downloadAsBlob(urls[i], filename);
      okCount++;
    } catch (err) {
      console.error('[Photo radar] Fallo descarga:', urls[i], err);
      failCount++;
    }
  }

  // Restaurar botón
  btnDownload.innerHTML = `
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M10 3v10M10 13l-3-3M10 13l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Descargar seleccionadas
  `;
  updateUI();

  if (failCount > 0) {
    showToast(`${okCount} descargadas · ${failCount} fallaron`, 'error');
  } else {
    showToast(`${okCount} imagen${okCount !== 1 ? 'es' : ''} descargada${okCount !== 1 ? 's' : ''} ✓`, 'success');
  }
}

/** Elimina las imágenes seleccionadas del popup y del background. */
async function deleteSelected() {
  if (selected.size === 0) return;

  for (const url of [...selected]) {
    await sendMessage({ type: 'DELETE_IMAGE', tabId: activeTabId, url });
    images.delete(url);
    selected.delete(url);
    const card = imgGrid.querySelector(`.img-card[data-url="${CSS.escape(url)}"]`);
    if (card) card.remove();
  }
  updateUI();
  showToast('Imágenes eliminadas de la lista', 'success');
}

/** Limpia toda la lista de la pestaña activa. */
async function clearAll() {
  await sendMessage({ type: 'CLEAR_ALL', tabId: activeTabId });
  images.clear();
  selected.clear();
  imgGrid.innerHTML = '';
  updateUI();
  showToast('Lista limpiada', 'success');
}

// ─── Toasts ────────────────────────────────────────────────────────────────

let toastTimeout = null;

/**
 * Muestra un toast de notificación temporal.
 * @param {string} msg
 * @param {'success'|'error'|''} [type='']
 */
function showToast(msg, type = '') {
  // Reutilizar o crear elemento
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  toast.textContent = msg;
  toast.className = `toast ${type}`;
  // Forzar reflow para reiniciar la animación
  void toast.offsetWidth;
  toast.classList.add('show');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ─── ZIP Builder (vanilla JS, sin dependencias externas) ─────────────────────
/**
 * Tabla CRC-32 pre-calculada. El formato ZIP la requiere para verificar
 * la integridad de cada archivo almacenado.
 */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

/**
 * Calcula el CRC-32 de un Uint8Array.
 * @param {Uint8Array} data
 * @returns {number}
 */
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Convierte un número a 2 bytes Little Endian */
function u16(n) { return [(n >>> 0) & 0xFF, (n >>> 8) & 0xFF]; }
/** Convierte un número a 4 bytes Little Endian */
function u32(n) { return [(n >>> 0) & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

/**
 * Construye un archivo ZIP en memoria usando el método STORE (sin compresión).
 * Las imágenes JPEG/PNG/WEBP ya están comprimidas, por lo que STORE es óptimo.
 *
 * @param {{ name: string, data: Uint8Array }[]} files
 * @returns {Uint8Array}
 */
function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [];          // [localHeader, fileData, ...]
  const centralDir = [];     // entradas del directorio central
  let localOffset = 0;       // offset acumulado para el directorio central

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const checksum  = crc32(data);
    const size      = data.length;

    // ── Local File Header (firma 0x04034b50) ────────────────────────────────
    const localHeader = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04,   // signature
      0x14, 0x00,               // version needed: 2.0
      0x00, 0x00,               // general purpose bit flag
      0x00, 0x00,               // compression method: STORE (0)
      0x00, 0x00,               // last mod file time
      0x00, 0x00,               // last mod file date
      ...u32(checksum),         // CRC-32
      ...u32(size),             // compressed size
      ...u32(size),             // uncompressed size
      ...u16(nameBytes.length), // file name length
      0x00, 0x00,               // extra field length
      ...nameBytes,             // file name
    ]);

    // ── Central Directory Entry (firma 0x02014b50) ──────────────────────────
    const cdEntry = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02,   // signature
      0x3F, 0x00,               // version made by (Unix + 2.0)
      0x14, 0x00,               // version needed
      0x00, 0x00,               // general purpose bit flag
      0x00, 0x00,               // compression method: STORE
      0x00, 0x00,               // last mod file time
      0x00, 0x00,               // last mod file date
      ...u32(checksum),         // CRC-32
      ...u32(size),             // compressed size
      ...u32(size),             // uncompressed size
      ...u16(nameBytes.length), // file name length
      0x00, 0x00,               // extra field length
      0x00, 0x00,               // file comment length
      0x00, 0x00,               // disk number start
      0x00, 0x00,               // internal file attributes
      0x00, 0x00, 0x00, 0x00,   // external file attributes
      ...u32(localOffset),      // relative offset of local header
      ...nameBytes,             // file name
    ]);

    parts.push(localHeader, data);
    centralDir.push(cdEntry);
    localOffset += localHeader.length + size;
  }

  // ── End of Central Directory Record (firma 0x06054b50) ───────────────────
  const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06,   // signature
    0x00, 0x00,               // number of this disk
    0x00, 0x00,               // disk with start of central dir
    ...u16(files.length),     // total entries on this disk
    ...u16(files.length),     // total entries in central dir
    ...u32(cdSize),           // size of central dir
    ...u32(localOffset),      // offset of start of central dir
    0x00, 0x00,               // ZIP comment length
  ]);

  // ── Concatenar todo en un único Uint8Array ────────────────────────────────
  const all = [...parts, ...centralDir, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const zip = new Uint8Array(total);
  let pos = 0;
  for (const chunk of all) { zip.set(chunk, pos); pos += chunk.length; }
  return zip;
}

/**
 * Descarga las imágenes seleccionadas empaquetadas en un único archivo ZIP.
 * Proceso: fetch cada imagen como blob → buildZip() → createObjectURL → download.
 */
async function downloadAsZip() {
  if (selected.size === 0) return;

  const urls = [...selected];
  const ts   = Date.now();

  // Bloquear botón y mostrar progreso
  btnDownloadZip.disabled = true;
  btnDownload.disabled    = true;
  const origLabel = btnDownloadZip.innerHTML;
  btnDownloadZip.textContent = `Preparando 0/${urls.length}…`;

  const zipFiles = [];
  let failCount  = 0;

  for (let i = 0; i < urls.length; i++) {
    btnDownloadZip.textContent = `Preparando ${i + 1}/${urls.length}…`;
    try {
      let blob;
      if (urls[i].startsWith('data:')) {
        const res = await fetch(urls[i]);
        blob = await res.blob();
      } else {
        const resp = await fetch(urls[i], { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        blob = await resp.blob();
      }

      // Detectar extensión real desde Content-Type
      const mime = blob.type || 'image/jpeg';
      const ext  = ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
                      'image/png': 'png', 'image/webp': 'webp',
                      'image/gif': 'gif' })[mime] || 'jpg';

      const arrayBuffer = await blob.arrayBuffer();
      zipFiles.push({
        name: `binaraweb_photo_radar_${ts}_${i + 1}.${ext}`,
        data: new Uint8Array(arrayBuffer),
      });
    } catch (err) {
      console.error('[Photo radar] Error al preparar para ZIP:', urls[i], err);
      failCount++;
    }
  }

  // Restaurar botones
  btnDownloadZip.innerHTML = origLabel;
  updateUI();

  if (zipFiles.length === 0) {
    showToast('No se pudo obtener ninguna imagen', 'error');
    return;
  }

  // Construir el ZIP y descargarlo
  try {
    btnDownloadZip.textContent = 'Comprimiendo…';
    const zipData   = buildZip(zipFiles);
    const zipBlob   = new Blob([zipData], { type: 'application/zip' });
    const zipUrl    = URL.createObjectURL(zipBlob);
    const zipName   = `photo_radar_${ts}.zip`;

    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: zipUrl, filename: zipName, saveAs: false },
        (id) => {
          if (chrome.runtime.lastError || id === undefined) {
            reject(chrome.runtime.lastError?.message || 'ZIP download failed');
          } else {
            resolve(id);
          }
        }
      );
    });

    setTimeout(() => URL.revokeObjectURL(zipUrl), 15_000);

    const msg = failCount > 0
      ? `ZIP con ${zipFiles.length} imgs · ${failCount} fallaron`
      : `ZIP con ${zipFiles.length} imagen${zipFiles.length !== 1 ? 'es' : ''} descargado ✓`;
    showToast(msg, failCount > 0 ? 'error' : 'success');
  } catch (err) {
    console.error('[Photo Radar] Error al generar ZIP:', err);
    showToast('Error al generar el ZIP', 'error');
  } finally {
    btnDownloadZip.innerHTML = origLabel;
    updateUI();
  }
}

/** Captura la pantalla de la pestaña activa. */
async function captureScreen() {
  if (!activeTabId) return;
  if (btnCaptureScreen) btnCaptureScreen.disabled = true;
  try {
    const response = await sendMessage({ type: 'CAPTURE_SCREENSHOT', tabId: activeTabId });
    if (response?.ok) {
      showToast('Captura realizada ✓', 'success');
    } else {
      showToast(response?.error || 'Error al capturar pantalla', 'error');
    }
  } catch (err) {
    showToast('Error al capturar pantalla', 'error');
  } finally {
    if (btnCaptureScreen) btnCaptureScreen.disabled = false;
  }
}

// ─── Escape HTML ───────────────────────────────────────────────────────────

/**
 * Escapa caracteres especiales en HTML para prevenir XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Event Listeners ───────────────────────────────────────────────────────

btnSelectAll.addEventListener('click', selectAll);
btnDeselectAll.addEventListener('click', deselectAll);
if (btnCaptureScreen) btnCaptureScreen.addEventListener('click', captureScreen);
btnDeleteSel.addEventListener('click', deleteSelected);
btnClearAll.addEventListener('click', clearAll);
btnDownload.addEventListener('click', downloadSelected);
btnDownloadZip.addEventListener('click', downloadAsZip);

// Actualizar UI inicial
updateUI();

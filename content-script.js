/**
 * content-script.js  (world: "ISOLATED" — default)
 *
 * Actúa como puente entre el page-interceptor.js (mundo principal) y el
 * service worker (background.js):
 *  - Recibe URLs de imágenes vía window.postMessage desde page-interceptor
 *  - Escanea el DOM con MutationObserver como capa de detección adicional
 *  - Filtra duplicados y URLs irrelevantes
 *  - Reenvía cada URL nueva al background
 */

(function () {
  'use strict';

  // ─── Configuración ─────────────────────────────────────────────────────────

  /**
   * Dimensión mínima en píxeles para filtrado a nivel DOM.
   * Esto evita capturar miniaturas, íconos de UI y avatares pequeños
   * que pasan por el MutationObserver pero no son contenido principal.
   */
  const MIN_SIZE = 150;

  /**
   * Patrones para ignorar URLs que corresponden a avatares pequeños,
   * favicons, emojis, rastreadores o fuentes.
   */
  const IGNORE_PATTERNS = [
    /favicon/i,
    /emoji/i,
    /blank\.gif/i,
    /spacer\.gif/i,
    /tracking/i,
    /analytics/i,
    /pixel/i,
    /1x1/i,
  ];

  /** URLs ya enviadas al background (evita duplicados en toda la sesión) */
  const seen = new Set();

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Determina si una URL debe ignorarse.
   * @param {string} url
   */
  function shouldIgnore(url) {
    if (!url || typeof url !== 'string') return true;
    if (!url.startsWith('https://') && !url.startsWith('http://')) return true;
    // No debe ser un video o fuente
    if (/\.(mp4|mov|webm|m4v|avi|ogv|woff2?|ttf|eot)(\?|$)/i.test(url)) return true;
    return IGNORE_PATTERNS.some(re => re.test(url));
  }

  /**
   * Devuelve una "clave de deduplicación" limpiando parámetros de tracking innecesarios.
   * @param {string} url
   */
  function dedupeKey(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return url.split('?')[0];
    }
  }

  /**
   * Verifica que un elemento DOM tenga dimensiones suficientes.
   * Si aún no está pintado (0×0) se deja pasar para revisión posterior.
   * @param {Element} el
   */
  function isBigEnough(el) {
    if (!el) return true;
    const { offsetWidth: w, offsetHeight: h } = el;
    if (w === 0 && h === 0) return true;   // no pintado aún
    return w >= MIN_SIZE && h >= MIN_SIZE;
  }

  /**
   * Envía una URL al service worker de forma segura.
   * Incluye opcionalmente las dimensiones conocidas de la imagen.
   * @param {string} url
   * @param {number} [width=0]
   * @param {number} [height=0]
   */
  function sendToBackground(url, width = 0, height = 0) {
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('https://') && !url.startsWith('http://')) return;
    const key = dedupeKey(url);
    if (seen.has(key)) return;
    if (shouldIgnore(url)) return;
    seen.add(key);

    try {
      chrome.runtime.sendMessage({ type: 'NEW_IMAGE', url, width, height }, () => {
        void chrome.runtime.lastError; // silenciar si el SW está inactivo
      });
    } catch (_) {}
  }

  // ─── Listener postMessage (desde page-interceptor.js) ────────────────────

  window.addEventListener('message', (event) => {
    // Solo aceptar mensajes del mismo frame (no iframes externos)
    if (event.source !== window) return;
    if (!event.data || (event.data.source !== 'INSTASAVER_PAGE' && event.data.source !== 'IMGSAVER_PAGE')) return;
    if (event.data.type !== 'IMAGE_URL') return;

    const { url, width = 0, height = 0 } = event.data;
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('https://') && !url.startsWith('http://')) return;

    // Filtro secundario: descartar si ambas dimensiones son muy pequeñas (ej. < 120px)
    if (width > 0 && height > 0 && Math.max(width, height) < 120) return;

    sendToBackground(url, width, height);
  });

  // ─── MutationObserver (capa de detección DOM) ──────────────────────────────

  /**
   * Extrae la URL de mayor resolución de un elemento <img>.
   * Instagram usa srcset con descriptores `w`; tomamos el más grande.
   * @param {HTMLImageElement} img
   * @returns {string|null}
   */
  function bestUrlFromImg(img) {
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (srcset) {
      let bestUrl = null, bestW = 0;
      for (const part of srcset.split(',')) {
        const [url, descriptor = ''] = part.trim().split(/\s+/);
        const w = parseInt(descriptor.replace('w', ''), 10) || 0;
        if (w > bestW) { bestW = w; bestUrl = url; }
      }
      if (bestUrl) return bestUrl;
    }
    return img.getAttribute('src') || img.getAttribute('data-src') || null;
  }

  /**
   * Escanea una lista de nodos DOM en busca de imágenes relevantes.
   * Optimizado para evitar getComputedStyle masivo durante el scroll.
   * @param {Iterable<Node>} nodes
   */
  function scanNodes(nodes) {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Etiquetas <img>
      const imgs = node.tagName === 'IMG'
        ? [node]
        : [...node.querySelectorAll('img')];

      for (const img of imgs) {
        if (!isBigEnough(img)) continue;
        const url = bestUrlFromImg(img);
        if (url) sendToBackground(url, img.naturalWidth || 0, img.naturalHeight || 0);

        // Observar carga tardía (lazy)
        if (!img.complete) {
          img.addEventListener('load', () => {
            const finalUrl = bestUrlFromImg(img);
            if (finalUrl) sendToBackground(finalUrl, img.naturalWidth || 0, img.naturalHeight || 0);
          }, { once: true });
        }
      }

      // Elementos con background-image inline o específicos con atrib estilo
      const elementsWithStyle = node.hasAttribute?.('style')
        ? [node]
        : [...node.querySelectorAll('[style*="url"]')];

      for (const el of elementsWithStyle) {
        const styleStr = el.style?.backgroundImage;
        if (styleStr && styleStr !== 'none') {
          const match = styleStr.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
          if (match) sendToBackground(match[1]);
        }
      }
    }
  }

  // Escaneo inicial del DOM ya existente
  if (document.body) scanNodes([document.body]);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        scanNodes(mutation.addedNodes);
      } else if (mutation.type === 'attributes') {
        const el = mutation.target;
        if (el.tagName === 'IMG') {
          const url = bestUrlFromImg(el);
          if (url) sendToBackground(url);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'style'],
  });

  window.addEventListener('beforeunload', () => observer.disconnect());

  console.log('[Photo radar] content-script activo en', location.href);
})();

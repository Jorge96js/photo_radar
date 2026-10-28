/**
 * page-interceptor.js  (world: "MAIN")
 *
 * Este script corre en el mundo principal de la página, por lo que puede
 * acceder y sobreescribir window.fetch y XMLHttpRequest para interceptar
 * las respuestas de la API de Instagram y extraer las URLs de imágenes
 * de máxima calidad.
 *
 * Comunica los resultados al content-script (mundo aislado) mediante
 * window.postMessage con la firma { source: 'INSTASAVER_PAGE', ... }.
 */

(function () {
  'use strict';

  const MSG_SOURCE = 'IMGSAVER_PAGE';

  /**
   * Dimensión mínima (en píxeles) que debe tener el lado más corto de una
   * imagen para ser considerada contenido relevante si se conocen las dimensiones.
   */
  const MIN_API_SIZE = 150;

  // ─── Utilidades de extracción ──────────────────────────────────────────────

  /**
   * Devuelve true si la URL corresponde a una imagen válida en HTTP/HTTPS.
   * @param {string} url
   */
  function isValidImageUrl(url) {
    if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
      return false;
    }
    // Descartar videos y fuentes
    if (/\.(mp4|mov|webm|m4v|avi|ogv|woff2?|ttf|eot)(\?|$)/i.test(url)) {
      return false;
    }
    // Aceptar cualquier URL con extensión de imagen o de CDNs conocidos
    const hasImgExt = /\.(jpg|jpeg|png|webp|avif|gif|svg)(\?|$)/i.test(url);
    const isKnownCdn = url.includes('cdninstagram.com') || url.includes('fbcdn.net') || url.includes('igcdn.com') || url.includes('unsplash.com') || url.includes('imgur.com') || url.includes('wp-content');
    return hasImgExt || isKnownCdn;
  }

  /**
   * Emite una URL al content-script vía postMessage, incluyendo las dimensiones
   * conocidas para que el receptor pueda filtrar imágenes pequeñas.
   * @param {string} url
   * @param {number} [width=0]
   * @param {number} [height=0]
   */
  function emit(url, width = 0, height = 0) {
    if (!url || typeof url !== 'string') return;
    // Limpiar escapes unicode comunes en JSON serializado
    url = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!isValidImageUrl(url)) return;
    // Filtrar imágenes cuya dimensión menor esté por debajo del umbral si ambas se conocen
    if (width > 0 && height > 0 && Math.min(width, height) < MIN_API_SIZE) return;
    window.postMessage({ source: MSG_SOURCE, type: 'IMAGE_URL', url, width, height }, '*');
  }

  /**
   * Recorre recursivamente un objeto JSON buscando URLs de imágenes.
   * Prioriza: image_versions2.candidates (Instagram) > display_url > display_resources > url/src con extensión de imagen
   * @param {any} node
   * @param {number} depth
   */
  function traverseJson(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 20) return;

    if (Array.isArray(node)) {
      node.forEach(child => traverseJson(child, depth + 1));
      return;
    }

    // ── Carruseles Instagram (edge_sidecar_to_children) ──────────────────────
    if (node.edge_sidecar_to_children?.edges?.length) {
      for (const edge of node.edge_sidecar_to_children.edges) {
        if (edge.node) traverseJson(edge.node, depth + 1);
      }
    }

    // ── image_versions2.candidates ──────────────────────────────────────────
    if (node.image_versions2?.candidates?.length) {
      const sorted = [...node.image_versions2.candidates]
        .sort((a, b) => (b.width || 0) - (a.width || 0));
      const best = sorted[0];
      if (best?.url) {
        const w = best.width  || 0;
        const h = best.height || 0;
        if (w === 0 || h === 0 || Math.min(w, h) >= MIN_API_SIZE) {
          emit(best.url, w, h);
        }
      }
    }

    // ── display_url ─────────────────────────────────────────────────────────
    if (typeof node.display_url === 'string') emit(node.display_url, 0, 0);

    // ── display_resources ───────────────────────────────────────────────────
    if (Array.isArray(node.display_resources) && node.display_resources.length) {
      const sorted = [...node.display_resources]
        .sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
      const best = sorted[0];
      if (best?.src) {
        emit(best.src, best.config_width || 0, 0);
      }
    }

    // ── thumbnail_src ───────────────────────────────────────────────────────
    if (typeof node.thumbnail_src === 'string') {
      emit(node.thumbnail_src, 0, 0);
    }

    // ── Propiedades estándar url / src / original ─────────────────────────
    for (const key of ['url', 'src', 'original', 'full_url', 'image', 'image_url']) {
      if (typeof node[key] === 'string' && isValidImageUrl(node[key])) {
        emit(node[key], node.width || 0, node.height || 0);
      }
    }

    // ── Recursión en hijos ──────────────────────────────────────────────────
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object') traverseJson(val, depth + 1);
    }
  }

  /**
   * Procesa el texto de una respuesta HTTP.
   * Primero intenta parsearlo como JSON, luego aplica regex como fallback.
   * @param {string} text
   */
  function processResponseText(text) {
    if (!text || text.length < 20) return;

    // Intentar parseo JSON para extracción estructurada
    try {
      const json = JSON.parse(text);
      traverseJson(json);
      return;
    } catch (_) {
      // No es JSON puro; puede ser JSON embebido en HTML o texto
    }

    // Fallback: regex universal para capturar URLs de imágenes directamente del texto
    const IMG_REGEX = /https?:\/\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|avif|gif|svg)(?:\?[^\s"'\\]*)?/gi;
    let match;
    while ((match = IMG_REGEX.exec(text)) !== null) {
      let url = match[0].replace(/\\u0026/g, '&').replace(/[",})\]>]+$/, '');
      emit(url);
    }
  }

  // ─── Interceptar fetch ─────────────────────────────────────────────────────

  const _originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await _originalFetch(...args);

    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
        clone.text().then(text => {
          if (text && text.length > 20) {
            processResponseText(text);
          }
        }).catch(() => {});
      }
    } catch (_) {}

    return response;
  };

  // ─── Interceptar XMLHttpRequest ────────────────────────────────────────────

  const _originalXHROpen = XMLHttpRequest.prototype.open;
  const _originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._imgsaverUrl = String(url || '');
    return _originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const text = this.responseText;
        if (text && text.length > 20) {
          processResponseText(text);
        }
      } catch (_) {}
    });
    return _originalXHRSend.apply(this, args);
  };

  // ─── PerformanceObserver (recursos de imagen) ─────────────────────────────

  function emitPerformanceEntry(entry) {
    const url = entry.name;
    if (isValidImageUrl(url) || entry.initiatorType === 'img' || entry.initiatorType === 'image') {
      emit(url);
    }
  }

  try {
    const perfObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach(emitPerformanceEntry);
    });
    perfObserver.observe({ entryTypes: ['resource'] });
  } catch (_) {}

  // Escanear recursos ya cargados al iniciar
  function scanExistingResources() {
    performance.getEntriesByType('resource').forEach(emitPerformanceEntry);
  }

  // Ejecutar varias veces para capturar carga diferida
  setTimeout(scanExistingResources, 500);
  setTimeout(scanExistingResources, 2000);
  setTimeout(scanExistingResources, 5000);

  console.log('[ImgSaver] interceptor de página universal activo.');
})();

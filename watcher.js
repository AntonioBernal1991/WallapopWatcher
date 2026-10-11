#!/usr/bin/env node
'use strict';

/**
 * Wallapop watcher — avisa por WhatsApp cuando aparece un chollo.
 *
 * Por cada búsqueda configurada hace dos llamadas a la API de Wallapop:
 *   1. "mercado":  misma búsqueda sin filtro de precio -> mediana de precios.
 *   2. "caza":     misma búsqueda ordenada por más reciente + filtros.
 * Un anuncio dispara aviso si es nuevo (no visto antes), pasa los filtros duros
 * y queda por debajo del umbral de chollo respecto a la mediana del mercado.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const navegador = require('./navegador');

const ROOT = __dirname;

// --config <archivo> permite tener perfiles separados (cada uno con su memoria).
const configArg = process.argv.indexOf('--config');
const CONFIG_PATH =
  configArg !== -1 && process.argv[configArg + 1]
    ? path.resolve(process.argv[configArg + 1])
    : path.join(ROOT, 'config.json');

const profile = path.basename(CONFIG_PATH, '.json');
const suffix = profile === 'config' ? '' : `.${profile}`;
const SEEN_PATH = path.join(ROOT, `seen${suffix}.json`);
const LOG_PATH = path.join(ROOT, `alerts${suffix}.log`);
const PRICES_PATH = path.join(ROOT, `precios${suffix}.json`);
const RUN_LOG_PATH = path.join(ROOT, `watcher${suffix}.log`);
const ESTADO_PATH = path.join(ROOT, `estado${suffix}.json`);
const MENSAJES_PATH = path.join(ROOT, `mensajes${suffix}.json`);

// --ahora ["texto"] fuerza una búsqueda inmediata: ignora la memoria de vistos
// y la pasada de arranque, y manda todo lo que encuentre. Para "búscame ya".
const nowArg = process.argv.indexOf('--ahora');
const FORCE_NOW = nowArg !== -1;
const FORCE_FILTER = FORCE_NOW && process.argv[nowArg + 1] && !process.argv[nowArg + 1].startsWith('--')
  ? process.argv[nowArg + 1].toLowerCase()
  : null;

const API = 'https://api.wallapop.com/api/v3/search';
const ITEM_BASE = 'https://es.wallapop.com/item/';
const SEEN_TTL_DAYS = 180; // por defecto; se cambia con seenTtlDays en config.json

const API_HEADERS = {
  'X-DeviceOS': '0',
  Accept: 'application/json',
  'Accept-Language': 'es-ES,es;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// ---------------------------------------------------------------- utilidades

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ts() {
  return new Date().toLocaleTimeString('es-ES', { hour12: false });
}

function log(...args) {
  const line = `[${ts()}] ${args.join(' ')}`;
  console.log(line);
  // Arrancado como tarea programada no hay consola que mirar, así que todo
  // queda también en watcher.log para poder comprobar que sigue vivo.
  try {
    fs.appendFileSync(RUN_LOG_PATH, `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch { /* si el log falla, no vale la pena tumbar el vigilante */ }
}

// Sin redondear: 24,99 € no puede mostrarse como "25 €" en una herramienta
// que existe para cazar precios. Los enteros sí se muestran sin decimales.
const eur = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Minúsculas sin acentos, para comparar títulos de forma tolerante. */
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Normalización agresiva para identificar el juego dentro del título de un
 * anuncio: quita apóstrofes (link's -> links) y convierte cualquier otro
 * signo en espacio, de modo que "Zelda: Link's Awakening (PAL/ESP)" y
 * "ZELDA LINKS AWAKENING - switch" acaben en la misma forma comparable.
 */
function normalizeTitle(str) {
  return normalize(str)
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Días desde la última señal de vida del anuncio (edición, o creación). */
function edadDias(item) {
  const ultima = item.modified_at || item.created_at;
  if (!ultima) return 0; // sin fecha, no lo descartamos por antigüedad
  return (Date.now() - ultima) / 86400000;
}

function timeAgo(msEpoch) {
  if (!msEpoch) return '';
  const mins = Math.round((Date.now() - msEpoch) / 60000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

function readJson(file, fallback) {
  try {
    // El Bloc de notas guarda UTF-8 con BOM y JSON.parse se atraganta con ella.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`aviso: no pude leer ${path.basename(file)} (${err.message})`);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ------------------------------------------------------------------ wallapop

async function searchWallapop(config, watch, { orderBy, applyPriceFilters }) {
  const params = new URLSearchParams({
    keywords: watch.keywords,
    source: 'search_box',
    latitude: String(config.location.latitude),
    longitude: String(config.location.longitude),
  });

  if (orderBy) params.set('order_by', orderBy);
  if (config.location.distanceKm > 0) {
    params.set('distance', String(config.location.distanceKm * 1000));
  }
  if (applyPriceFilters) {
    if (watch.minPrice != null) params.set('min_sale_price', String(watch.minPrice));
    if (watch.maxPrice != null) params.set('max_sale_price', String(watch.maxPrice));
  }
  if (watch.categoryId) params.set('category_ids', String(watch.categoryId));

  let res;
  try {
    res = await fetch(`${API}?${params}`, { headers: API_HEADERS });
  } catch (err) {
    // Sin red (típico al despertar el portátil de la suspensión). No es lo
    // mismo que un bloqueo: se contabiliza aparte para reintentar enseguida.
    fallosDeRed++;
    throw new Error(`sin conexión (${err.message})`);
  }

  if (res.status === 429 || res.status === 403) {
    throw new Error(`Wallapop responde ${res.status} (rate limit) — reintento en el siguiente ciclo`);
  }
  if (!res.ok) throw new Error(`Wallapop HTTP ${res.status}`);

  const body = await res.json();
  const items = body?.data?.section?.payload?.items ?? [];
  itemsDelCiclo += items.length;
  return items;
}

// Wallapop no devuelve 429 cuando te pasas de peticiones: responde 200 con la
// lista VACÍA. Sin este contador, el vigilante diría "sin novedades" para
// siempre y parecería que no hay nada, en vez de que no le están contestando.
let itemsDelCiclo = 0;
let fallosDeRed = 0;
let ultimoAvisoBloqueo = 0;
// Rondas bloqueadas seguidas. Wallapop no dice cuántas peticiones admite ni
// cuándo levanta el castigo, así que la única estrategia sensata es apartarse
// un rato y volver: 15 min, 30, 60... y a la primera respuesta buena, normal.
let bloqueosSeguidos = 0;
let sinRed = false;

// Provincias fuera de la península: el envío se encarece o directamente no se
// hace, y varios vendedores lo excluyen en la letra pequeña.
const FUERA_PENINSULA = [
  'santa cruz de tenerife', 'las palmas', 'baleares', 'illes balears', 'islas baleares',
  'ceuta', 'melilla', 'tenerife', 'gran canaria', 'lanzarote', 'fuerteventura',
  'la palma', 'la gomera', 'el hierro', 'mallorca', 'menorca', 'ibiza', 'formentera',
];

function esPeninsula(item) {
  const pais = (item.location?.country_code || 'ES').toUpperCase();
  if (pais !== 'ES') return false;
  const donde = normalize(`${item.location?.region2 || ''} ${item.location?.region || ''} ${item.location?.city || ''}`);
  return !FUERA_PENINSULA.some((z) => donde.includes(normalize(z)));
}

// Señales de que se vende sólo el cartucho, sin caja ni manual. Aquí sí se mira
// la descripción: casi nadie lo pone en el título y es justo lo que se pregunta.
const SENALES_SUELTO = [
  'solo cartucho', 'solo el cartucho', 'cartucho suelto', 'suelto', 'sin caja',
  'sin su caja', 'no incluye caja', 'sin manual', 'sin caratula', 'solo el juego',
  'unicamente el cartucho', 'no tiene caja', 'sin cajita',
];

function esCartuchoSuelto(item) {
  const texto = normalize(`${item.title} ${item.description || ''}`);
  return SENALES_SUELTO.some((s) => texto.includes(normalize(s)));
}

/**
 * Barrido de caza: une el orden por defecto (relevancia) con order_by=newest.
 *
 * Hace falta unir los dos porque 'newest' no ordena: RESTRINGE a lo publicado
 * hace muy poco. En una búsqueda de nicho ("zelda links awakening switch")
 * devuelve 0 de 36 anuncios, y combinado con filtro de precio, cero siempre.
 * Por relevancia salen todos pero un catálogo amplio se queda estancado en los
 * mismos 40 de siempre; con los dos se cubren ambos casos.
 */
async function huntSearch(config, watch) {
  const found = new Map();
  const fallos = [];

  for (const orderBy of [null, 'newest']) {
    try {
      for (const item of await searchWallapop(config, watch, { orderBy, applyPriceFilters: true })) {
        found.set(item.id, item);
      }
    } catch (err) {
      fallos.push(err.message);
    }
    await sleep(500 + Math.random() * 600);
  }

  if (!found.size && fallos.length === 2) throw new Error(fallos[0]);
  return [...found.values()];
}

/**
 * Pasa los filtros de texto: sin palabras excluidas y con las obligatorias.
 *
 * Por defecto sólo mira el TÍTULO, que es donde está la identidad del producto.
 * Mirar también la descripción descarta de más: casi cualquier vendedor escribe
 * "lo usé poco en mi consola" o "acepto pack", y eso tumbaría anuncios buenos.
 * Con matchDescription: true se recupera el comportamiento amplio.
 */
function titleMatches(item, watch) {
  // "Caja Zelda Skyward Sword" o "Manual Pokémon HeartGold" venden el envoltorio,
  // no el juego, y contienen el nombre entero: sólo se distinguen por empezar
  // con esa palabra. Por eso se mira la primera palabra aparte.
  const primera = normalizeTitle(item.title).split(' ')[0];
  if ((watch.excludeStartsWith || []).some((w) => normalizeTitle(w) === primera)) return false;

  // La excepción a mirar sólo el título, y sólo para frases INEQUÍVOCAS del
  // tipo "no es el juego" o "puntos vip": hay tarjetas de Club Nintendo cuyo
  // título es idéntico al del juego ("Zelda Spirit Tracks - Nintendo DS", 10 €)
  // y únicamente la descripción las delata. No meter aquí nada ambiguo o
  // volvemos a tumbar anuncios buenos por el "lo usé en mi consola" de turno.
  if ((watch.excludeDescWords || []).length) {
    const conDesc = normalize(`${item.title} ${item.description || ''}`);
    if (watch.excludeDescWords.some((w) => conDesc.includes(normalize(w)))) return false;
  }

  const haystack = normalize(watch.matchDescription ? `${item.title} ${item.description || ''}` : item.title);
  const excluded = (watch.excludeWords || []).some((w) => haystack.includes(normalize(w)));
  if (excluded) return false;

  // requireWords: todas obligatorias. requireAny: basta con una, para juegos
  // que se anuncian de varias formas ("trading card", "TCG", "juego de cartas").
  if (!(watch.requireWords || []).every((w) => haystack.includes(normalize(w)))) return false;
  const any = watch.requireAny || [];
  return any.length === 0 || any.some((w) => haystack.includes(normalize(w)));
}

function itemUrl(item) {
  return item.web_slug ? ITEM_BASE + item.web_slug : `${ITEM_BASE}${item.id}`;
}

// ------------------------------------------------------------------ whatsapp

function bridgeToken(config) {
  try {
    return fs.readFileSync(config.whatsapp.tokenFile, 'utf8').trim();
  } catch (err) {
    throw new Error(`No pude leer el token del bridge (${config.whatsapp.tokenFile}): ${err.message}`);
  }
}

async function bridgeHealthy(config) {
  try {
    const res = await fetch(`${config.whatsapp.bridgeUrl}/health`, {
      headers: { Authorization: `Bearer ${bridgeToken(config)}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Arranca whatsapp-bridge.exe desasociado y espera a que responda /health. */
async function ensureBridge(config) {
  if (await bridgeHealthy(config)) return true;
  if (!config.whatsapp.autoStartBridge) return false;

  const exe = config.whatsapp.bridgeExe;
  if (!fs.existsSync(exe)) {
    log(`bridge no encontrado en ${exe}`);
    return false;
  }

  log('bridge caído — arrancándolo...');
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: { ...process.env, WHATSAPP_BRIDGE_PORT: String(config.whatsapp.bridgePort) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    if (await bridgeHealthy(config)) {
      log('bridge listo');
      return true;
    }
  }
  log('el bridge no respondió a tiempo (¿hace falta reescanear el QR?)');
  return false;
}

async function sendWhatsApp(config, message) {
  const res = await fetch(`${config.whatsapp.bridgeUrl}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridgeToken(config)}`,
    },
    body: JSON.stringify({ recipient: config.whatsapp.recipient, message }),
  });

  if (!res.ok) throw new Error(`bridge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body.success) throw new Error(body.message || 'el bridge rechazó el envío');
}

function formatAlert({ item, watch, marketMedian, label, ronda }) {
  const price = item.price?.amount ?? 0;
  const lines = [];
  // Cabecera de ronda: permite distinguir de un vistazo si dos avisos vienen
  // del mismo barrido o de barridos distintos.
  if (ronda) lines.push(`🔄 _Ronda #${ronda.numero} · ${ronda.hora}_`, '');
  lines.push(`🔥 *CHOLLO* · ${label || watch.name}`, '', `📱 ${item.title}`);

  if (marketMedian && price < marketMedian) {
    const off = Math.round((1 - price / marketMedian) * 100);
    lines.push(`💰 *${eur.format(price)}* — ${off}% por debajo de la media (${eur.format(marketMedian)})`);
  } else {
    lines.push(`💰 *${eur.format(price)}*`);
  }

  const place = [item.location?.city, item.location?.region2].filter(Boolean).join(', ');
  const meta = [];
  if (place) meta.push(`📍 ${place}`);
  if (item.shipping?.item_is_shippable) meta.push('📦 con envío');
  // Se muestran las dos fechas cuando difieren: "publicado hace 111 d pero
  // editado anteayer" dice mucho más sobre si el vendedor va a contestar.
  if (item.created_at) {
    const editado = item.modified_at && item.modified_at - item.created_at > 86400000;
    meta.push(editado ? `🕒 ${timeAgo(item.created_at)}, editado ${timeAgo(item.modified_at)}` : `🕒 ${timeAgo(item.created_at)}`);
  }
  if (meta.length) lines.push(meta.join(' · '));

  lines.push('', itemUrl(item));
  // Enlace directo al chat con el vendedor: abre la conversación de ESTE
  // anuncio, así se escribe de un toque desde el propio aviso de WhatsApp.
  if (item.id) lines.push(`💬 Escribirle: https://es.wallapop.com/app/chat?itemId=${item.id}`);
  return lines.join('\n');
}

// ------------------------------------------------------- modo catálogo
//
// Para una categoría entera ("juegos de Switch") una única mediana no sirve:
// mezclar un Zelda de 35 € con un juego suelto de 5 € da un número que no
// describe a ninguno de los dos. Así que identificamos QUÉ juego es cada
// anuncio y lo comparamos contra la mediana de ESE título.

// Cacheado por ruta: dos búsquedas con catálogos distintos no deben pisarse.
const catalogCache = new Map();

function loadCatalog(watch) {
  const file = path.resolve(ROOT, watch.catalogFile);
  if (catalogCache.has(file)) return catalogCache.get(file);

  const data = readJson(file, null);
  if (!data) throw new Error(`no pude leer el catálogo ${watch.catalogFile}`);

  const entries = (data.juegos || data.items || []).map((g) => ({
    ...g,
    alias: (g.alias || []).map(normalizeTitle).filter(Boolean),
    excluir: (g.excluir || []).map(normalizeTitle).filter(Boolean),
  }));

  catalogCache.set(file, entries);
  return entries;
}

/**
 * Devuelve la entrada del catálogo que mejor encaja con el título, o null.
 *
 * Gana el alias más largo que ENCAJE, no el más largo del catálogo: "Super
 * Mario Party Jamboree" contiene tanto "mario party" como "mario party
 * jamboree", y debe ganar el segundo por ser más específico. 'excluir' remata
 * los casos que ningún alias distingue — "Minecraft Dungeons" no es Minecraft
 * y "Smash Bros N64" no es el de Switch.
 */
function identifyGame(title, catalog) {
  const hay = normalizeTitle(title);
  let best = null;
  let bestLength = 0;

  for (const game of catalog) {
    if (game.excluir.some((x) => hay.includes(x))) continue;
    for (const a of game.alias) {
      if (a.length > bestLength && hay.includes(a)) {
        best = game;
        bestLength = a.length;
      }
    }
  }
  return best;
}

/** Mediana de mercado de un juego concreto, cacheada en precios.json. */
async function gameMedian(config, watch, game, prices) {
  const ttl = (watch.medianTtlHours ?? 24) * 3600000;
  const cached = prices[game.id];
  if (cached && Date.now() - cached.at < ttl) return cached.median;

  const probe = { ...watch, keywords: game.busqueda || game.nombre };
  const items = await searchWallapop(config, probe, { orderBy: null, applyPriceFilters: false });

  const sample = items
    .filter((it) => titleMatches(it, watch))
    .filter((it) => identifyGame(it.title, [game])) // que sea de verdad ese juego
    .map((it) => it.price?.amount)
    .filter((p) => typeof p === 'number' && p > 0);

  // Con 4 anuncios o menos la mediana es ruido, no mercado.
  const value = sample.length >= 5 ? median(sample) : null;
  prices[game.id] = { median: value, n: sample.length, at: Date.now(), nombre: game.nombre };
  return value;
}

async function runCatalogWatch(config, watch, seen, prices) {
  const catalog = loadCatalog(watch);
  const alerts = [];
  const firstRun = !seen[watch.name] && !FORCE_NOW;
  if (!seen[watch.name]) seen[watch.name] = {};

  // Barrido amplio: varias formas de buscar lo mismo cubren más que paginar.
  const queries = watch.queries || [watch.keywords];
  const fresh = [];
  for (const keywords of queries) {
    try {
      fresh.push(...(await huntSearch(config, { ...watch, keywords })));
    } catch (err) {
      log(`  ${watch.name}: barrido "${keywords}" falló (${err.message})`);
    }
    await sleep(600 + Math.random() * 700);
  }

  // Candidatos: anuncios nuevos, identificables y que pasan los filtros duros.
  const candidates = [];
  for (const item of fresh) {
    if (seen[watch.name][item.id] && !FORCE_NOW) continue;
    const price = item.price?.amount;
    if (typeof price !== 'number') continue;
    if (item.reserved?.flag) continue;
    if (watch.shippingOnly && !item.shipping?.item_is_shippable) continue;
    if (watch.soloPeninsula && !esPeninsula(item)) continue;
    if (watch.noCartuchoSuelto && esCartuchoSuelto(item)) continue;
    // Un anuncio barato y abandonado suele ser un vendedor que ya no contesta.
    // Se mide por la última EDICIÓN, no por la creación: hay anuncios de hace
    // 111 días editados anteayer, cuyo vendedor está perfectamente activo, y
    // mirando created_at se descartaban justo los más baratos.
    if (watch.maxAgeDays && edadDias(item) > watch.maxAgeDays) continue;
    // maxAgePublicadoDays mira la fecha de PUBLICACIÓN, no la de edición: hay
    // anuncios de hace dos años "editados" hace semanas, que es el renovar
    // automático que sugiere Wallapop y no prueba que el vendedor conteste.
    if (watch.maxAgePublicadoDays && item.created_at &&
        (Date.now() - item.created_at) / 86400000 > watch.maxAgePublicadoDays) continue;
    if (watch.minPrice != null && price < watch.minPrice) continue;
    if (watch.maxPrice != null && price > watch.maxPrice) continue;
    if (!titleMatches(item, watch)) continue;

    const game = identifyGame(item.title, catalog);
    if (!game) {
      seen[watch.name][item.id] = Date.now(); // no está en el catálogo: olvidar
      continue;
    }
    if (candidates.some((c) => c.item.id === item.id)) continue; // duplicado entre queries
    candidates.push({ item, game });
  }

  if (firstRun) {
    for (const { item } of candidates) seen[watch.name][item.id] = Date.now();
    for (const item of fresh) seen[watch.name][item.id] = Date.now();
    log(`  ${watch.name}: primera pasada, ${fresh.length} anuncios memorizados (${candidates.length} identificados)`);
    return [];
  }

  // Sólo consultamos la mediana de los juegos que realmente han aparecido, y
  // como máximo unas pocas por ciclo: el resto ya se resolverá en la siguiente.
  let lookups = 0;
  const maxLookups = watch.maxMedianLookupsPerCycle ?? 6;

  for (const { item, game } of candidates) {
    const known = prices[game.id];
    const fresco = known && Date.now() - known.at < (watch.medianTtlHours ?? 24) * 3600000;

    if (!fresco) {
      if (lookups >= maxLookups) continue; // sin marcar: se reintenta en el próximo ciclo
      lookups++;
      try {
        await gameMedian(config, watch, game, prices);
      } catch (err) {
        log(`  ${watch.name}: media de "${game.nombre}" falló (${err.message})`);
        continue;
      }
      await sleep(600 + Math.random() * 700);
    }

    const m = prices[game.id]?.median;
    if (!m) {
      seen[watch.name][item.id] = Date.now(); // sin mercado fiable, no opinamos
      continue;
    }

    const threshold = m * (1 - (watch.dealPercent ?? 25) / 100);
    if (item.price.amount > threshold) {
      seen[watch.name][item.id] = Date.now();
      continue;
    }

    alerts.push({ item, watch, marketMedian: m, label: game.nombre });
  }

  return alerts;
}

// -------------------------------------------------- mensajes automáticos
//
// Sólo se escribe a un anuncio si su búsqueda lo tiene activado y el precio
// cae bajo su tope. Nunca dos veces al mismo anuncio, nunca más de N al día,
// y siempre tras una espera aleatoria: escribir en el mismo segundo en que
// aparece el anuncio es justo el patrón que delata a un bot.

function cargarMensajes() {
  const m = readJson(MENSAJES_PATH, { enviados: {}, cola: [] });
  m.enviados = m.enviados || {};
  m.cola = m.cola || [];
  return m;
}

function enviadosHoy(mensajes) {
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  return Object.values(mensajes.enviados).filter((e) => e.ok && e.at >= inicio.getTime()).length;
}

/** Decide si un aviso recién enviado merece mensaje, y lo pone en cola. */
function encolarMensaje(config, alert, mensajes) {
  const regla = alert.watch.autoMensaje;
  const global = config.autoMensaje;
  if (!global?.activo || !regla?.activo) return null;

  const precio = alert.item.price?.amount;
  if (regla.maxPrice != null && precio > regla.maxPrice) return null;
  if (mensajes.enviados[alert.item.id]) return null;
  if (mensajes.cola.some((c) => c.itemId === alert.item.id)) return null;

  const [min, max] = global.esperaMinutos || [3, 12];
  const espera = (min + Math.random() * Math.max(0, max - min)) * 60000;
  const entrada = {
    itemId: alert.item.id,
    watch: alert.watch.name,
    titulo: alert.item.title,
    precio,
    texto: regla.texto || global.texto || 'hola, sigue disponible?',
    cuando: Date.now() + espera,
    url: itemUrl(alert.item),
  };
  mensajes.cola.push(entrada);
  return entrada;
}

/** Envía los mensajes de la cola que ya toquen, respetando el tope diario. */
async function procesarCola(config, mensajes) {
  const global = config.autoMensaje;
  if (!global?.activo || !mensajes.cola.length) return;

  const maxDia = global.maxPorDia ?? 4;
  const ahora = Date.now();
  const pendientes = mensajes.cola.filter((c) => c.cuando <= ahora);
  if (!pendientes.length) return;

  for (const entrada of pendientes) {
    if (enviadosHoy(mensajes) >= maxDia) {
      log(`  tope diario de mensajes alcanzado (${maxDia}); el resto espera a mañana`);
      break;
    }

    const r = await navegador.enviarMensaje({
      nav: global.navegador,
      itemUrl: entrada.url,
      texto: entrada.texto,
      log,
    });

    if (!r.ok && !/ya había mensajes/i.test(r.motivo || '')) {
      // Un fallo técnico no debe quemar el hallazgo: se reintenta más tarde,
      // hasta 3 veces. Sólo un "ya le habías escrito" cierra el asunto.
      entrada.intentos = (entrada.intentos || 0) + 1;
      if (entrada.intentos < 3) {
        entrada.cuando = Date.now() + 30 * 60000;
        log(`  ✍️ falló (${r.motivo}); reintento ${entrada.intentos}/3 en 30 min`);
        writeJson(MENSAJES_PATH, mensajes);
        continue;
      }
    }

    mensajes.enviados[entrada.itemId] = {
      at: Date.now(),
      ok: r.ok,
      motivo: r.motivo || null,
      texto: entrada.texto,
      titulo: entrada.titulo,
      precio: entrada.precio,
      url: entrada.url,
    };
    mensajes.cola = mensajes.cola.filter((c) => c.itemId !== entrada.itemId);
    writeJson(MENSAJES_PATH, mensajes);

    if (r.ok) {
      log(`  ✍️ escrito a "${entrada.titulo.slice(0, 40)}" (${eur.format(entrada.precio)})`);
      try {
        await sendWhatsApp(
          config,
          `✍️ Le he escrito al vendedor de *${entrada.titulo}* (${eur.format(entrada.precio)}):\n_"${entrada.texto}"_\n\n${entrada.url}`,
        );
      } catch { /* avisar del aviso es opcional */ }
    } else {
      log(`  ✍️ no pude escribir a "${entrada.titulo.slice(0, 40)}": ${r.motivo}`);
      if (/sesión|Chrome/i.test(r.motivo || '')) {
        try {
          await sendWhatsApp(config, `⚠️ No he podido escribir en Wallapop: ${r.motivo}`);
        } catch { /* nada */ }
      }
    }
    await sleep(20000 + Math.random() * 40000); // separación entre mensajes
  }
}

// ------------------------------------------------------------------- núcleo

/**
 * ¿Toca callarse? Ventana de descanso configurable, p.ej. de 01:00 a 07:00.
 * Se admite que cruce la medianoche (desde 23 hasta 7).
 */
function enPausa(config) {
  const p = config.pausaNocturna;
  if (!p || p.desdeHora == null || p.hastaHora == null) return false;
  const h = new Date().getHours();
  return p.desdeHora <= p.hastaHora
    ? h >= p.desdeHora && h < p.hastaHora
    : h >= p.desdeHora || h < p.hastaHora;
}

function pruneSeen(seen, config) {
  const cutoff = Date.now() - (config.seenTtlDays ?? SEEN_TTL_DAYS) * 86400000;
  for (const watchName of Object.keys(seen)) {
    for (const [id, when] of Object.entries(seen[watchName])) {
      if (when < cutoff) delete seen[watchName][id];
    }
  }
}

/**
 * Por qué NO se avisa de un anuncio, o null si pasa todos los filtros.
 *
 * Vive aparte de runWatch para que `--simular` pueda explicar cada descarte sin
 * duplicar la lista de reglas, que es justo donde se cuelan las diferencias
 * entre lo que dices que filtras y lo que filtras de verdad.
 *
 * `definitivo` marca los descartes que no van a cambiar por sí solos (el precio
 * no baja mirando): esos se memorizan para no reevaluarlos en cada ronda.
 */
function motivoDescarte(item, watch, marketMedian) {
  const price = item.price?.amount;
  if (typeof price !== 'number') return { texto: 'sin precio' };
  if (item.reserved?.flag) return { texto: 'reservado' };
  if (watch.shippingOnly && !item.shipping?.item_is_shippable) return { texto: 'no envía' };
  if (watch.soloPeninsula && !esPeninsula(item)) return { texto: 'fuera de la península' };
  if (watch.noCartuchoSuelto && esCartuchoSuelto(item)) return { texto: 'cartucho suelto' };
  if (watch.maxAgeDays && edadDias(item) > watch.maxAgeDays) {
    return { texto: `editado hace ${edadDias(item)} d` };
  }
  if (watch.maxAgePublicadoDays && item.created_at &&
      (Date.now() - item.created_at) / 86400000 > watch.maxAgePublicadoDays) {
    return { texto: `publicado hace ${Math.round((Date.now() - item.created_at) / 86400000)} d` };
  }
  if (watch.minPrice != null && price < watch.minPrice) return { texto: `bajo el mínimo (${watch.minPrice})` };
  if (watch.maxPrice != null && price > watch.maxPrice) return { texto: `sobre el máximo (${watch.maxPrice})` };
  if (!titleMatches(item, watch)) return { texto: 'filtro de palabras' };

  // Umbral de chollo: sólo avisa si está claramente por debajo del mercado.
  if (watch.dealPercent && marketMedian) {
    const threshold = marketMedian * (1 - watch.dealPercent / 100);
    if (price > threshold) return { texto: `no es chollo (umbral ${eur.format(threshold)})`, definitivo: true };
  }
  return null;
}

async function runWatch(config, watch, seen) {
  const alerts = [];
  const firstRun = !seen[watch.name] && !FORCE_NOW;
  if (!seen[watch.name]) seen[watch.name] = {};

  // 1. Foto del mercado: precios de anuncios comparables, sin filtro de precio.
  let marketMedian = null;
  try {
    const market = await searchWallapop(config, watch, { orderBy: null, applyPriceFilters: false });
    const prices = market
      .filter((it) => titleMatches(it, watch))
      .map((it) => it.price?.amount)
      .filter((p) => typeof p === 'number' && p > 0);
    marketMedian = median(prices);
  } catch (err) {
    log(`  ${watch.name}: no pude calcular la media (${err.message})`);
  }

  await sleep(600 + Math.random() * 900); // pausa educada entre llamadas

  // 2. Anuncios recientes que ya vienen filtrados por precio.
  // Varias formas de buscar lo mismo: "trading card game", "tcg", "juego de
  // cartas"... cada una devuelve anuncios que las otras no.
  const fresh = [];
  const yaVistos = new Set();
  for (const keywords of watch.queries || [watch.keywords]) {
    try {
      for (const item of await huntSearch(config, { ...watch, keywords })) {
        if (!yaVistos.has(item.id)) {
          yaVistos.add(item.id);
          fresh.push(item);
        }
      }
    } catch (err) {
      log(`  ${watch.name}: barrido "${keywords}" falló (${err.message})`);
    }
    if ((watch.queries || []).length > 1) await sleep(500 + Math.random() * 600);
  }

  // La edad se mide por la última EDICIÓN, no por la creación: hay anuncios de
  // hace 111 días editados anteayer, cuyo vendedor está perfectamente activo, y
  // mirando created_at se descartaban justo los más baratos. maxAgePublicadoDays
  // es el contrapeso, para los que se "renuevan" solos sin que nadie conteste.
  for (const item of fresh) {
    if (seen[watch.name][item.id] && !FORCE_NOW) continue;

    const descarte = motivoDescarte(item, watch, marketMedian);
    if (descarte) {
      if (descarte.definitivo) seen[watch.name][item.id] = Date.now(); // no repetir
      continue;
    }

    alerts.push({ item, watch, marketMedian });
  }

  // En la primera pasada no bombardeamos con el histórico: sólo memorizamos.
  if (firstRun) {
    for (const { item } of alerts) seen[watch.name][item.id] = Date.now();
    const median_ = marketMedian ? ` · media del mercado ${eur.format(marketMedian)}` : '';
    log(`  ${watch.name}: primera pasada, ${fresh.length} anuncios memorizados${median_}`);
    return [];
  }

  return alerts;
}

async function cycle(config) {
  const seen = readJson(SEEN_PATH, {});
  const prices = readJson(PRICES_PATH, {});
  pruneSeen(seen, config);

  // La cola se atiende siempre, haya novedades o no: sus entradas llevan una
  // espera aleatoria y vencen en rondas posteriores a la que las creó.
  const mensajes = cargarMensajes();
  try {
    await procesarCola(config, mensajes);
  } catch (err) {
    log(`  cola de mensajes: ${err.message}`);
  }

  itemsDelCiclo = 0;
  fallosDeRed = 0;
  const estado = readJson(ESTADO_PATH, { ronda: 0 });
  estado.ronda += 1;
  const ronda = {
    numero: estado.ronda,
    hora: new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  };
  writeJson(ESTADO_PATH, estado);

  const watches = FORCE_FILTER
    ? config.watches.filter((w) => w.name.toLowerCase().includes(FORCE_FILTER))
    : config.watches;

  if (!watches.length) {
    log(`ninguna búsqueda se llama como "${FORCE_FILTER}"`);
    return;
  }

  const pending = [];
  for (const watch of watches) {
    try {
      const found =
        watch.mode === 'catalog'
          ? await runCatalogWatch(config, watch, seen, prices)
          : await runWatch(config, watch, seen);
      pending.push(...found);
    } catch (err) {
      log(`  ${watch.name}: ${err.message}`);
    }
    await sleep(800 + Math.random() * 1200);
  }

  writeJson(PRICES_PATH, prices);

  // Ninguna búsqueda devolvió NADA: eso no es que no haya anuncios, es que
  // Wallapop no está contestando. No se guarda nada para no dar por "visto"
  // lo que en realidad no hemos podido mirar.
  // Sin red no hay nada que diagnosticar ni castigo que esperar: se reintenta
  // enseguida. Confundirlo con un bloqueo dejaba el vigilante media hora
  // parado justo al volver el portátil de la suspensión.
  if (itemsDelCiclo === 0 && fallosDeRed > 0) {
    sinRed = true;
    log(`ronda #${ronda.numero}: sin conexión (${fallosDeRed} intento(s) fallidos), reintento en 1 min`);
    return;
  }
  sinRed = false;

  if (itemsDelCiclo === 0) {
    bloqueosSeguidos++;
    log(`ronda #${ronda.numero}: ⚠️ la API devuelve 0 anuncios en todas las búsquedas — probable bloqueo temporal`);
    if (Date.now() - ultimoAvisoBloqueo > 3600000) {
      ultimoAvisoBloqueo = Date.now();
      try {
        await sendWhatsApp(
          config,
          '⚠️ Wallapop está devolviendo listas vacías (bloqueo temporal por exceso de peticiones). ' +
            'La vigilancia sigue en marcha y se recupera sola; mientras tanto no puede ver anuncios nuevos.',
        );
      } catch { /* nada */ }
    }
    return;
  }

  if (bloqueosSeguidos > 0) {
    log(`  API respondiendo de nuevo tras ${bloqueosSeguidos} ronda(s) bloqueada(s)`);
    bloqueosSeguidos = 0;
  }

  if (!pending.length) {
    writeJson(SEEN_PATH, seen);
    log(`ronda #${ronda.numero}: sin novedades (${watches.length} búsqueda${watches.length === 1 ? '' : 's'})`);
    return;
  }

  // Los más baratos respecto a su mercado, primero.
  pending.sort((a, b) => {
    const score = (x) => (x.marketMedian ? x.item.price.amount / x.marketMedian : 1);
    return score(a) - score(b);
  });

  const cap = config.maxAlertsPerCycle ?? 8;
  const toSend = pending.slice(0, cap);
  const dropped = pending.length - toSend.length;

  await ensureBridge(config);

  let sent = 0;
  for (const alert of toSend) {
    const message = formatAlert({ ...alert, ronda });
    try {
      await sendWhatsApp(config, message);
      // Sólo lo marcamos como visto si el aviso salió: si falla, se reintenta.
      seen[alert.watch.name][alert.item.id] = Date.now();
      fs.appendFileSync(
        LOG_PATH,
        JSON.stringify({
          at: new Date().toISOString(),
          watch: alert.watch.name,
          juego: alert.label || null,
          title: alert.item.title,
          price: alert.item.price.amount,
          median: alert.marketMedian,
          url: itemUrl(alert.item),
        }) + '\n',
      );
      sent++;
      const encolado = encolarMensaje(config, alert, mensajes);
      if (encolado) {
        const enMin = Math.round((encolado.cuando - Date.now()) / 60000);
        log(`     ✍️ le escribiré en ~${enMin} min ("${encolado.texto}")`);
        writeJson(MENSAJES_PATH, mensajes);
      }
      log(
        `  📤 ${alert.label || alert.watch.name}: ${eur.format(alert.item.price.amount)}` +
          `${alert.marketMedian ? ` (media ${eur.format(alert.marketMedian)})` : ''} — ${alert.item.title.slice(0, 45)}`,
      );
      await sleep(1200); // no atropellar a WhatsApp
    } catch (err) {
      log(`  ❌ envío fallido (${err.message}) — se reintenta en el próximo ciclo`);
      break;
    }
  }

  if (dropped > 0 && sent > 0) {
    try {
      await sendWhatsApp(
        config,
        `🔄 _Ronda #${ronda.numero}_ · …y ${dropped} chollo(s) más en cola. Te los mando en la siguiente pasada.`,
      );
    } catch { /* el resumen es opcional */ }
  }

  writeJson(SEEN_PATH, seen);
  log(`ronda #${ronda.numero}: ${sent} aviso(s) enviados${dropped > 0 ? `, ${dropped} en cola` : ''}`);
}

// -------------------------------------------------------------------- arranque

function loadConfig() {
  const config = readJson(CONFIG_PATH, null);
  if (!config) throw new Error(`No encuentro ${CONFIG_PATH}`);

  const todas = config.watches || [];

  // Las excludeWords globales valen para todas las búsquedas; cada una puede
  // sumar las suyas. Así la lista larga de accesorios se escribe una sola vez.
  for (const watch of todas) {
    // Los grupos permiten reutilizar listas largas sin repetirlas: la lista de
    // "otras consolas" no puede ser global, porque excluir "game boy" es justo
    // lo que hace falta vigilando Switch y lo que lo rompe todo vigilando GBC.
    const deGrupos = (watch.excludeGroups || []).flatMap((g) => config.gruposExcluidos?.[g] || []);
    watch.excludeWords = [...(config.excludeWords || []), ...deGrupos, ...(watch.excludeWords || [])];
    watch.excludeStartsWith = [...(config.excludeStartsWith || []), ...(watch.excludeStartsWith || [])];
  }

  // "enabled": false deja una búsqueda guardada pero apagada, sin borrarla. El
  // vigilante sólo ve las encendidas, pero --simular necesita las apagadas: un
  // juego nuevo se ensaya en seco ANTES de dejarlo suelto, no después.
  config.todasLasWatches = todas;
  config.watches = todas.filter((w) => w.enabled !== false);
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.includes('--diagnostico')) {
    for (const watch of config.watches.filter((w) => w.mode === 'catalog')) {
      const catalog = loadCatalog(watch);
      console.log(`\n=== ${watch.name} · ${catalog.length} juegos en el catálogo ===\n`);

      const seenIds = new Set();
      const rows = [];
      for (const keywords of watch.queries || [watch.keywords]) {
        for (const item of await huntSearch(config, { ...watch, keywords })) {
          if (seenIds.has(item.id)) continue;
          seenIds.add(item.id);
          rows.push({
            item,
            excluido: !titleMatches(item, watch),
            juego: identifyGame(item.title, catalog),
          });
        }
        await sleep(700);
      }

      const ok = rows.filter((r) => !r.excluido && r.juego);
      console.log(`IDENTIFICADOS (${ok.length}):`);
      for (const r of ok) {
        console.log(`  ${String(r.item.price.amount).padStart(6)} €  ${r.juego.nombre.padEnd(34)} ← ${r.item.title.slice(0, 44)}`);
      }

      const nope = rows.filter((r) => !r.excluido && !r.juego);
      console.log(`\nSIN IDENTIFICAR (${nope.length}) — candidatos a añadir al catálogo:`);
      for (const r of nope.slice(0, 30)) {
        console.log(`  ${String(r.item.price.amount).padStart(6)} €  ${r.item.title.slice(0, 62)}`);
      }

      const out = rows.filter((r) => r.excluido);
      console.log(`\nDESCARTADOS POR excludeWords (${out.length}):`);
      for (const r of out.slice(0, 15)) {
        console.log(`  ${String(r.item.price.amount).padStart(6)} €  ${r.item.title.slice(0, 62)}`);
      }
    }
    return;
  }

  // Ensayo en seco de una vigilancia normal: dice de qué avisaría y por qué
  // descarta el resto, sin tocar seen.json ni mandar nada. Es la herramienta
  // para afinar excludeWords al añadir un juego, antes de dejarlo suelto.
  const simArg = args.indexOf('--simular');
  if (simArg !== -1) {
    const filtro = args[simArg + 1] && !args[simArg + 1].startsWith('--')
      ? args[simArg + 1].toLowerCase()
      : null;

    const elegidas = config.todasLasWatches.filter((w) => w.mode !== 'catalog' &&
      (filtro ? w.name.toLowerCase().includes(filtro) : w.enabled !== false));
    if (!elegidas.length) {
      console.log(filtro ? `ninguna vigilancia se llama como "${filtro}"` : 'no hay vigilancias activas');
      return;
    }

    for (const watch of elegidas) {
      console.log(`\n=== ${watch.name}${watch.enabled === false ? ' (APAGADA)' : ''} ===`);

      let marketMedian = null;
      try {
        const market = await searchWallapop(config, watch, { orderBy: null, applyPriceFilters: false });
        marketMedian = median(market
          .filter((it) => titleMatches(it, watch))
          .map((it) => it.price?.amount)
          .filter((p) => typeof p === 'number' && p > 0));
      } catch (err) {
        console.log(`  (sin mediana: ${err.message})`);
      }
      console.log(`mediana del mercado: ${marketMedian ? eur.format(marketMedian) : 'n/d'}`);
      await sleep(600);

      const vistos = new Set();
      const filas = [];
      for (const keywords of watch.queries || [watch.keywords]) {
        try {
          for (const item of await huntSearch(config, { ...watch, keywords })) {
            if (vistos.has(item.id)) continue;
            vistos.add(item.id);
            filas.push({ item, descarte: motivoDescarte(item, watch, marketMedian) });
          }
        } catch (err) {
          console.log(`  barrido "${keywords}" falló (${err.message})`);
        }
        await sleep(700);
      }

      const pasan = filas.filter((f) => !f.descarte);
      console.log(`\nAVISARÍA DE (${pasan.length}):`);
      for (const f of pasan) {
        console.log(`  ${eur.format(f.item.price.amount).padStart(9)}  ${f.item.title.slice(0, 58)}`);
        console.log(`             ${itemUrl(f.item)}`);
      }

      const fuera = filas.filter((f) => f.descarte);
      console.log(`\nDESCARTADOS (${fuera.length}):`);
      for (const f of fuera) {
        const precio = typeof f.item.price?.amount === 'number' ? eur.format(f.item.price.amount) : '—';
        console.log(`  ${precio.padStart(9)}  ${f.descarte.texto.padEnd(26)} ${f.item.title.slice(0, 44)}`);
      }
    }
    return;
  }

  if (args.includes('--sesion')) {
    const nav = config.autoMensaje?.navegador;
    if (!nav) {
      log('no hay bloque autoMensaje.navegador en la config');
      return;
    }
    log('abriendo el Chrome del vigilante y comprobando la sesión...');
    const r = await navegador.comprobarSesion({ nav, log });
    log(r.ok ? '✅ sesión iniciada: ya puede escribir por ti' : `❌ ${r.motivo}`);
    if (!r.ok) log('   Entra en Wallapop en esa ventana de Chrome y vuelve a lanzar: node watcher.js --sesion');
    return;
  }

  // --probar <itemId>: recorre todo el envío pero NO pulsa enviar.
  const iProbar = args.indexOf('--probar');
  if (iProbar !== -1) {
    const itemUrl = args[iProbar + 1];
    if (!itemUrl) {
      log('uso: node watcher.js --probar <url del anuncio>');
      return;
    }
    const r = await navegador.enviarMensaje({
      nav: config.autoMensaje.navegador,
      itemUrl,
      texto: config.autoMensaje.texto,
      log,
      soloProbar: true,
    });
    log(`${r.ok ? '✅' : '❌'} ${r.motivo}`);
    return;
  }

  if (args.includes('--cola')) {
    const m = cargarMensajes();
    console.log(`\nEnviados: ${Object.keys(m.enviados).length} · hoy: ${enviadosHoy(m)}`);
    for (const [id, e] of Object.entries(m.enviados).slice(-10)) {
      console.log(`  ${e.ok ? '✅' : '❌'} ${new Date(e.at).toLocaleString('es-ES')}  ${eur.format(e.precio)}  ${e.titulo?.slice(0, 42)}  ${e.motivo || ''}`);
    }
    console.log(`\nEn cola: ${m.cola.length}`);
    for (const c of m.cola) {
      const min = Math.round((c.cuando - Date.now()) / 60000);
      console.log(`  ⏳ en ${min} min  ${eur.format(c.precio)}  ${c.titulo.slice(0, 42)}`);
    }
    return;
  }

  if (args.includes('--test')) {
    await ensureBridge(config);
    await sendWhatsApp(config, '✅ Wallapop watcher conectado. Ya te aviso cuando salga un chollo.');
    log('mensaje de prueba enviado');
    return;
  }

  const names = config.watches.map((w) => w.name).join(', ');

  log(`vigilando: ${names}`);

  if (args.includes('--once') || FORCE_NOW) {
    await cycle(config);
    return;
  }

  log(`sondeo cada ${config.pollMinutes || 5} min — Ctrl+C para parar`);

  let avisadoPausa = false;

  for (;;) {
    try {
      // Se relee la config en cada vuelta: así puedes editar config.json o el
      // catálogo con el vigilante corriendo, sin reiniciarlo.
      config = loadConfig();
      catalogCache.clear();

      if (enPausa(config)) {
        // Un solo mensaje al entrar en la ventana, no uno cada 5 minutos.
        if (!avisadoPausa) {
          const p = config.pausaNocturna;
          log(`en pausa nocturna (${p.desdeHora}:00–${p.hastaHora}:00), sin buscar`);
          avisadoPausa = true;
        }
      } else {
        avisadoPausa = false;
        await cycle(config);
      }
    } catch (err) {
      log(`ciclo fallido: ${err.message}`);
    }
    // Si nos han cortado, apartarse: 15, 30, 60 min. Insistir cada 5 sólo
    // alarga el castigo. Jitter siempre, para no golpear con patrón exacto.
    const minutos = sinRed
      ? 1
      : bloqueosSeguidos > 0
        ? Math.min(60, 15 * 2 ** (bloqueosSeguidos - 1))
        : config.pollMinutes || 5;
    if (bloqueosSeguidos > 0) log(`  esperando ${minutos} min antes de reintentar`);
    await sleep(minutos * 60000 + Math.random() * 30000);
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});

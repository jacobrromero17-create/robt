// Robot de consulta ZonaPagos (GM Financial).
// Flujo: abre el link -> espera la interfaz de consulta -> digita cédula y placa -> presiona
// "Continuar" -> lee Número de crédito, Placa, Fecha límite, Valor sugerido y Pagar otro valor.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// La URL original (PreLoginPage.aspx?ico=33968) solo responde con un header "Refresh: 5" hacia este
// destino, es decir, una espera fija de 5 s. Se entra directo al destino para no pagar esos 5 s.
const URL_CONSULTA = 'https://www.zonapagos.com/t_gmacbd/';
const SEL = {
  cedula: '#Login_InicioLogin_Mod9_IdCliente',
  placa: '#Login_InicioLogin_Mod9_IdPago',
  boton: '#Login_InicioLogin_BtnContinuarMod9',
  tabla: '#Contenido_ListadoFacturas_ctl00_GvFacturas',
};
const DEBUG_DIR = path.join(__dirname, 'debug');

class ConsultaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const headless = process.env.HEADLESS !== 'false';
    // Edge viene con Windows; si no está, se cae al Chromium de Playwright.
    browserPromise = chromium.launch({ channel: 'msedge', headless })
      .catch(() => chromium.launch({ headless }))
      .catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const fechaDDMMAAAA = (s) => clean(s).replace(/\//g, '-');

// Código que se ejecuta dentro de la página: lee la tabla de resultados.
// 1) Por ids conocidos de ZonaPagos. 2) Fallback visual: ubica las columnas por el TEXTO visible
//    de la cabecera (ignora columnas ocultas), así sigue funcionando si cambian ids/orden.
function extraerEnPagina() {
  const n = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) && getComputedStyle(el).visibility !== 'hidden';
  const CAMPOS = {
    credito: (h) => h.includes('numero de credito'),
    placa: (h) => h === 'placa',
    fecha: (h) => h.includes('fecha limite'),
    valorSugerido: (h) => h.includes('valor sugerido'),
    otroValor: (h) => h.includes('pagar otro valor'),
  };
  const tablas = [...document.querySelectorAll('table')].filter(visible);
  tablas.sort((a, b) => (a.id === 'Contenido_ListadoFacturas_ctl00_GvFacturas' ? -1 : 0) - (b.id === 'Contenido_ListadoFacturas_ctl00_GvFacturas' ? -1 : 0));
  for (const t of tablas) {
    const filas = [...t.querySelectorAll('tr')];
    const cab = filas.find((r) => r.querySelector('th'));
    if (!cab) continue;
    const ths = [...cab.children];
    const idx = {};
    ths.forEach((th, i) => {
      if (!visible(th)) return;
      const h = n(th.textContent);
      for (const [k, f] of Object.entries(CAMPOS)) if (idx[k] === undefined && f(h)) idx[k] = i;
    });
    if (idx.credito === undefined || idx.valorSugerido === undefined) continue;
    const resultados = [];
    for (const r of filas) {
      if (r === cab || r.querySelector('th')) continue;
      const tds = [...r.children];
      if (tds.length < ths.length) continue;
      const celda = (k) => {
        const td = tds[idx[k]];
        if (!td) return '';
        const inp = td.querySelector('input[type=text]');
        return inp ? inp.value : td.textContent;
      };
      resultados.push({
        credito: celda('credito'), placa: celda('placa'), fecha: celda('fecha'),
        valorSugerido: celda('valorSugerido'), otroValor: celda('otroValor'),
      });
    }
    if (resultados.length) return { via: t.id ? 'tabla-id' : 'cabeceras', resultados };
  }
  return null;
}

// Último recurso: busca en el texto visible de toda la página.
function extraerPorTextoEnPagina() {
  const txt = document.body.innerText || '';
  const fecha = (txt.match(/\b\d{2}[\/-]\d{2}[\/-]\d{4}\b/) || [''])[0];
  const lineas = txt.split('\n').map((l) => l.trim()).filter(Boolean);
  const num = lineas.find((l) => /^\d{6,}$/.test(l)) || '';
  const placa = lineas.find((l) => /^[A-Za-z]{3}\d{2}[A-Za-z0-9]$/.test(l)) || '';
  const valor = lineas.find((l) => /^\d{1,3}([.,]\d{3})+$/.test(l)) || '';
  if (!num || !valor) return null;
  return { via: 'texto', resultados: [{ credito: num, placa, fecha, valorSugerido: valor, otroValor: '' }] };
}

async function mensajeDeError(page) {
  const t = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    const cand = [...document.querySelectorAll('#Error_UpError, .error-message, .alert, .alert-danger, [id*=Error], [class*=error]')]
      .filter(vis).map((e) => (e.innerText || '').trim()).filter(Boolean);
    return cand.join(' | ');
  }).catch(() => '');
  return clean(t);
}

async function guardarEvidencia(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `${tag}-${Date.now()}.png`), fullPage: true });
  } catch { /* no es crítico */ }
}

// Abre una sesión nueva y la deja parada en el formulario de consulta.
async function abrirFormulario() {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ locale: 'es-CO', timezoneId: 'America/Bogota', viewport: { width: 1280, height: 900 } });
  try {
    // Imágenes, fuentes y media no aportan al resultado: no se descargan.
    await ctx.route('**/*', (r) => (['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(URL_CONSULTA, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(SEL.cedula, { state: 'visible', timeout: 45000 });
    return { ctx, page, t: Date.now() };
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
}

// Sesiones ya abiertas en el formulario: el cliente solo digita y consulta, sin esperar la carga.
const POOL_OBJETIVO = 2;
const POOL_VIDA_MS = 3 * 60 * 1000; // pasado esto la sesión del portal podría vencer
const pool = [];
let cerrando = false;

function rellenarPool() {
  while (!cerrando && pool.length < POOL_OBJETIVO) {
    const p = abrirFormulario();
    p.catch(() => {});
    pool.push(p);
    p.then((h) => setTimeout(() => {
      const i = pool.indexOf(p);
      if (i >= 0) { pool.splice(i, 1); h.ctx.close().catch(() => {}); rellenarPool(); }
    }, POOL_VIDA_MS).unref(), () => {
      const i = pool.indexOf(p);
      if (i >= 0) pool.splice(i, 1);
    });
  }
}

async function tomarFormulario() {
  const p = pool.shift();
  rellenarPool();
  if (p) { try { return await p; } catch { /* se abre uno propio */ } }
  return abrirFormulario();
}

async function consultar({ cedula, placa }) {
  const { ctx, page } = await tomarFormulario();
  try {
    // 2. Digitar los datos del cliente.
    await page.fill(SEL.cedula, cedula);
    await page.fill(SEL.placa, placa);

    // 3. Presionar "Continuar" (no se espera un load aparte: el sondeo de abajo ya detecta el resultado).
    await page.click(SEL.boton);

    // 4. Esperar resultado: tabla de créditos, o mensaje de error del portal.
    const deadline = Date.now() + 40000;
    let datos = null;
    while (Date.now() < deadline) {
      datos = await page.evaluate(extraerEnPagina).catch(() => null);
      if (datos) break;
      const err = await mensajeDeError(page);
      if (err && !(await page.$(SEL.tabla))) {
        await guardarEvidencia(page, 'rechazo');
        throw new ConsultaError('NO_ENCONTRADO', err.replace(/^[×✕✖\s]+/, '') || err);
      }
      await page.waitForTimeout(50);
    }
    if (!datos) datos = await page.evaluate(extraerPorTextoEnPagina).catch(() => null);
    if (!datos) {
      await guardarEvidencia(page, 'sin-resultado');
      throw new ConsultaError('SIN_RESULTADO', 'No se pudo identificar la información de la consulta en la página.');
    }

    return {
      via: datos.via,
      creditos: datos.resultados.map((r) => ({
        credito: clean(r.credito),
        placa: clean(r.placa),
        fecha: fechaDDMMAAAA(r.fecha),
        valorSugerido: clean(r.valorSugerido),
        otroValor: clean(r.otroValor),
      })),
    };
  } catch (e) {
    if (!(e instanceof ConsultaError)) {
      await guardarEvidencia(page, 'error');
      if (/Timeout/i.test(e.message)) throw new ConsultaError('TIMEOUT', 'El portal tardó demasiado en responder.');
      throw new ConsultaError('ROBOT', e.message);
    }
    throw e;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function cerrar() {
  cerrando = true;
  await Promise.all(pool.splice(0).map((p) => p.then((h) => h.ctx.close(), () => {}).catch(() => {})));
  if (browserPromise) { const b = await browserPromise.catch(() => null); if (b) await b.close(); browserPromise = null; }
}

// Enciende el navegador por anticipado (al arrancar el servidor) para que el primer
// cliente no pague el costo de abrirlo.
function precalentar() { return getBrowser().then(rellenarPool).catch((e) => console.error('[precalentar]', e.message)); }

module.exports = { consultar, cerrar, precalentar, ConsultaError, extraerEnPagina, extraerPorTextoEnPagina };

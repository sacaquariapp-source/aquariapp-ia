const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const ARQUIVO = path.join(__dirname, 'pushStore.json');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:sac.aquariapp@gmail.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return dados && typeof dados === 'object' ? dados : {};
  } catch (e) {
    return {};
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar pushStore.json:', e.message);
  }
}

// Guarda a subscription push do dispositivo (overwrite = mais recente).
function registrar({ dispositivoId, subscription }) {
  const dados = ler();
  dados[dispositivoId] = {
    ...(dados[dispositivoId] || {}),
    subscription,
    atualizadoEm: Date.now(),
  };
  salvar(dados);
}

// Salva os disparos futuros do dispositivo: [{ ts, title, body }].
function agendar({ dispositivoId, triggers }) {
  const dados = ler();
  const lista = Array.isArray(triggers) ? triggers : [];
  const limpo = lista
    .map((t) => ({
      ts: Number(t && t.ts) || 0,
      title: String((t && t.title) || 'AquarIApp'),
      body: String((t && t.body) || ''),
    }))
    .filter((t) => t.ts > 0);
  dados[dispositivoId] = {
    ...(dados[dispositivoId] || {}),
    triggers: limpo,
    atualizadoEm: Date.now(),
  };
  salvar(dados);
}

// Envia um push. Retorna true se entregue; false se a subscription expirou.
async function enviarPush(subscription, title, body) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
    return true;
  } catch (e) {
    // 404/410 = subscription não existe mais no push service.
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return false;
    console.error('Falha ao enviar push:', e.message);
    return null;
  }
}

// Envia os disparos que já venceram e remove os entregues/expirados.
async function processarDevidos() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return 0;
  const agora = Date.now();
  const dados = ler();
  let enviados = 0;
  let mudou = false;
  for (const [dispositivoId, reg] of Object.entries(dados)) {
    if (!reg || !reg.subscription || !Array.isArray(reg.triggers)) continue;
    const devidos = reg.triggers.filter((t) => t.ts <= agora);
    const futuros = reg.triggers.filter((t) => t.ts > agora);
    if (devidos.length === 0) continue;
    let expirou = false;
    for (const t of devidos) {
      const r = await enviarPush(reg.subscription, t.title, t.body);
      if (r === false) {
        expirou = true;
        break;
      }
      if (r === true) enviados += 1;
    }
    if (expirou) {
      delete dados[dispositivoId];
      mudou = true;
    } else if (futuros.length !== reg.triggers.length) {
      reg.triggers = futuros;
      mudou = true;
    }
  }
  if (mudou) salvar(dados);
  return enviados;
}

function resumo() {
  const dados = ler();
  return {
    vapid: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
    dispositivos: Object.keys(dados).filter((id) => dados[id] && dados[id].subscription).length,
    triggersPendentes: Object.values(dados).reduce(
      (acc, r) => acc + (Array.isArray(r && r.triggers) ? r.triggers.length : 0),
      0
    ),
  };
}

module.exports = { registrar, agendar, processarDevidos, resumo, VAPID_PUBLIC_KEY };
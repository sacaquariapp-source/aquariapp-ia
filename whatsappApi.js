// Camada de integração com o gerenciador de grupos do WhatsApp.
//
// IMPORTANTE: a API oficial WhatsApp Cloud API NÃO permite adicionar membros a
// um grupo nem promover/rebaixar admins de forma programática. Por isso esta
// camada é agnóstica de provedor: você a conecta a um serviço que ofereça isso
// (ex.: Whapi.Cloud, Wassenger, wawp.net) OU à lib não-oficial whatsapp-web.js.
//
// MODO SIMULADO (padrão): enquanto WHATSAPP_API_KEY/WHATSAPP_API_URL/WHATSAPP_GROUP_ID
// não forem preenchidos no .env, as operações apenas são registradas em log e
// retornam sucesso. Isso permite testar todo o fluxo do app de ponta a ponta
// sem depender de credenciais reais.
//
// Ao configurar o provedor, implemente as 4 funções abaixo (adicionarMembro,
// removerMembro, promoverAdmin, rebaixarAdmin) usando a API do seu provedor.

const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || '';
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || '';
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';

function configurado() {
  return !!(WHATSAPP_API_KEY && WHATSAPP_API_URL && WHATSAPP_GROUP_ID);
}

function normalizarTelefoneParaWhatsApp(t) {
  // Aceita "11999999999", "+5511999999999", "5511999999999" e retorna
  // "5511999999999" (formato E.164 sem o "+").
  let num = String(t || '').replace(/[^0-9]/g, '');
  if (num.startsWith('0')) num = num.slice(1);
  if (num.length === 11 && !num.startsWith('55')) num = `55${num}`;
  return num;
}

function log(acao, telefone, extra) {
  console.log(`[whatsapp-simulado] ${acao} | ${telefone}${extra ? ` | ${extra}` : ''}`);
}

// Faz a chamada real ao provedor. Substitua pelo SDK/endpoints do seu provedor.
async function chamarProvedor(metodo, caminho, corpo) {
  const res = await fetch(`${WHATSAPP_API_URL}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_API_KEY}`,
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Provedor WhatsApp (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  return res.json();
}

// Papel esperado: 'membro' (free, só leitura no grupo de anúncios) ou 'admin'
// (premium, pode postar). Devolve { papel, acao, modo }.
async function sincronizarMembro({ telefone, premium, grupo }) {
  const num = normalizarTelefoneParaWhatsApp(telefone);
  const papel = premium ? 'admin' : 'membro';

  if (!configurado()) {
    log(premium ? 'ADICIONAR_OU_PROMOVER' : 'ADICIONAR_COMO_MEMBRO', num, `papel=${papel}`);
    return { ok: true, modo: 'simulado', papel, acao: premium ? 'promover' : 'adicionar' };
  }

  // Fluxo real: adiciona se ainda não estiver e ajusta o papel.
  try {
    await adicionarMembro(num, grupo);
  } catch (e) {
    // Se já pertence ao grupo, o provedor costuma responder que já é membro;
    // então seguimos apenas ajustando o papel.
    console.warn('[whatsapp] Falha ao adicionar (pode já ser membro):', e.message);
  }
  if (premium) {
    await promoverAdmin(num, grupo);
  } else {
    await rebaixarAdmin(num, grupo);
  }
  return { ok: true, modo: 'real', papel, acao: premium ? 'promover' : 'adicionar' };
}

async function removerMembro(telefone, grupo) {
  const num = normalizarTelefoneParaWhatsApp(telefone);
  if (!configurado()) {
    log('REMOVER', num);
    return { ok: true, modo: 'simulado' };
  }
  await chamarProvedor('DELETE', `/groups/${grupo || WHATSAPP_GROUP_ID}/participants/${num}`);
  return { ok: true, modo: 'real' };
}

async function adicionarMembro(telefone, grupo) {
  const num = normalizarTelefoneParaWhatsApp(telefone);
  await chamarProvedor('POST', `/groups/${grupo || WHATSAPP_GROUP_ID}/participants`, {
    participants: [num],
  });
  return { ok: true };
}

async function promoverAdmin(telefone, grupo) {
  const num = normalizarTelefoneParaWhatsApp(telefone);
  await chamarProvedor('POST', `/groups/${grupo || WHATSAPP_GROUP_ID}/participants/${num}/promote`);
  return { ok: true };
}

async function rebaixarAdmin(telefone, grupo) {
  const num = normalizarTelefoneParaWhatsApp(telefone);
  await chamarProvedor('POST', `/groups/${grupo || WHATSAPP_GROUP_ID}/participants/${num}/demote`);
  return { ok: true };
}

module.exports = {
  configurado,
  sincronizarMembro,
  removerMembro,
  adicionarMembro,
  promoverAdmin,
  rebaixarAdmin,
  normalizarTelefoneParaWhatsApp,
};

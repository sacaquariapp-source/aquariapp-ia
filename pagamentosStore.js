const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'pagamentos.json');

// Catálogo oficial de produtos vendáveis no web (Checkout Pro Mercado Pago).
// O servidor é a autoridade de preço — o app nunca envia valores.
// Assinatura web = período pago (renovação por nova compra; sem recorrência).
const PRODUTOS = {
  'assinatura-mensal': { tipo: 'assinatura', rotulo: 'Premium Mensal', preco: 19.9, meses: 1 },
  'assinatura-trimestral': { tipo: 'assinatura', rotulo: 'Premium Trimestral', preco: 49.9, meses: 3 },
  'creditos-basico-20': { tipo: 'creditos', rotulo: '20 créditos (Básico)', preco: 4.9, creditos: 20, plano: 'basico' },
  'creditos-basico-50': { tipo: 'creditos', rotulo: '50 créditos (Básico)', preco: 9.9, creditos: 50, plano: 'basico' },
  'creditos-basico-120': { tipo: 'creditos', rotulo: '120 créditos (Básico)', preco: 19.9, creditos: 120, plano: 'basico' },
  'creditos-premium-30': { tipo: 'creditos', rotulo: '30 créditos (Premium)', preco: 4.9, creditos: 30, plano: 'premium' },
  'creditos-premium-70': { tipo: 'creditos', rotulo: '70 créditos (Premium)', preco: 9.9, creditos: 70, plano: 'premium' },
  'creditos-premium-150': { tipo: 'creditos', rotulo: '150 créditos (Premium)', preco: 19.9, creditos: 150, plano: 'premium' },
};

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar pagamentos.json:', e.message);
  }
}

function novoRef() {
  return (
    'AQ' +
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 8).toUpperCase()
  );
}

// Registra a intenção de compra (status pendente) antes de abrir o checkout.
function criar({ produtoId, email, dispositivoId }) {
  const produto = PRODUTOS[produtoId];
  if (!produto) return { ok: false, erro: 'PRODUTO_INVALIDO' };
  const ref = novoRef();
  const agora = new Date().toISOString();
  const registro = {
    ref,
    produtoId,
    tipo: produto.tipo,
    rotulo: produto.rotulo,
    preco: produto.preco,
    email: String(email || '').trim().toLowerCase(),
    dispositivoId: String(dispositivoId || '').trim(),
    status: 'pendente',
    criadoEm: agora,
    atualizadoEm: agora,
  };
  const dados = ler();
  dados[ref] = registro;
  salvar(dados);
  return { ok: true, ref, registro };
}

// Marca como pago. `dadosMp` traz id da transação e método para auditoria.
function marcarPago(ref, dadosMp = {}) {
  const dados = ler();
  const r = dados[ref];
  if (!r) return { ok: false, erro: 'REF_NAO_ENCONTRADA' };
  if (r.status === 'pago') return { ok: true, registro: r, jaEstava: true };
  r.status = 'pago';
  r.pagoEm = new Date().toISOString();
  r.mpPaymentId = dadosMp.mpPaymentId || null;
  r.metodo = dadosMp.metodo || null;
  if (r.tipo === 'assinatura') {
    const dias = (PRODUTOS[r.produtoId] && PRODUTOS[r.produtoId].meses * 30) || 30;
    r.validadeAte = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
  }
  dados[ref] = r;
  salvar(dados);
  return { ok: true, registro: r };
}

function statusPorRef(ref) {
  const dados = ler();
  return dados[String(ref || '').trim()] || null;
}

function listarPorEmail(email) {
  const alvo = String(email || '').trim().toLowerCase();
  if (!alvo) return [];
  return Object.values(ler())
    .filter((p) => p.email === alvo)
    .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

function listarTodos(limite = 200) {
  return Object.values(ler())
    .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''))
    .slice(0, limite);
}

module.exports = { PRODUTOS, criar, marcarPago, statusPorRef, listarPorEmail, listarTodos };

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'contas.json');

// Registro central de contas (email verificado no app). Alimenta:
//  - lista de transmissão do admin separada por assinantes x básicos;
//  - consentimento de marketing (receberOfertas — padrão LIGADO, LGPD:
//    o usuário pode desligar quando quiser em Configurações).
// Persistido em disco (Render free não garante disco permanente entre
// restarts — mesma limitação aceita no trial.json).
function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return dados && typeof dados === 'object' && dados.contas ? dados : { contas: {} };
  } catch (e) {
    return { contas: {} };
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar contas.json:', e.message);
  }
}

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Cria ou atualiza o registro da conta. Nunca apaga campos existentes
// (ex.: plano definido por pagamento) se o campo não vier na chamada.
function registrarOuAtualizar({ email, dispositivoId, receberOfertas }) {
  const chave = normalizarEmail(email);
  if (!chave || !chave.includes('@')) return null;
  const dados = ler();
  const atual = dados.contas[chave] || {};
  const conta = {
    ...atual,
    email: chave,
    dispositivoId: dispositivoId ? String(dispositivoId) : atual.dispositivoId || null,
    plano: atual.plano || 'basico',
    receberOfertas:
      typeof receberOfertas === 'boolean' ? receberOfertas : atual.receberOfertas !== false,
    canceladoEm: atual.canceladoEm || null,
    atualizadoEm: new Date().toISOString(),
    criadoEm: atual.criadoEm || new Date().toISOString(),
  };
  dados.contas[chave] = conta;
  dados.atualizadoEm = conta.atualizadoEm;
  salvar(dados);
  return conta;
}

function definirPreferencias({ email, receberOfertas }) {
  const chave = normalizarEmail(email);
  if (!chave || typeof receberOfertas !== 'boolean') return null;
  const dados = ler();
  const atual = dados.contas[chave];
  if (!atual) return null;
  atual.receberOfertas = receberOfertas;
  atual.atualizadoEm = new Date().toISOString();
  dados.contas[chave] = atual;
  dados.atualizadoEm = atual.atualizadoEm;
  salvar(dados);
  return atual;
}

// Plano: 'basico' | 'mensal' | 'trimestral'. Chamado pelo webhook de
// pagamento (entrada/renovação) e pelo endpoint de cancelamento.
function definirPlano({ email, plano }) {
  const chave = normalizarEmail(email);
  if (!chave || !['basico', 'mensal', 'trimestral'].includes(plano)) return null;
  const dados = ler();
  const atual = dados.contas[chave];
  if (!atual) {
    // Pagamento chegou antes do primeiro login no dispositivo novo —
    // cria o registro para o plano já estar certo quando a conta registrar.
    return registrarOuAtualizar({ email: chave, plano });
  }
  atual.plano = plano;
  if (plano === 'basico') atual.canceladoEm = new Date().toISOString();
  else atual.canceladoEm = null;
  atual.atualizadoEm = new Date().toISOString();
  salvar(dados);
  return atual;
}

function remover(email) {
  const chave = normalizarEmail(email);
  const dados = ler();
  if (!dados.contas[chave]) return false;
  delete dados.contas[chave];
  salvar(dados);
  return true;
}

// segmento: 'todos' | 'assinantes' | 'basicos' | 'ofertas' | 'cancelados'
function listar(segmento = 'todos') {
  const dados = ler();
  let contas = Object.values(dados.contas || {});
  if (segmento === 'assinantes') contas = contas.filter((c) => c.plano !== 'basico');
  else if (segmento === 'basicos') contas = contas.filter((c) => c.plano === 'basico');
  else if (segmento === 'ofertas') contas = contas.filter((c) => c.receberOfertas !== false);
  else if (segmento === 'cancelados') contas = contas.filter((c) => !!c.canceladoEm);
  return contas.sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
}

function resumo() {
  const todas = listar('todos');
  return {
    total: todas.length,
    assinantes: todas.filter((c) => c.plano !== 'basico').length,
    basicos: todas.filter((c) => c.plano === 'basico').length,
    receberOfertas: todas.filter((c) => c.receberOfertas !== false).length,
    cancelados: todas.filter((c) => !!c.canceladoEm).length,
    atualizadoEm: dadosAtualizadoEm(),
  };
}

function dadosAtualizadoEm() {
  try {
    return ler().atualizadoEm || null;
  } catch (e) {
    return null;
  }
}

function paraCSV(contas) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const linhas = ['email;plano;receberOfertas;criadoEm;atualizadoEm;canceladoEm'];
  for (const c of contas) {
    linhas.push(
      [c.email, c.plano, c.receberOfertas !== false ? 'sim' : 'nao', c.criadoEm, c.atualizadoEm, c.canceladoEm]
        .map(esc)
        .join(';')
    );
  }
  return linhas.join('\r\n');
}

module.exports = {
  registrarOuAtualizar,
  definirPreferencias,
  definirPlano,
  remover,
  listar,
  resumo,
  paraCSV,
};

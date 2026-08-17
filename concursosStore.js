const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'concursos.json');

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
    console.error('Falha ao salvar concursos:', e.message);
  }
}

// --- Configuração do concurso ativo ---
function obterConfig() {
  const dados = ler();
  return dados.config || null;
}

function salvarConfig(config) {
  const dados = ler();
  dados.config = config;
  salvar(dados);
  return config;
}

// --- Inscrições ---
function listarInscricoes() {
  const dados = ler();
  return Array.isArray(dados.inscricoes) ? dados.inscricoes : [];
}

function obterInscricao(id) {
  return listarInscricoes().find((i) => i.id === id) || null;
}

function atualizarInscricao(id, mudancas) {
  const inscricoes = listarInscricoes();
  const idx = inscricoes.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  inscricoes[idx] = { ...inscricoes[idx], ...mudancas };
  const store = ler();
  store.inscricoes = inscricoes;
  salvar(store);
  return inscricoes[idx];
}

function removerInscricao(id) {
  const inscricoes = listarInscricoes();
  const nova = inscricoes.filter((i) => i.id !== id);
  if (nova.length === inscricoes.length) return false;
  const store = ler();
  store.inscricoes = nova;
  salvar(store);
  return true;
}

// Inscrição: status inicial 'pendente' (aguarda aprovação do admin). A foto é
// imutável; apenas o status pode mudar (aprovado / rejeitado) ou o item pode
// ser removido pelo admin.
function criarInscricao(dados) {
  const inscricoes = listarInscricoes();
  const inscricao = {
    id: `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    criadoEm: Date.now(),
    votos: 0,
    votantes: [],
    status: 'pendente',
    ...dados,
  };
  inscricoes.push(inscricao);
  const store = ler();
  store.inscricoes = inscricoes;
  salvar(store);
  return inscricao;
}

function statusDeDispositivo(dispositivoId) {
  const norm = String(dispositivoId || '').trim();
  if (!norm) return null;
  const ins = listarInscricoes().find((i) => String(i.dispositivoId || '') === norm);
  return ins
    ? { status: ins.status || 'pendente', inscricaoId: ins.id, motivo: ins.motivo || '', foto: ins.foto || '' }
    : null;
}

// --- Votação ---
function registrarVoto(inscricaoId, dispositivoId) {
  const inscricoes = listarInscricoes();
  const idx = inscricoes.findIndex((i) => i.id === inscricaoId);
  if (idx === -1) return { ok: false, motivo: 'Inscrição não encontrada.' };
  const inscricao = inscricoes[idx];
  if (inscricao.status !== 'aprovado') {
    return { ok: false, motivo: 'Esta inscrição não está autorizada para votação.' };
  }
  const votantes = Array.isArray(inscricao.votantes) ? inscricao.votantes : [];
  const norm = String(dispositivoId || '').trim();
  if (!norm) return { ok: false, motivo: 'Dispositivo inválido.' };
  // Regra: UM voto por dispositivo em TODO o concurso (não por foto). Se o
  // dispositivo já votou em qualquer inscrição, o voto é recusado.
  const jaVotouEmAlguma = inscricoes.some((i) => Array.isArray(i.votantes) && i.votantes.includes(norm));
  if (jaVotouEmAlguma) {
    return { ok: false, motivo: 'JÁ_VOTOU', jaVotou: true };
  }
  votantes.push(norm);
  inscricoes[idx] = { ...inscricao, votantes, votos: votantes.length };
  const store = ler();
  store.inscricoes = inscricoes;
  salvar(store);
  return { ok: true, inscricao: inscricoes[idx] };
}

function definirGanhador(inscricaoId) {
  const inscricoes = listarInscricoes();
  const idx = inscricoes.findIndex((i) => i.id === inscricaoId);
  if (idx === -1) return null;
  if (inscricoes[idx].status !== 'aprovado') return null;
  const store = ler();
  store.ganhador = { inscricaoId, declaradoEm: Date.now() };
  salvar(store);
  return { inscricaoId, inscricao: inscricoes[idx] };
}

function obterGanhador() {
  const dados = ler();
  if (!dados.ganhador) return null;
  const inscricao = obterInscricao(dados.ganhador.inscricaoId);
  if (!inscricao) return null;
  return { inscricaoId: inscricao.id, inscricao, declaradoEm: dados.ganhador.declaradoEm };
}

// --- Histórico / encerramento ---
// Após a declaração do vencedor o admin pode encerrar o concurso. As fotos são
// apagadas (o arquivo é removido na rota) e fica guardada apenas a "memória":
// categoria do concurso + dados do vencedor.
function encerrarConcurso(historico) {
  const store = ler();
  const registros = Array.isArray(store.historico) ? store.historico : [];
  registros.push(historico);
  store.historico = registros;
  store.inscricoes = [];
  store.ganhador = null;
  if (store.config) store.config = { ...store.config, ativo: false };
  salvar(store);
  return historico;
}

function obterHistorico() {
  const dados = ler();
  return Array.isArray(dados.historico) ? dados.historico : [];
}

module.exports = {
  obterConfig,
  salvarConfig,
  listarInscricoes,
  obterInscricao,
  atualizarInscricao,
  removerInscricao,
  criarInscricao,
  statusDeDispositivo,
  registrarVoto,
  definirGanhador,
  obterGanhador,
  encerrarConcurso,
  obterHistorico,
};

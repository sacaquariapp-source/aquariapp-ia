const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'tester.json');

// Acesso ilimitado: só as pessoas que receberem o link usam o app (o próprio
// link é a "senha" de acesso). Mantém a expiração garantida como segurança,
// caso esqueçam de tirar o link do ar.
const EXPIRA_EM = new Date('2026-09-30T23:59:59-03:00').getTime();

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
    console.error('Falha ao salvar tester.json:', e.message);
  }
}

function estado() {
  const dados = ler();
  return {
    limite: 'ilimitado',
    expiraEm: EXPIRA_EM,
    dispositivos: Array.isArray(dados.dispositivos) ? dados.dispositivos : [],
  };
}

// Valida o acesso de um dispositivo de teste. Sem limite de vagas: todo
// dispositivo que recebeu o link é liberado (apenas a expiração limita).
// Retorna { ok: true } se liberado, ou { ok: false, codigo, motivo } se negado.
function validar(dispositivoId) {
  const e = estado();
  const agora = Date.now();

  if (agora > e.expiraEm) {
    return { ok: false, codigo: 'EXPIRADO', motivo: 'O período de testes terminou.' };
  }

  const id = String(dispositivoId || '').trim();
  if (!id) {
    return { ok: false, codigo: 'SEM_ID', motivo: 'Não foi possível identificar o dispositivo.' };
  }

  // Registra o dispositivo na 1ª visita (apenas para o admin acompanhar quantos
  // abriram o link), mas NUNCA nega acesso por quantidade.
  const jaRegistrado = e.dispositivos.some((d) => d.id === id);
  if (!jaRegistrado) {
    const nova = [...e.dispositivos, { id, registradoEm: agora }];
    salvar({ ...ler(), dispositivos: nova });
  }
  return { ok: true };
}

function listar() {
  return estado();
}

// Permite remover um dispositivo da lista (útil se quiser deixar de acompanhá-lo).
function remover(dispositivoId) {
  const e = estado();
  const nova = e.dispositivos.filter((d) => d.id !== dispositivoId);
  if (nova.length === e.dispositivos.length) return false;
  salvar({ ...ler(), dispositivos: nova });
  return true;
}

module.exports = { validar, listar, remover, LIMITE_TESTERS: null, EXPIRA_EM };

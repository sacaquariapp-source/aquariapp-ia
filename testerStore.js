const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'tester.json');

// Limite de testadores e expiração garantida (segurança caso esqueçam de tirar
// o link do ar). O servidor é a fonte da verdade para ambos.
const LIMITE_TESTERS = 6;
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
    limite: LIMITE_TESTERS,
    expiraEm: EXPIRA_EM,
    dispositivos: Array.isArray(dados.dispositivos) ? dados.dispositivos : [],
  };
}

// Valida o acesso de um dispositivo de teste.
// Retorna { ok: true } se liberado, ou { ok: false, codigo, motivo } se negado.
// Codigos: 'EXPIRADO' | 'LIMITE_ATINGIDO'
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

  const jaRegistrado = e.dispositivos.some((d) => d.id === id);
  if (jaRegistrado) {
    return { ok: true };
  }

  if (e.dispositivos.length >= e.limite) {
    return {
      ok: false,
      codigo: 'LIMITE_ATINGIDO',
      motivo: `Limite de testadores atingido (${e.limite}).`,
    };
  }

  const nova = [...e.dispositivos, { id, registradoEm: agora }];
  salvar({ ...ler(), dispositivos: nova });
  return { ok: true };
}

function listar() {
  return estado();
}

// Permite liberar uma vaga (útil se um testador desistir). Exige chave admin.
function remover(dispositivoId) {
  const e = estado();
  const nova = e.dispositivos.filter((d) => d.id !== dispositivoId);
  if (nova.length === e.dispositivos.length) return false;
  salvar({ ...ler(), dispositivos: nova });
  return true;
}

module.exports = { validar, listar, remover, LIMITE_TESTERS, EXPIRA_EM };

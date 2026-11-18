/* Regras dos campos usadas pelo painel: as MESMAS do servidor (api/src/validate.ts e api/src/html-editor.ts).
 * O servidor é a autoridade e confere tudo de novo; aqui elas evitam pendência que nunca some (o painel
 * achava "mudou" por causa de um espaço que o servidor ignora) e erro só depois de publicar.
 * api/test/node/regras-painel.test.ts roda este arquivo e o do servidor nos mesmos milhares de valores e exige
 * o mesmo resultado (forma canônica e válido/inválido). O limite de cada campo vem do /content (esquema do
 * commit); TYPE_MAX é só o teto por tipo, igual ao do servidor. */
(function (root) {
  'use strict';
  var TYPE_MAX = { text: 600, meta: 300, address: 300, number: 9, phone: 30, whatsapp: 30, email: 120, link: 300, image: 200 };
  var IMAGE_PATH_RE = /^assets\/fotos\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/;

  function digits(s) { return String(s).replace(/\D/g, ''); }
  function normWhats(v) { var d = digits(v); if (d.length === 10 || d.length === 11) d = '55' + d; return d; }
  function fmtWhats(v) {
    var d = digits(v); if (d.indexOf('55') === 0 && d.length >= 12) d = d.slice(2);
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return d;
  }
  // como o servidor recebe: CRLF/CR viram LF e tira espaço das pontas
  function normalizeValue(v) { return String(v).replace(/\r\n?/g, '\n').trim(); }
  // forma usada para decidir se o valor MUDOU (servidor: canonicalValue)
  function canonicalValue(type, v) {
    v = String(v);
    switch (type) {
      case 'text': case 'phone': case 'email': return v.replace(/\s+/g, ' ').trim();
      case 'whatsapp': return normWhats(v);
      case 'number': return String(parseInt(v, 10) || 0);
      case 'address': return v.split('\n').map(function (l) { return l.trim(); }).join('\n');
      default: return v;
    }
  }
  // '' se válido; senão a mensagem. v já normalizado (normalizeValue). max: limite do esquema do campo.
  function validate(type, v, max) {
    v = String(v);
    max = max || TYPE_MAX[type];
    if (!v.trim()) return 'Não pode ficar vazio.';
    if (type !== 'address' && /[\r\n]/.test(v)) return 'Este campo não aceita quebra de linha (Enter).';
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v)) return 'Tem um caractere invisível no texto. Apague e digite de novo.';
    if (max && v.length > max) return 'Máximo de ' + max + ' caracteres.';
    switch (type) {
      case 'image': return IMAGE_PATH_RE.test(v) ? '' : 'Foto inválida. Envie uma foto JPG, PNG ou WebP.';
      case 'number': return /^\d{1,9}$/.test(v) ? '' : 'Use só números.';
      case 'phone': var d = digits(v).length; return d < 10 || d > 13 ? 'Telefone com DDD, ex.: +55 (51) 99999-9999.' : '';
      case 'whatsapp': return /^55\d{10,11}$/.test(normWhats(v)) ? '' : 'Número com DDD, ex.: (51) 99377-5912.';
      case 'email': return /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(v) ? '' : 'E-mail inválido.';
      case 'link': return /^https:\/\/[^\s"<>]+$/i.test(v) ? '' : 'O link precisa começar com https://';
      default: return '';
    }
  }

  root.HG_RULES = {
    TYPE_MAX: TYPE_MAX, digits: digits, normWhats: normWhats, fmtWhats: fmtWhats,
    normalizeValue: normalizeValue, canonicalValue: canonicalValue, validate: validate
  };
})(typeof window !== 'undefined' ? window : globalThis);

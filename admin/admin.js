/* Painel HG Transportes (JS puro, sem build). Fala só com o servidor do painel (Worker), nunca com o GitHub.
 *
 * Sessão: POST /login {username, password, turnstileToken?} => token opaco guardado só nesta aba
 *   (sessionStorage) e enviado como Authorization: Bearer. Ao abrir, GET /me valida o token.
 *   Qualquer 401 volta para a tela de entrar preservando o rascunho.
 * Rascunho (localStorage, uma chave POR USUÁRIO): {user, base, values, originals}. originals = o valor
 *   publicado que a pessoa via ao editar. Ao repor, se o site mudou aquele campo desde então, o campo fica
 *   em CONFLITO visível (nada é aplicado em silêncio) até ela escolher. Sair (botão) descarta o rascunho;
 *   sessão vencida guarda. Rascunho de um usuário nunca aparece para outro.
 * Publicação: GET /content => {html, commit, fields (tipo e limite por campo, do esquema do commit)}.
 *   O html vira os campos (DOMParser, inerte) e o commit fica como base. POST /publish {base, changes,
 *   images, expected} gera UM commit; expected = o valor publicado que o painel mostrava (o servidor
 *   confere contra o HEAD). Resposta: commit novo, paths das fotos e rebased/othersChanged: se outra
 *   pessoa tinha publicado outros campos, o painel recarrega o conteúdo novo (mantendo o que ainda não foi
 *   publicado) e avisa quais campos mudaram. 409 conflict = outra pessoa mudou o mesmo campo; 409
 *   schema_mismatch e 422 integrity = problema técnico (bloqueia e manda chamar o responsável).
 * Prévia: iframe sandbox="allow-same-origin" (sem allow-scripts: o JS do site não roda dentro do painel)
 *   com ../index.html do Pages (pode estar atrasado); ao carregar, o painel iguala o DOM ao html do
 *   servidor e aplica o rascunho por cima. Fotos novas aparecem via blob: até o Pages atualizar.
 * Segurança: todo dado externo entra na tela por textContent/atributo; o servidor valida tudo de novo.
 */
(function () {
  'use strict';
  if (window.top !== window.self) { window.top.location = window.self.location; return; }

  var CFG = window.HG_CMS || {};
  var API_BASE = String(CFG.apiBase || '').replace(/\/+$/, '');
  var MB = 1024 * 1024, DAY = 86400000;
  var MAX_IMG_BYTES = (CFG.maxImageMB || 3) * MB;          // cada foto já reduzida (decodificada)
  var MAX_IMAGES = CFG.maxImages || 6;                      // fotos por publicação
  var MAX_BODY_BYTES = (CFG.maxPublishMB || 12) * 1000 * 1000; // corpo do /publish (decimal: margem a favor)
  var MAX_IMG_WIDTH = CFG.maxImageWidth || 2000;
  var MAX_RAW_IMG_BYTES = 25 * MB; // foto original antes de reduzir
  var TEXT_RESERVE = 256 * 1024;   // espaço do corpo reservado para textos e JSON ao somar fotos
  var IMG_PATH_RE = /^assets\/fotos\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/;
  var IMG_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
  var TS_KEY = String(CFG.turnstileSiteKey || '');
  var TS_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  var SESSION_KEY = 'hg-cms-session';
  var DRAFT_PREFIX = 'hg-cms-draft:';  // + usuário
  var LEGACY_DRAFT_KEY = 'hg-cms-draft'; // formato antigo, sem dono: apagado ao abrir
  var R = window.HG_RULES;             // regras dos campos (rules.js), iguais às do servidor
  var MSG_SCHEMA = 'O site foi alterado fora do painel e os campos não batem mais. Nada foi publicado. ' +
    'Chame o responsável técnico antes de publicar de novo.';
  var MSG_INTEGRITY = 'O painel não conseguiu aplicar esta alteração com segurança e nada foi publicado. ' +
    'Chame o responsável técnico e diga qual campo estava marcado.';
  var MSG_TOO_LARGE = 'As fotos ficaram grandes demais para enviar de uma vez. ' +
    'Publique uma ou duas fotos agora e troque as outras numa próxima publicação.';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  var token = null, me = null, previewOnly = false, busy = false;
  var siteCommit = null;    // commit do site em que o painel se baseia (vem do /content; base do /publish e /restore)
  var tokenExpiresAt = null; // validade da chave de publicação (só admin; vem do /me)
  var fields = [];          // {key,label,type,group,original,value,conflict,wrap,input,msg,...}
  var byKey = {};
  var rulesByKey = {};      // chave -> {type, max} do /content (esquema do commit)
  var pendingOwner = null;  // usuário dono das fotos escolhidas e ainda não publicadas
  var pendingImages = {};   // chave -> {blob, blobUrl}
  var localUrls = {};       // caminho publicado -> blob: (enquanto o site público não atualiza)
  var frameDoc = null;
  var ts = { state: 'off', id: null, token: '' }; // Turnstile: off | loading | ready | failed

  /* ---------------- util ---------------- */
  var digits = R.digits;
  function oneLine(s) { return String(s).replace(/\r\n?|\n|\t/g, ' '); }
  function b64Len(bytes) { return Math.ceil(bytes / 3) * 4; }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function toast(msg, kind) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + (kind || '');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = 'toast'; }, kind === 'bad' ? 7000 : 4000);
  }
  function store() { try { return localStorage; } catch (e) { return null; } }
  function sess() { try { return sessionStorage; } catch (e) { return null; } }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* ---------------- servidor do painel ---------------- */
  var DEFAULT_MSG = {
    0: 'Não foi possível falar com o servidor do painel. Confira a internet e tente de novo.',
    400: 'Pedido inválido.',
    401: 'Sua sessão expirou. Entre de novo.',
    403: 'Você não tem permissão para fazer isso.',
    404: 'Não encontrado.',
    409: 'O site foi alterado por outra pessoa. Recarregue o painel.',
    413: 'O envio ficou grande demais.',
    422: 'Confira os campos marcados em vermelho.',
    429: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.',
    500: 'O servidor do painel teve um problema. Tente de novo em instantes.',
    502: 'O serviço que guarda o site não respondeu. Tente de novo em instantes.'
  };
  // Mensagens que o servidor manda com termo técnico ganham versão para quem não é da área.
  var MSG_CONFLICT = 'Outra pessoa publicou uma mudança no site depois que você abriu o painel. ' +
    'Recarregue para ver a versão nova; suas alterações não publicadas continuam guardadas.';
  var MSG_CONFLICT_FIELDS = 'Outra pessoa publicou uma mudança nestes mesmos campos depois que você abriu o painel. ' +
    'Recarregue para ver o que ela mudou; suas alterações continuam guardadas e voltam por cima.';
  var MSG_UPSTREAM = 'O serviço que guarda o site não respondeu. Nada foi perdido; tente de novo em instantes.';
  // Retry-After (segundos) em texto: "cerca de 15 minutos", "cerca de 1 minuto", "alguns segundos".
  function waitText(sec) {
    if (!(sec > 0)) return 'alguns minutos';
    if (sec < 60) return 'alguns segundos';
    var m = Math.ceil(sec / 60);
    return 'cerca de ' + m + (m === 1 ? ' minuto' : ' minutos');
  }
  function apiError(status, code, message, fieldsErr, retryAfter) {
    var friendly = '';
    if (status === 429) friendly = 'Muitas tentativas seguidas. Por segurança, aguarde ' + waitText(retryAfter) + ' e tente de novo.';
    else if (code === 'conflict' && status === 409 && /alterado por outra pessoa/i.test(message || '')) {
      friendly = fieldsErr && Object.keys(fieldsErr).length ? MSG_CONFLICT_FIELDS : MSG_CONFLICT;
    } else if (status === 502 || code === 'upstream') friendly = MSG_UPSTREAM;
    else if (code === 'session_expired' || code === 'unauthenticated') friendly = DEFAULT_MSG[401];
    var e = new Error(friendly || message || DEFAULT_MSG[status] || DEFAULT_MSG[status >= 500 ? 500 : 400]);
    e.status = status; e.code = code || ''; e.fields = fieldsErr && typeof fieldsErr === 'object' ? fieldsErr : null;
    e.retryAfter = retryAfter > 0 ? retryAfter : 0;
    e.fromServer = !!message; // a mensagem veio do servidor (tem prioridade sobre a dica do cliente)
    return e;
  }
  // opts: {method, body (objeto JSON), auth:false (não trata 401 como sessão expirada)}
  function api(path, opts) {
    opts = opts || {};
    var headers = {}, body = opts.body;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(API_BASE + path, {
      method: opts.method || (body !== undefined ? 'POST' : 'GET'),
      headers: headers,
      body: body,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).catch(function () { throw apiError(0, 'network'); }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok && j && j.ok !== false) return j;
        var ra = parseInt(r.headers.get('Retry-After') || '', 10);
        var e = apiError(r.status, j && j.code, j && typeof j.error === 'string' ? j.error : '', j && j.fields, ra);
        if (r.status === 401 && opts.auth !== false) { e.handled = true; sessionExpired(); }
        throw e;
      });
    });
  }
  // Texto de erro para formulários: campos do servidor > mensagem do servidor > padrão do formulário.
  var FORM_LABEL = { username: 'Usuário', password: 'Senha', current: 'Senha atual', 'new': 'Nova senha', role: 'Papel', currentPassword: 'Sua senha' };
  function fieldsText(e, fallback) {
    if (e.status === 409 || e.status === 429) return e.message; // ex.: "Já existe um usuário com esse nome."
    var parts = e.fields ? Object.keys(e.fields).map(function (k) {
      var m = String(e.fields[k]), l = FORM_LABEL[k];
      // "Senha: Use pelo menos 3 caracteres diferentes." (sem repetir quando a mensagem já diz o campo)
      return l && m.toLowerCase().indexOf(l.toLowerCase()) < 0 ? l + ': ' + m : m;
    }) : [];
    if (parts.length) return parts.join(' ');
    if (e.fromServer || !fallback || e.status !== 422) return e.message;
    return fallback;
  }

  /* ---------------- sessão ---------------- */
  function saveToken(t) { token = t; try { var s = sess(); if (s) t ? s.setItem(SESSION_KEY, t) : s.removeItem(SESSION_KEY); } catch (e) {} }
  function sessionExpired() {
    saveDraft(); // o rascunho fica guardado; ao entrar de novo ele volta
    saveToken(null); me = null;
    showLogin('Sua sessão expirou. Entre de novo.');
  }
  function closeDialogs() { $$('dialog[open]').forEach(function (d) { d.close(); }); }
  function showLogin(msg) {
    closeDialogs();
    busy = false; previewOnly = false; tokenExpiresAt = null;
    updateTokenWarning(); showBlocked('');
    $('#app').hidden = true; $('#login').hidden = false;
    $('#loginError').textContent = msg || '';
    var btn = $('#loginBtn'); btn.disabled = false; btn.textContent = 'Entrar';
    $('#pass').value = '';
    initTurnstile(); resetTurnstile(); // o token da Turnstile vale uma vez só
    ($('#user').value ? $('#pass') : $('#user')).focus();
  }

  /* ---------------- faixas de aviso ---------------- */
  // Só admin: a chave de publicação (token do GitHub no servidor) tem validade.
  function updateTokenWarning() {
    var box = $('#tokenWarning'), msg = '';
    var ms = tokenExpiresAt ? Date.parse(tokenExpiresAt) - Date.now() : NaN;
    if (!previewOnly && me && me.role === 'admin' && !isNaN(ms) && ms < 30 * DAY) {
      var n = Math.floor(ms / DAY);
      msg = ms <= 0 ? 'A chave de publicação do site venceu, publicações vão falhar. Avise o responsável técnico.'
        : 'A chave de publicação do site vence ' + (n < 1 ? 'em menos de 1 dia' : 'em ' + n + (n === 1 ? ' dia' : ' dias')) +
          '. Avise o responsável técnico.';
    }
    box.textContent = msg; box.hidden = !msg;
  }
  // Publicação bloqueada por problema que o usuário não resolve sozinho (fica até publicar com sucesso).
  function showBlocked(msg) { var b = $('#blockedWarning'); b.textContent = msg || ''; b.hidden = !msg; }

  /* ---------------- Turnstile (opcional: só com turnstileSiteKey no config.js) ---------------- */
  function initTurnstile() {
    if (!TS_KEY || ts.state !== 'off') return;
    var box = $('#turnstile'); box.hidden = false;
    ts.state = 'loading';
    var fail = function () { ts.state = 'failed'; ts.token = ''; };
    var s = document.createElement('script');
    s.src = TS_SRC; s.async = true;
    s.addEventListener('error', fail);
    s.addEventListener('load', function () {
      var T = window.turnstile;
      if (!T || typeof T.render !== 'function') { fail(); return; }
      try {
        ts.id = T.render(box, {
          sitekey: TS_KEY,
          action: 'login',
          language: 'pt-br',
          callback: function (t) { ts.token = typeof t === 'string' ? t : ''; },
          'expired-callback': function () { ts.token = ''; },
          'timeout-callback': function () { ts.token = ''; },
          'error-callback': function () { ts.token = ''; }
        });
        ts.state = 'ready';
      } catch (e) { fail(); }
    });
    document.head.appendChild(s);
  }
  function resetTurnstile() {
    ts.token = '';
    if (ts.state === 'ready' && window.turnstile) { try { window.turnstile.reset(ts.id); } catch (e) {} }
  }

  /* ---------------- tipos de campo ---------------- */
  // Só apresentação. Limite e validação vêm de rules.js + /content (mesma regra do servidor).
  var TYPES = {
    text:     { multiline: function (v) { return v.length > 60; } },
    meta:     { multiline: function () { return true; } },
    address:  { multiline: function () { return true; }, note: 'Uma linha por linha do endereço. O botão "Ver no mapa" acompanha.' },
    number:   {},
    phone:    { note: 'Do jeito que deve aparecer. O link para ligar é gerado sozinho.' },
    whatsapp: { note: 'Com DDD. Ex.: (51) 99377-5912. Vale para todos os botões de WhatsApp e para o formulário.' },
    email:    {},
    link:     { note: 'Endereço completo, começando com https://' },
    image:    {}
  };

  function readValue(node, type) {
    switch (type) {
      case 'meta': case 'whatsapp': return node.getAttribute('content') || '';
      case 'number': return node.getAttribute('data-count') || digits(node.textContent);
      case 'link': return node.getAttribute('href') || '';
      case 'image': return node.getAttribute('src') || '';
      case 'address':
        // linhas separadas por <br>, lidas como texto (sem innerHTML)
        var lines = [''];
        [].forEach.call(node.childNodes, function (n) {
          if (n.nodeName === 'BR') lines.push('');
          else lines[lines.length - 1] += n.textContent;
        });
        return lines.map(function (s) { return s.trim(); }).join('\n');
      default: return node.textContent.replace(/\s+/g, ' ').trim();
    }
  }

  var normWhats = R.normWhats, fmtWhats = R.fmtWhats;
  function telHref(v) { var d = digits(v); if (d.length === 10 || d.length === 11) d = '55' + d; return 'tel:+' + d; }
  function mapsHref(v) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.split('\n').join(', ')); }
  function fmtNumber(node, v) { var n = parseInt(v, 10) || 0; return node.hasAttribute('data-sep') ? n.toLocaleString('pt-BR') : String(n); }

  // Mesma regra do servidor (rules.js); o limite é o do esquema do commit (/content), senão o teto do tipo.
  function maxOf(f) { var r = rulesByKey[f.key]; return r && r.max > 0 ? r.max : R.TYPE_MAX[f.type]; }
  function norm(v) { return R.normalizeValue(v); }
  function validate(f, v) {
    if (f.type === 'image') return '';
    return R.validate(f.type, norm(v), maxOf(f));
  }

  /* ---------------- aplicar no DOM (prévia) ---------------- */
  function imgUrl(path) { return localUrls[path] || path; }
  function applyDom(doc, f, v) {
    if (!doc) return;
    $$('[data-cms="' + cssEsc(f.key) + '"]', doc).forEach(function (node) {
      switch (f.type) {
        case 'meta': node.setAttribute('content', v); break;
        case 'whatsapp': node.setAttribute('content', normWhats(v)); break;
        case 'number': node.setAttribute('data-count', v); node.textContent = fmtNumber(node, v); break;
        case 'link': node.setAttribute('href', v); break;
        case 'image': node.setAttribute('src', pendingImages[f.key] ? pendingImages[f.key].blobUrl : imgUrl(v)); break;
        case 'address':
          node.textContent = '';
          v.split('\n').forEach(function (line, i) { if (i) node.appendChild(doc.createElement('br')); node.appendChild(doc.createTextNode(line)); });
          break;
        default: node.textContent = v;
      }
      if (node.tagName === 'TITLE') doc.title = v;
    });
    $$('[data-cms-href="' + cssEsc(f.key) + '"]', doc).forEach(function (a) { a.setAttribute('href', derivedHref(f, v, a.getAttribute('href'))); });
  }
  function derivedHref(f, v, current) {
    switch (f.type) {
      case 'whatsapp': return String(current).replace(/phone=\d*/, 'phone=' + normWhats(v));
      case 'phone': return telHref(v);
      case 'email': return 'mailto:' + v.trim();
      case 'address': return mapsHref(v);
    }
    return current;
  }

  /* ---------------- montar o formulário ---------------- */
  function groupOf(node) {
    if (node.hasAttribute('data-cms-group')) return node.getAttribute('data-cms-group');
    var g = node.closest('[data-cms-group]');
    if (g) return g.getAttribute('data-cms-group');
    return node.closest('head') ? 'Google (busca)' : 'Outros';
  }

  // srcText: HTML do site (do /content). DOMParser cria um documento inerte: nada dele executa.
  // O documento do DOMParser herda a CSP do painel (style-src sem 'unsafe-inline'): por isso o site não tem
  // <style> nem style="" (CSS em assets/site.css; o validar-marcadores barra estilo inline no index.html).
  // opts.others: chaves que outra pessoa acabou de publicar (rebase): ganham um aviso no campo.
  function build(srcText, opts) {
    opts = opts || {};
    var doc = new DOMParser().parseFromString(srcText, 'text/html');
    fields = []; byKey = {};
    $$('[data-cms]', doc).forEach(function (node) {
      var key = node.getAttribute('data-cms');
      if (!key || byKey[key]) return;
      var type = node.getAttribute('data-cms-type') || 'text';
      if (!TYPES[type]) type = 'text';
      var f = { key: key, type: type, label: node.getAttribute('data-cms-label') || key, group: groupOf(node) };
      f.original = readValue(node, type);
      if (type === 'whatsapp') f.original = fmtWhats(f.original);
      f.value = f.original;
      fields.push(f); byKey[key] = f;
    });
    // fotos escolhidas e ainda não publicadas continuam valendo (ex.: depois de entrar de novo), só para
    // o mesmo usuário
    if (me && pendingOwner && pendingOwner !== me.username) dropPendingImages();
    Object.keys(pendingImages).forEach(function (k) {
      if (!byKey[k] || byKey[k].type !== 'image') { URL.revokeObjectURL(pendingImages[k].blobUrl); delete pendingImages[k]; }
    });
    // rascunho salvo DESTE usuário; campo que o site mudou desde o rascunho fica em conflito visível
    var draft = readDraft(), restored = 0, conflicts = 0;
    if (draft) Object.keys(draft.values).forEach(function (k) {
      var f = byKey[k], v = draft.values[k];
      if (!f || f.type === 'image' || typeof v !== 'string') return;
      if (R.canonicalValue(f.type, norm(v)) === R.canonicalValue(f.type, norm(f.original))) return; // já publicado
      f.value = v; restored++;
      var seen = draft.originals[k];
      if (typeof seen === 'string' && R.canonicalValue(f.type, norm(seen)) !== R.canonicalValue(f.type, norm(f.original))) {
        f.conflict = { seen: seen, theirs: f.original }; conflicts++;
      }
    });
    (opts.others || []).forEach(function (k) { if (byKey[k] && !byKey[k].conflict) byKey[k].others = true; });
    render();
    var pend = Object.keys(pendingImages).length;
    if (opts.quiet) return;
    if (restored + pend) {
      toast('Recuperei ' + (restored + pend) + ' alteração(ões) que não tinham sido publicadas.' +
        (conflicts ? ' ' + conflicts + ' em conflito: outra pessoa publicou o mesmo campo depois. Confira os campos marcados antes de publicar.' : ''),
        conflicts ? 'bad' : '');
    }
  }

  /* ---------------- rascunho por usuário ---------------- */
  function draftKey() { return !previewOnly && me && me.username ? DRAFT_PREFIX + me.username : null; }
  function readDraft() {
    var k = draftKey(), d = null;
    if (!k) return null;
    try { d = JSON.parse((store() && store().getItem(k)) || 'null'); } catch (e) { d = null; }
    if (!d || typeof d !== 'object' || d.user !== me.username || !d.values || typeof d.values !== 'object') return null;
    if (!d.originals || typeof d.originals !== 'object') d.originals = {};
    return d;
  }
  function dropDraft() { var k = draftKey(); try { if (k && store()) store().removeItem(k); } catch (e) {} }
  function dropPendingImages() {
    Object.keys(pendingImages).forEach(function (k) { if (!busy) URL.revokeObjectURL(pendingImages[k].blobUrl); });
    pendingImages = {}; pendingOwner = null;
  }

  function render() {
    var root = $('#fields'); root.textContent = '';
    var groups = {}, order = [];
    fields.forEach(function (f) { if (!groups[f.group]) { groups[f.group] = []; order.push(f.group); } groups[f.group].push(f); });
    // SEO e contato por último
    order.sort(function (a, b) { var w = function (g) { return g === 'Google (busca)' ? 2 : g === 'Contato e rodapé' ? 1 : 0; }; return w(a) - w(b); });
    order.forEach(function (g, gi) {
      var det = el('details', 'group'); if (gi === 0) det.open = true;
      var sum = el('summary', '', g);
      var cnt = el('span', 'count'); cnt.hidden = true; sum.appendChild(cnt);
      det.appendChild(sum);
      var box = el('div', 'fields'); det.appendChild(box);
      groups[g].forEach(function (f) { f.groupEl = det; f.countEl = cnt; box.appendChild(fieldEl(f)); });
      root.appendChild(det);
    });
    $('#search').value = '';
    refreshState();
  }

  function fieldEl(f) {
    var wrap = el('div', 'field'); wrap.id = 'f-' + f.key.replace(/\W/g, '-');
    wrap.setAttribute('data-key', f.key);
    var lbl = el('div', 'lbl');
    var dot = el('span', 'dot');
    var lt = el('label', '', f.label); lt.htmlFor = 'in-' + wrap.id;
    var undo = el('button', 'undo', 'desfazer'); undo.type = 'button';
    lbl.append(dot, lt, undo); wrap.appendChild(lbl);
    f.wrap = wrap;

    if (f.type === 'image') {
      var row = el('div', 'img-field');
      var img = el('img'); img.alt = '';
      img.src = pendingImages[f.key] ? pendingImages[f.key].blobUrl : localUrls[f.original] || '../' + f.original;
      var pick = el('label', 'btn btn-line', 'Trocar foto');
      var file = el('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp'; file.id = 'in-' + wrap.id;
      pick.appendChild(file); row.append(img, pick); wrap.appendChild(row);
      wrap.appendChild(el('div', 'note', 'JPG, PNG ou WebP. Fotos grandes são reduzidas sozinhas antes de enviar.'));
      var msg = el('div', 'msg'); wrap.appendChild(msg);
      f.thumb = img; f.msg = msg;
      file.addEventListener('change', function () { onImage(f, file.files[0]); file.value = ''; });
      file.addEventListener('focus', function () { focusInPreview(f); });
      undo.addEventListener('click', function () {
        if (pendingImages[f.key]) { if (!busy) URL.revokeObjectURL(pendingImages[f.key].blobUrl); delete pendingImages[f.key]; }
        f.value = f.original; img.src = localUrls[f.original] || '../' + f.original; f.msg.textContent = ''; wrap.classList.remove('invalid');
        applyDom(frameDoc, f, f.value); refreshState();
      });
      return wrap;
    }

    var multi = TYPES[f.type].multiline && TYPES[f.type].multiline(f.original);
    var input = el(multi ? 'textarea' : 'input');
    input.id = 'in-' + wrap.id;
    if (!multi) input.type = f.type === 'email' ? 'email' : f.type === 'link' ? 'url' : 'text';
    if (f.type === 'number') input.inputMode = 'numeric';
    if (f.type === 'phone' || f.type === 'whatsapp') input.inputMode = 'tel';
    if (multi) input.rows = Math.min(6, Math.max(2, Math.ceil(f.original.length / 48) + (f.original.split('\n').length - 1)));
    input.value = f.value; input.spellcheck = true;
    wrap.appendChild(input);
    if (TYPES[f.type].note) wrap.appendChild(el('div', 'note', TYPES[f.type].note));
    var m = el('div', 'msg'); wrap.appendChild(m);
    f.input = input; f.msg = m;
    if (isChanged(f)) { var e0 = validate(f, f.value); m.textContent = e0; wrap.classList.toggle('invalid', !!e0); }
    if (f.conflict) conflictBox(f);
    else if (f.others) othersNote(f);

    if (f.type !== 'address') {
      // Só o endereço tem várias linhas: Enter não faz nada e quebra de linha colada vira espaço.
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) e.preventDefault(); });
      input.addEventListener('paste', function (e) {
        var txt = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!/[\r\n\t]/.test(txt) || input.selectionStart == null) return; // e-mail: o navegador já limpa
        e.preventDefault();
        input.setRangeText(oneLine(txt), input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    input.addEventListener('input', function () {
      if (f.type !== 'address' && /[\r\n]/.test(input.value)) { // arrastar e soltar, autocompletar etc.
        var pos = input.selectionStart;
        input.value = oneLine(input.value);
        if (pos != null) { pos = Math.min(pos, input.value.length); input.setSelectionRange(pos, pos); }
      }
      f.value = f.type === 'address' ? input.value.replace(/\r/g, '') : input.value;
      var err = validate(f, f.value); f.msg.textContent = err; wrap.classList.toggle('invalid', !!err);
      if (!err) applyDom(frameDoc, f, norm(f.value));
      clearOthers(f);
      saveDraft(); refreshState();
    });
    input.addEventListener('focus', function () { focusInPreview(f); });
    undo.addEventListener('click', function () { undoField(f); });
    return wrap;
  }
  function undoField(f) {
    f.value = f.original; f.input.value = f.original; f.msg.textContent = ''; f.wrap.classList.remove('invalid');
    clearConflict(f); clearOthers(f);
    applyDom(frameDoc, f, f.value); saveDraft(); refreshState();
  }
  // Conflito ao repor o rascunho: o campo mostra o texto da pessoa e o que foi publicado depois; publicar
  // fica bloqueado até ela escolher.
  function conflictBox(f) {
    var box = el('div', 'conflict-box'); box.setAttribute('role', 'alert');
    box.appendChild(el('p', '', 'Conflito: depois do seu rascunho, outra pessoa publicou neste campo:'));
    box.appendChild(el('p', 'theirs', '«' + f.conflict.theirs + '»'));
    box.appendChild(el('p', '', 'O campo mostra o seu texto. Escolha qual fica antes de publicar.'));
    var acts = el('div', 'form-actions');
    var mine = el('button', 'btn btn-line', 'Manter o meu'); mine.type = 'button'; mine.setAttribute('data-keep', '');
    var theirs = el('button', 'btn btn-line', 'Usar o publicado'); theirs.type = 'button'; theirs.setAttribute('data-theirs', '');
    mine.addEventListener('click', function () { clearConflict(f); saveDraft(); refreshState(); });
    theirs.addEventListener('click', function () { undoField(f); });
    acts.append(mine, theirs); box.appendChild(acts);
    f.wrap.classList.add('conflict'); f.wrap.appendChild(box); f.conflictEl = box;
  }
  function clearConflict(f) {
    f.conflict = null;
    if (f.conflictEl) { f.conflictEl.remove(); f.conflictEl = null; }
    if (f.wrap) f.wrap.classList.remove('conflict');
  }
  // Depois de um rebase: este campo foi publicado por outra pessoa e o painel já mostra o valor novo.
  function othersNote(f) {
    var n = el('div', 'note others-note', 'Atualizado: outra pessoa publicou este campo enquanto você editava. O valor acima já é o novo.');
    f.wrap.classList.add('others'); f.wrap.appendChild(n); f.othersEl = n;
  }
  function clearOthers(f) {
    f.others = false;
    if (f.othersEl) { f.othersEl.remove(); f.othersEl = null; }
    if (f.wrap) f.wrap.classList.remove('others');
  }

  /* ---------------- fotos: reduzir e limpar antes de enviar ----------------
   * Redesenhar no canvas re-encoda a imagem: tira dados escondidos (EXIF, GPS) e reduz o peso. */
  function decodeImage(file) {
    var viaImg = function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), im = new Image();
        im.onload = function () { resolve({ src: im, w: im.naturalWidth, h: im.naturalHeight, done: function () { URL.revokeObjectURL(url); } }); };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        im.src = url;
      });
    };
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bm) {
        return { src: bm, w: bm.width, h: bm.height, done: function () { bm.close && bm.close(); } };
      }).catch(viaImg);
    }
    return viaImg();
  }
  function toBlob(canvas, type, q) { return new Promise(function (res) { canvas.toBlob(res, type, q); }); }
  function prepareImage(file) {
    return decodeImage(file).then(function (d) {
      if (!d.w || !d.h) { d.done(); throw new Error('decode'); }
      var scale = Math.min(1, MAX_IMG_WIDTH / d.w);
      var w = Math.max(1, Math.round(d.w * scale)), h = Math.max(1, Math.round(d.h * scale));
      var type = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
      var draw = function (opaque) {
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        if (opaque) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(d.src, 0, 0, w, h);
        return c;
      };
      var jpeg = draw(true), orig = type === 'image/jpeg' ? jpeg : draw(false);
      d.done();
      var tryJpeg = function (qs) {
        return toBlob(jpeg, 'image/jpeg', qs[0]).then(function (b) {
          if (b && b.size <= MAX_IMG_BYTES) return b;
          if (qs.length > 1) return tryJpeg(qs.slice(1));
          throw new Error('big');
        });
      };
      return toBlob(orig, type, 0.86).then(function (b) {
        if (b && b.type === type && b.size <= MAX_IMG_BYTES) return b;
        return tryJpeg([0.82, 0.72, 0.6]); // formato sem suporte no navegador ou pesado demais: vira JPG
      });
    });
  }

  function onImage(f, file) {
    if (!file) return;
    f.msg.textContent = ''; f.wrap.classList.remove('invalid');
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { f.msg.textContent = 'Use uma foto JPG, PNG ou WebP.'; return; }
    if (file.size > MAX_RAW_IMG_BYTES) { f.msg.textContent = 'Foto muito grande. Use uma foto de até 25 MB.'; return; }
    var others = function () { return Object.keys(pendingImages).filter(function (k) { return k !== f.key; }); };
    var tooMany = 'Dá para trocar até ' + MAX_IMAGES + ' fotos por publicação. Publique as que já escolheu e depois troque esta.';
    if (others().length >= MAX_IMAGES) { f.msg.textContent = tooMany; return; }
    f.msg.textContent = 'Preparando a foto…';
    prepareImage(file).then(function (blob) {
      // As fotos vão todas no mesmo pedido de publicação (base64): confere o total antes de aceitar.
      var o = others();
      if (o.length >= MAX_IMAGES) { f.msg.textContent = tooMany; return; }
      var total = b64Len(blob.size);
      o.forEach(function (k) { total += b64Len(pendingImages[k].blob.size); });
      if (total > MAX_BODY_BYTES - TEXT_RESERVE) {
        f.msg.textContent = 'Junto com as outras fotos escolhidas, passa do limite de envio. Publique as que já escolheu e depois troque esta.';
        return;
      }
      // durante a publicação o blob: anterior ainda vai virar a foto publicada: não revogar
      if (pendingImages[f.key] && !busy) URL.revokeObjectURL(pendingImages[f.key].blobUrl);
      var blobUrl = URL.createObjectURL(blob);
      pendingImages[f.key] = { blob: blob, blobUrl: blobUrl };
      pendingOwner = me ? me.username : null;
      f.thumb.src = blobUrl; f.msg.textContent = '';
      applyDom(frameDoc, f, f.value); focusInPreview(f); refreshState();
    }).catch(function (e) {
      f.msg.textContent = e && e.message === 'big'
        ? 'Mesmo reduzida, a foto passou de ' + (CFG.maxImageMB || 3) + ' MB. Tente outra foto.'
        : 'Não consegui abrir esta foto. Tente outra.';
    });
  }

  // base64 puro (sem o prefixo data:...;base64,), como o /publish espera em images[chave].data
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result), i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
      r.onerror = function () { reject(new Error('read')); };
      r.readAsDataURL(blob);
    });
  }

  // Mudou = forma canônica diferente (a mesma do servidor): espaço a mais num texto não é alteração.
  function isChanged(f) {
    if (f.type === 'image') return !!pendingImages[f.key];
    return R.canonicalValue(f.type, norm(f.value)) !== R.canonicalValue(f.type, norm(f.original));
  }
  function changed() { return fields.filter(isChanged); }
  function invalid() { return fields.filter(function (f) { return f.type !== 'image' && isChanged(f) && validate(f, f.value); }); }
  function inConflict() { return fields.filter(function (f) { return !!f.conflict; }); }

  function refreshState() {
    var ch = changed(), per = {};
    fields.forEach(function (f) { if (f.wrap) f.wrap.classList.toggle('changed', isChanged(f)); });
    ch.forEach(function (f) { per[f.group] = (per[f.group] || 0) + 1; });
    fields.forEach(function (f) { if (f.countEl) { var c = per[f.group] || 0; f.countEl.hidden = !c; f.countEl.textContent = c; } });
    var bad = invalid().length, conf = inConflict().length;
    var pb = $('#publishBtn');
    if (!busy) {
      pb.disabled = previewOnly || !ch.length || !!bad || !!conf;
      pb.textContent = previewOnly ? 'Entre para publicar' : ch.length ? 'Publicar ' + ch.length + (ch.length > 1 ? ' alterações' : ' alteração') : 'Publicar';
    }
    $('#discardBtn').disabled = busy || !ch.length;
    var st = $('#status');
    if (busy) return;
    if (conf) st.textContent = conf + ' campo(s) em conflito';
    else if (bad) st.textContent = bad + ' campo(s) com erro';
    else if (ch.length) st.textContent = 'Alterações não publicadas';
    else st.textContent = previewOnly ? 'Modo teste: nada é publicado' : 'Tudo publicado';
  }

  // {user, base, values, originals}: originals = o publicado que a pessoa via (detecta conflito ao repor).
  // Campo em conflito guarda o publicado que ela ainda não aceitou, para o conflito continuar depois de F5.
  function saveDraft() {
    var k = draftKey();
    if (!k) return;
    var d = { v: 2, user: me.username, base: siteCommit, savedAt: new Date().toISOString(), values: {}, originals: {} }, n = 0;
    fields.forEach(function (f) {
      if (f.type === 'image' || !isChanged(f)) return;
      d.values[f.key] = f.value; d.originals[f.key] = f.conflict ? f.conflict.seen : f.original; n++;
    });
    try { var s = store(); if (s) n ? s.setItem(k, JSON.stringify(d)) : s.removeItem(k); } catch (e) {}
  }

  /* ---------------- prévia ---------------- */
  var PREVIEW_CSS =
    '.cookie{display:none!important}' +
    '.js .rv,.js .rv-left{opacity:1!important;transform:none!important;filter:none!important}' +
    '.js .rv-img{clip-path:none!important}.js .rv-img>img{transform:none!important}' +
    '[data-cms]{cursor:pointer;transition:outline-color .3s}' +
    '[data-cms]:hover{outline:2px dashed rgba(217,20,58,.55);outline-offset:4px}' +
    '.cms-hl{outline:3px solid #d9143a!important;outline-offset:5px;border-radius:4px}';

  function loadPreview() {
    var fr = $('#frame');
    frameDoc = null;
    fr.onload = function () {
      var doc;
      try { doc = fr.contentDocument; } catch (e) { doc = null; }
      if (!doc || !doc.head) return;
      frameDoc = doc;
      var st = doc.createElement('style'); st.textContent = PREVIEW_CSS; doc.head.appendChild(st);
      $$('.rv,.rv-img,.rv-left,#ctaBox', doc).forEach(function (x) { x.classList.add('in'); });
      // O site publicado pode estar alguns minutos atrás do GitHub (cache do Pages).
      // 1) iguala a prévia ao que o servidor devolveu; 2) aplica as alterações do rascunho.
      fields.forEach(function (f) {
        if (isChanged(f)) { applyDom(doc, f, f.type === 'image' ? f.value : norm(f.value)); return; }
        var node = doc.querySelector('[data-cms="' + cssEsc(f.key) + '"]');
        if (!node) return;
        var cur = readValue(node, f.type);
        if (f.type === 'whatsapp') cur = fmtWhats(cur);
        if (cur !== f.original || (f.type === 'image' && localUrls[f.original])) applyDom(doc, f, f.original);
      });
      doc.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('[data-cms]');
        if (!t) { if (e.target.closest && e.target.closest('a')) e.preventDefault(); return; }
        e.preventDefault(); e.stopPropagation();
        openField(byKey[t.getAttribute('data-cms')]);
      }, true);
      doc.addEventListener('submit', function (e) { e.preventDefault(); }, true);
    };
    fr.src = '../' + (CFG.page || 'index.html') + '?preview=' + Date.now();
  }

  function focusInPreview(f) {
    if (!frameDoc) return;
    var node = frameDoc.querySelector('[data-cms="' + cssEsc(f.key) + '"]');
    if (!node || node.closest('head')) return;
    $$('.cms-hl', frameDoc).forEach(function (x) { x.classList.remove('cms-hl'); });
    node.classList.add('cms-hl');
    var r = node.getBoundingClientRect(), win = frameDoc.defaultView;
    if (r.top < 90 || r.bottom > win.innerHeight - 40) win.scrollTo({ top: win.scrollY + r.top - win.innerHeight / 3, behavior: 'smooth' });
  }

  function openField(f) {
    if (!f) return;
    showPane('edit');
    f.groupEl.open = true;
    f.wrap.hidden = false; f.groupEl.hidden = false;
    f.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    f.wrap.classList.remove('flash'); void f.wrap.offsetWidth; f.wrap.classList.add('flash');
    setTimeout(function () { if (f.input) f.input.focus({ preventScroll: true }); focusInPreview(f); }, 250);
  }

  var device = 'desktop';
  function layout() {
    var stage = $('#stage'), wrap = $('#frameWrap');
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    var vw = device === 'mobile' ? 390 : 1280, pad = device === 'mobile' ? 24 : 0;
    var bw = device === 'mobile' ? 16 : 0;
    var scale = Math.min(1, (W - pad * 2) / (vw + bw));
    var vh = device === 'mobile' ? Math.min(844, (H - pad * 2) / scale - bw) : H / scale;
    // propriedades via CSSOM (permitido pela CSP; não é atributo style inline)
    wrap.style.width = (vw + bw) + 'px'; wrap.style.height = (vh + bw) + 'px';
    wrap.style.transform = 'scale(' + scale + ')';
    wrap.style.left = Math.max(0, (W - (vw + bw) * scale) / 2) + 'px';
    wrap.style.top = (device === 'mobile' ? Math.max(pad, (H - (vh + bw) * scale) / 2) : 0) + 'px';
    stage.classList.toggle('mobile', device === 'mobile');
  }

  function showPane(p) {
    $$('.tabs-mobile button').forEach(function (b) { b.classList.toggle('on', b.dataset.pane === p); });
    $('#paneEdit').classList.toggle('on', p === 'edit');
    $('#panePreview').classList.toggle('on', p === 'preview');
    if (p === 'preview') setTimeout(layout, 0);
  }

  /* ---------------- erros do servidor ---------------- */
  function markServerErrors(errs) {
    var first = null, unknown = [];
    Object.keys(errs || {}).forEach(function (k) {
      var f = byKey[k];
      if (!f || !f.msg) { unknown.push(String(errs[k])); return; }
      f.msg.textContent = String(errs[k]);
      f.wrap.classList.add('invalid');
      f.groupEl.open = true;
      if (!first) first = f;
    });
    if (first) openField(first);
    return unknown;
  }
  function handleError(e, what) {
    if (e.handled) return; // 401: já voltou para a tela de entrar
    if (e.status === 422 && e.fields) {
      var unknown = markServerErrors(e.fields);
      toast(unknown.length ? unknown.join(' ') : e.message, 'bad');
      return;
    }
    if (e.code === 'integrity') {
      if (e.fields) markServerErrors(e.fields);
      showBlocked(MSG_INTEGRITY); toast(MSG_INTEGRITY, 'bad');
      return;
    }
    if (e.status === 409 && e.code === 'schema_mismatch') {
      // Recarregar não resolve: o arquivo do site precisa de conserto técnico.
      showBlocked(MSG_SCHEMA); toast(MSG_SCHEMA, 'bad');
      return;
    }
    if (e.status === 409) { // conflict: outra pessoa mudou o mesmo campo (ou o site andou)
      if (e.fields) markServerErrors(e.fields);
      toast(e.message, 'bad');
      if (window.confirm(e.message + '\n\nRecarregar agora?')) loadContent();
      return;
    }
    if (e.status === 413 || e.code === 'too_large') { toast(MSG_TOO_LARGE, 'bad'); return; }
    toast((what ? what + ': ' : '') + e.message, 'bad');
  }

  /* ---------------- carregar ---------------- */
  // opts: {others: chaves publicadas por outra pessoa (rebase), quiet: sem o aviso de rascunho recuperado}
  function loadContent(opts) {
    $('#status').textContent = 'Carregando…';
    var load = previewOnly
      ? fetch('../' + (CFG.page || 'index.html'), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status); return r.text();
        })
      : api('/content').then(function (j) {
          if (typeof j.html !== 'string' || !j.commit) throw apiError(500, 'server');
          siteCommit = String(j.commit);
          rulesByKey = {};
          (Array.isArray(j.fields) ? j.fields : []).forEach(function (r) {
            if (r && typeof r.key === 'string' && typeof r.max === 'number') rulesByKey[r.key] = { type: String(r.type), max: r.max };
          });
          return j.html;
        });
    return load.then(function (txt) { build(txt, opts); loadPreview(); layout(); })
      .catch(function (e) { if (!e.handled) toast('Erro ao carregar o site: ' + e.message, 'bad'); });
  }

  function startApp() {
    $('#login').hidden = true; $('#app').hidden = false;
    var admin = !!(me && me.role === 'admin');
    $('#usersBtn').hidden = previewOnly;
    $('#usersBtn').textContent = admin ? 'Usuários' : 'Minha senha';
    $('#historyBtn').hidden = previewOnly;
    $('#logoutBtn').title = previewOnly ? 'Voltar para a tela de entrar' : 'Sair';
    updateTokenWarning();
    loadContent();
  }
  function readMe(j) { me = j.user || null; tokenExpiresAt = typeof j.githubTokenExpiresAt === 'string' ? j.githubTokenExpiresAt : null; }

  /* ---------------- publicar ----------------
   * Um pedido só: textos em changes, fotos em images (base64). O servidor grava tudo num commit. */
  function publish() {
    var ch = changed();
    if (busy || previewOnly || !ch.length || invalid().length) return;
    if (!siteCommit) { toast('O conteúdo do site ainda não carregou. Recarregue o painel.', 'bad'); return; }
    var imgs = ch.filter(function (f) { return f.type === 'image'; });
    if (imgs.length > MAX_IMAGES) { toast('Dá para trocar até ' + MAX_IMAGES + ' fotos por publicação. Desfaça algumas e publique em partes.', 'bad'); return; }
    busy = true;
    var btn = $('#publishBtn'); btn.disabled = true; btn.textContent = 'Publicando…';
    $('#discardBtn').disabled = true;
    $('#status').textContent = imgs.length ? 'Preparando as fotos…' : 'Publicando…';
    ch.forEach(function (f) { if (f.msg) { f.msg.textContent = ''; f.wrap.classList.remove('invalid'); } });

    // snap: a foto enviada (a pessoa pode escolher outra durante o envio)
    // expected: o valor publicado que o painel mostrava; o servidor recusa (409) se o site já tiver outro
    var changes = {}, snap = {}, expected = {};
    ch.forEach(function (f) {
      if (f.type === 'image') snap[f.key] = pendingImages[f.key]; else changes[f.key] = norm(f.value);
      expected[f.key] = f.original;
    });

    Promise.all(imgs.map(function (f) {
      return blobToBase64(snap[f.key].blob).then(function (data) { return { key: f.key, type: snap[f.key].blob.type, data: data }; });
    })).then(function (list) {
      var body = { base: siteCommit, changes: changes, expected: expected }, size = new Blob([JSON.stringify(body)]).size;
      if (list.length) {
        body.images = {};
        list.forEach(function (im) {
          if (!IMG_TYPES[im.type] || !im.data) throw apiError(422, 'validation', 'Não consegui preparar uma das fotos. Escolha a foto de novo.');
          body.images[im.key] = { type: im.type, data: im.data };
          size += im.data.length + im.key.length + 64;
        });
      }
      if (size > MAX_BODY_BYTES) throw apiError(413, 'too_large');
      $('#status').textContent = 'Publicando…';
      return api('/publish', { method: 'POST', body: body });
    }).then(function (j) {
      if (j.commit) siteCommit = String(j.commit);
      var paths = j.paths && typeof j.paths === 'object' ? j.paths : {}, resync = false;
      ch.forEach(function (f) {
        if (f.type === 'image') {
          var p = snap[f.key], path = paths[f.key], cur = pendingImages[f.key];
          if (cur === p) delete pendingImages[f.key]; // outra foto escolhida durante o envio continua pendente
          if (typeof path === 'string' && IMG_PATH_RE.test(path)) {
            localUrls[path] = p.blobUrl; // o blob: segue mostrando a foto até o site público atualizar
            f.original = f.value = path;
            if (!pendingImages[f.key] && f.thumb) f.thumb.src = p.blobUrl;
            applyDom(frameDoc, f, f.value);
          } else {
            resync = true; // servidor não disse o caminho: relê o conteúdo para não mostrar foto errada
          }
        } else {
          var sent = changes[f.key];
          f.original = sent;
          if (norm(f.value) === sent) { f.value = sent; if (f.input && document.activeElement !== f.input) f.input.value = f.value; }
        }
      });
      busy = false;
      showBlocked('');
      saveDraft(); refreshState();
      var others = j.rebased && Array.isArray(j.othersChanged) ? j.othersChanged.filter(function (k) { return byKey[k] && !changes.hasOwnProperty(k) && !snap[k]; }) : [];
      if (j.rebased) {
        // Outra pessoa publicou antes (outros campos): o commit novo tem as mudanças dela. Recarrega para os
        // campos mostrarem o que está no site agora; o que ainda não foi publicado volta pelo rascunho.
        var names = others.map(function (k) { return byKey[k].label; });
        toast('Publicado! Outra pessoa também tinha publicado ' +
          (names.length ? 'mudanças em: ' + names.slice(0, 4).join(', ') + (names.length > 4 ? ' e mais ' + (names.length - 4) : '') : 'mudanças no site') +
          '. O painel foi atualizado com a versão nova.', 'ok');
        loadContent({ others: others, quiet: true });
        return;
      }
      toast('Publicado! O site público leva de 1 a 2 minutos para mostrar as mudanças.', 'ok');
      if (resync) loadContent({ quiet: true });
    }).catch(function (e) {
      busy = false;
      refreshState();
      handleError(e, 'Não foi possível publicar');
    });
  }

  function discard() {
    if (!window.confirm('Descartar todas as alterações que ainda não foram publicadas?')) return;
    Object.keys(pendingImages).forEach(function (k) { URL.revokeObjectURL(pendingImages[k].blobUrl); });
    pendingImages = {};
    fields.forEach(function (f) { f.value = f.original; f.conflict = null; f.others = false; });
    dropDraft();
    render(); loadPreview();
  }

  /* ---------------- versões (histórico) ---------------- */
  function openHistory() {
    $('#historyDlg').showModal();
    var ul = $('#versionsList'); ul.textContent = '';
    ul.appendChild(el('li', 'muted', 'Carregando…'));
    api('/history').then(function (j) {
      ul.textContent = '';
      var list = Array.isArray(j.versions) ? j.versions : [];
      if (!list.length) { ul.appendChild(el('li', 'muted', 'Nenhuma versão encontrada.')); return; }
      list.forEach(function (v, i) {
        var li = el('li');
        var info = el('div', 'v-info');
        var when = fmtDate(v.date);
        info.appendChild(el('strong', '', when || 'Data desconhecida'));
        if (v.author) info.appendChild(el('span', 'v-author', String(v.author)));
        info.appendChild(el('span', 'v-msg', String(v.message || '')));
        li.appendChild(info);
        if (i === 0) {
          li.appendChild(el('span', 'you', 'versão atual'));
        } else {
          var b = el('button', 'btn btn-line', 'Voltar para esta versão'); b.type = 'button';
          b.setAttribute('data-restore', String(v.commit));
          b.addEventListener('click', function () { restore(v, when); });
          li.appendChild(b);
        }
        ul.appendChild(li);
      });
    }).catch(function (e) {
      if (e.handled) return;
      ul.textContent = '';
      ul.appendChild(el('li', 'error', 'Não foi possível carregar as versões: ' + e.message));
    });
  }
  function restore(v, when) {
    var msg = 'Voltar o site para a versão de ' + (when || 'data desconhecida') + '?\n\n' +
      'O site inteiro volta a ficar como estava nesse momento. Isso vira uma versão nova, então dá para desfazer depois.';
    if (changed().length) msg += '\n\nSuas alterações ainda não publicadas continuam guardadas no painel.';
    if (!window.confirm(msg)) return;
    $$('#versionsList [data-restore]').forEach(function (b) { b.disabled = true; });
    api('/restore', { method: 'POST', body: { commit: String(v.commit), base: siteCommit } }).then(function (j) {
      if (j.commit) siteCommit = String(j.commit);
      showBlocked('');
      $('#historyDlg').close();
      toast('Pronto! O site voltou para a versão de ' + (when || 'antes') + '. O site público leva de 1 a 2 minutos para mostrar.', 'ok');
      loadContent();
    }).catch(function (e) {
      $$('#versionsList [data-restore]').forEach(function (b) { b.disabled = false; });
      if (e.status === 409) $('#historyDlg').close();
      handleError(e, 'Não foi possível voltar a versão');
    });
  }

  /* ---------------- usuários ---------------- */
  var ROLE_NAME = { admin: 'administrador', editor: 'editor' };
  function normUser(u) { return String(u || '').trim().toLowerCase(); }
  function openUsers() {
    var admin = !!(me && me.role === 'admin');
    $('#usersTitle').textContent = admin ? 'Usuários do painel' : 'Minha senha';
    $('#whoami').textContent = me ? 'Você entrou como ' + me.username + ' (' + (ROLE_NAME[me.role] || me.role) + ').' : '';
    $('#adminArea').hidden = !admin;
    $('#addUserError').textContent = ''; $('#myPassError').textContent = '';
    closeResetPass(); closeRemove();
    $('#usersDlg').showModal();
    if (admin) renderUsers();
  }
  function renderUsers() {
    var ul = $('#usersList'); ul.textContent = '';
    ul.appendChild(el('li', 'muted', 'Carregando…'));
    api('/users').then(function (j) {
      ul.textContent = '';
      var list = Array.isArray(j.users) ? j.users.slice() : [];
      list.sort(function (a, b) { return a.username < b.username ? -1 : 1; });
      if (!list.length) { ul.appendChild(el('li', 'muted', 'Nenhum usuário.')); return; }
      list.forEach(function (u) {
        var li = el('li');
        var info = el('div', 'u-info');
        var name = el('span', 'u-name', String(u.username));
        info.appendChild(name);
        var meta = (ROLE_NAME[u.role] || String(u.role || '')) + (u.last_login_at ? ' · último acesso ' + fmtDate(u.last_login_at) : ' · ainda não entrou');
        info.appendChild(el('span', 'u-meta', meta));
        li.appendChild(info);
        if (me && u.username === me.username) {
          li.appendChild(el('span', 'you', 'você'));
        } else {
          var acts = el('div', 'u-actions');
          var rs = el('button', 'btn btn-line', 'Nova senha'); rs.type = 'button';
          rs.setAttribute('data-reset', String(u.username));
          rs.addEventListener('click', function () { openResetPass(u.username); });
          var rm = el('button', 'btn btn-line', 'Remover'); rm.type = 'button';
          rm.setAttribute('data-remove', String(u.username));
          rm.addEventListener('click', function () { openRemove(u.username); });
          acts.append(rs, rm);
          li.appendChild(acts);
        }
        ul.appendChild(li);
      });
    }).catch(function (e) {
      if (e.handled) return;
      ul.textContent = '';
      ul.appendChild(el('li', 'error', 'Não foi possível carregar os usuários: ' + e.message));
    });
  }
  // Admin redefine a senha de outra pessoa (POST /users/password): as sessões dela caem no servidor.
  var resetTarget = null;
  function openResetPass(username) {
    closeRemove();
    resetTarget = username;
    var f = $('#resetPassForm');
    $('#resetPassTitle').textContent = 'Nova senha para ' + username;
    $('#resetPass').value = ''; $('#resetActorPass').value = ''; $('#resetPassError').textContent = '';
    f.hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#resetPass').focus();
  }
  function closeResetPass() { resetTarget = null; $('#resetPassForm').hidden = true; $('#resetPass').value = ''; $('#resetActorPass').value = ''; }
  // Remover pede a senha de quem está removendo (POST /users/delete com currentPassword).
  var removeTarget = null;
  function openRemove(username) {
    closeResetPass();
    removeTarget = username;
    $('#removeTitle').textContent = 'Remover ' + username;
    $('#removeActorPass').value = ''; $('#removeError').textContent = '';
    var f = $('#removeForm'); f.hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#removeActorPass').focus();
  }
  function closeRemove() { removeTarget = null; $('#removeForm').hidden = true; $('#removeActorPass').value = ''; }
  // Dica no cliente para poupar uma ida ao servidor; quem decide é o servidor (a mensagem dele prevalece).
  function passwordHint(p, username) {
    if (p.length < 10 || p.length > 200) return 'A senha precisa ter de 10 a 200 caracteres.';
    var u = normUser(username);
    if (u && p.toLowerCase().indexOf(u) >= 0) return 'A senha não pode conter o nome de usuário.';
    return '';
  }
  function formBusy(btn, on, label) { btn.disabled = on; btn.textContent = on ? 'Salvando…' : label; }

  /* ---------------- eventos ---------------- */
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('#loginBtn'), err = $('#loginError'); err.textContent = '';
    var u = normUser($('#user').value), p = $('#pass').value;
    if (!u || !p) { err.textContent = 'Preencha usuário e senha.'; return; }
    var body = { username: u, password: p };
    if (TS_KEY) {
      if (ts.state === 'failed') { err.textContent = 'Não foi possível carregar a verificação de segurança. Confira a internet e recarregue a página.'; return; }
      if (!ts.token) { err.textContent = 'Aguarde a verificação de segurança (o quadro acima do botão) e tente de novo.'; return; }
      body.turnstileToken = ts.token;
    }
    btn.disabled = true; btn.textContent = 'Entrando…';
    api('/login', { method: 'POST', body: body, auth: false }).then(function (j) {
      if (!j.token) throw apiError(500, 'server');
      resetTurnstile();
      saveToken(String(j.token)); me = j.user || { username: u, role: 'editor' }; tokenExpiresAt = null;
      if (pendingOwner && pendingOwner !== me.username) dropPendingImages(); // fotos de outro usuário
      previewOnly = false;
      $('#pass').value = '';
      btn.disabled = false; btn.textContent = 'Entrar';
      startApp();
      // a validade da chave de publicação só vem no /me (e só para admin)
      if (me.role === 'admin') api('/me').then(function (j2) { readMe(j2); updateTokenWarning(); }).catch(function () {});
    }).catch(function (e2) {
      resetTurnstile(); // token da Turnstile é de uso único: pede outro antes da próxima tentativa
      err.textContent = fieldsText(e2); btn.disabled = false; btn.textContent = 'Entrar'; $('#pass').value = ''; $('#pass').focus();
    });
  });
  $('#previewOnly').addEventListener('click', function () { previewOnly = true; me = null; startApp(); });
  $('#publishBtn').addEventListener('click', publish);
  $('#discardBtn').addEventListener('click', discard);
  $('#historyBtn').addEventListener('click', openHistory);
  $('#usersBtn').addEventListener('click', openUsers);
  $$('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  // Sair (botão) descarta o rascunho deste usuário e as fotos escolhidas: o próximo a usar este navegador
  // não herda nada. Sessão vencida (sessionExpired) é diferente: guarda o rascunho para a mesma pessoa.
  $('#logoutBtn').addEventListener('click', function () {
    if (previewOnly) { showLogin(''); return; }
    var n = changed().length;
    if (n && !window.confirm('Sair descarta ' + n + (n > 1 ? ' alterações não publicadas' : ' alteração não publicada') + '. Sair mesmo assim?')) return;
    dropDraft(); dropPendingImages();
    fields.forEach(function (f) { f.value = f.original; f.conflict = null; });
    var done = function () { saveToken(null); me = null; siteCommit = null; showLogin(''); };
    api('/logout', { method: 'POST', body: {}, auth: false }).then(done, done);
  });
  $('#addUserForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = normUser($('#newUser').value), p = $('#newPass').value, role = $('#newRole').value, mine = $('#addActorPass').value;
    var err = $('#addUserError'), btn = $('#addUserBtn'); err.textContent = '';
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) { err.textContent = 'Usuário com 3 a 32 letras minúsculas, números, ponto, hífen ou sublinhado, sem espaços.'; return; }
    var hint = passwordHint(p, u);
    if (hint) { err.textContent = hint; return; }
    if (!mine) { err.textContent = 'Digite a sua senha para confirmar.'; return; }
    if (role !== 'admin' && role !== 'editor') role = 'editor';
    formBusy(btn, true);
    api('/users/create', { method: 'POST', body: { username: u, password: p, role: role, currentPassword: mine } }).then(function () {
      $('#newUser').value = ''; $('#newPass').value = ''; $('#newRole').value = 'editor'; $('#addActorPass').value = '';
      formBusy(btn, false, 'Adicionar usuário');
      toast('Usuário ' + u + ' cadastrado. Já pode entrar.', 'ok');
      renderUsers();
    }).catch(function (e2) {
      formBusy(btn, false, 'Adicionar usuário');
      $('#addActorPass').value = '';
      if (!e2.handled) err.textContent = fieldsText(e2, 'O servidor não aceitou este usuário ou senha.');
    });
  });
  $('#resetPassForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = resetTarget, p = $('#resetPass').value, mine = $('#resetActorPass').value, err = $('#resetPassError'), btn = $('#resetPassBtn');
    err.textContent = '';
    if (!u) { closeResetPass(); return; }
    var hint = passwordHint(p, u);
    if (hint) { err.textContent = hint; return; }
    if (!mine) { err.textContent = 'Digite a sua senha para confirmar.'; return; }
    formBusy(btn, true);
    api('/users/password', { method: 'POST', body: { username: u, password: p, currentPassword: mine } }).then(function () {
      formBusy(btn, false, 'Salvar nova senha');
      closeResetPass();
      toast('Senha de ' + u + ' trocada. Ela precisa entrar de novo com a senha nova.', 'ok');
    }).catch(function (e2) {
      formBusy(btn, false, 'Salvar nova senha');
      $('#resetActorPass').value = '';
      if (!e2.handled) err.textContent = fieldsText(e2, 'O servidor não aceitou esta senha. Tente outra.');
    });
  });
  $('#resetPassCancel').addEventListener('click', closeResetPass);
  $('#removeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = removeTarget, mine = $('#removeActorPass').value, err = $('#removeError'), btn = $('#removeBtn');
    err.textContent = '';
    if (!u) { closeRemove(); return; }
    if (!mine) { err.textContent = 'Digite a sua senha para confirmar.'; return; }
    formBusy(btn, true);
    api('/users/delete', { method: 'POST', body: { username: u, currentPassword: mine } }).then(function () {
      formBusy(btn, false, 'Remover');
      closeRemove();
      toast('Usuário ' + u + ' removido.', 'ok'); renderUsers();
    }).catch(function (e2) {
      formBusy(btn, false, 'Remover');
      $('#removeActorPass').value = '';
      if (!e2.handled) err.textContent = fieldsText(e2, 'Não foi possível remover.');
    });
  });
  $('#removeCancel').addEventListener('click', closeRemove);
  $('#myPassForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var cur = $('#curPass').value, nw = $('#newMyPass').value, err = $('#myPassError'), btn = $('#myPassBtn');
    err.textContent = '';
    if (!cur) { err.textContent = 'Digite sua senha atual.'; return; }
    var hint = passwordHint(nw, me && me.username);
    if (hint) { err.textContent = hint; return; }
    if (nw === cur) { err.textContent = 'A nova senha precisa ser diferente da atual.'; return; }
    formBusy(btn, true);
    api('/password', { method: 'POST', body: { current: cur, 'new': nw } }).then(function () {
      $('#curPass').value = ''; $('#newMyPass').value = '';
      formBusy(btn, false, 'Salvar nova senha');
      toast('Senha trocada.', 'ok');
    }).catch(function (e2) {
      formBusy(btn, false, 'Salvar nova senha');
      if (!e2.handled) err.textContent = fieldsText(e2, 'A senha não foi aceita. Confira a senha atual e tente outra senha nova.');
    });
  });
  $('#search').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    fields.forEach(function (f) {
      var hit = !q || (f.label + ' ' + f.group + ' ' + f.value).toLowerCase().indexOf(q) >= 0;
      f.wrap.hidden = !hit;
    });
    $$('#fields .group').forEach(function (g) { var any = $$('.field:not([hidden])', g).length; g.hidden = !any; if (q && any) g.open = true; });
  });
  $$('.seg button[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      device = b.getAttribute('data-view');
      $$('.seg button[data-view]').forEach(function (x) { x.classList.toggle('on', x === b); });
      layout();
    });
  });
  $$('.tabs-mobile button').forEach(function (b) { b.addEventListener('click', function () { showPane(b.dataset.pane); }); });
  window.addEventListener('resize', layout);
  window.addEventListener('beforeunload', function (e) {
    if (!previewOnly && token && changed().length) { saveDraft(); e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------- início ---------------- */
  try { if (store()) store().removeItem(LEGACY_DRAFT_KEY); } catch (e) {} // rascunho antigo sem dono (C2)
  var saved = null;
  try { saved = sess() && sess().getItem(SESSION_KEY); } catch (e) { saved = null; }
  if (saved) {
    token = saved;
    api('/me').then(function (j) { readMe(j); startApp(); }).catch(function (e) {
      if (e.handled) return; // 401: sessionExpired() já mostrou a tela de entrar
      showLogin(e.message);
    });
  } else {
    showLogin('');
  }

  // exposto só para os testes automatizados (sem token nem dado sensível)
  window.__hgCms = { build: build, fields: function () { return fields; }, validate: validate, rules: function () { return rulesByKey; } };
})();

'use strict';
/* A single persisted request identity survives refresh, timeout and retry. */
(function (global) {
  const money = n => '$' + (n / 1000000).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:6});
  const terminal = new Set(['settled', 'failed', 'canceled', 'requote_required']);
  let generation = 0, timer, api, panel, storageKey, saved, sources = [], sourceCursors = [null], sourcePage = 0, nextSourceCursor = null, busy = false;
  function el(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function button(text, action) {
    const node = el('button', text, {type:'button', class:'btn btn-primary btn-sm'});
    node.disabled = busy;
    node.addEventListener('click', action);
    return node;
  }
  function persist(next) {
    // Storage must succeed before sending. No provider IDs or email are used as the namespace.
    localStorage.setItem(storageKey, JSON.stringify(next));
    saved = next;
  }
  async function request(path, options) {
    const response = await api(path, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.code || 'RETURN_UNAVAILABLE'), {code:data.code, status:response.status});
    return data;
  }
  function message(text) {
    let status = panel.querySelector('[role="status"]');
    if (!status) { status = el('p', '', {role:'status', 'aria-live':'polite'}); panel.append(status); }
    status.textContent = text;
  }
  function header() {
    panel.replaceChildren(el('h2', 'Return unused funds', {id:'funds-return-title', class:'dash-card-title'}));
    panel.append(el('p', 'Returns go to the original payment method. Review the exact cost and cash amount before confirming.'));
  }
  function figures(row) {
    const failed = row.state === 'failed' || row.state === 'canceled';
    const list = el('dl');
    for (const [label, key] of [['Amount requested','G'], ['Covered by earned margin','coverageMicros'], ['Your uncovered cost','C'], ['Balance used','D'], [row.state === 'settled' ? 'Cash returned to original payment method' : failed ? 'Quoted cash (not returned)' : 'Cash to return to original payment method','N'], ['Remainder kept in your balance','r']]) {
      list.append(el('dt', label), el('dd', money(row[key])));
    }
    panel.append(list);
    if (failed) panel.append(el('p', 'Customer charge for this failed attempt: ' + money(row.failureCustomerCostMicros || 0) + '. The original quote above was not completed.'));
  }
  function render() {
    header();
    if (saved?.operation) {
      const operation = saved.operation;
      figures(operation);
      const states = {
        settled:'Return confirmed. The cash amount shown has been returned by the payment provider.',
        failed:'The payment provider reports this return failed. Review the reconciled balance before another request.',
        canceled:'The payment provider reports this return was canceled.',
        requote_required:'This request was not sent. Get a new quote to review the current amounts.'
      };
      message(states[operation.state] || 'Return pending reconciliation. The result is not yet confirmed. Reserved funds remain unavailable.');
      panel.append(el('p', 'Reference: ' + operation.id));
      if (!terminal.has(operation.state)) { const help = el('a', 'Get help with this return', {href:'mailto:support@auxilo.io?subject=' + encodeURIComponent('Return ' + operation.id)}); panel.append(help); }
      if (terminal.has(operation.state)) panel.append(button('Back to eligible funds', async () => { persist(null); await refreshSources(); render(); }));
      else panel.append(button('Check status', checkStatus));
      return;
    }
    if (saved?.submitted) {
      figures(saved.quote);
      message('The result of this request is not yet known. Check this same request before starting another.');
      panel.append(button('Check same request', confirm));
      return;
    }
    if (saved?.quote) {
      figures(saved.quote);
      const expired = Date.now() >= saved.quote.expiresAt;
      message(expired ? 'This quote has expired. Review a new quote before confirming.' : 'Costs verified for this quote. Expires ' + new Date(saved.quote.expiresAt).toLocaleTimeString() + '. A changed cost requires a new quote.');
      const submit = button('Confirm return of ' + money(saved.quote.N), confirm);
      submit.disabled = busy || expired;
      panel.append(submit, button('Choose another amount', () => { persist(null); render(); }));
      return;
    }
    if (sourcePage > 0 || nextSourceCursor) {
      const pages = el('div');
      pages.append(el('p', 'Funding page ' + (sourcePage + 1)));
      if (sourcePage > 0) pages.append(button('Previous funding', () => loadSourcePage(sourcePage - 1)));
      if (nextSourceCursor) pages.append(button('More funding', () => { sourceCursors[sourcePage + 1] = nextSourceCursor; return loadSourcePage(sourcePage + 1); }));
      panel.append(pages);
    }
    if (!sources.length) { message(sourcePage ? 'There is no funding on this page. Use Previous funding to return.' : 'No eligible new funding is available for a return. Historical balances remain restricted.'); return; }
    const form = el('form');
    const select = el('select', undefined, {id:'return-source', required:''});
    let count = 0;
    for (const source of sources) {
      const available = source.availableMicros || 0;
      const held = source.heldMicros || 0;
      panel.append(el('p', money(available) + ' available; ' + money(held) + ' reserved for a pending return.' + (!source.available ? ' Returns are currently unavailable for this funding.' : '')));
      if (source.available && available > 0) { count++; select.append(el('option', 'Funding ' + count + ' — ' + money(available) + ' available', {value:source.id})); }
    }
    if (!count) { message('A return is unavailable until its funding, cost and reconciliation requirements are satisfied.'); return; }
    const amount = el('input', undefined, {id:'return-amount', type:'text', inputmode:'decimal', required:'', autocomplete:'off', placeholder:'10.00'});
    const submit = el('button', 'Review return quote', {type:'submit', class:'btn btn-primary btn-sm'});
    submit.disabled = busy;
    form.append(el('label', 'Funding source', {for:'return-source'}), select, el('label', 'Maximum balance to use (USD)', {for:'return-amount'}), amount, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const input = amount.value.trim();
      if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(input)) { message('Enter a positive dollar amount with up to six decimal places.'); return; }
      const [dollars, fraction = ''] = input.split('.');
      const micros = Number(dollars) * 1000000 + Number(fraction.padEnd(6, '0'));
      const source = sources.find(row => row.id === select.value);
      if (!Number.isSafeInteger(micros) || micros <= 0 || micros > source.availableMicros) { message('Enter an amount within the available balance.'); return; }
      busy = true; submit.disabled = true;
      const active = generation;
      try {
        const quote = await request('/account/funds-return/quote', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sourceId:source.id, maxGrossMicros:micros})});
        if (active !== generation) return;
        persist({quote, requestKey:crypto.randomUUID(), submitted:false});
        busy = false; render();
      } catch (error) { if (active === generation) message('A verified quote is unavailable. Your balance has not been reserved by this quote request.'); }
      finally { if (active === generation) { busy = false; submit.disabled = false; } }
    });
    panel.append(form);
  }
  async function refreshSources(page = 0) {
    const active = generation, cursor = sourceCursors[page];
    const data = await request('/account/funds-return/sources' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
    if (active === generation) { sources = data.sources; sourcePage = page; nextSourceCursor = data.nextCursor || null; }
    return data;
  }
  async function loadSourcePage(page) {
    if (busy) return;
    const active = generation;
    busy = true; render();
    try { await refreshSources(page); if (active === generation) { busy = false; render(); } }
    catch { if (active === generation) { busy = false; render(); message('Funding is temporarily unavailable. Try this page again.'); } }
    finally { if (active === generation) busy = false; }
  }
  async function confirm() {
    if (busy || !saved?.quote) return;
    busy = true;
    const active = generation;
    try {
      persist({...saved, submitted:true});
      render();
      const operation = await request('/account/funds-return/confirm', {method:'POST', headers:{'Content-Type':'application/json', 'Idempotency-Key':saved.requestKey}, body:JSON.stringify({quoteId:saved.quote.id, quoteHash:saved.quote.hash})});
      if (active !== generation) return;
      persist({...saved, operation});
      busy = false; render(); schedule();
    } catch (error) {
      if (active !== generation) return;
      busy = false; render();
      // Only a definitive pre-send requote response permits replacing the request identity.
      if (error.code === 'REQUOTE_REQUIRED') { persist(null); render(); message('The quote changed or expired. Review a new quote before confirming.'); }
      else message('The request result is not confirmed. Use Check same request to retrieve its result; do not start a second return.');
    } finally { if (active === generation) busy = false; }
  }
  function schedule() {
    clearTimeout(timer);
    if (saved?.operation && !terminal.has(saved.operation.state)) timer = setTimeout(checkStatus, 5000);
  }
  async function checkStatus() {
    if (busy || !saved?.operation) return;
    busy = true;
    const active = generation;
    try {
      const operation = await request('/account/funds-return/' + encodeURIComponent(saved.operation.id));
      if (active !== generation) return;
      persist({...saved, operation}); busy = false; render();
    } catch { if (active === generation) message('Status is temporarily unavailable. The existing request remains saved.'); }
    finally { if (active === generation) { busy = false; schedule(); } }
  }
  function stop() { generation++; clearTimeout(timer); busy = false; saved = null; sources = []; sourceCursors = [null]; sourcePage = 0; nextSourceCursor = null; if (panel) panel.hidden = true; }
  async function init(options) {
    stop(); api = options.api; panel = document.getElementById('funds-return-panel');
    const active = generation;
    try {
      const health = await (await fetch('/health')).json();
      if (!health.financial_epoch || active !== generation) return;
      const data = await refreshSources();
      if (active !== generation) return;
      storageKey = 'auxilo_return_v1:' + data.accountId;
      saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      panel.hidden = false; render();
      if (saved?.operation) await checkStatus();
    } catch { if (active === generation) { panel.hidden = false; header(); message('Return controls are unavailable. Existing requests have not been changed.'); } }
  }
  global.AuxiloFundsReturn = {init, stop};
}(window));

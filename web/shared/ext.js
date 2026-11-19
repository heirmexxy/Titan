/*
 * Titan feature pages shared by the admin (/admin) and the client console (/console):
 * firmware updates, PAYG, quality & lots (GradeGuard), data export, carbon verification and registries,
 * system health (admin), subscription and card (console), and the password reset pages.
 * The host page calls window.TitanExt(host) with its own helpers; host.api already prefixes /admin/api or /console/api.
 */
window.TitanExt = function (H) {
  const { app, views, NAV, layout, h, raw, esc, api, bindForm, onClick, toast, options, pill, when, ago, formData, route, bindRowLinks } = H;
  const admin = H.surface === 'admin';
  const owner = () => admin || (H.isOwner && H.isOwner());
  const base = admin ? '/admin/api' : '/console/api';
  const csrf = admin ? { 'X-Titan-Admin': '1' } : { 'X-Titan-Console': '1' };
  const money = (cur, v) => `${esc(cur || 'NGN')} ${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const bytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${Math.round(b / 1e3)} KB`);
  const DEVICE_TYPES = ['wareguard-v1', 'gradeguard-v1', 'titan-controller-v1', 'paygo-appliance-v1', 'titan-kiln-v1', 'titan-cookstove-v1', 'titan-solar-v1', 'titan-lora-gateway-v1'];
  const orgsCache = { list: null };
  const orgs = async () => (admin ? (orgsCache.list ??= (await api('GET', '/orgs')).orgs.filter((o) => o.kind !== 'verifier')) : []);
  const sites = async () => { const r = await api('GET', '/sites'); return admin ? r.sites : r.sites; };
  const orgField = async (label = 'Organisation') => (admin ? `<label>${label}<select name="orgId" required>${(await orgs()).map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>` : '');
  const tabs = (active, list) => `<div class="row" role="tablist" style="margin-bottom:1rem">${list.map(([k, label, href]) => `<a class="btn${k === active ? ' primary' : ''}" role="tab" aria-selected="${k === active}" href="${href}" style="text-decoration:none${k === active ? ';background:var(--ink);color:var(--paper)' : ''}">${esc(label)}</a>`).join('')}</div>`;
  // Works both inside h`` templates (via __html) and inside plain template strings (as a string).
  const statePill = (s) => {
    const cls = { installed: 'st-online', done: 'st-online', active: 'st-online', paid_off: 'st-online', pass: 'st-online', positive: 'st-online', issued: 'st-online', closed: 'st-resolved', failed: 'st-offline', fail: 'st-offline', negative: 'st-offline', cancelled: 'st-disabled', rejected: 'st-offline', suspended: 'st-offline', open: 'st-open' }[s] || 'pending';
    const html = `<span class="pill ${cls}">${esc(String(s ?? '').replace(/_/g, ' '))}</span>`;
    const o = new String(html); o.__html = html; return o;
  };

  // Navigation entries (before Settings / Organisations).
  const at = NAV.findIndex(([k]) => ['orgs', 'billing', 'settings'].includes(k));
  const add = [['firmware', 'Firmware'], ['payg', 'PAYG'], ['quality', 'Quality & lots'], ['verification', 'Verification'], ['exports', 'Export data'], ...(admin ? [['health', 'System health']] : [])];
  NAV.splice(at < 0 ? NAV.length : at, 0, ...add);

  // ======================= Firmware =======================
  views.firmware = async () => {
    const { releases, rollouts, publicKey } = await api('GET', '/firmware');
    const siteList = await sites();
    layout('firmware', h`<h1>Firmware updates</h1>
      <p class="muted">Upload a firmware file, then roll it out. Devices get it in batches, only while online, check its fingerprint and signature before installing, and report the new version when they restart.</p>
      ${raw(rollouts.length ? `<div class="panel"><h2>Rollouts</h2><div class="scroll"><table><thead><tr><th>Release</th><th>Progress</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>${rollouts.map((r) => {
        const total = r.queued + r.in_progress + r.installed + r.failed || 1;
        return `<tr class="click" data-href="#rollout-${esc(r.id)}"><td><code>${esc(r.type_id)}</code> ${esc(r.version)}${admin && r.org_name ? `<div class="small muted">${esc(r.org_name)}</div>` : ''}</td>
          <td style="min-width:180px"><div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line)" aria-label="${r.installed} installed of ${total}"><span style="width:${(r.installed / total) * 100}%;background:var(--leaf)"></span><span style="width:${(r.in_progress / total) * 100}%;background:var(--grain)"></span><span style="width:${(r.failed / total) * 100}%;background:var(--alert)"></span></div>
          <div class="small muted">${r.installed} installed · ${r.in_progress} in progress · ${r.queued} waiting · ${r.failed} failed</div></td>
          <td>${statePill(r.status)}</td><td class="small">${esc(ago(r.created_at))}</td>
          <td class="r">${owner() && r.status === 'active' ? `<button class="small" data-ro="${esc(r.id)}" data-act="pause">Pause</button>` : ''}${owner() && r.status === 'paused' ? `<button class="small" data-ro="${esc(r.id)}" data-act="resume">Resume</button>` : ''}${owner() && ['active', 'paused'].includes(r.status) ? ` <button class="small danger" data-ro="${esc(r.id)}" data-act="cancel">Cancel</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></div>` : '')}
      <div class="panel"><h2>Releases</h2>${raw(releases.length ? `<div class="scroll"><table><thead><tr><th>Device type</th><th>Version</th><th>Size</th><th>Fingerprint</th><th class="r">Devices on it</th><th>Uploaded</th><th></th></tr></thead><tbody>${releases.map((r) => `
        <tr><td><code>${esc(r.type_id)}</code>${r.org_id ? (admin ? `<div class="small muted">${esc(r.org_name)}</div>` : '') : '<div class="small muted">Kitovu</div>'}</td><td><b>${esc(r.version)}</b>${r.notes ? `<div class="small muted">${esc(r.notes)}</div>` : ''}${r.retired_at ? ' <span class="pill st-disabled">retired</span>' : ''}</td>
        <td class="small">${esc(bytes(Number(r.size)))}</td><td><code class="small" title="${esc(r.sha256)}">${esc(r.sha256.slice(0, 12))}…</code></td><td class="r num">${esc(r.devices_on_version)}</td><td class="small">${esc(ago(r.created_at))}</td>
        <td class="r">${owner() && !r.retired_at && (admin || r.org_id) ? `<button class="small primary" data-rollout="${esc(r.id)}" data-type="${esc(r.type_id)}" data-version="${esc(r.version)}">Roll out</button> <button class="small" data-retire="${esc(r.id)}">Retire</button>` : owner() && !r.retired_at ? `<button class="small primary" data-rollout="${esc(r.id)}" data-type="${esc(r.type_id)}" data-version="${esc(r.version)}">Roll out</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No firmware uploaded yet.</p>')}
        <div id="ro-form"></div></div>
      ${raw(owner() ? `<div class="panel"><h2>Upload a release</h2>
        <form class="f" id="fw-form"><label>Device type<select name="type">${DEVICE_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></label>
          <label>Version<input name="version" placeholder="2.1.0" required pattern="[0-9A-Za-z][0-9A-Za-z._+-]{0,31}"></label>
          <label style="grid-column:span 2">What changed<input name="notes" maxlength="1000" placeholder="Faster GSM reconnect"></label>
          <label>Firmware file (.bin, up to 8 MB)<input name="file" type="file" accept=".bin,application/octet-stream" required></label>
          <div><button class="primary" type="submit">Upload and sign</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div>` : '')}
      <div class="panel"><h2>Signing key</h2><p class="small muted">Build this public key into your firmware. Devices must reject any update whose signature does not verify with it.</p><div class="secret"><code>${publicKey}</code></div>
        <p class="small">Ed25519 over the 32-byte SHA-256 of the binary. Also at <code>/api/firmware/public-key</code>. See <a href="/docs/device-protocol.html#15-firmware-updates-over-the-air" target="_blank">Device Protocol §15</a>.</p></div>`);
    bindRowLinks();
    bindForm('#fw-form', async (d, form) => {
      const file = form.querySelector('input[type=file]').files[0];
      if (!file) throw new Error('Choose a file');
      if (file.size > 8 * 1024 * 1024) throw new Error('Firmware must be 8 MB or smaller');
      const qs = new URLSearchParams({ type: d.type, version: d.version, notes: d.notes || '' });
      const res = await fetch(`${base}/firmware?${qs}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', ...csrf }, body: await file.arrayBuffer() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || json.error || `Upload failed (${res.status})`);
      toast(`Uploaded ${json.release.version}. Fingerprint ${json.release.sha256.slice(0, 12)}…`); route();
    });
    onClick('[data-retire]', async (d) => { if (!confirm('Retire this release? It can no longer be rolled out.')) return; await api('POST', `/firmware/${d.retire}/retire`); route(); });
    onClick('[data-ro]', async (d) => { await api('POST', `/firmware/rollouts/${d.ro}/${d.act}`); toast(`Rollout ${d.act === 'cancel' ? 'cancelled' : d.act === 'pause' ? 'paused' : 'resumed'}`); route(); });
    onClick('[data-rollout]', async (d) => {
      const box = app.querySelector('#ro-form');
      box.innerHTML = h`<h2 style="margin-top:1.2rem">Roll out ${d.type} ${d.version}</h2>
        <form class="f" id="ro"><input type="hidden" name="id" value="${d.rollout}">${raw(admin ? `<label>Organisation's devices<select name="orgId"><option value="">Every organisation</option>${(await orgs()).map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>` : '')}
        <label>Site<select name="siteId"><option value="">All sites</option>${options(siteList, '', 'id', (s) => (admin ? `${s.org_name} · ${s.name}` : s.name))}</select></label>
        <label style="grid-column:span 2">Only these devices (optional)<input name="deviceIds" placeholder="WG-000001, WG-000002"></label>
        <label>Batch size<input name="batchSize" type="number" min="1" max="1000" value="10"></label>
        <div><button class="primary" type="submit">Start rollout</button></div><p class="form-msg small" style="grid-column:1/-1">Start with a small batch. Devices already on this version are skipped.</p></form>`;
      bindForm('#ro', async (f) => {
        const out = await api('POST', `/firmware/${f.id}/rollouts`, { orgId: f.orgId || undefined, siteId: f.siteId || undefined, deviceIds: f.deviceIds || undefined, batchSize: Number(f.batchSize) });
        toast(`Rollout started for ${out.devices} devices`); location.hash = `#rollout-${out.rollout.id}`;
      });
      box.scrollIntoView({ behavior: 'smooth' });
    });
  };
  views.rollout = async (id) => {
    const { rollout, devices } = await api('GET', `/firmware/rollouts/${id}`);
    layout('firmware', h`<p class="small"><a href="#firmware">Firmware</a></p><h1>Rollout</h1>
      <p>${statePill(rollout.status)} batch of ${rollout.batch_size} · started ${when(rollout.created_at)}</p>
      <div class="panel"><div class="scroll"><table><thead><tr><th>Device</th><th>State</th><th>Running</th><th>Tries</th><th>Detail</th><th>Updated</th></tr></thead><tbody>${raw(devices.map((dv) => `
        <tr><td><a href="#device-${esc(dv.device_id)}"><code>${esc(dv.device_id)}</code></a><div class="small muted">${esc(dv.device_status)}</div></td><td>${statePill(dv.state)}</td><td><code>${esc(dv.current_version ?? '–')}</code></td><td class="num">${esc(dv.attempts)}</td><td class="small">${esc(dv.detail ?? '')}</td><td class="small">${esc(ago(dv.updated_at))}</td></tr>`).join(''))}</tbody></table></div></div>`);
  };

  // ======================= PAYG =======================
  views.payg = async (_, params) => {
    const [{ plans }, { accounts }] = await Promise.all([api('GET', '/payg/plans'), api('GET', `/payg/accounts${params.get('due') ? '?due=1' : ''}`)]);
    const now = Date.now();
    const due = accounts.filter((a) => a.status === 'active' && new Date(a.credit_until).getTime() < now).length;
    layout('payg', h`<h1>Pay-as-you-go</h1>
      <p class="muted">Each payment buys time on an appliance. Titan unlocks it until the paid-up date, and locks it when credit runs out, even if the appliance is offline.</p>
      <div class="tiles"><div class="tile"><div class="v">${accounts.filter((a) => a.status === 'active').length}</div><div class="l">Active accounts</div></div>
        <div class="tile ${due ? 'bad' : ''}"><div class="v">${due}</div><div class="l">Out of credit</div></div>
        <div class="tile"><div class="v">${accounts.filter((a) => a.status === 'paid_off').length}</div><div class="l">Paid off</div></div>
        <div class="tile"><div class="v">${plans.length}</div><div class="l">Plans</div></div></div>
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Accounts</h2><a href="#payg${params.get('due') ? '' : '?due=1'}" class="small">${params.get('due') ? 'Show all' : 'Show only out of credit'}</a></div>
      ${raw(accounts.length ? `<div class="scroll"><table><thead><tr><th>Code</th><th>Customer</th><th>Appliance</th><th>Status</th><th>Paid until</th><th class="r">Paid</th><th>Lock</th></tr></thead><tbody>${accounts.map((a) => {
        const late = a.status === 'active' && new Date(a.credit_until).getTime() < now;
        return `<tr class="click" data-href="#paygacct-${esc(a.id)}"><td><code>${esc(a.code)}</code></td><td>${esc(a.customer_name)}<div class="small muted">${esc(a.customer_ref ?? '')}${admin ? ` · ${esc(a.org_name)}` : ''}</div></td>
          <td><code>${esc(a.device_id)}</code></td><td>${statePill(a.status)}</td><td class="small ${late ? 'err' : ''}">${a.status === 'paid_off' ? 'for good' : esc(when(a.credit_until))}</td>
          <td class="r num">${money(a.currency, a.total_paid)}${a.total_price ? `<div class="small muted">of ${money(a.currency, a.total_price)}</div>` : ''}</td><td>${esc(a.lock_state)}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="empty">No accounts yet.</p>')}</div>
      ${raw(owner() ? `<div class="grid2">
        <div class="panel"><h2>Put an appliance on a plan</h2>${plans.length ? `<form class="f" id="acct-form">${await orgField()}
          <label>Appliance ID<input name="deviceId" required placeholder="KB-000123"></label>
          <label>Plan<select name="planId">${plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${admin ? ` · ${esc(p.org_name)}` : ''}</option>`).join('')}</select></label>
          <label>Customer name<input name="customerName" required></label><label>Phone (for reminders)<input name="customerPhone" type="tel" placeholder="+234…"></label>
          <label>Your customer ID<input name="customerRef"></label><div><button class="primary" type="submit">Create account</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form>` : '<p class="empty">Create a plan first.</p>'}</div>
        <div class="panel"><h2>New plan</h2><form class="f" id="plan-form">${await orgField()}
          <label>Name<input name="name" required placeholder="Solar fridge 12 months"></label><label>Price per day<input name="pricePerDay" type="number" step="any" min="0.01" required></label>
          <label>Currency<input name="currency" value="NGN" maxlength="3"></label><label>Total price (lease-to-own)<input name="totalPrice" type="number" step="any" min="0" placeholder="Leave empty for pay-per-use"></label>
          <label>Grace hours<input name="graceHours" type="number" min="0" max="720" value="0"></label><label>Minimum payment<input name="minPayment" type="number" step="any" min="0" value="0"></label>
          <div><button type="submit">Save plan</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div></div>` : '')}
      <div class="panel"><h2>Plans</h2>${raw(plans.length ? `<table><tbody>${plans.map((p) => `<tr><td>${esc(p.name)}${admin ? `<div class="small muted">${esc(p.org_name)}</div>` : ''}</td><td class="num">${money(p.currency, p.price_per_day)} / day</td><td class="small">${p.total_price ? `Owned after ${money(p.currency, p.total_price)}` : 'Pay per use'}${Number(p.grace_hours) ? ` · ${p.grace_hours}h grace` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No plans yet.</p>')}
        <p class="small muted">Collection systems post payments to <code>POST /v1/payg/accounts/{id}/payments</code> with an API key (scope manage:payg). Customers can also pay by card, transfer or USSD on the account's pay page.</p></div>`);
    bindRowLinks();
    bindForm('#plan-form', async (d) => { await api('POST', '/payg/plans', { ...d, totalPrice: d.totalPrice || undefined }); toast('Plan saved'); route(); });
    bindForm('#acct-form', async (d) => { const out = await api('POST', '/payg/accounts', d); toast(`Account ${out.account.code} created. The appliance stays locked until the first payment.`); location.hash = `#paygacct-${out.account.id}`; });
  };
  views.paygacct = async (id) => {
    const { account: a, payments, payUrl } = await api('GET', `/payg/accounts/${id}`);
    const live = new Date(a.credit_until).getTime() > Date.now();
    layout('payg', h`<p class="small"><a href="#payg">PAYG</a></p><h1>${a.customer_name} <code style="font-size:1rem">${a.code}</code></h1>
      <div class="tiles"><div class="tile ${!live && a.status === 'active' ? 'bad' : ''}"><div class="v" style="font-size:1.3rem">${a.status === 'paid_off' ? 'Owned' : when(a.credit_until)}</div><div class="l">${a.status === 'paid_off' ? 'Paid in full' : live ? 'Paid until' : 'Credit ended'}</div></div>
        <div class="tile"><div class="v" style="font-size:1.3rem">${raw(money(a.currency, a.total_paid))}</div><div class="l">${a.total_price ? `Paid of ${money(a.currency, a.total_price)}` : 'Paid so far'}</div></div>
        <div class="tile"><div class="v" style="font-size:1.3rem">${a.lock_state}</div><div class="l">Appliance ${a.device_id} · ${a.device_status}</div></div></div>
      <div class="grid2"><div class="panel"><h2>Account</h2><dl class="kv"><dt>Status</dt><dd>${statePill(a.status)}</dd><dt>Plan</dt><dd>${a.plan_name} · ${raw(money(a.currency, a.price_per_day))}/day</dd><dt>Phone</dt><dd>${a.customer_phone ?? '–'}</dd><dt>Your ID</dt><dd>${a.customer_ref ?? '–'}</dd><dt>Pay page</dt><dd><a href="${payUrl}" target="_blank">${payUrl}</a></dd></dl>
        ${raw(owner() ? `<div class="row" style="margin-top:1rem">${a.status === 'active' ? '<button class="small" data-st="suspend">Suspend (lock)</button>' : ''}${a.status === 'suspended' ? '<button class="small" data-st="activate">Reactivate</button>' : ''}${['active', 'suspended'].includes(a.status) ? '<button class="small danger" data-st="cancel">Cancel account</button>' : ''}</div>` : '')}</div>
        <div class="panel"><h2>Record a payment</h2><form class="f" id="pay-form"><label>Amount (${a.currency})<input name="amount" type="number" step="any" min="0.01" required></label><label>Reference<input name="reference" required placeholder="Receipt or transfer ID"></label><div><button class="primary" type="submit">Record</button></div><p class="form-msg small" style="grid-column:1/-1">Each reference is recorded once.</p></form></div></div>
      <div class="panel"><h2>Payments</h2>${raw(payments.length ? `<table><thead><tr><th>When</th><th class="r">Amount</th><th>Source</th><th>Reference</th><th>Credit until</th></tr></thead><tbody>${payments.map((p) => `<tr><td class="small">${esc(when(p.received_at))}</td><td class="r num">${money(p.currency, p.amount)}</td><td>${esc(p.source)}</td><td><code class="small">${esc(p.reference)}</code></td><td class="small">${esc(when(p.credit_until))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No payments yet.</p>')}</div>`);
    bindForm('#pay-form', async (d) => { const out = await api('POST', `/payg/accounts/${id}/payments`, d); toast(out.duplicate ? 'That reference was already recorded' : 'Payment recorded; unlocking'); route(); });
    onClick('[data-st]', async (d) => { if (d.st === 'cancel' && !confirm('Cancel this account? The appliance will be locked.')) return; await api('POST', `/payg/accounts/${id}/${d.st}`); route(); });
  };

  // ======================= Quality & lots (GradeGuard) =======================
  const PARAMS = [['moisture', 'Moisture', '%', null, 14], ['foreign_matter', 'Foreign matter', '%', null, 2], ['broken', 'Broken grains', '%', null, 5], ['discoloured', 'Discoloured grains', '%', null, 2], ['aflatoxin', 'Aflatoxin', 'ppb', null, 10], ['hectolitre_mass', 'Hectolitre mass', 'kg/hl', 72, null], ['temperature', 'Sample temperature', '°C', null, null]];
  views.quality = async (_, params) => {
    const tab = params.get('tab') || 'tests';
    const T = tabs(tab, [['tests', 'Tests', '#quality?tab=tests'], ['lots', 'Lots', '#quality?tab=lots'], ['specs', 'Buyer specs', '#quality?tab=specs']]);
    const { specs } = await api('GET', '/quality/specs');
    if (tab === 'specs') {
      layout('quality', h`<h1>Quality & lots</h1>${raw(T)}
        <div class="panel"><h2>Buyer specifications</h2>${raw(specs.length ? `<table><thead><tr><th>Spec</th><th>Commodity</th><th>Limits</th><th></th></tr></thead><tbody>${specs.map((s) => `<tr><td>${esc(s.name)}<div class="small muted">${esc(s.buyer ?? '')}${admin ? ` · ${esc(s.org_name)}` : ''}</div></td><td>${esc(s.commodity)}</td>
          <td class="small">${s.parameters.map((p) => `${esc(p.label)} ${p.min != null ? `≥ ${esc(p.min)}` : ''}${p.min != null && p.max != null ? ', ' : ''}${p.max != null ? `≤ ${esc(p.max)}` : ''} ${esc(p.unit)}`).join('<br>')}</td>
          <td class="r">${owner() ? `<button class="small" data-off="${esc(s.id)}">Archive</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No specs yet. Add your buyers\' grades so every test is scored pass or fail.</p>')}</div>
        ${raw(owner() ? `<div class="panel"><h2>New spec</h2><form id="spec-form" class="f">${await orgField()}<label>Name<input name="name" required placeholder="Olam paddy grade 1"></label><label>Buyer<input name="buyer"></label><label>Commodity<input name="commodity" required placeholder="rice"></label>
          <div style="grid-column:1/-1"><table><thead><tr><th>Use</th><th>Parameter</th><th>Min</th><th>Max</th></tr></thead><tbody>${PARAMS.map(([k, l, u, mn, mx]) => `<tr><td><input type="checkbox" name="use_${k}" ${mx != null || mn != null ? 'checked' : ''} style="width:auto"></td><td>${l} <span class="muted small">${u}</span></td><td><input name="min_${k}" type="number" step="any" value="${mn ?? ''}"></td><td><input name="max_${k}" type="number" step="any" value="${mx ?? ''}"></td></tr>`).join('')}</tbody></table></div>
          <div><button class="primary" type="submit">Save spec</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div>` : '')}`);
      bindForm('#spec-form', async (d) => {
        const parameters = PARAMS.filter(([k]) => d[`use_${k}`]).map(([k, l, u]) => ({ key: k, label: l, unit: u, min: d[`min_${k}`] === '' ? null : Number(d[`min_${k}`]), max: d[`max_${k}`] === '' ? null : Number(d[`max_${k}`]) }));
        await api('POST', '/quality/specs', { orgId: d.orgId, name: d.name, buyer: d.buyer, commodity: d.commodity, parameters }); toast('Spec saved'); route();
      });
      onClick('[data-off]', async (d) => { await api('POST', `/quality/specs/${d.off}/deactivate`); route(); });
      return;
    }
    if (tab === 'lots') {
      const { lots } = await api('GET', `/lots${params.get('q') ? `?q=${encodeURIComponent(params.get('q'))}` : ''}`);
      layout('quality', h`<h1>Quality & lots</h1>${raw(T)}
        <div class="panel"><form class="row" id="lot-search"><input name="q" placeholder="Search lot code or origin" value="${params.get('q') ?? ''}" style="max-width:320px"><button type="submit">Search</button></form>
        ${raw(lots.length ? `<div class="scroll" style="margin-top:.8rem"><table><thead><tr><th>Lot</th><th>Commodity</th><th class="r">Quantity</th><th>Origin</th><th>Where</th><th>Status</th><th>Last test</th></tr></thead><tbody>${lots.map((l) => `<tr class="click" data-href="#lot-${encodeURIComponent(l.code)}"><td><code>${esc(l.code)}</code>${admin ? `<div class="small muted">${esc(l.org_name)}</div>` : ''}</td><td>${esc(l.commodity)}</td><td class="r num">${l.quantity != null ? `${Number(l.quantity).toLocaleString()} ${esc(l.unit)}` : '–'}</td><td>${esc(l.origin ?? '')}</td><td>${esc(l.site_name ?? '')}</td><td>${statePill(l.status)}</td><td>${l.last_outcome ? statePill(l.last_outcome).__html : '<span class="muted small">untested</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No lots yet.</p>')}</div>
        <div class="panel"><h2>New lot</h2><form class="f" id="lot-form">${await orgField()}<label>Code (blank = generate)<input name="code" placeholder="RICE-0001"></label><label>Commodity<input name="commodity" required></label><label>Quantity (kg)<input name="quantity" type="number" step="any" min="0"></label>
          <label>Origin (farmer, cluster)<input name="origin"></label><label>Harvested<input name="harvestedOn" type="date"></label><div><button class="primary" type="submit">Create lot</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div>`);
      bindRowLinks();
      bindForm('#lot-search', async (d) => { location.hash = `#quality?tab=lots${d.q ? '&q=' + encodeURIComponent(d.q) : ''}`; });
      bindForm('#lot-form', async (d) => { const { lot } = await api('POST', '/lots', { ...d, quantity: d.quantity || undefined, harvestedOn: d.harvestedOn || undefined }); location.hash = `#lot-${encodeURIComponent(lot.code)}`; });
      return;
    }
    const { tests } = await api('GET', `/quality/tests?limit=200${params.get('outcome') ? `&outcome=${params.get('outcome')}` : ''}`);
    const pass = tests.filter((t) => t.outcome === 'pass').length, fail = tests.filter((t) => t.outcome === 'fail').length;
    layout('quality', h`<h1>Quality & lots</h1>${raw(T)}
      <div class="tiles"><div class="tile"><div class="v">${tests.length}</div><div class="l">Recent tests</div></div><div class="tile"><div class="v">${pass}</div><div class="l">Passed</div></div><div class="tile ${fail ? 'bad' : ''}"><div class="v">${fail}</div><div class="l">Failed</div></div></div>
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Tests</h2><span class="small"><a href="#quality?tab=tests">All</a> · <a href="#quality?tab=tests&outcome=fail">Failed only</a></span></div>
      ${raw(tests.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Lot</th><th>Spec</th><th>Results</th><th>Outcome</th><th>By</th></tr></thead><tbody>${tests.map((t) => `<tr><td class="small">${esc(when(t.tested_at))}</td><td>${t.lot_code ? `<a href="#lot-${encodeURIComponent(t.lot_code)}"><code>${esc(t.lot_code)}</code></a>` : '–'}</td><td class="small">${esc(t.spec_name ?? '–')}</td>
        <td class="small">${Object.entries(t.results).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} <b>${esc(v)}</b>`).join(' · ')}</td><td>${statePill(t.outcome).__html}${t.failures.length ? `<div class="small err">${t.failures.map((f) => `${esc(f.key.replace(/_/g, ' '))} ${esc(f.reason)}`).join(', ')}</div>` : ''}</td><td class="small">${esc(t.device_id ? `GradeGuard ${t.device_id}` : t.tested_by.replace(/^(user|apikey):.*/, 'person'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No tests yet. GradeGuard devices and the field app record them here.</p>')}</div>
      <div class="panel"><h2>Record a test</h2><form class="f" id="test-form">${await orgField()}<label>Spec<select name="specId" id="spec-pick"><option value="">No spec</option>${options(specs, '', 'id', (s) => `${s.name} (${s.commodity})`)}</select></label>
        <label>Lot code<input name="lot" placeholder="optional"></label><label>Commodity<input name="commodity" placeholder="if no spec or lot"></label><label>Sample<input name="sampleRef" placeholder="bag 14"></label>
        <div id="param-fields" style="display:contents"></div><div><button class="primary" type="submit">Save test</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div>`);
    const renderFields = () => {
      const s = specs.find((x) => x.id === app.querySelector('#spec-pick').value);
      const list = s ? s.parameters : PARAMS.slice(0, 3).map(([key, label, unit]) => ({ key, label, unit }));
      app.querySelector('#param-fields').innerHTML = list.map((p) => `<label>${esc(p.label)} (${esc(p.unit)})<input name="r_${esc(p.key)}" type="number" step="any" inputmode="decimal"></label>`).join('');
    };
    app.querySelector('#spec-pick').addEventListener('change', renderFields); renderFields();
    bindForm('#test-form', async (d) => {
      const results = Object.fromEntries(Object.entries(d).filter(([k, v]) => k.startsWith('r_') && v !== '').map(([k, v]) => [k.slice(2), Number(v)]));
      const { test } = await api('POST', '/quality/tests', { orgId: d.orgId, specId: d.specId || undefined, lot: d.lot || undefined, commodity: d.commodity || undefined, sampleRef: d.sampleRef || undefined, results });
      toast(test.outcome === 'pass' ? 'Passed' : test.outcome === 'fail' ? `Failed: ${test.failures.map((f) => f.key + ' ' + f.reason).join(', ')}` : 'Saved'); route();
    });
  };
  views.lot = async (code) => {
    const { lot, parents, events, tests, storage } = await api('GET', `/lots/${encodeURIComponent(code)}`);
    const siteList = await sites().catch(() => []);
    layout('quality', h`<p class="small"><a href="#quality?tab=lots">Lots</a></p><h1>Lot <code>${lot.code}</code></h1>
      <div class="tiles"><div class="tile"><div class="v" style="font-size:1.4rem">${lot.commodity}</div><div class="l">${lot.quantity != null ? `${Number(lot.quantity).toLocaleString()} ${lot.unit}` : 'Quantity not set'}</div></div>
        <div class="tile"><div class="v" style="font-size:1.4rem">${raw(statePill(lot.status).__html)}</div><div class="l">${lot.site_name ?? 'Location not set'}${lot.stack_code ? ` · ${lot.stack_code}` : ''}</div></div>
        <div class="tile"><div class="v" style="font-size:1.4rem">${tests.length}</div><div class="l">Tests · last ${tests[0] ? tests[0].outcome : 'none'}</div></div></div>
      <div class="grid2"><div class="panel"><h2>Origin</h2><dl class="kv"><dt>From</dt><dd>${lot.origin ?? '–'}</dd><dt>Harvested</dt><dd>${lot.harvested_on ? String(lot.harvested_on).slice(0, 10) : '–'}</dd><dt>Location</dt><dd>${lot.origin_lat != null ? raw(`<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${esc(lot.origin_lat)}&mlon=${esc(lot.origin_lng)}#map=14/${esc(lot.origin_lat)}/${esc(lot.origin_lng)}">${esc(Number(lot.origin_lat).toFixed(4))}, ${esc(Number(lot.origin_lng).toFixed(4))}</a>`) : '–'}</dd></dl>
        ${raw(parents.length ? `<h2 style="margin-top:1rem">Made from</h2><ul>${parents.map((p) => `<li><a href="#lot-${encodeURIComponent(p.code)}"><code>${esc(p.code)}</code></a> ${esc(p.origin ?? '')} ${p.quantity != null ? `· ${Number(p.quantity).toLocaleString()} ${esc(p.unit)}` : ''}</li>`).join('')}</ul>` : '')}</div>
        <div class="panel"><h2>Storage conditions</h2>${raw(storage.length ? storage.map((s) => `<p><b>${esc(s.siteName)}</b> <span class="small muted">${esc(when(s.from))} → ${esc(when(s.to))}</span></p>${s.conditions.length ? `<table><tbody>${s.conditions.map((c) => `<tr><td>${esc(c.metric)}</td><td class="num">min ${esc(c.min)} · avg ${esc(c.avg)} · max ${esc(c.max)}</td><td class="small muted">${esc(c.readings)} readings</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No sensor readings for this period.</p>'}`).join('') : '<p class="empty">Not stored in a monitored warehouse yet.</p>')}</div></div>
      <div class="panel"><h2>Chain of custody</h2><ol style="padding-left:1.2rem">${raw(events.map((e) => `<li style="margin-bottom:.5rem"><b>${esc(e.kind)}</b> <span class="small muted">${esc(when(e.at))}</span>${e.lot_id !== lot.id ? ' <span class="small muted">(source lot)</span>' : ''}<div class="small">${[e.site_name, e.stack_code, e.counterparty, e.quantity != null ? `${Number(e.quantity).toLocaleString()} kg` : '', e.note].filter(Boolean).map(esc).join(' · ')}</div></li>`).join(''))}</ol>
        <form class="f" id="ev-form" style="margin-top:1rem"><label>Event<select name="kind">${['received', 'stored', 'moved', 'aggregated', 'merged', 'dispatched', 'delivered', 'note'].map((k) => `<option>${k}</option>`).join('')}</select></label>
          <label>Site<select name="siteId"><option value="">–</option>${options(siteList, '', 'id', (s) => (admin ? `${s.org_name} · ${s.name}` : s.name))}</select></label><label>Stack (zone/stack)<input name="stack" placeholder="B1/S1"></label>
          <label>Counterparty<input name="counterparty" placeholder="buyer, transporter"></label><label>Quantity (kg)<input name="quantity" type="number" step="any" min="0"></label><label>Merge lots (codes)<input name="mergeFrom" placeholder="for 'merged'"></label>
          <label style="grid-column:span 2">Note<input name="note"></label><div><button class="primary" type="submit">Add event</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form></div>
      <div class="panel"><h2>Tests</h2>${raw(tests.length ? `<table><tbody>${tests.map((t) => `<tr><td class="small">${esc(when(t.tested_at))}</td><td>${statePill(t.outcome).__html}</td><td class="small">${Object.entries(t.results).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${esc(v)}`).join(' · ')}</td><td class="small">${esc(t.spec_name ?? '')}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No tests yet.</p>')}</div>`);
    bindForm('#ev-form', async (d) => { await api('POST', `/lots/${encodeURIComponent(code)}/events`, { ...d, siteId: d.siteId || undefined, quantity: d.quantity || undefined }); toast('Added'); route(); });
  };

  // ======================= Export =======================
  const DATASETS = [
    ['readings', 'Sensor readings', 'Every reading, or averages per minute, hour or day.', true], ['alerts', 'Alerts', 'Opened and resolved alerts with severity.', true], ['devices', 'Devices', 'Every device, status and firmware version.', false],
    ['quality-tests', 'Quality tests', 'GradeGuard and manual tests with pass/fail.', true], ['lots', 'Lots', 'Traceable lots with origin and last result.', false], ['custody', 'Chain of custody', 'Every custody event.', true],
    ['payg-payments', 'PAYG payments', 'Payments with the credit they bought.', true], ['payg-accounts', 'PAYG accounts', 'Accounts, credit dates and lock state.', false], ['carbon-activities', 'Carbon activities', 'Batches and periods with net tCO₂e.', true],
  ];
  views.exports = async () => {
    const siteList = await sites().catch(() => []);
    const today = new Date().toISOString().slice(0, 10), month = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    layout('exports', h`<h1>Export data</h1><p class="muted">Download as CSV or Excel. The same exports are available to your systems at <code>GET /v1/export/{dataset}</code> with an API key holding <code>export:data</code>.</p>
      <div class="panel"><form class="f" id="ex-form"><label>Data<select name="dataset">${raw(DATASETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join(''))}</select></label>
        <label>Format<select name="format"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label>
        <label>From<input name="from" type="date" value="${month}"></label><label>To<input name="to" type="date" value="${today}"></label>
        <label>Site<select name="site"><option value="">All sites</option>${options(siteList, '', 'id', (s) => (admin ? `${s.org_name} · ${s.name}` : s.name))}</select></label>
        <label>Readings detail<select name="interval"><option value="1h">Hourly averages</option><option value="1d">Daily averages</option><option value="1m">Per minute</option><option value="raw">Every reading</option></select></label>
        ${raw(admin ? `<label>Organisation<select name="org"><option value="">All</option>${(await orgs()).map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>` : '')}
        <div><button class="primary" type="submit">Download</button></div><p class="form-msg small" style="grid-column:1/-1" id="ex-hint"></p></form></div>
      <div class="panel"><table><tbody>${raw(DATASETS.map(([k, l, d, timed]) => `<tr><td><b>${l}</b><div class="small muted">${d}</div></td><td class="small">${timed ? 'Filtered by date' : 'Current list'}</td></tr>`).join(''))}</tbody></table><p class="small muted">Up to 200,000 rows in Excel and 500,000 in CSV per download, and 366 days at a time.</p></div>`);
    bindForm('#ex-form', async (d) => {
      const qs = new URLSearchParams({ format: d.format, from: new Date(d.from).toISOString(), to: new Date(new Date(d.to).getTime() + 86400e3).toISOString(), interval: d.interval });
      if (d.site) qs.set('site', d.site);
      if (d.org) qs.set('org', d.org);
      const res = await fetch(`${base}/export/${d.dataset}?${qs}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || j.error || `Export failed (${res.status})`); }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `titan-${d.dataset}.${d.format}`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast(`${Number(res.headers.get('x-titan-rows') || 0).toLocaleString()} rows downloaded${res.headers.get('x-titan-truncated') ? ' (limit reached: narrow the dates)' : ''}`);
    });
  };

  // ======================= Carbon verification & registries =======================
  views.verification = async () => {
    const { projects } = await api('GET', '/carbon');
    const mine = admin ? projects : projects.filter((p) => p.owned);
    layout('verification', h`<h1>Verification & registries</h1>
      <p class="muted">Give an independent verifier read access to a project's evidence, answer their findings, and prepare the package for Verra, Gold Standard, Puro.earth or Isometric.</p>
      <div class="panel">${raw(mine.length ? `<table><thead><tr><th>Project</th><th>Registry</th><th class="r">Calculated</th><th class="r">Net tCO₂e</th></tr></thead><tbody>${mine.map((p) => `<tr class="click" data-href="#verif-${esc(p.id)}"><td>${esc(p.name)}<div class="small muted">${p.methodology === 'biochar-v1' ? 'Biochar' : 'Cookstoves'}${admin ? ` · ${esc(p.org_name)}` : ''}</div></td><td>${esc(p.registry ?? '–')}</td><td class="r num">${p.summary.calculated}/${p.summary.activities}</td><td class="r num">${Number(p.summary.netTco2e).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No carbon projects yet.</p>')}</div>`);
    bindRowLinks();
  };
  views.verif = async (id) => {
    const v = await api('GET', `/carbon/projects/${id}/verification`);
    const { project: p, verifiers, findings, statements, submissions, registries } = v;
    const reg = (k) => registries[k]?.name ?? k;
    layout('verification', h`<p class="small"><a href="#verification">Verification</a></p><h1>${p.name}</h1>
      <div class="grid2">
        <div class="panel"><h2>Registry</h2><form class="f" id="reg-form"><label>Registry<select name="registry">${raw(Object.entries(registries).map(([k, r]) => `<option value="${esc(r.name)}" ${p.registry === r.name ? 'selected' : ''}>${esc(r.name)}</option>`).join(''))}</select></label>
          <label>Methodology code<input name="registryMethodology" value="${p.registry_methodology ?? ''}" placeholder="as registered"></label><label>Registry project ID<input name="registryProjectId" value="${p.registry_project_id ?? ''}"></label>
          ${raw(owner() ? '<div><button type="submit">Save</button></div>' : '')}<p class="form-msg small" style="grid-column:1/-1"></p></form></div>
        <div class="panel"><h2>Verifiers</h2>${raw(verifiers.length ? `<table><tbody>${verifiers.map((x) => `<tr><td>${esc(x.name)}<div class="small muted">${esc(x.emails ?? '')}</div></td><td>${x.revoked_at ? '<span class="pill st-disabled">removed</span>' : '<span class="pill st-online">has access</span>'}</td><td class="r">${owner() && !x.revoked_at ? `<button class="small danger" data-revoke-v="${esc(x.verifier_org_id)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No verifier yet.</p>')}
          ${raw(owner() ? `<form class="f" id="inv-form" style="margin-top:.8rem"><label>Verifier's email<input name="email" type="email" required></label><label>Verification body<input name="organisation" required placeholder="e.g. their VVB"></label><div><button class="primary" type="submit">Give access</button></div><p class="form-msg small" style="grid-column:1/-1">They get an email to set a password, then see this project's evidence only.</p></form>` : '')}</div></div>
      <div class="panel"><h2>Findings</h2>${raw(findings.length ? findings.map((f) => `<div style="border-bottom:1px solid var(--line);padding:.6rem 0"><div>${statePill(f.status).__html} <b>${esc(f.kind.replace(/_/g, ' '))}</b> <span class="small muted">${esc(f.verifier)} · ${esc(when(f.created_at))}${f.activity_reference ? ` · batch ${esc(f.activity_reference)}` : ''}</span></div><p style="margin:.3rem 0">${esc(f.text)}</p>${f.response ? `<p class="small"><b>Response:</b> ${esc(f.response)}</p>` : ''}
        ${f.status !== 'closed' ? `<form class="row" data-respond="${esc(f.id)}"><input name="response" placeholder="Your response or the fix" required style="max-width:520px"><button class="small" type="submit">Respond</button></form>` : ''}</div>`).join('') : '<p class="empty">No findings.</p>')}</div>
      <div class="panel"><h2>Verification statements</h2>${raw(statements.length ? `<table><thead><tr><th>Verifier</th><th>Opinion</th><th class="r">Verified tCO₂e</th><th>Signed</th><th>Evidence fingerprint</th></tr></thead><tbody>${statements.map((s) => `<tr><td>${esc(s.verifier)}</td><td>${statePill(s.opinion).__html}</td><td class="r num">${esc(s.verified_tco2e)}</td><td class="small">${esc(when(s.signed_at))}</td><td><code class="small" title="${esc(s.package_sha256)}">${esc(s.package_sha256.slice(0, 12))}…</code></td></tr>`).join('')}</tbody></table>` : '<p class="empty">Not verified yet.</p>')}</div>
      <div class="panel"><h2>Registry submissions</h2>${raw(submissions.length ? `<div class="scroll"><table><thead><tr><th>Registry</th><th class="r">Claimed</th><th>Status</th><th>Reference / serials</th><th></th></tr></thead><tbody>${submissions.map((s) => `<tr><td>${esc(reg(s.registry))}<div class="small muted">${esc(when(s.created_at))}</div></td><td class="r num">${esc(s.claimed_tco2e)}${s.issued_tco2e ? `<div class="small ok">${esc(s.issued_tco2e)} issued</div>` : ''}</td><td>${statePill(s.status).__html}</td><td class="small">${esc(s.registry_ref ?? '')}${s.serial_from ? `<div>${esc(s.serial_from)} → ${esc(s.serial_to ?? '')}</div>` : ''}</td>
        <td class="r"><a class="btn small" href="${base}/carbon/submissions/${esc(s.id)}/package" download>Download package</a>${owner() && !['issued', 'rejected'].includes(s.status) ? ` <button class="small" data-sub="${esc(s.id)}">Update status</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing prepared yet.</p>')}
        <div id="sub-status"></div>
        ${raw(owner() ? `<form class="f" id="sub-form" style="margin-top:1rem"><label>Registry<select name="registry">${Object.entries(registries).map(([k, r]) => `<option value="${k}">${esc(r.name)}</option>`).join('')}</select></label>
          <label>Based on statement<select name="statementId"><option value="">Unverified (all calculated)</option>${statements.filter((s) => s.opinion !== 'negative').map((s) => `<option value="${esc(s.id)}">${esc(s.verifier)} · ${esc(s.verified_tco2e)} tCO₂e · ${esc(when(s.signed_at))}</option>`).join('')}</select></label>
          <div><button class="primary" type="submit">Prepare package</button></div><p class="form-msg small" style="grid-column:1/-1">Titan prepares and fingerprints the evidence; you upload it through the registry's own portal, then record its reference and serial numbers here.</p></form>` : '')}</div>`);
    bindForm('#reg-form', async (d) => { await api('POST', `/carbon/projects/${id}/registry`, d); toast('Saved'); });
    bindForm('#inv-form', async (d) => { const out = await api('POST', `/carbon/projects/${id}/verifiers`, d); toast(out.invited ? 'Access given; invitation sent' : 'Access given'); route(); });
    onClick('[data-revoke-v]', async (d) => { await api('DELETE', `/carbon/projects/${id}/verifiers/${d.revokeV}`); route(); });
    app.querySelectorAll('form[data-respond]').forEach((f) => f.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', `/carbon/findings/${f.dataset.respond}/respond`, formData(f)); toast('Response sent'); route(); } catch (err) { toast(err.message); } }));
    bindForm('#sub-form', async (d) => { await api('POST', `/carbon/projects/${id}/submissions`, { registry: d.registry, statementId: d.statementId || undefined }); toast('Package prepared'); route(); });
    onClick('[data-sub]', async (d) => {
      const box = app.querySelector('#sub-status');
      box.innerHTML = `<form class="f" id="st-form" style="margin-top:1rem"><label>Status<select name="status"><option value="submitted">Submitted</option><option value="under_review">Under review</option><option value="issued">Issued</option><option value="rejected">Rejected</option></select></label>
        <label>Registry reference<input name="registryRef"></label><label>Issued tCO₂e<input name="issuedTco2e" type="number" step="any" min="0"></label><label>Serial from<input name="serialFrom"></label><label>Serial to<input name="serialTo"></label>
        <label style="grid-column:span 2">Notes<input name="notes"></label><div><button class="primary" type="submit">Save</button></div><p class="form-msg small" style="grid-column:1/-1"></p></form>`;
      bindForm('#st-form', async (f) => { await api('POST', `/carbon/submissions/${d.sub}/status`, { ...f, issuedTco2e: f.issuedTco2e || undefined }); toast('Updated'); route(); });
    });
  };

  // ======================= System health (admin) =======================
  if (admin) {
    views.health = async () => {
      const hh = await api('GET', '/health');
      layout('health', h`<h1>System health</h1>
        <div class="tiles"><div class="tile ${hh.ok ? '' : 'bad'}"><div class="v">${hh.ok ? 'Healthy' : 'Needs attention'}</div><div class="l">Checked ${when(hh.at)}</div></div>
          <div class="tile"><div class="v">${hh.checks.filter((c) => !c.ok).length}</div><div class="l">Checks failing</div></div></div>
        <div class="panel"><table><thead><tr><th>Check</th><th>State</th><th>Detail</th></tr></thead><tbody>${raw(hh.checks.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${c.ok ? '<span class="pill st-online">ok</span>' : `<span class="pill ${c.level === 'critical' ? 'st-offline' : 'pending'}">${esc(c.level)}</span>`}</td><td class="small">${esc(c.detail)}</td></tr>`).join(''))}</tbody></table></div>
        <div class="panel"><h2>Heartbeats</h2><table><tbody>${raw(hh.heartbeats.map((b) => `<tr><td>${esc(b.name)}</td><td class="small">${esc(ago(b.beat_at))}</td><td class="small muted">${esc(b.detail ? JSON.stringify(b.detail) : '')}</td></tr>`).join(''))}</tbody></table>
          <p class="small muted">The on-server watchdog checks this every minute, restarts Titan or the broker if they stop, and emails and texts the monitoring contacts. Outside monitors can poll <code>/healthz/deep</code> (200 healthy, 503 not).</p></div>`);
      clearTimeout(views.health.t);
      views.health.t = setTimeout(() => { if (location.hash === '#health') route(); }, 30_000);
    };
  }

  // ======================= Subscription & card (console) =======================
  if (!admin) {
    views.billing = async (_, params) => {
      const [{ subscription: s, card, plans, devices, cardPayments }, { invoices, usage }] = await Promise.all([api('GET', '/subscription'), api('GET', '/billing')]);
      if (params.get('card') === '1') toast('Card saved. Future invoices are charged to it automatically.');
      if (params.get('card') === '0') toast('The card was not saved.');
      const trialDays = s?.trial_ends_at ? Math.max(0, Math.ceil((new Date(s.trial_ends_at).getTime() - Date.now()) / 86400e3)) : null;
      layout('billing', h`<h1>Billing</h1>
        ${raw(s?.status === 'past_due' ? '<div class="secret">Your account needs a payment method. Devices keep reporting, but please add a card below.</div>' : '')}
        <div class="tiles"><div class="tile"><div class="v" style="font-size:1.4rem">${s ? s.plan_name : 'No plan'}</div><div class="l">${s ? (s.status === 'trialing' ? `Free trial · ${trialDays} days left` : s.status.replace('_', ' ')) : 'Choose one below'}</div></div>
          <div class="tile"><div class="v">${devices}${s?.device_limit ? ` / ${s.device_limit}` : ''}</div><div class="l">Devices</div></div>
          <div class="tile"><div class="v">${usage.active_devices}</div><div class="l">Active this month</div></div>
          <div class="tile"><div class="v" style="font-size:1.2rem">${card ? `${card.card_brand ?? 'Card'} •••• ${card.last4}` : 'No card'}</div><div class="l">${card ? `Expires ${card.exp ?? ''}` : 'Add one for automatic payment'}</div></div></div>
        ${raw(plans.length ? `<div class="panel"><h2>Plans</h2><div class="tiles">${plans.map((p) => `<div class="tile" style="${s?.plan_id === p.id ? 'border:2px solid var(--ink)' : ''}"><div style="font-weight:700">${esc(p.name)}</div>
          <div class="num" style="font-size:1.4rem;margin:.3rem 0">${Number(p.base_fee) ? `${money(p.currency, p.base_fee)}/mo` : ''}${Number(p.base_fee) && Number(p.price_per_device) ? ' + ' : ''}${Number(p.price_per_device) ? `${money(p.currency, p.price_per_device)}/device` : ''}${!Number(p.base_fee) && !Number(p.price_per_device) ? 'Free' : ''}</div>
          <div class="small muted">${p.device_limit ? `Up to ${p.device_limit} devices` : 'Unlimited devices'}${p.description ? ` · ${esc(p.description)}` : ''}</div>
          ${s?.plan_id === p.id ? '<p class="small ok">Current plan</p>' : H.isOwner() ? `<button class="small" style="margin-top:.5rem" data-plan="${esc(p.id)}">Choose</button>` : ''}</div>`).join('')}</div></div>` : '')}
        <div class="panel"><h2>Payment card</h2>${raw(card ? `<p>${esc(card.card_brand ?? 'Card')} ending ${esc(card.last4)}, added ${esc(when(card.created_at))}. Invoices are charged on the 1st.</p>` : '<p class="muted">No card yet.</p>')}
          ${raw(H.isOwner() && cardPayments ? `<button class="primary" id="add-card">${card ? 'Replace card' : 'Add a card'}</button><p class="small muted">Paystack charges ₦100 to check the card and refunds it straight away.</p>` : !cardPayments ? '<p class="small muted">Card payments are not switched on yet. Contact titan@kitovu.com.ng.</p>' : '')}</div>
        <div class="panel"><h2>Invoices</h2>${raw(invoices.length ? `<table><tbody>${invoices.map((i) => `<tr><td>${esc(i.period)}</td><td class="r num">${money(i.currency, i.amount)}</td><td>${i.status === 'paid' ? '<span class="pill st-online">paid</span>' : '<span class="pill pending">due</span>'}</td><td class="r">${i.status === 'open' && H.isOwner() ? `<button class="small primary" data-pay="${esc(i.id)}">Pay now</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No invoices yet.</p>')}</div>`);
      onClick('[data-plan]', async (d) => { await api('POST', '/subscription/plan', { planId: d.plan }); toast('Plan changed'); route(); });
      onClick('#add-card', async () => { const { url } = await api('POST', '/subscription/card'); location.href = url; });
      onClick('[data-pay]', async (d) => { const { url } = await api('POST', `/invoices/${d.pay}/pay`); location.href = url; });
    };

    views.welcome = async () => {
      const me = H.getMe();
      layout('overview', h`<h1>Welcome to Titan, ${me.name ?? ''}</h1><p class="muted">Your account for ${me.orgName} is ready. Four steps to your first readings:</p>
        <ol class="panel" style="padding-left:2rem;line-height:2">
          <li><a href="#sites">Add a site</a>: a warehouse, farm, kiln yard or depot.</li>
          <li><a href="#devices">Register a device</a> with an ID starting <code>${me.devicePrefix ?? ''}-</code>, and enter its provisioning code on the device. No Titan hardware yet? <a href="/docs/" target="_blank">Connect your own</a> with the device protocol.</li>
          <li><a href="#rules">Set alert rules</a> and who gets emails and texts.</li>
          <li><a href="#billing">Check your plan</a> and add a card before your trial ends.</li>
        </ol><p class="small">On a phone? Install the field app from <a href="/app/">titan.kitovu.com.ng/app</a>.</p>`);
    };
  }

  // ======================= Password pages (no sign-in) =======================
  const shell = (inner) => { app.innerHTML = `<div class="login panel"><div class="brand">Titan</div>${inner}</div>`; };
  views.public.forgot = () => {
    shell(`<p class="muted">Enter your email and we'll send a link to choose a new password.</p><form id="f-form"><label class="lbl">Email<input name="email" type="email" required autocomplete="username"></label><button class="primary" type="submit">Send link</button><p class="form-msg small"></p></form><p class="small"><a href="#">Back to sign in</a></p>`);
    bindForm('#f-form', async (d, form) => {
      const res = await fetch('/api/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Could not send the link');
      form.innerHTML = '<p class="ok">If that email has an account, a reset link is on its way. It works for 2 hours.</p>';
    });
  };
  views.public.reset = (params) => {
    shell(`<p class="muted">Choose a new password (at least 10 characters).</p><form id="r-form"><label class="lbl">New password<input name="password" type="password" minlength="10" required autocomplete="new-password"></label><button class="primary" type="submit">Save password</button><p class="form-msg small"></p></form>`);
    bindForm('#r-form', async (d) => {
      const res = await fetch('/api/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: params.get('token'), password: d.password }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || 'That link has expired');
      toast('Password saved. Sign in with it now.');
      history.replaceState(null, '', location.pathname); H.renderLogin();
    });
  };
};

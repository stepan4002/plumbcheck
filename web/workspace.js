/** Self-contained workspace UI, also embedded in offline evidence documents. */
export function startWorkspaceUI(scenarios, mountScenarioBuilder) {
  const $ = id => document.getElementById(id);
  const nav = document.querySelector('[data-view="workspace"]');
  if (document.body.dataset.studio !== 'true') { nav.hidden = true; return; }
  let capability = null, session = 0;
  try { capability = sessionStorage.getItem('plumbcheck-workspace-token'); } catch { /* Memory-only authorization still works. */ }
  function consumeLaunchToken() {
    const token = new URLSearchParams(location.hash.slice(1)).get('auth');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    history.replaceState(null, '', location.pathname + location.search);
    capability = token; session++;
    try { sessionStorage.setItem('plumbcheck-workspace-token', token); } catch { /* Keep the capability in memory. */ }
    return true;
  }
  consumeLaunchToken();
  let state, project = null, activeRun = null, polling = false, saving = false, editingConnection = null;
  let submittingRun = false;
  const runButton = $('run-project');
  const runBusy = () => submittingRun || Boolean(activeRun);
  function updateRunButton() {
    runButton.disabled = !project;
    // Keep Run focusable while busy; the click handler enforces aria-disabled.
    if (runBusy()) runButton.setAttribute('aria-disabled', 'true');
    else runButton.removeAttribute('aria-disabled');
  }
  let projectRequest = 0, refreshRequest = 0, builderProjectId = null;
  const draft = () => JSON.stringify({ name: $('project-name').value, task: $('project-task').value, contract: $('editor').value });
  let savedDraft = draft();
  document.addEventListener('plumbcheck:examples-ready', () => {
    // The included example is the starting point, not a user edit. Preserve any
    // name or instructions typed while examples were loading.
    const initial = JSON.parse(savedDraft);
    if (!project && initial?.contract === '') { initial.contract = $('editor').value; savedDraft = JSON.stringify(initial); }
  }, { once: true });
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  document.addEventListener('plumbcheck:feedback', event => { if (event.detail?.source !== 'workspace') { $('workspace-message').textContent = ''; $('workspace-message').classList.remove('bad'); } });
  const notice = (message, bad = false) => { document.dispatchEvent(new CustomEvent('plumbcheck:feedback', { detail: { source: 'workspace' } })); $('workspace-message').textContent = message; $('workspace-message').classList.toggle('bad', bad); };
  mountScenarioBuilder({ root: $('scenario-builder'), scenarios, onCreate: async input => {
    if (!state || saving) throw new Error('Wait for the workspace to finish loading or saving.');
    if (draft() !== savedDraft && !confirm('Create this new project and replace the unsaved Contract, name and instructions? Cancel to keep your current draft.')) return false;
    const before = draft(); projectRequest++; saving = true; $('save-project').disabled = true;
    try {
      const created = await api('projects', 'POST', { ...input, ...(project?.id === builderProjectId ? { id: project.id, revision: project.revision } : {}) });
      builderProjectId = created.id;
      if (draft() !== before) { await refresh(); notice('The new project was saved. Your newer draft edits were preserved. Open the new project from the list when ready.'); return { message: 'New project saved. Newer edits remain in the existing draft; open the new project from the list when ready.' }; }
      project = created; $('project-name').value = project.name; $('project-task').value = project.task;
      $('editor').value = JSON.stringify(project.contract, null, 2); $('editor').dispatchEvent(new Event('input')); savedDraft = draft();
      await refresh(); notice($('run-mode').value === 'model' ? `Your test is saved as revision ${project.revision}. The real model test is selected: authorize it to see what the agent actually does. The planned-call check only verifies the draft.` : `Your test is saved as revision ${project.revision}. The planned-call check verifies the draft without running an agent; connect a model to test what the agent actually does.`);
      return { message: `Saved revision ${project.revision}. Keep this project open to save builder changes as another revision. Expected values stay fixed while you correct planned arguments.` };
    } finally { saving = false; $('save-project').disabled = false; }
  } });
  async function api(path, method = 'GET', body) {
    const requestSession = session;
    const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(capability ? { Authorization: `Bearer ${capability}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (requestSession !== session) throw new Error('The application session changed. Please retry the action.');
    if (!response.ok) throw new Error(value.error || 'Request failed.');
    return value;
  }
  function options(items, empty) { return `<option value="">${empty}</option>` + items.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join(''); }
  const runDescription = r => r.status === 'imported' ? `Imported from ${r.source.deviceName} · source report revision ${r.source.contractRevision ?? 'unknown'} · ${r.source.reportMatchesSnapshot === false ? 'evidence is from a different revision or contract' : r.source.reportMatchesSnapshot === null ? 'contract link unknown' : 'matching revision and contract hash'} · unverified provenance · not executed here` : `${r.mode === 'model' ? `${r.provider} / ${r.model}` : 'Offline fixture replay'} · revision ${r.revision}`;
  // Once a model is connected, the real model test is the default run. A user's own
  // choice of mode is respected; model spending consent is never pre-ticked.
  let runModeTouched = false, preferredConnectionId = null;
  function preferModelRun() {
    const mode = $('run-mode'), select = $('run-connection');
    if (!state.connections.length) {
      if (mode.value === 'model') { mode.value = 'fixture'; $('model-run-settings').hidden = true; }
      $('model-consent').checked = false;
      return;
    }
    if (!state.connections.some(c => c.id === select.value)) {
      // Consent belongs to the connection it was given for: never carry it to
      // a connection that was selected automatically.
      const preferred = state.connections.find(c => c.id === preferredConnectionId);
      select.value = (preferred ?? state.connections[0]).id;
      $('model-consent').checked = false;
    }
    if (runModeTouched || mode.value === 'model') return;
    mode.value = 'model'; $('model-run-settings').hidden = false;
  }
  function render() {
    const connectionId = $('run-connection').value;
    $('project-list').innerHTML = state.projects.length ? state.projects.map(p => `<button type="button" class="project-card ${project?.id === p.id ? 'selected' : ''}" data-project="${esc(p.id)}"><span class="eyebrow">REVISION ${p.revision} · ${p.cases} SCENARIOS</span><strong>${esc(p.name)}</strong><span>Open project →</span></button>`).join('') : '<div class="empty">Open “Build your first test” above to create a scenario without JSON, or save the included Contract draft.</div>';
    document.querySelectorAll('[data-project]').forEach(button => button.onclick = () => loadProject(button.dataset.project).catch(e => notice(e.message, true)));
    $('run-connection').innerHTML = options(state.connections, 'Choose a saved model');
    $('run-connection').value = connectionId;
    preferModelRun();
    $('connection-list').innerHTML = state.connections.map(c => `<div class="connection-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.provider)} / ${esc(c.model)}</small></div><button type="button" data-edit-connection="${esc(c.id)}">Edit</button><button type="button" data-discover="${esc(c.id)}">Check / list models</button><button type="button" data-remove-connection="${esc(c.id)}">Remove</button></div>`).join('') || '<p class="muted">No model connections yet. Offline fixture tests work without one.</p>';
    document.querySelectorAll('[data-discover]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api(`connections/${b.dataset.discover}/models`, 'POST', {}); notice(`${r.note}\n${r.models.join(', ')}`); } catch (e) { notice(e.message, true); } finally { b.disabled = false; } });
    document.querySelectorAll('[data-edit-connection]').forEach(b => b.onclick = () => {
      const c = state.connections.find(c => c.id === b.dataset.editConnection);
      editingConnection = c.id; $('connection-name').value = c.name; $('connection-provider').value = c.provider; $('connection-provider').onchange();
      $('connection-model').value = c.model; $('connection-url').value = c.baseURL || ''; $('connection-key').value = ''; $('connection-key').required = false;
      $('connection-key').placeholder = 'Leave blank to keep the saved key for this destination'; $('save-connection').textContent = 'Save connection changes →';
      $('connection-form').closest('details').open = true; notice('Editing a saved connection. A changed provider or destination needs its own credential.');
    });
    document.querySelectorAll('[data-remove-connection]').forEach(b => b.onclick = async () => { if (!confirm('Remove this saved connection and its stored credential? Existing reports will remain.')) return; try { await api(`connections/${b.dataset.removeConnection}`, 'DELETE'); await refresh(); } catch (e) { notice(e.message, true); } });
    updateRunButton();
    $('delete-project').disabled = !project || Boolean(activeRun);
    $('active-project').textContent = project ? `${project.name} / revision ${project.revision}` : 'Choose or create a project';
    $('credential-note').textContent = state.persistentSecrets ? 'Credentials are encrypted by Windows for your user account. They are excluded from project exports.' : 'Credentials stay in this process only. Re-enter them after restarting the application.';
    $('run-history').innerHTML = state.runs.length ? state.runs.map(r => `<article class="history-row"><div><span class="badge ${r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : ''}">${esc(r.status.toUpperCase())}</span><strong>${esc(r.projectName)}</strong><small>${esc(runDescription(r))} · ${esc(new Date(r.createdAt).toLocaleString())}</small>${r.usage ? `<small>${r.usage.inputTokens} input / ${r.usage.outputTokens} output tokens · ${r.usage.steps} model steps${r.usage.usageIncomplete ? ' · provider counts incomplete' : ''}</small>` : ''}${r.error ? `<small class="bad">${esc(r.error)}</small>` : ''}</div><div class="editor-actions">${r.summary ? `<span>${r.summary.passed}/${r.summary.total} passed</span><button data-report="${r.id}">Inspect →</button>` : ''}${['queued', 'running'].includes(r.status) ? `<button data-cancel="${r.id}">Cancel</button>` : `<button data-remove-run="${r.id}">Remove</button>`}</div></article>`).join('') : '<p class="empty">Your first run will appear here. Results survive app restarts.</p>';
    document.querySelectorAll('[data-report]').forEach(b => b.onclick = async () => { try { const r = await api(`runs/${b.dataset.report}`); document.dispatchEvent(new CustomEvent('plumbcheck:report', { detail: { report: r.report, source: r.status === 'imported' ? 'snapshot' : 'workspace' } })); } catch (e) { notice(e.message, true); } });
    document.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => { try { await api(`runs/${b.dataset.cancel}/cancel`, 'POST', {}); await refresh(); } catch (e) { notice(e.message, true); } });
    document.querySelectorAll('[data-remove-run]').forEach(b => b.onclick = async () => { if (!confirm('Remove this saved result? Export it first if needed.')) return; try { await api(`runs/${b.dataset.removeRun}`, 'DELETE'); await refresh(); } catch (e) { notice(e.message, true); } });
    const completed = state.runs.filter(r => ['passed', 'failed', 'imported'].includes(r.status) && r.summary);
    for (const id of ['compare-left', 'compare-right']) { const previous = $(id).value; $(id).innerHTML = options(completed.map(r => ({ id: r.id, name: `${r.projectName} / ${r.status} / ${new Date(r.createdAt).toLocaleTimeString()}` })), 'Select a completed run'); $(id).value = previous; }
    $('compare-runs').disabled = completed.length < 2;
  }
  async function refresh() {
    const request = ++refreshRequest;
    const next = await api('workspace');
    if (request !== refreshRequest) return;
    const firstLoad = !state;
    state = next;
    if (firstLoad && !state.projects.length) $('scenario-builder').closest('details').open = true;
    activeRun = state.runs.find(r => ['queued', 'running'].includes(r.status))?.id || null;
    render();
    if (activeRun && !polling) { polling = true; setTimeout(async () => { polling = false; try { await refresh(); } catch (e) { notice(e.message, true); } }, 1000); }
  }
  async function loadProject(id) {
    if (saving) { notice('Wait for the current project save to finish.', true); return; }
    const request = ++projectRequest;
    const beforeLoad = draft();
    const next = await api(`projects/${id}`);
    if (request !== projectRequest) return;
    if (draft() !== beforeLoad) { notice('Project opening canceled because you edited while it was loading. Your draft is unchanged. Open it again when ready.'); return; }
    const incoming = JSON.stringify({ name: next.name, task: next.task, contract: JSON.stringify(next.contract, null, 2) });
    if (draft() !== savedDraft && draft() !== incoming && !confirm('Replace your unsaved contract, project name and instructions with this saved project? Cancel to keep editing.')) {
      notice('Project opening canceled. Your unsaved draft is unchanged.'); return;
    }
    project = next;
    $('project-name').value = project.name; $('project-task').value = project.task;
    $('editor').value = JSON.stringify(project.contract, null, 2);
    $('editor').dispatchEvent(new Event('input'));
    savedDraft = draft();
    render(); notice('Project opened. Run its saved revision, or edit the Contract tab and save a new revision.');
  }
  $('new-project').onclick = () => {
    if (saving) { notice('Wait for the current project save to finish.', true); return; }
    if (draft() !== savedDraft && !confirm('Start a new project? Your unsaved project name and instructions will be reset. The Contract draft will be kept.')) { notice('New project canceled. Your draft is unchanged.'); return; }
    projectRequest++; project = null; savedDraft = null; $('project-name').value = ''; $('project-task').value = 'Complete the customer request using the provided tools. Use the email address returned by the order lookup. Do not delete orders.'; render(); $('project-name').focus(); notice('The current Contract draft will become the new project’s scenarios.');
  };
  $('project-form').onsubmit = async event => {
    event.preventDefault(); if (saving) return; saving = true; $('save-project').disabled = true;
    try {
      projectRequest++;
      const submitted = draft(), values = JSON.parse(submitted);
      project = await api('projects', 'POST', { id: project?.id, revision: project?.revision, name: values.name, task: values.task, contract: JSON.parse(values.contract) });
      savedDraft = submitted;
      await refresh(); notice(draft() === savedDraft ? 'Project saved on this device. The run button uses this saved revision.' : 'Project saved on this device. Newer edits remain in your draft; save again to include them.');
    }
    catch (e) { notice(e.message, true); } finally { saving = false; $('save-project').disabled = false; }
  };
  $('delete-project').onclick = async () => { if (!project || !confirm('Remove this project from this device? Existing run history will remain. Export its scenarios first if needed.')) return; try { await api(`projects/${project.id}`, 'DELETE'); project = null; await refresh(); notice('Project removed. Its historical runs remain available.'); } catch (e) { notice(e.message, true); } };
  $('connection-provider').onchange = () => {
    const p = $('connection-provider').value;
    $('connection-url-row').hidden = !['ollama', 'lmstudio', 'compatible'].includes(p);
    $('connection-url').value = p === 'ollama' ? 'http://127.0.0.1:11434/v1' : p === 'lmstudio' ? 'http://127.0.0.1:1234/v1' : '';
    $('connection-key').required = !['ollama', 'lmstudio', 'compatible'].includes(p);
    $('connection-model').value = ''; $('model-options').replaceChildren(); $('discovered-models').hidden = true;
  };
  $('connection-provider').onchange();
  $('connection-form').onsubmit = async event => {
    event.preventDefault(); const b = $('save-connection'); b.disabled = true;
    try { const c = await api('connections', 'POST', { id: editingConnection, name: $('connection-name').value, provider: $('connection-provider').value, model: $('connection-model').value, baseURL: $('connection-url').value, apiKey: $('connection-key').value }); editingConnection = c.id; preferredConnectionId = c.id; $('connection-key').value = ''; $('connection-key').required = false; $('connection-key').placeholder = 'Leave blank to keep the saved key for this destination'; $('save-connection').textContent = 'Save connection changes →'; await refresh(); $('run-connection').value = c.id; $('run-mode').value = 'model'; $('run-mode').onchange(); $('model-consent').checked = false; notice('Connection saved and selected. Review your saved test, authorize this run below, then Run saved project to verify actual tool decisions. Discovery alone does not prove tool support.'); }
    catch (e) { notice(e.message, true); } finally { b.disabled = false; }
  };
  $('discover-models').onclick = async () => {
    const button = $('discover-models'); button.disabled = true;
    const destination = () => JSON.stringify([editingConnection, $('connection-provider').value, $('connection-url').value, $('connection-key').value]);
    const requestedDestination = destination(), previousModel = $('connection-model').value;
    try {
      const result = await api('discover-models', 'POST', { id: editingConnection, name: $('connection-name').value, provider: $('connection-provider').value, model: $('connection-model').value, baseURL: $('connection-url').value, apiKey: $('connection-key').value });
      if (destination() !== requestedDestination) { notice('Connection details changed while discovery was running. Find models again for the current destination.', true); return; }
      $('model-options').replaceChildren();
      for (const model of result.models) { const option = document.createElement('option'); option.value = model; $('model-options').append(option); }
      $('discovered-models').replaceChildren();
      const choose = document.createElement('option'); choose.value = ''; choose.textContent = 'Choose an installed model'; $('discovered-models').append(choose);
      for (const model of result.models) { const option = document.createElement('option'); option.value = model; option.textContent = model; $('discovered-models').append(option); }
      $('discovered-models').hidden = !result.models.length;
      if (result.models.length === 1 && $('connection-model').value === previousModel) $('connection-model').value = result.models[0];
      notice(result.models.length ? `${result.models.length} model IDs found. Choose one in the model field, then save the connection. ${result.note}` : 'Server responded without model IDs. Enter a known model ID manually.');
    } catch (e) { notice($('connection-provider').value === 'ollama' ? `Ollama could not be verified. Open Ollama on this PC and check the server address; install a tool-capable model if the model list is empty. ${e.message}` : e.message, true); } finally { button.disabled = false; }
  };
  $('discovered-models').onchange = () => { if ($('discovered-models').value) $('connection-model').value = $('discovered-models').value; };
  $('detect-ollama').onclick = () => {
    if ((editingConnection || $('connection-key').value) && !confirm('Set up a new Ollama connection? Your saved connections remain unchanged. Unsaved connection fields will be reset.')) return;
    editingConnection = null; $('connection-form').reset(); $('connection-provider').value = 'ollama'; $('connection-provider').onchange();
    $('connection-name').value = 'Ollama on this PC'; $('connection-form').closest('details').open = true;
    $('save-connection').textContent = 'Save connection →'; $('connection-key').placeholder = '';
    $('discover-models').click();
  };
  $('new-connection').onclick = () => { editingConnection = null; $('connection-form').reset(); $('connection-provider').onchange(); $('connection-key').placeholder = ''; $('save-connection').textContent = 'Save connection →'; $('connection-form').closest('details').open = true; $('connection-name').focus(); };
  $('run-mode').onchange = () => { $('model-run-settings').hidden = $('run-mode').value !== 'model'; };
  // Programmatic onchange() calls carry no event; only a real change marks the user's choice.
  $('run-mode').addEventListener('change', () => { runModeTouched = true; });
  // Choosing another connection requires a fresh spending consent.
  $('run-connection').addEventListener('change', () => { $('model-consent').checked = false; preferredConnectionId = $('run-connection').value; });
  runButton.onclick = async () => {
    if (!project || runBusy()) return;
    const mode = $('run-mode').value;
    if (mode === 'model' && !$('model-consent').checked) { notice('Confirm that this run may send the scenario to your chosen provider and use its API quota.', true); return; }
    submittingRun = true;
    updateRunButton();
    try { const r = await api('runs', 'POST', { projectId: project.id, revision: project.revision, mode, connectionId: $('run-connection').value, idempotencyKey: crypto.randomUUID(), timeoutMs: Number($('run-timeout').value) * 1000, maxSteps: Number($('run-steps').value), maxOutputTokens: Number($('run-tokens').value), maxTotalOutputTokens: Number($('run-total-tokens').value), modelConsent: $('model-consent').checked }); activeRun = r.id; notice('Run started. Inspect its progress and evidence in History.'); await refresh(); }
    catch (e) { notice(e.message, true); }
    finally { submittingRun = false; updateRunButton(); }
  };
  $('refresh-workspace').onclick = () => refresh().catch(e => notice(e.message, true));
  $('compare-runs').onclick = async () => { try { const r = await api('compare', 'POST', { left: $('compare-left').value, right: $('compare-right').value }); $('comparison-result').textContent = r.changes.map(c => `${c.name}: ${c.before === null ? 'NEW' : c.before ? 'PASS' : 'FAIL'} → ${c.after === null ? 'REMOVED' : c.after ? 'PASS' : 'FAIL'} ${c.failureCodes.join(', ')}`).join('\n'); } catch (e) { notice(e.message, true); } };
  $('export-project').onclick = () => {
    if (!project) { notice('Open a saved project first.', true); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(project.contract, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'plumbcheck-contract.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Contract exported. Review its fixture data before sharing. Credentials were excluded.');
  };
  const syncAction = (id, action) => { $(id).onclick = async () => { $(id).disabled = true; try { await action(); } catch (e) { notice(e.message, true); } finally { $(id).disabled = false; } }; };
  syncAction('sync-pair', async () => { await api('sync/pair', 'POST', { url: $('sync-url').value, code: $('sync-code').value, name: $('sync-name').value }); $('sync-code').value = ''; notice('Device paired. Refresh snapshots or upload a reviewed project.'); });
  syncAction('sync-list', async () => { const snapshots = await api('sync/list', 'POST', {}); $('sync-snapshots').innerHTML = options(snapshots.map(s => ({ id: s.id, name: `${s.name} / revision ${s.revision} / ${s.sourceDevice} / ${new Date(s.createdAt).toLocaleString()}` })), 'Choose an immutable snapshot'); notice(`${snapshots.length} snapshots available. Your local projects are unchanged.`); });
  syncAction('sync-upload', async () => { if (!project) throw new Error('Open a saved project first.'); const result = await api('sync/upload', 'POST', { projectId: project.id, consent: $('sync-consent').checked, includeReport: $('sync-report').checked }); notice(`Uploaded immutable snapshot ${result.id}. API keys were excluded.`); });
  syncAction('sync-import', async () => { const result = await api('sync/import', 'POST', { snapshotId: $('sync-snapshots').value }); await refresh(); await loadProject(result.project.id); notice(result.note); });
  if (typeof window.plumbcheckDesktop?.controlSetup === 'function') {
    $('control-setup').hidden = false;
    $('control-setup').onclick = async () => { try { $('control-config').textContent = JSON.stringify(await window.plumbcheckDesktop.controlSetup(), null, 2); notice('Copy this configuration into a compatible MCP desktop client. Keep PlumbCheck open while using it.'); } catch (e) { notice(e.message, true); } };
  }
  // Windows app only: an opt-out notice that links to the release page. Nothing is installed.
  const desktop = window.plumbcheckDesktop;
  if (typeof desktop?.updateStatus === 'function' && typeof desktop?.setUpdateChecks === 'function') {
    let shownUpdate = null, dismissedUpdate = null;
    const showUpdate = status => {
      const url = typeof status?.url === 'string' && status.url.startsWith('https://github.com/stepan4002/plumbcheck/releases/') ? status.url : null;
      $('update-toggle').checked = status?.enabled !== false;
      shownUpdate = status?.available && url && typeof status.version === 'string' ? status.version : null;
      $('update-banner').hidden = !shownUpdate || shownUpdate === dismissedUpdate;
      if (!shownUpdate) return;
      $('update-text').textContent = `PlumbCheck ${shownUpdate} is available.`;
      $('update-link').href = url;
    };
    // Answers can arrive out of order (a check may wait on the network); only the newest request may update the UI.
    let latestRequest = 0;
    const request = async call => { const id = ++latestRequest; const status = await call(); return id === latestRequest ? status : undefined; };
    // Checks are on by default. The user can opt out at once; their choice wins over any earlier answer.
    $('update-toggle').checked = true;
    $('update-toggle-row').hidden = false;
    $('update-dismiss').onclick = () => { dismissedUpdate = shownUpdate; $('update-banner').hidden = true; };
    $('update-toggle').onchange = async () => {
      const enabled = $('update-toggle').checked;
      try {
        const status = await request(() => desktop.setUpdateChecks(enabled));
        if (!status) return;
        showUpdate(status);
        notice(enabled ? 'Update checks are on. PlumbCheck asks GitHub at most once a day.' : 'Update checks are off. PlumbCheck will not contact GitHub.');
      } catch { $('update-toggle').checked = !enabled; notice('The update setting could not be saved.', true); }
    };
    request(() => desktop.updateStatus()).then(status => { if (status) showUpdate(status); }, () => {});
  }
  async function connect(initial = false) {
    const requestSession = session;
    const previousNotice = $('workspace-message').textContent;
    try {
      await refresh(); if (requestSession !== session) return;
      nav.hidden = false; $('local-note').textContent = 'On this device · Model calls are opt-in.';
      if (initial) nav.click();
      if ($('workspace-message').textContent === previousNotice) notice(initial ? 'Start with the included contract: name your project, save it, and run offline checks. Add a model when you’re ready to test its decisions.' : 'Application session refreshed. Your contract and project draft were preserved. Open a saved project when ready.');
    } catch (error) {
      if (requestSession !== session) return;
      nav.hidden = true; $('local-note').textContent = 'For saved projects, open the private launch link printed by Studio. This page can still run the offline demo.';
      notice(error.message, true);
    }
  }
  window.addEventListener('hashchange', () => {
    if (!consumeLaunchToken()) return;
    projectRequest++; refreshRequest++; project = null; activeRun = null; editingConnection = null; savedDraft = null;
    // A new launch link is a new session: earlier consent and mode choices do not carry over.
    $('model-consent').checked = false; runModeTouched = false; preferredConnectionId = null;
    state = { projects: [], connections: [], runs: [], persistentSecrets: false }; render();
    $('sync-snapshots').replaceChildren(); $('comparison-result').textContent = ''; $('control-config').textContent = '';
    $('connection-form').reset(); $('connection-key').value = ''; $('connection-provider').onchange();
    $('save-connection').textContent = 'Save connection →'; $('connection-key').placeholder = '';
    notice('Refreshing the application session. Your draft is unchanged.');
    connect();
  });
  connect(true);
}

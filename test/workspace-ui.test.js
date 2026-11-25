import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startStudio, loadExamples } from '../src/studio.js';

const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('The expected interface state did not arrive.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

// jsdom 26 keeps focus on a control it disables. Chrome blurs that control first.
function blurFocusedControlWhenDisabled(window, control) {
  const owner = Object.getPrototypeOf(control);
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'disabled');
  Object.defineProperty(owner, 'disabled', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) {
      if (value && window.document.activeElement === this) this.blur();
      descriptor.set.call(this, value);
    },
  });
}

// Execute the actual generated, inlined application in a DOM against a real
// isolated Studio server. No user workspace, credentials or model calls are used.
async function fixture(t, intercept, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), 'plumbcheck-ui-'));
  let server = await startStudio({ port: 0, workspaceDirectory: directory });
  const examples = await loadExamples();
  const p = empty ? null : await server.workspace.saveProject({ name: 'Saved regression', task: 'Original instructions', contract: examples.regression });
  const q = empty ? null : await server.workspace.saveProject({ name: 'Other project', task: 'Other instructions', contract: examples.safe });
  const origin = new URL(server.uiURL).origin;
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dialogs = [];
  const replies = [];
  const dom = new JSDOM(await (await fetch(origin)).text(), {
    url: server.uiURL, runScripts: 'dangerously', virtualConsole: console,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.fetch = (path, options) => {
        const perform = () => fetch(new URL(path, origin), options);
        return intercept ? intercept(path, perform, options) : perform();
      };
      window.confirm = message => { dialogs.push(message); return replies.shift() ?? false; };
      window.URL.createObjectURL = () => 'blob:synthetic-test-export';
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = () => {};
    },
  });
  const $ = id => dom.window.document.getElementById(id);
  t.after(async () => { dom.window.close(); await server.shutdown(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  await until(() => $('editor').value && (empty ? !dom.window.document.querySelector('[data-view="workspace"]').hidden : dom.window.document.querySelector(`[data-project="${p.id}"]`)));
  const open = id => dom.window.document.querySelector(`[data-project="${id}"]`).click();
  const save = () => $('project-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, $, p, q, examples, open, save, dialogs, replies, directory, get server() { return server; },
    async restart() { const port = server.address().port; await server.shutdown(); server = await startStudio({ port, workspaceDirectory: directory }); return server.uiURL; },
  };
}

test('opening a project protects contract, name and instruction drafts, including example selection', async t => {
  const f = await fixture(t);
  f.open(f.p.id);
  await until(() => f.$('project-name').value === f.p.name);
  assert.equal(f.dialogs.length, 0, 'Opening the first project must not warn about the untouched included example.');
  f.$('example').value = 'safe';
  f.$('example').dispatchEvent(new f.dom.window.Event('change'));
  const edited = f.$('editor').value;
  f.open(f.p.id);
  await until(() => f.dialogs.length || f.$('editor').value !== edited);
  assert.equal(f.$('editor').value, edited, 'Canceling must retain the corrected contract.');
  assert.match(f.dialogs[0], /unsaved/i);
  f.save();
  await until(() => /Project saved/.test(f.$('workspace-message').textContent));
  assert.deepEqual(f.server.workspace.project(f.p.id).contract, f.examples.safe);
  assert.equal(f.server.workspace.project(f.p.id).revision, 2);
  for (const [id, value] of [['project-name', 'Unsaved name'], ['project-task', 'Unsaved instructions']]) {
    f.$(id).value = value;
    const before = [f.$('project-name').value, f.$('project-task').value, f.$('editor').value];
    const count = f.dialogs.length;
    f.open(f.q.id);
    await until(() => f.dialogs.length > count || f.$(id).value !== value);
    assert.deepEqual([f.$('project-name').value, f.$('project-task').value, f.$('editor').value], before);
  }
  f.replies.push(true);
  f.open(f.q.id);
  await until(() => f.$('project-name').value === f.q.name);
  assert.equal(f.$('project-task').value, f.q.task);
});

test('a new launch link refreshes authorization in the same tab and preserves the draft', async t => {
  const f = await fixture(t);
  f.open(f.p.id);
  await until(() => f.$('project-name').value === f.p.name);
  f.$('project-task').value = 'Keep these unsaved instructions';
  const launch = await f.restart();
  f.dom.window.location.hash = new URL(launch).hash;
  await until(() => f.dom.window.location.hash === '');
  assert.equal(f.$('project-task').value, 'Keep these unsaved instructions');
  f.$('sync-list').click();
  await until(() => !f.$('sync-list').disabled);
  assert.match(f.$('workspace-message').textContent, /Pair this device/);
  assert.doesNotMatch(f.$('workspace-message').textContent, /private application launch/);
  assert.equal(f.dom.window.sessionStorage.getItem('plumbcheck-workspace-token'), f.server.workspaceToken);
});

test('new edits during project loading are retained; older loads cannot replace newer choices', async t => {
  const held = [];
  let hold = false;
  const f = await fixture(t, (path, perform) => hold && path.startsWith('/api/projects/') ? new Promise(resolve => held.push(() => resolve(perform()))) : perform());
  hold = true;
  f.open(f.p.id); f.open(f.q.id);
  held[1]();
  await until(() => f.$('project-name').value === f.q.name);
  held[0]();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.$('project-name').value, f.q.name);
  f.open(f.p.id);
  f.$('project-task').value = 'Edited while loading';
  held[2]();
  await until(() => /edited while it was loading/.test(f.$('workspace-message').textContent));
  assert.equal(f.$('project-task').value, 'Edited while loading');
});

test('export and run failures clear stale success feedback; invalid imports keep data', async t => {
  const f = await fixture(t);
  const draft = f.$('editor').value;
  for (const button of ['download-contract', 'run-editor']) {
    f.$('editor').value = draft;
    f.$('download-contract').click();
    assert.match(f.$('announcement').textContent, /downloaded/);
    f.$('editor').value = '{invalid';
    f.$(button).click();
    assert.equal(f.$('error').hidden, false);
    assert.doesNotMatch(f.$('announcement').textContent, /downloaded/);
  }
  f.$('editor').value = draft;
  f.$('download-contract').click();
  f.$('import-text').value = '{invalid'; f.$('open-pasted').click();
  assert.equal(f.$('editor').value, draft);
  assert.match(f.$('announcement').textContent, /not opened/);
});

test('saving captures submitted inputs and keeps edits made while the save is in flight', async t => {
  let release;
  const f = await fixture(t, (path, perform, options) => path === '/api/projects' && options.method === 'POST'
    ? new Promise(resolve => { release = () => resolve(perform()); }) : perform());
  f.open(f.p.id);
  await until(() => f.$('project-name').value === f.p.name);
  f.$('project-task').value = 'Submitted instructions';
  f.save();
  await until(() => release);
  f.$('project-task').value = 'Newer instructions';
  f.open(f.q.id);
  assert.equal(f.$('project-name').value, f.p.name, 'Opening a different project must wait for the save.');
  release();
  await until(() => /Project saved/.test(f.$('workspace-message').textContent));
  assert.equal(f.server.workspace.project(f.p.id).task, 'Submitted instructions');
  assert.equal(f.$('project-task').value, 'Newer instructions');
  assert.match(f.$('workspace-message').textContent, /Newer edits/);
  f.open(f.q.id);
  await until(() => f.dialogs.length);
  assert.equal(f.$('project-task').value, 'Newer instructions');
});

test('new-project cancellation preserves metadata and a stale response cannot overwrite a refreshed session', async t => {
  let release;
  let hold = false;
  const f = await fixture(t, (path, perform) => hold && path.startsWith('/api/projects/')
    ? new Promise(resolve => { release = () => resolve(perform()); }) : perform());
  f.open(f.p.id);
  await until(() => f.$('project-name').value === f.p.name);
  f.$('project-name').value = 'Keep my name';
  f.$('new-project').click();
  assert.equal(f.$('project-name').value, 'Keep my name');
  assert.match(f.dialogs[0], /unsaved/);
  hold = true; f.open(f.q.id);
  await until(() => release);
  const launch = await f.restart();
  f.dom.window.location.hash = new URL(launch).hash;
  await until(() => /session refreshed/.test(f.$('workspace-message').textContent));
  release();
  await until(() => /session changed/.test(f.$('workspace-message').textContent));
  assert.equal(f.$('project-name').value, 'Keep my name');
  assert.equal(f.$('project-task').value, f.p.task);
  assert.equal(f.dom.window.location.hash, '');
});

test('file-import and asynchronous runner errors replace previous success messages', async t => {
  const f = await fixture(t, (path, perform) => path === '/api/run'
    ? Promise.resolve(new Response(JSON.stringify({ error: 'Synthetic runner failure' }), { status: 400 })) : perform());
  const before = f.$('editor').value;
  f.$('download-contract').click();
  f.$('run-editor').click();
  await until(() => f.$('error').textContent === 'Synthetic runner failure');
  assert.match(f.$('announcement').textContent, /could not run/);
  assert.equal(f.$('editor').value, before);
  f.$('download-contract').click();
  Object.defineProperty(f.$('artifact-file'), 'files', { value: [{ name: 'invalid.json', size: 8, text: async () => '{invalid' }] });
  f.$('artifact-file').dispatchEvent(new f.dom.window.Event('change'));
  await until(() => /File was not opened/.test(f.$('announcement').textContent));
  assert.equal(f.$('editor').value, before);
  assert.equal(f.$('error').hidden, false);
});

test('workspace exports and workbench errors share feedback; later successful saves clear the old error', async t => {
  const f = await fixture(t);
  f.open(f.p.id); await until(() => f.$('project-name').value === f.p.name);
  f.$('export-project').click();
  assert.match(f.$('workspace-message').textContent, /Contract exported/);
  f.$('import-text').value = 'not json'; f.$('open-pasted').click();
  assert.equal(f.$('error').hidden, false);
  assert.doesNotMatch(f.$('workspace-message').textContent, /Contract exported/);
  f.save(); await until(() => /Project saved/.test(f.$('workspace-message').textContent));
  assert.equal(f.$('error').hidden, true);
  assert.equal(f.$('announcement').textContent, '');
  f.$('project-name').value = 'Edited name'; f.$('new-project').click();
  assert.match(f.$('workspace-message').textContent, /New project canceled/);
  f.$('export-project').click();
  Object.defineProperty(f.$('artifact-file'), 'files', { value: [{ name: 'malformed.json', size: 8, text: async () => 'not json' }] });
  f.$('artifact-file').dispatchEvent(new f.dom.window.Event('change'));
  await until(() => /File was not opened/.test(f.$('announcement').textContent));
  assert.doesNotMatch(f.$('workspace-message').textContent, /Contract exported/);
  f.save(); await until(() => /Project saved/.test(f.$('workspace-message').textContent));
  assert.equal(f.$('error').hidden, true);
});

test('no-JSON builder saves, exposes a real failure, fixes the same scenario and preserves it after restart', async t => {
  const f = await fixture(t);
  const root = f.$('scenario-builder'), field = selector => root.querySelector(selector);
  field('[data-name]').value = 'Builder regression';
  field('[data-planned]').value = 'WRONG-ORDER';
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(field('[data-message]').textContent));
  const created = f.server.workspace.summary().projects.find(p => p.name === 'Builder regression');
  assert.ok(created);
  assert.equal(f.$('project-name').value, created.name);
  f.$('run-project').click();
  await until(() => f.server.workspace.summary().runs.some(r => r.projectId === created.id && r.status === 'failed'));
  const first = f.server.workspace.summary().runs.find(r => r.projectId === created.id);
  assert.ok(f.server.workspace.run(first.id).report.cases[0].failures.some(f => f.code === 'ARGUMENT_MISMATCH'));
  field('[data-planned]').value = 'ORD-1042';
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 2/.test(field('[data-message]').textContent));
  assert.equal(f.server.workspace.summary().projects.filter(p => p.name === 'Builder regression').length, 1);
  f.$('run-project').click();
  await until(() => f.server.workspace.summary().runs.some(r => r.projectId === created.id && r.status === 'passed'));
  const second = f.server.workspace.summary().runs.find(r => r.projectId === created.id && r.status === 'passed');
  const comparison = f.server.workspace.compare(first.id, second.id);
  assert.equal(comparison.changes.length, 1);
  assert.equal(comparison.changes[0].before, false);
  assert.equal(comparison.changes[0].after, true);
  await f.restart();
  assert.equal(f.server.workspace.project(created.id).revision, 2);
  assert.equal(f.server.workspace.run(second.id).report.passed, true);
});

test('saving the first test returns keyboard focus to the builder control that started it', async t => {
  const f = await fixture(t, null, true);
  const root = f.$('scenario-builder');
  const button = root.querySelector('[data-create]');
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  root.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(root.querySelector('[data-message]').textContent));
  assert.equal(f.dom.window.document.activeElement, button);
});

test('a focus failure after a saved builder test does not reject the completed save', async t => {
  const rejections = [];
  const f = await fixture(t, null, true);
  f.dom.window.addEventListener('unhandledrejection', event => { rejections.push(event.reason); event.preventDefault(); });
  const root = f.$('scenario-builder');
  const button = root.querySelector('[data-create]');
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  button.focus = () => { throw new Error('focus unavailable'); };
  root.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(root.querySelector('[data-message]').textContent));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(rejections, []);
  assert.equal(f.server.workspace.summary().projects.length, 1);
});

test('saving the first test leaves focus on the control a keyboard user reached while save was pending', async t => {
  let release;
  const f = await fixture(t, (path, perform, options) => path === '/api/projects' && options?.method === 'POST'
    ? new Promise(resolve => { release = () => resolve(perform()); })
    : perform(), true);
  const root = f.$('scenario-builder');
  const button = root.querySelector('[data-create]');
  const next = f.dom.window.document.querySelector('[data-view="overview"]');
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  root.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => button.disabled && release);
  next.focus();
  release();
  await until(() => /Saved revision 1/.test(root.querySelector('[data-message]').textContent));
  assert.equal(f.dom.window.document.activeElement, next);
  assert.equal(f.server.workspace.summary().projects.length, 1);
});

test('running a saved project keeps focus on Run and prevents repeat activation while starting', async t => {
  let release, starts = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, (path, perform) => {
    if (path !== '/api/runs') return perform();
    starts++;
    return pending.then(perform);
  });
  const { document } = f.dom.window;
  const button = f.$('run-project');
  assert.equal(button.disabled, true, 'Run is unavailable before opening a saved project');
  f.open(f.q.id);
  await until(() => f.$('project-name').value === f.q.name);
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  button.click();
  assert.equal(document.activeElement.id, button.id, 'starting the run must not drop keyboard focus');
  assert.equal(button.getAttribute('aria-disabled'), 'true');

  const card = f.$('project-list').firstElementChild;
  f.$('refresh-workspace').click();
  await until(() => f.$('project-list').firstElementChild !== card);
  assert.equal(button.getAttribute('aria-disabled'), 'true', 'a refresh must not unlock a pending submission');
  button.click();
  assert.equal(starts, 1);

  release();
  await until(() => f.$('run-history').querySelector('[data-report]'));
  assert.equal(button.matches(':disabled, [aria-disabled="true"]'), false);
  assert.equal(document.activeElement.id, button.id);
});

test('a queued saved-project run stays unavailable and its completion leaves focus where the user moved it', async t => {
  let queued, starts = 0;
  const f = await fixture(t, async (path, perform) => {
    if (path === '/api/runs') starts++;
    const response = await perform();
    if (path === '/api/runs') queued = await response.clone().json();
    if (path === '/api/workspace' && queued) {
      // Show the real queued response once even if the fixture has already finished.
      const run = queued;
      queued = null;
      return Response.json({ ...await response.json(), runs: [run] });
    }
    return response;
  });
  f.open(f.q.id);
  await until(() => f.$('project-name').value === f.q.name);
  const button = f.$('run-project'), next = f.$('run-total-tokens');
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  button.click();
  await until(() => f.$('run-history').querySelector('[data-cancel]'));
  assert.equal(f.dom.window.document.activeElement.id, button.id);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  button.click();
  assert.equal(starts, 1);
  next.focus();
  await until(() => f.$('run-history').querySelector('[data-report]'));
  assert.equal(button.matches(':disabled, [aria-disabled="true"]'), false);
  assert.equal(f.dom.window.document.activeElement.id, next.id);
});

test('a rejected saved-project run becomes available for retry without moving focus', async t => {
  const f = await fixture(t);
  f.open(f.q.id);
  await until(() => f.$('project-name').value === f.q.name);
  const button = f.$('run-project'), timeout = f.$('run-timeout');
  blurFocusedControlWhenDisabled(f.dom.window, button);
  button.focus();
  timeout.value = '0';
  button.click();
  const message = f.$('workspace-message');
  await until(() => /timeoutMs must be/.test(message.textContent));
  assert.ok(message.classList.contains('bad'), 'a rejected run still presents an error');
  assert.equal(f.dom.window.document.activeElement.id, button.id);
  assert.equal(button.matches(':disabled, [aria-disabled="true"]'), false);
  timeout.value = '60';
  button.click();
  await until(() => f.$('run-history').querySelector('[data-report]'));
  assert.equal(f.server.workspace.summary().runs.length, 1);
});

test('inspecting a saved run moves focus to the execution evidence heading', async t => {
  const f = await fixture(t);
  f.open(f.q.id);
  await until(() => f.$('project-name').value === f.q.name);
  const workspaceButton = f.dom.window.document.querySelector('[data-view="workspace"]');
  workspaceButton.click();
  f.$('run-project').click();
  const inspect = () => f.$('run-history').querySelector('[data-report]');
  await until(inspect);
  inspect().focus();
  inspect().click();
  await until(() => !f.$('overview').hidden);
  assert.equal(f.dom.window.document.activeElement.id, 'evidence-heading');
});

test('builder validation and cancellation preserve the existing project and render hostile-looking names as text', async t => {
  const f = await fixture(t);
  f.open(f.p.id); await until(() => f.$('project-name').value === f.p.name);
  const root = f.$('scenario-builder'), field = selector => root.querySelector(selector);
  field('[data-path]').value = '__proto__.polluted';
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(field('[data-message]').textContent, /Reserved/);
  assert.equal(f.server.workspace.summary().projects.length, 2);
  field('[data-path]').value = 'orderId';
  field('[data-name]').value = '<img src=x onerror=alert(1)>';
  f.$('project-task').value = 'Keep this draft';
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Creation canceled/.test(field('[data-message]').textContent));
  assert.equal(f.$('project-task').value, 'Keep this draft');
  f.replies.push(true);
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(field('[data-message]').textContent));
  assert.ok(f.$('project-list').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(f.$('project-list').querySelector('img'), null);
});

test('guided Ollama setup lists actual returned models, saves selection and requires separate model-run consent', async t => {
  const requests = [];
  const f = await fixture(t, (path, perform) => {
    if (path === '/api/discover-models') { requests.push(path); return Promise.resolve(Response.json({ models: ['model-one', 'model-two'], note: 'Server reached.' })); }
    return perform();
  });
  f.$('detect-ollama').click();
  await until(() => !f.$('discovered-models').hidden);
  assert.equal(requests.length, 1);
  assert.equal(f.$('connection-provider').value, 'ollama');
  assert.equal(f.$('connection-key').required, false);
  f.$('discovered-models').value = 'model-two';
  f.$('discovered-models').dispatchEvent(new f.dom.window.Event('change'));
  f.$('connection-form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.server.workspace.summary().connections.length === 1 && /Connection saved/.test(f.$('workspace-message').textContent));
  assert.equal(f.server.workspace.summary().connections[0].model, 'model-two');
  assert.equal(f.$('run-mode').value, 'model');
  assert.equal(f.$('model-consent').checked, false);
  assert.equal(f.server.workspace.summary().runs.length, 0);
});

test('model discovery cannot populate a changed destination with stale model IDs', async t => {
  let release;
  const f = await fixture(t, (path, perform) => path === '/api/discover-models' ? new Promise(resolve => { release = () => resolve(Response.json({ models: ['old-destination-model'], note: 'Server reached.' })); }) : perform());
  f.$('detect-ollama').click(); await until(() => release);
  f.$('connection-provider').value = 'lmstudio'; f.$('connection-provider').onchange();
  release();
  await until(() => /details changed/.test(f.$('workspace-message').textContent));
  assert.equal(f.$('connection-model').value, '');
  assert.equal(f.$('discovered-models').hidden, true);
  assert.equal(f.$('model-options').children.length, 0);
});

test('a fresh workspace opens the builder and saves the first test without a misleading unsaved-example prompt', async t => {
  const f = await fixture(t, null, true);
  assert.equal(f.$('scenario-builder').closest('details').open, true);
  const root = f.$('scenario-builder');
  root.querySelector('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(root.querySelector('[data-message]').textContent));
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.server.workspace.summary().projects.length, 1);
  f.dom.window.document.querySelector('[data-view="overview"]').click();
  assert.match(f.$('artifact-source').textContent, /BUILT-IN EXAMPLE/);
});

test('with a saved connection the builder defaults to a real model run, never pre-consents, and respects a manual choice', async t => {
  const f = await fixture(t);
  await f.server.workspace.saveConnection({ name: 'Local', provider: 'ollama', model: 'qwen3.5:4b', baseURL: 'http://127.0.0.1:11434/v1' });
  const root = f.$('scenario-builder'), field = selector => root.querySelector(selector);
  f.replies.push(true, true);
  field('[data-template-kind]').value = 'forbidden-delete';
  field('[data-template]').click();
  assert.equal(field('[data-guard-kind]').value, 'deny');
  assert.equal(field('[data-guard-tool]').value, 'orders.delete');
  field('[data-name]').value = 'Must not delete';
  field('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Saved revision 1/.test(field('[data-message]').textContent));
  await until(() => f.$('run-mode').value === 'model');
  assert.equal(f.$('model-consent').checked, false);
  assert.equal(f.$('run-connection').value, f.server.workspace.summary().connections[0].id);
  const saved = f.server.workspace.summary().projects.find(p => p.name === 'Must not delete');
  assert.ok(saved);
  f.$('run-mode').value = 'fixture'; f.$('run-mode').dispatchEvent(new f.dom.window.Event('change'));
  const renders = f.server.workspace.summary().connections.length;
  f.$('refresh-workspace').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(renders, 1);
  assert.equal(f.$('run-mode').value, 'fixture', 'a manual choice survives refreshes');
  field('[data-template-kind]').value = 'order'; field('[data-template]').click();
  assert.equal(field('[data-guard-kind]').value, 'none', 'switching templates clears the guard');
  assert.equal(field('[data-guard-tool]').value, '');
});

test('model-spending consent never carries over to a connection the user did not choose', async t => {
  const f = await fixture(t);
  const a = await f.server.workspace.saveConnection({ name: 'Local A', provider: 'ollama', model: 'model-a', baseURL: 'http://127.0.0.1:11434/v1' });
  const b = await f.server.workspace.saveConnection({ name: 'Local B', provider: 'lmstudio', model: 'model-b', baseURL: 'http://127.0.0.1:1234/v1' });
  f.$('refresh-workspace').click();
  await until(() => f.$('run-connection').querySelectorAll('option').length >= 3);
  f.$('run-connection').value = b.id; f.$('run-connection').dispatchEvent(new f.dom.window.Event('change'));
  f.$('model-consent').checked = true;
  await f.server.workspace.remove('connections', b.id);
  f.$('refresh-workspace').click();
  await until(() => f.$('run-connection').value === a.id);
  assert.equal(f.$('model-consent').checked, false, 'auto-selected connection must not inherit consent');
  f.$('model-consent').checked = true;
  f.$('run-connection').value = ''; f.$('run-connection').dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.$('model-consent').checked, false, 'changing the connection clears consent');
});

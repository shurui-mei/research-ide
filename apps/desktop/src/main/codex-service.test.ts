import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexService, __codexInternals } from './codex-service';
import { ProjectPathGuard } from './path-guard';
import type { ProjectService } from './project-service';

const FAKE_APP_SERVER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = process.argv[2];
const cwd = process.cwd();
fs.appendFileSync(logPath, JSON.stringify({ launchArgs: process.argv.slice(3) }) + '\n');
const thread = {
  id: 'thread-1', name: 'Experiment review', preview: 'Review the experiment', cwd,
  createdAt: 1700000000, updatedAt: 1700000010, recencyAt: 1700000020,
  status: { type: 'idle' }, modelProvider: 'openai'
};
const turns = [{
  id: 'turn-1', startedAt: 1700000000,
  items: [
    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Earlier question', text_elements: [] }] },
    { id: 'assistant-1', type: 'agentMessage', text: 'Earlier answer' }
  ]
}, {
  id: 'turn-2', startedAt: 1700000100,
  items: [
    { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Latest question', text_elements: [] }] },
    { id: 'assistant-2', type: 'agentMessage', text: 'Latest answer' }
  ]
}];
function turnsPage(params) {
  return params && params.cursor === 'older-page'
    ? { data: [turns[1], turns[0]], nextCursor: null, backwardsCursor: 'newer-page' }
    : { data: [turns[1]], nextCursor: 'older-page', backwardsCursor: null };
}
function resultFor(method, params) {
  if (method === 'initialize') return { userAgent: 'codex-cli/0.999.0' };
  if (method === 'permissionProfile/list') return { data: [{ id: ':read-only', allowed: true }, { id: ':workspace', allowed: true }] };
  if (method === 'thread/list') return { data: [thread] };
  if (method === 'model/list') return { data: [{ id: 'model-a', model: 'model-a', displayName: 'Model A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }] };
  if (method === 'config/read') return { config: { approvals_reviewer: 'auto_review' } };
  if (method === 'configRequirements/read') return { requirements: { allowedApprovalsReviewers: ['user', 'auto_review'] } };
  if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fake@example.test' } };
  if (method === 'thread/read') return { thread: params && params.threadId === 'thread-mismatch' ? thread : { ...thread, id: params && params.threadId || thread.id } };
  if (method === 'thread/turns/list' && params && params.threadId === 'thread-loop') return { data: [turns[1]], nextCursor: 'loop-cursor', backwardsCursor: null };
  if (method === 'thread/turns/list') return turnsPage(params);
  if (method === 'thread/resume') return { thread, initialTurnsPage: turnsPage(params && params.initialTurnsPage), model: 'model-a', reasoningEffort: 'medium' };
  if (method === 'thread/settings/update') return {};
  if (method === 'turn/start') return { turn: { id: 'turn-2' } };
  return {};
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const keepAlive = setInterval(() => {}, 1000);
fs.appendFileSync(logPath, JSON.stringify({ stdin: { destroyed: process.stdin.destroyed, readable: process.stdin.readable } }) + '\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify({ rpc: message }) + '\n');
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: resultFor(message.method, message.params) }) + '\n');
});
lines.on('close', () => { fs.appendFileSync(logPath, JSON.stringify({ stdinClosed: true }) + '\n'); clearInterval(keepAlive); });
`;

// The managed Codex Linux sandbox used for repository verification closes a
// recursively spawned Node process' stdin. Normal CI uses the JavaScript
// fixture above; this equivalent keeps the local stdio contract test real
// without a shell launcher in that one constrained harness.
const FAKE_APP_SERVER_PY = String.raw`
import json, os, sys
log_path = sys.argv[1]
cwd = os.getcwd()
thread = {
  'id': 'thread-1', 'name': 'Experiment review', 'preview': 'Review the experiment', 'cwd': cwd,
  'createdAt': 1700000000, 'updatedAt': 1700000010, 'recencyAt': 1700000020,
  'status': {'type': 'idle'}, 'modelProvider': 'openai'
}
turns = [{'id': 'turn-1', 'startedAt': 1700000000, 'items': [
  {'id': 'user-1', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Earlier question', 'text_elements': []}]},
  {'id': 'assistant-1', 'type': 'agentMessage', 'text': 'Earlier answer'}
]}, {'id': 'turn-2', 'startedAt': 1700000100, 'items': [
  {'id': 'user-2', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Latest question', 'text_elements': []}]},
  {'id': 'assistant-2', 'type': 'agentMessage', 'text': 'Latest answer'}
]}]
def turns_page(params):
  if params and params.get('cursor') == 'older-page':
    return {'data': [turns[1], turns[0]], 'nextCursor': None, 'backwardsCursor': 'newer-page'}
  return {'data': [turns[1]], 'nextCursor': 'older-page', 'backwardsCursor': None}
def append(value):
  with open(log_path, 'a', encoding='utf-8') as handle:
    handle.write(json.dumps(value) + '\n')
def result_for(method, params):
  if method == 'initialize': return {'userAgent': 'codex-cli/0.999.0'}
  if method == 'permissionProfile/list': return {'data': [{'id': ':read-only', 'allowed': True}, {'id': ':workspace', 'allowed': True}]}
  if method == 'thread/list': return {'data': [thread]}
  if method == 'model/list': return {'data': [{'id': 'model-a', 'model': 'model-a', 'displayName': 'Model A', 'isDefault': True, 'defaultReasoningEffort': 'medium', 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}, {'reasoningEffort': 'medium'}, {'reasoningEffort': 'high'}]}]}
  if method == 'config/read': return {'config': {'approvals_reviewer': 'auto_review'}}
  if method == 'configRequirements/read': return {'requirements': {'allowedApprovalsReviewers': ['user', 'auto_review']}}
  if method == 'account/read': return {'account': {'type': 'chatgpt', 'email': 'fake@example.test'}}
  if method == 'thread/read': return {'thread': thread if params and params.get('threadId') == 'thread-mismatch' else dict(thread, id=(params or {}).get('threadId', thread['id']))}
  if method == 'thread/turns/list' and params and params.get('threadId') == 'thread-loop': return {'data': [turns[1]], 'nextCursor': 'loop-cursor', 'backwardsCursor': None}
  if method == 'thread/turns/list': return turns_page(params)
  if method == 'thread/resume': return {'thread': thread, 'initialTurnsPage': turns_page((params or {}).get('initialTurnsPage')), 'model': 'model-a', 'reasoningEffort': 'medium'}
  if method == 'turn/start': return {'turn': {'id': 'turn-2'}}
  return {}
append({'launchArgs': sys.argv[2:]})
for line in sys.stdin:
  message = json.loads(line)
  append({'rpc': message})
  if 'id' in message:
    sys.stdout.write(json.dumps({'id': message['id'], 'result': result_for(message.get('method'), message.get('params'))}) + '\n')
    sys.stdout.flush()
`;

describe('Codex app-server response mapping', () => {
  it('omits provider authentication config entirely when an OpenAI-like endpoint has no key', () => {
    expect(__codexInternals.validateOptionalProviderKey(undefined)).toBeUndefined();
    expect(__codexInternals.validateOptionalProviderKey('   ')).toBeUndefined();
    expect(__codexInternals.validateOptionalProviderKey('  session-only-secret  ')).toBe('session-only-secret');
    expect(() => __codexInternals.validateOptionalProviderKey('short')).toThrow(/empty or a valid session credential/i);

    const anonymous = __codexInternals.providerRuntimeConfiguration({
      method: 'openaiLike', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model',
    });
    expect(anonymous.environment).toEqual({});
    expect(anonymous.appServerArguments.join(' ')).toContain('model_providers.research_ide.base_url=');
    expect(anonymous.appServerArguments.join(' ')).toContain('model_providers.research_ide.wire_api="responses"');
    expect(anonymous.appServerArguments.join(' ')).not.toContain('env_key');

    const secret = 'session-only-secret';
    const authenticated = __codexInternals.providerRuntimeConfiguration({
      method: 'openaiLike', apiKey: secret, baseUrl: 'https://provider.example/v1', model: 'remote-model',
    });
    expect(authenticated.environment).toEqual({ RESEARCH_IDE_PROVIDER_API_KEY: secret });
    expect(authenticated.appServerArguments.join(' ')).toContain('env_key="RESEARCH_IDE_PROVIDER_API_KEY"');
    expect(authenticated.appServerArguments.join(' ')).not.toContain(secret);
  });

  it('adds trusted macOS GUI locations while rejecting project-local Codex commands and child PATH entries', async () => {
    expect(__codexInternals.codexSystemSearchDirectories('darwin', '/usr/bin')).toEqual(expect.arrayContaining([
      '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin',
    ]));

    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-codex-path-'));
    try {
      const projectRoot = path.join(base, 'project');
      const projectBin = path.join(projectRoot, 'bin');
      const outsideBin = path.join(base, 'system-bin');
      const name = `codex-path-probe-${path.basename(base)}`;
      const projectExecutable = path.join(projectBin, name);
      const outsideExecutable = path.join(outsideBin, name);
      await Promise.all([mkdir(projectBin, { recursive: true }), mkdir(outsideBin, { recursive: true })]);
      await Promise.all([
        writeFile(projectExecutable, '#!/bin/sh\nexit 0\n', 'utf8'),
        writeFile(outsideExecutable, '#!/bin/sh\nexit 0\n', 'utf8'),
      ]);
      await Promise.all([chmod(projectExecutable, 0o700), chmod(outsideExecutable, 0o700)]);

      expect(__codexInternals.sameCanonicalPath(projectRoot, projectRoot)).toBe(true);
      expect(__codexInternals.sameCanonicalPath(projectRoot, outsideBin)).toBe(false);
      expect(__codexInternals.sameCanonicalPath(projectRoot, path.join(base, 'missing'))).toBe(false);
      if (process.platform !== 'win32') {
        const projectAlias = path.join(base, 'project-alias');
        await symlink(projectRoot, projectAlias, 'dir');
        expect(__codexInternals.sameCanonicalPath(projectRoot, projectAlias)).toBe(true);
      }

      expect(__codexInternals.trustedPathFile(projectRoot, [name], {
        pathValue: projectBin, platform: process.platform,
      })).toBeUndefined();
      expect(__codexInternals.trustedPathFile(projectRoot, [name], {
        pathValue: [projectBin, outsideBin].join(path.delimiter), platform: process.platform,
      })).toBe(await realpath(outsideExecutable));

      const childDirectories = __codexInternals.codexChildPathDirectories(
        projectRoot, outsideExecutable, process.platform, [projectBin, outsideBin].join(path.delimiter),
      );
      expect(childDirectories).toContain(await realpath(outsideBin));
      expect(childDirectories).not.toContain(await realpath(projectBin));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('keeps Ask mode fail-closed and delegates Agent approvals only to Codex auto-review', () => {
    expect(__codexInternals.turnApprovalSettings('ask', true)).toEqual({ approvalPolicy: 'never', approvalsReviewer: 'user' });
    expect(__codexInternals.turnApprovalSettings('agent', true)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(__codexInternals.turnApprovalSettings('agent', false)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  });

  it('maps persisted thread metadata without exposing rollout paths', () => {
    expect(__codexInternals.parseThreadSummary({
      id: 'thread-1',
      name: null,
      preview: 'Analyse the experiment\nwith the latest data',
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_010,
      recencyAt: 1_700_000_020,
      status: { type: 'idle' },
      modelProvider: 'openai',
      path: '/private/rollout.jsonl',
    })).toEqual({
      id: 'thread-1',
      title: 'Analyse the experiment',
      preview: 'Analyse the experiment\nwith the latest data',
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:13:40.000Z',
      status: 'idle',
      modelProvider: 'openai',
    });
  });

  it('reconstructs user and assistant messages from thread/read turns', () => {
    expect(__codexInternals.parseThreadMessages({
      turns: [{
        id: 'turn-1',
        startedAt: 1_700_000_000,
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Check the results', text_elements: [] }, { type: 'mention', name: 'results.csv', path: '/project/results.csv' }] },
          { id: 'reasoning-1', type: 'reasoning', summary: ['private'] },
          { id: 'assistant-1', type: 'agentMessage', text: 'The results are consistent.' },
        ],
      }],
    })).toEqual([
      { id: 'user-1', role: 'user', content: 'Check the results', createdAt: '2023-11-14T22:13:20.000Z' },
      { id: 'assistant-1', role: 'assistant', content: 'The results are consistent.', createdAt: '2023-11-14T22:13:20.000Z' },
    ]);
  });

  it('reverses the newest-first bounded turns page for chronological rendering', () => {
    expect(__codexInternals.withTurnsPage({ id: 'thread-1', turns: [] }, { data: [{ id: 'new' }, { id: 'old' }] }).turns)
      .toEqual([{ id: 'old' }, { id: 'new' }]);
  });

  it('deduplicates paged turns, keeps chronological order, and reports bounded truncation', () => {
    const newestFirst = [{ id: 'new' }, { id: 'middle' }, { id: 'middle' }, { id: 'old' }];
    const complete = __codexInternals.boundNewestFirstTurns(newestFirst, { maxTurns: 10, maxBytes: 10_000 });
    expect(complete.turns.map((turn) => turn.id)).toEqual(['old', 'middle', 'new']);
    expect(complete.history).toEqual({ truncated: false, loadedTurns: 3, maxTurns: 10 });

    const limited = __codexInternals.boundNewestFirstTurns(newestFirst, { maxTurns: 2, maxBytes: 10_000 });
    expect(limited.turns.map((turn) => turn.id)).toEqual(['middle', 'new']);
    expect(limited.history).toEqual({ truncated: true, loadedTurns: 2, maxTurns: 2, truncationReason: 'turnLimit' });

    const sizeLimited = __codexInternals.boundNewestFirstTurns([{ id: 'large', text: 'x'.repeat(100) }], { maxTurns: 10, maxBytes: 20 });
    expect(sizeLimited.history).toEqual({ truncated: true, loadedTurns: 0, maxTurns: 10, truncationReason: 'sizeLimit' });
  });

  it('uses model/list reasoning options and excludes hidden models', () => {
    expect(__codexInternals.parseModelOptions({ data: [
      {
        id: 'model-a', model: 'model-a', displayName: 'Model A', description: 'General model', hidden: false, isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
      },
      { id: 'hidden', model: 'hidden', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
    ] })).toEqual([{
      id: 'model-a', model: 'model-a', displayName: 'Model A', description: 'General model', isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { value: 'low', description: 'Fast' },
        { value: 'medium', description: 'Balanced' },
      ],
    }]);
  });

  it('validates selected buffers and strips embedded base64 images in the main process', () => {
    const payload = __codexInternals.validateContextPayload(
      ['notes/paper.researchdoc'],
      [{
        path: 'notes/paper.researchdoc',
        format: 'prosemirror',
        content: JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Current unsaved result' }] },
            { type: 'image', attrs: { src: 'data:image/png;base64,QUJDRA==' } },
          ],
        }),
      }],
    );
    expect(payload.buffers[0].content).toContain('Current unsaved result');
    expect(payload.buffers[0].content).toContain('embedded image omitted');
    expect(payload.buffers[0].content).not.toContain('data:image');
    expect(() => __codexInternals.validateContextPayload(
      ['notes/saved.md'],
      [{ path: 'notes/other.md', format: 'text', content: 'not selected' }],
    )).toThrow(/selected context set/i);
    expect(() => __codexInternals.validateContextPayload(
      ['notes/saved.md', 'notes/saved.md'],
      [],
    )).toThrow(/duplicates/i);
  });

  it('sends an unsaved buffer as explicitly untrusted text instead of a disk mention', () => {
    const selected = new Map([
      ['/project/dirty.md', { absolute: '/project/dirty.md', relative: 'dirty.md' }],
      ['/project/saved.md', { absolute: '/project/saved.md', relative: 'saved.md' }],
    ]);
    const buffers = new Map([
      ['/project/dirty.md', { buffer: { path: 'dirty.md', format: 'text' as const, content: 'new unsaved text' }, relative: 'dirty.md' }],
    ]);
    const items = __codexInternals.buildContextInputItems('Analyse this', selected, buffers);
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ type: 'text' });
    expect(String(items[1].text)).toContain('UNTRUSTED PROJECT CONTENT');
    expect(String(items[1].text)).toContain('new unsaved text');
    expect(items).toContainEqual({ type: 'mention', name: 'saved.md', path: '/project/saved.md' });
    expect(items).not.toContainEqual({ type: 'mention', name: 'dirty.md', path: '/project/dirty.md' });
  });

  it('enforces per-buffer and aggregate context limits without truncating', () => {
    expect(() => __codexInternals.validateContextPayload(
      ['large.txt'],
      [{ path: 'large.txt', format: 'text', content: 'x'.repeat(512 * 1024 + 1) }],
    )).toThrow(/exceeds/i);
    const files = Array.from({ length: 5 }, (_, index) => `part-${index}.txt`);
    expect(() => __codexInternals.validateContextPayload(
      files,
      files.map((path) => ({ path, format: 'text', content: 'x'.repeat(450 * 1024) })),
    )).toThrow(/in total/i);
  });

  it('honours the local app-server contract through the injectable command resolver', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'research-ide-codex-contract-'));
    const projectRoot = path.join(base, 'project');
    const userData = path.join(base, 'user-data');
    const fakeServer = path.join(base, 'fake-app-server.cjs');
    const fakeServerPy = path.join(base, 'fake-app-server.py');
    const rpcLog = path.join(base, 'rpc.jsonl');
    await Promise.all([
      mkdir(projectRoot),
      mkdir(userData),
      writeFile(fakeServer, FAKE_APP_SERVER, 'utf8'),
      writeFile(fakeServerPy, FAKE_APP_SERVER_PY, 'utf8'),
    ]);
    const projects = {
      current: { id: 'project-1', name: 'contract', path: projectRoot, kind: 'blank' as const },
      guard: await ProjectPathGuard.create(projectRoot),
    } as ProjectService;
    let service: CodexService | undefined;
    try {
      await Promise.all([
        writeFile(path.join(projectRoot, 'dirty.md'), 'disk version', 'utf8'),
        writeFile(path.join(projectRoot, 'saved.md'), 'saved version', 'utf8'),
      ]);
      service = new CodexService(projects, userData, () => undefined, async () => undefined, {
        resolveCommand: () => process.platform === 'linux' && process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1'
          ? { executable: '/usr/bin/python3', prefixArgs: [fakeServerPy, rpcLog], detached: false }
          : { executable: process.execPath, prefixArgs: [fakeServer, rpcLog], detached: false },
      });
      const status = await service.start();
      expect(status).toMatchObject({
        server: 'ready', model: 'model-a', effort: 'medium', account: { state: 'signedIn' },
        capabilities: { conversations: 'available', modelSelection: 'available', autoReview: 'available', serverVersion: '0.999.0' },
      });
      expect(await service.listModels()).toHaveLength(1);
      expect(await service.listThreads()).toEqual([expect.objectContaining({ id: 'thread-1', title: 'Experiment review' })]);
      expect(await service.listThreads({ archived: true })).toEqual([expect.objectContaining({ id: 'thread-1', archived: true })]);
      await service.archiveThread('thread-archive');
      await service.unarchiveThread('thread-archive');
      await service.deleteThread('thread-delete');
      await expect(service.deleteThread('thread-mismatch')).rejects.toThrow(/current project/i);
      const readView = await service.readThread('thread-1');
      expect(readView.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'Earlier question' }),
        expect.objectContaining({ role: 'assistant', content: 'Earlier answer' }),
        expect.objectContaining({ role: 'user', content: 'Latest question' }),
        expect.objectContaining({ role: 'assistant', content: 'Latest answer' }),
      ]);
      expect(readView.history).toEqual({ truncated: false, loadedTurns: 2, maxTurns: 500 });
      const guardedView = await service.readThread('thread-loop');
      expect(guardedView.messages.map((message) => message.content)).toEqual(['Latest question', 'Latest answer']);
      expect(guardedView.history).toEqual({ truncated: true, loadedTurns: 1, maxTurns: 500, truncationReason: 'paginationGuard' });
      const resumedView = await service.resumeThread('thread-1');
      expect(resumedView.messages.map((message) => message.content)).toEqual([
        'Earlier question', 'Earlier answer', 'Latest question', 'Latest answer',
      ]);
      expect(resumedView.history).toEqual({ truncated: false, loadedTurns: 2, maxTurns: 500 });
      await service.updateSettings({ threadId: 'thread-1', model: 'model-a', effort: 'high' });
      await service.send({
        threadId: 'thread-1', prompt: 'Use the live draft', projectPath: projectRoot,
        contextFiles: ['dirty.md', 'saved.md'],
        contextBuffers: [{ path: 'dirty.md', format: 'text', content: 'live draft data:image/png;base64,QUJDRA==' }],
        mode: 'agent',
      });
      await expect(service.deleteThread('thread-1')).rejects.toThrow(/Stop the active Codex turn/i);
      await service.stop();

      const records = (await readFile(rpcLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { launchArgs?: string[]; rpc?: { method?: string; params?: Record<string, unknown> } });
      const methods = records.flatMap((record) => record.rpc?.method ? [record.rpc.method] : []);
      expect(methods).toEqual(expect.arrayContaining([
        'permissionProfile/list', 'model/list', 'config/read', 'configRequirements/read',
        'thread/list', 'thread/read', 'thread/turns/list', 'thread/resume', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/settings/update', 'turn/start',
      ]));
      expect(records.filter((record) => record.rpc?.method === 'thread/list').map((record) => record.rpc?.params))
        .toEqual(expect.arrayContaining([expect.objectContaining({ archived: false }), expect.objectContaining({ archived: true })]));
      expect(records.find((record) => record.rpc?.method === 'thread/archive')?.rpc?.params).toEqual({ threadId: 'thread-archive' });
      expect(records.find((record) => record.rpc?.method === 'thread/unarchive')?.rpc?.params).toEqual({ threadId: 'thread-archive' });
      expect(records.find((record) => record.rpc?.method === 'thread/delete')?.rpc?.params).toEqual({ threadId: 'thread-delete' });
      expect(records[0].launchArgs?.join(' ')).toContain('auto_review.policy=');
      const resumed = records.find((record) => record.rpc?.method === 'thread/resume')?.rpc?.params;
      expect(resumed).toMatchObject({ approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only', cwd: projects.guard.root });
      expect(resumed?.initialTurnsPage).toEqual({ limit: 50, sortDirection: 'desc', itemsView: 'full' });
      const historyRequests = records.filter((record) => record.rpc?.method === 'thread/turns/list').map((record) => record.rpc?.params);
      expect(historyRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: 'thread-1', limit: 50, sortDirection: 'desc', itemsView: 'full' }),
        expect.objectContaining({ threadId: 'thread-1', cursor: 'older-page', limit: 50, sortDirection: 'desc', itemsView: 'full' }),
      ]));
      expect(historyRequests.filter((params) => params?.threadId === 'thread-loop')).toHaveLength(2);
      const turn = [...records].reverse().find((record) => record.rpc?.method === 'turn/start')?.rpc?.params as { input?: Array<Record<string, unknown>> } | undefined;
      expect(turn).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', permissions: ':workspace', model: 'model-a', effort: 'high', cwd: projects.guard.root });
      expect(turn?.input?.some((item) => item.type === 'mention' && item.name === 'saved.md')).toBe(true);
      expect(turn?.input?.some((item) => item.type === 'mention' && item.name === 'dirty.md')).toBe(false);
      const unsaved = turn?.input?.find((item) => item.type === 'text' && String(item.text).includes('UNTRUSTED PROJECT CONTENT'));
      expect(String(unsaved?.text)).toContain('live draft');
      expect(String(unsaved?.text)).not.toContain('data:image');
    } catch (error) {
      const log = await readFile(rpcLog, 'utf8').catch(() => '<no fake-server log>');
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nFake app-server log:\n${log}`);
    } finally {
      await service?.stop().catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  }, 15_000);
});

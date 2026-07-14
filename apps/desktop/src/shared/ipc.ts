export const IPC = {
  app: {
    info: 'app:info', selectDirectory: 'app:select-directory', openExternal: 'app:open-external', revealPath: 'app:reveal-path',
  },
  project: {
    listRecent: 'project:list-recent', openDialog: 'project:open-dialog', open: 'project:open', create: 'project:create', close: 'project:close', tree: 'project:tree', changed: 'project:changed',
  },
  files: {
    readText: 'files:read-text', writeText: 'files:write-text', readBinary: 'files:read-binary', create: 'files:create', rename: 'files:rename', delete: 'files:delete', search: 'files:search',
  },
  documents: {
    read: 'documents:read', write: 'documents:write',
    readDocx: 'documents:read-docx', writeDocx: 'documents:write-docx',
    readDoc: 'documents:read-doc', writeDoc: 'documents:write-doc',
    libreOfficeStatus: 'documents:libreoffice-status', selectLibreOffice: 'documents:select-libreoffice', clearLibreOffice: 'documents:clear-libreoffice',
  },
  literature: {
    status: 'literature:status', list: 'literature:list', search: 'literature:search', create: 'literature:create', update: 'literature:update', delete: 'literature:delete', importFile: 'literature:import-file', openAttachment: 'literature:open-attachment', connectZotero: 'literature:connect-zotero', launchZotero: 'literature:launch-zotero',
  },
  toolchains: {
    list: 'toolchains:list', ensureDetected: 'toolchains:ensure-detected', detect: 'toolchains:detect', selectSystem: 'toolchains:select-system', selectExecutable: 'toolchains:select-executable', install: 'toolchains:install',
    managedCatalog: 'toolchains:managed-catalog', installManaged: 'toolchains:install-managed', selectManaged: 'toolchains:select-managed', removeManaged: 'toolchains:remove-managed', managedEvent: 'toolchains:managed-event',
    selectForProject: 'toolchains:select-project', run: 'toolchains:run', stop: 'toolchains:stop', event: 'toolchains:event',
  },
  latex: { detect: 'latex:detect', compile: 'latex:compile', readOutput: 'latex:read-output' },
  snapshots: { list: 'snapshots:list', create: 'snapshots:create', restore: 'snapshots:restore', delete: 'snapshots:delete' },
  codex: {
    status: 'codex:status', start: 'codex:start', signIn: 'codex:sign-in', signOut: 'codex:sign-out', send: 'codex:send', decideApproval: 'codex:decide-approval', cancelTurn: 'codex:cancel-turn', newThread: 'codex:new-thread', listThreads: 'codex:list-threads', readThread: 'codex:read-thread', resumeThread: 'codex:resume-thread', archiveThread: 'codex:archive-thread', unarchiveThread: 'codex:unarchive-thread', deleteThread: 'codex:delete-thread', listModels: 'codex:list-models', updateSettings: 'codex:update-settings', event: 'codex:event',
  },
  codexRuntime: {
    status: 'codex-runtime:status', catalog: 'codex-runtime:catalog', selectExecutable: 'codex-runtime:select-executable',
    install: 'codex-runtime:install', update: 'codex-runtime:update', clearSelection: 'codex-runtime:clear-selection', event: 'codex-runtime:event',
  },
  diagnostics: { list: 'diagnostics:list' },
} as const;

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiConfigStore, AiConsentStore } from '../../src/ai/config-store';
import { createTestEncryptor, KeyStore } from '../../src/ai/keys';
import { realProviderFactory } from '../../src/ai/providers/index';
import { AiService } from '../../src/ai/service';
import { createAgentRunner } from '../../src/ai/agent/runner';
import { createProjectPorts } from '../../src/ai/agent/ports';
import { appDataPath } from '../../src/main/app-data-layout';
import { AppLog } from '../../src/main/app-log';
import { ProjectService } from '../../src/workspace/project-service';
import type { AiEvent, AiProviderId, AiRequest } from '../../src/shared/ipc/ai-contract';

/**
 * S36.1 live smoke test (decision 0025): the real AiService and agent runner over the real provider SDKs, against
 * api.anthropic.com / api.openai.com with the owner's own key. Run with `npm run test:ai-live`; never part of
 * `npm test`, `verify` or CI. Each provider runs only when its key is set:
 *
 *   NOOBIDE_AI_LIVE_ANTHROPIC_KEY  — default models of decision 0025 (claude-opus-5-5, inline claude-haiku-5-5)
 *   NOOBIDE_AI_LIVE_OPENAI_KEY     — defaults picked from the account's model list (pickOpenAiDefaults)
 *
 * Per provider: key test, one chat answer, one inline completion, one inline edit and one agent turn that must end in a
 * file-change proposal (rejected here, so nothing is written). Cheap settings: low effort and small output budgets.
 * The outputs are printed so the owner can judge them; the key must not appear in any event or the app log.
 */
const KEYS: Readonly<Record<AiProviderId, string | undefined>> = {
  anthropic: process.env.NOOBIDE_AI_LIVE_ANTHROPIC_KEY?.trim() || undefined,
  openai: process.env.NOOBIDE_AI_LIVE_OPENAI_KEY?.trim() || undefined,
};

const OWNER = 1;
const INDEX =
  '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>My page</title>\n' +
  '  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello</h1>\n  <button id="go">Go</button>\n' +
  '  <script src="app.js"></script>\n</body>\n</html>\n';
const CSS = 'h1 {\n  color: red;\n}\n';
const JS = "const button = document.getElementById('go');\n";

function print(provider: AiProviderId, what: string, text: string): void {
  console.log(`\n===== [${provider}] ${what} =====\n${text}\n===== end ${what} =====`);
}

for (const provider of ['anthropic', 'openai'] as const) {
  const key = KEYS[provider];
  describe.skipIf(key === undefined)(`live ${provider}`, () => {
    let tmp: string;
    let userData: string;
    let projects: ProjectService;
    let projectId: string;
    let service: AiService;
    let appLog: AppLog;
    const allEvents: AiEvent[] = [];

    beforeAll(async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), `noobide-ai-live-${provider}-`));
      userData = path.join(tmp, 'userData');
      const root = path.join(tmp, '我的 网页');
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'index.html'), INDEX);
      await writeFile(path.join(root, 'style.css'), CSS);
      await writeFile(path.join(root, 'app.js'), JS);
      projects = new ProjectService();
      const opened = await projects.open(root);
      if (!opened.ok) throw new Error(opened.message);
      projectId = opened.value.projectId;
      appLog = new AppLog({ dir: appDataPath(userData, 'logs') });
      const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
        appLog.write('warn', event, fields);
      service = new AiService({
        // A temp app-data dir that is deleted afterwards; Electron's safeStorage does not exist outside Electron.
        keys: new KeyStore({ file: appDataPath(userData, 'aiKeys'), encryptor: createTestEncryptor(true), log }),
        config: new AiConfigStore({ file: appDataPath(userData, 'aiConfig'), log }),
        consent: new AiConsentStore({ file: appDataPath(userData, 'aiConsent'), log }),
        providers: realProviderFactory,
        rootOf: (id) => projects.rootOf(id),
        readFile: async (id, relPath) => {
          const read = await projects.read({ projectId: id, relPath });
          return read.ok ? read.value.text : null;
        },
        agentRunner: createAgentRunner({
          projectPorts: (id) => createProjectPorts({ projects, projectId: id }),
          budgets: { maxSteps: 10, maxTokens: 300_000, maxWallTimeMs: 4 * 60_000, maxOutputTokensPerStep: 8_000 },
        }),
        log: (level, event, fields) => appLog.write(level, event, fields),
        // Cheap settings: low effort everywhere, small output budgets.
        budgets: {
          chat: { maxOutputTokens: 2_000, timeoutMs: 120_000, effort: 'low' },
          edit: { maxOutputTokens: 2_000, timeoutMs: 120_000, effort: 'low' },
          inline: { maxOutputTokens: 128, timeoutMs: 30_000, effort: 'low' },
          agent: { maxOutputTokens: 8_000, timeoutMs: 240_000, effort: 'low' },
        },
      });
      expect(await service.setKey(provider, key!)).toEqual({ ok: true, value: null });
      expect(await service.setConsent(projectId, true)).toEqual({ ok: true, value: null });
    });

    afterAll(async () => {
      if (!tmp) return;
      // The key never appears in any event or in the app log.
      const logs = appDataPath(userData, 'logs');
      const names = await readdir(logs).catch(() => [] as string[]);
      const logText = (await Promise.all(names.map((n) => readFile(path.join(logs, n), 'utf8')))).join('\n');
      const keyMaterial = key!.slice(-24);
      expect(logText).not.toContain(keyMaterial);
      expect(JSON.stringify(allEvents)).not.toContain(keyMaterial);
      await rm(tmp, { recursive: true, force: true });
    });

    /** Starts a request and collects its events until the terminal one; `onEvent` may answer proposals. */
    async function run(request: AiRequest, onEvent?: (event: AiEvent) => void): Promise<AiEvent[]> {
      const events: AiEvent[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const started = await service.request(request, OWNER, (event) => {
        events.push(event);
        allEvents.push(event);
        onEvent?.(event);
        if (event.type === 'done' || event.type === 'error') finish();
      });
      if (!started.ok) throw new Error(`request refused: ${started.code}`);
      await finished;
      const error = events.find((e) => e.type === 'error');
      if (error?.type === 'error') throw new Error(`${request.kind} failed: ${error.code} ${error.message}`);
      return events;
    }

    const textOf = (events: readonly AiEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
    const usageOf = (events: readonly AiEvent[]) => {
      const done = events.find((e) => e.type === 'done');
      return done?.type === 'done' && done.usage
        ? `${done.usage.inputTokens} in / ${done.usage.outputTokens} out`
        : '?';
    };

    it('accepts the key (model list)', async () => {
      expect(await service.testKey(provider)).toEqual({ ok: true, value: null });
    });

    it('chat: answers a question about a file in context', async () => {
      const events = await run({
        kind: 'chat',
        projectId,
        history: [],
        prompt: 'In one or two sentences: what does this page show?',
        context: [{ kind: 'file', relPath: 'index.html' }],
        locale: 'en',
      });
      const text = textOf(events);
      print(provider, `chat (${usageOf(events)})`, text);
      expect(text.trim().length).toBeGreaterThan(10);
    });

    it('inline: completes code at the cursor', async () => {
      const events = await run({
        kind: 'inline',
        projectId,
        relPath: 'app.js',
        languageId: 'javascript',
        prefix: "const button = document.getElementById('go');\nbutton.addEventListener('click', () => {\n  ",
        suffix: '\n});\n',
      });
      const text = textOf(events);
      print(provider, `inline completion (${usageOf(events)})`, text);
      expect(events.some((e) => e.type === 'done')).toBe(true);
      expect(text.trim().length).toBeGreaterThan(0);
    });

    it('edit: rewrites a selection', async () => {
      const events = await run({
        kind: 'edit',
        projectId,
        relPath: 'style.css',
        languageId: 'css',
        instruction: 'make the heading blue',
        selection: CSS,
        before: '',
        after: '',
        locale: 'en',
      });
      const text = textOf(events);
      print(provider, `inline edit (${usageOf(events)})`, text);
      expect(text).toMatch(/blue|#00f|#0000ff|rgb\(\s*0\s*,\s*0\s*,\s*255/i);
    });

    it('agent: one turn ends in a file-change proposal', async () => {
      const proposals: Extract<AiEvent, { type: 'proposal' }>[] = [];
      const steps: string[] = [];
      const events = await run(
        {
          kind: 'agent',
          projectId,
          history: [],
          prompt: 'Add a short about.html page and a link to it from index.html. Keep it minimal.',
          context: [],
          locale: 'en',
        },
        (event) => {
          if (event.type === 'step') steps.push(`${event.tool}: ${event.summary}`);
          if (event.type === 'proposal') {
            proposals.push(event);
            // Rejected: the live test never writes into the project; the agent then ends its turn.
            service.resolveProposal(
              {
                requestId: event.requestId,
                proposalId: event.proposalId,
                results: event.changes.map(() => ({ accepted: false as const })),
              },
              OWNER,
            );
          }
        },
      );
      print(
        provider,
        `agent turn (${usageOf(events)})`,
        [
          `steps:\n  ${steps.join('\n  ') || '(none)'}`,
          ...proposals.map(
            (p) =>
              `proposal: ${p.reason}\n` +
              p.changes
                .map(
                  (c) =>
                    `  ${c.kind} ${c.relPath}${c.kind === 'rename' ? ` → ${c.to}` : ''}` +
                    (c.kind === 'create' || c.kind === 'edit' ? `\n${c.after.replace(/^/gm, '    | ')}` : ''),
                )
                .join('\n'),
          ),
          `final text:\n${textOf(events)}`,
        ].join('\n'),
      );
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0]!.changes.length).toBeGreaterThan(0);
      // Nothing was written: proposals were rejected.
      const entries = (await readdir(projects.rootOf(projectId)!)).filter((n) => !n.startsWith('.'));
      expect(entries.sort()).toEqual(['app.js', 'index.html', 'style.css']);
    });
  });
}

if (KEYS.anthropic === undefined && KEYS.openai === undefined) {
  console.log('test:ai-live skipped: set NOOBIDE_AI_LIVE_ANTHROPIC_KEY and/or NOOBIDE_AI_LIVE_OPENAI_KEY to run it.');
}

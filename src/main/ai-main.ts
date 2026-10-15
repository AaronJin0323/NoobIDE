import { readFileSync } from 'node:fs';
import type { IpcMain } from 'electron';
import { AiChatStore } from '../ai/chat-store';
import { AiConfigStore, AiConsentStore } from '../ai/config-store';
import { AiUsageStore } from '../ai/usage-store';
import {
  BUILTIN_FAKE_SCRIPT,
  createFakeProviders,
  parseFakeScript,
  withBuiltin,
  type FakeProviderHub,
} from '../ai/fake-provider';
import { createTestEncryptor, KeyStore, type KeyEncryptor } from '../ai/keys';
import { realProviderFactory } from '../ai/providers/index';
import { AiService, type AiLog, type AiServiceDeps } from '../ai/service';
import { createAgentRunner } from '../ai/agent/runner';
import { createProjectPorts, type ProjectPortsDeps } from '../ai/agent/ports';
import { ScriptedModel } from '../ai/agent/scripted-model';
import { fakeAgentScript } from '../ai/agent/fake-scripts';
import type { RecoveryLogger } from '../recovery/atomic-file';
import type { ProjectService } from '../workspace/project-service';
import { registerAiHistoryIpcHandlers } from './ai-history-ipc';
import { registerAiIpcHandlers } from './ai-ipc';
import type { RecentProjects } from './recent-projects';
import { appDataPath } from './app-data-layout';

/**
 * Wires the AI assistant into main (S31.3, decision 0025): key store (safeStorage), config and consent stores in app
 * data, the request service and its IPC handlers. With `NOOBIDE_AI_FAKE=<script.json>` (tests, e2e) the scripted
 * fake provider replaces both real providers and keys use a test encryptor, so tests never reach a provider or the
 * developer's keychain.
 */
export interface AiMainOptions {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly allowedOrigin: string;
  readonly userData: string;
  readonly projects: Pick<ProjectService, 'rootOf' | 'read' | 'listDir'>;
  /** S39.1: the recent-projects list, so removing an entry can offer to delete its saved chats. */
  readonly recent?: Pick<RecentProjects, 'rootOf'>;
  /** S34 agent tools: runtime problems (problemsBridge.capture) and the preview (PreviewManager). */
  readonly problems?: ProjectPortsDeps['problems'];
  readonly preview?: ProjectPortsDeps['preview'] & NonNullable<AiServiceDeps['preview']>;
  /** Electron safeStorage. */
  readonly safeStorage: KeyEncryptor;
  readonly logger: RecoveryLogger;
  readonly log: AiLog;
  /**
   * `app.isPackaged`. A packaged app never runs the fake provider or the test encryptor, whatever `fakeScript` says
   * (S36.1 security review): see {@link aiTestEnv}.
   */
  readonly isPackaged: boolean;
  /** process.env.NOOBIDE_AI_FAKE: '1' (built-in scenarios), a script as inline JSON, or a script file's path. */
  readonly fakeScript?: string | undefined;
  /** NOOBIDE_AI_FAKE_AGENT: the agent script the fake plays (src/ai/agent/fake-scripts.ts). */
  readonly fakeAgentScript?: string | undefined;
}

export interface AiTestEnv {
  readonly fakeScript: string | undefined;
  readonly fakeAgentScript: string | undefined;
  /** The variables were set but ignored because the app is packaged. */
  readonly ignored: boolean;
}

/**
 * The test-only AI switches from the environment (S36.1 security review, decision 0025). `NOOBIDE_AI_FAKE` /
 * `NOOBIDE_AI_FAKE_AGENT` replace the real providers with scripted ones and the OS keychain with a reversible test
 * encryptor, so they are honoured only in an unpackaged build (`npm start`, unit/integration tests and the Playwright
 * e2e suite, which launches .vite/build with the Electron binary). A packaged app ignores them: a user-level
 * environment variable must never make NoobIDE store a real key reversibly or answer with canned output.
 */
export function aiTestEnv(input: {
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): AiTestEnv {
  const fakeScript = input.env.NOOBIDE_AI_FAKE || undefined;
  const fakeAgentScript = input.env.NOOBIDE_AI_FAKE_AGENT || undefined;
  if (input.isPackaged) {
    return { fakeScript: undefined, fakeAgentScript: undefined, ignored: Boolean(fakeScript ?? fakeAgentScript) };
  }
  return { fakeScript, fakeAgentScript, ignored: false };
}

export interface AiMain {
  readonly service: AiService;
  /** S39: saved chats per project and token usage (app data). */
  readonly chats: AiChatStore;
  readonly usage: AiUsageStore;
  /** Only with NOOBIDE_AI_FAKE: what the fake provider received (e2e assertions). */
  readonly fake: FakeProviderHub | null;
}

/** Synchronous, so the handlers exist before the first window loads. */
export function setupAi(options: AiMainOptions): AiMain {
  let fake: FakeProviderHub | null = null;
  const {
    fakeScript,
    fakeAgentScript: fakeAgentScriptName,
    ignored,
  } = aiTestEnv({
    isPackaged: options.isPackaged,
    env: { NOOBIDE_AI_FAKE: options.fakeScript, NOOBIDE_AI_FAKE_AGENT: options.fakeAgentScript },
  });
  if (ignored) options.log('warn', 'ai-fake-ignored', { packaged: true });
  if (fakeScript) {
    try {
      fake = createFakeProviders(
        fakeScript === '1'
          ? BUILTIN_FAKE_SCRIPT
          : withBuiltin(
              parseFakeScript(
                JSON.parse(
                  // Inline JSON (e2e specs pass the script itself) or the path of a script file.
                  fakeScript.trimStart().startsWith('{') ? fakeScript : readFileSync(fakeScript, 'utf8'),
                ) as unknown,
              ),
            ),
      );
    } catch (e) {
      options.log('error', 'ai-fake-script-invalid', { reason: e instanceof Error ? e.name : 'unknown' });
      fake = createFakeProviders(parseFakeScript({}));
    }
  }
  const encryptor = fake ? createTestEncryptor(fake.script.secureStorage ?? true) : options.safeStorage;
  const { projects } = options;
  const chats = new AiChatStore({ dir: appDataPath(options.userData, 'aiChats'), log: options.logger });
  const usage = new AiUsageStore({ file: appDataPath(options.userData, 'aiUsage'), log: options.logger });
  const service = new AiService({
    keys: new KeyStore({ file: appDataPath(options.userData, 'aiKeys'), encryptor, log: options.logger }),
    config: new AiConfigStore({ file: appDataPath(options.userData, 'aiConfig'), log: options.logger }),
    consent: new AiConsentStore({ file: appDataPath(options.userData, 'aiConsent'), log: options.logger }),
    providers: fake ? fake.factory : realProviderFactory,
    rootOf: (projectId) => projects.rootOf(projectId),
    readFile: async (projectId, relPath) => {
      const read = await projects.read({ projectId, relPath });
      return read.ok ? read.value.text : null;
    },
    // S34: the agent loop over main's existing services (no new file-system path).
    agentRunner: createAgentRunner({
      projectPorts: (projectId, owner) =>
        createProjectPorts({
          projects,
          projectId,
          ...(owner !== undefined ? { owner } : {}),
          ...(options.problems ? { problems: options.problems } : {}),
          ...(options.preview ? { preview: options.preview } : {}),
        }),
    }),
    // Fake mode: agent requests play a scripted agent (one ScriptedModel per request).
    ...(fake ? { agentModel: () => new ScriptedModel(fakeAgentScript(fakeAgentScriptName)) } : {}),
    log: options.log,
    usage, // S39.2
    ...(options.preview ? { preview: options.preview } : {}), // S38.2: Preview chip snapshots
  });
  registerAiIpcHandlers(options.ipcMain, { allowedOrigin: options.allowedOrigin, service });
  registerAiHistoryIpcHandlers(options.ipcMain, {
    allowedOrigin: options.allowedOrigin,
    chats,
    usage,
    rootOf: (projectId) => projects.rootOf(projectId),
    recentRootOf: async (id) => options.recent?.rootOf(id),
  });
  return { service, chats, usage, fake };
}

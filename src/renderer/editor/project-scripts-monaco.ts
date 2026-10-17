import type { FileEntry } from '../../shared/ipc/contract';
import { monaco, languageDefaults } from './monaco-setup';
import { ProjectScripts } from './project-scripts';
import { projectScriptReadGate, registerProjectScripts, unregisterProjectScripts } from './project-scripts-registry';

/** S57: the open project's scripts (null without a project), for JavaScript navigation's file names. */
export { currentProjectScripts } from './project-scripts-registry';

/**
 * ProjectScripts (S18.4) bound to Monaco: models decide what is open, extra libs feed the JavaScript service. The
 * instance is registered and starts reading `files` before this returns, so no navigation can find it registered but
 * not yet indexing (S57.3).
 */
export function createProjectScripts(
  read: ProjectScriptsRead,
  files: readonly FileEntry[],
): { scripts: ProjectScripts; dispose(): void } {
  const scripts = new ProjectScripts({
    read: async (relPath) => {
      await projectScriptReadGate(); // e2e only: held reads stand for a slow disk
      return read(relPath);
    },
    hasModel: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)) !== null,
    libName: (uri) => monaco.Uri.parse(uri).toString(),
    setLibs: (libs) => {
      // Monaco fires onDidExtraLibsChange on a 0 ms timer and only then posts the libs to the worker (its listener
      // runs before this one, so when this resolves the post is already queued): resolve on that event.
      const taken = new Promise<void>((resolve) => {
        const subscription = languageDefaults.javascript.onDidExtraLibsChange(() => {
          subscription.dispose();
          resolve();
        });
      });
      languageDefaults.javascript.setExtraLibs([...libs]);
      return taken;
    },
  });
  registerProjectScripts(scripts);
  void scripts.open(files);
  const subscriptions = [
    monaco.editor.onDidCreateModel(() => scripts.modelsChanged()),
    // The model still exists while this event runs; decide after it is gone.
    monaco.editor.onWillDisposeModel((model) => {
      const uri = model.uri.toString();
      setTimeout(() => void scripts.modelClosed(uri), 0);
    }),
  ];
  return {
    scripts,
    dispose() {
      unregisterProjectScripts(scripts);
      for (const subscription of subscriptions) subscription.dispose();
      scripts.close();
    },
  };
}

export type ProjectScriptsRead = ConstructorParameters<typeof ProjectScripts>[0]['read'];

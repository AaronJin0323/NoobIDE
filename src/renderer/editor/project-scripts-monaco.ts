import { monaco, languageDefaults } from './monaco-setup';
import { ProjectScripts } from './project-scripts';

/** ProjectScripts (S18.4) bound to Monaco: models decide what is open, extra libs feed the JavaScript service. */
export function createProjectScripts(read: ProjectScriptsRead): { scripts: ProjectScripts; dispose(): void } {
  const scripts = new ProjectScripts({
    read,
    hasModel: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)) !== null,
    libName: (uri) => monaco.Uri.parse(uri).toString(),
    setLibs: (libs) => languageDefaults.javascript.setExtraLibs([...libs]),
  });
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
      for (const subscription of subscriptions) subscription.dispose();
      scripts.close();
    },
  };
}

export type ProjectScriptsRead = ConstructorParameters<typeof ProjectScripts>[0]['read'];

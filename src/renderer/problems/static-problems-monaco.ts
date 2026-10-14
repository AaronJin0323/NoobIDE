import { monaco } from '../editor/monaco-setup';
import type { StaticProblems } from './static-problems';

/**
 * S19.1: feeds Monaco's markers into StaticProblems. `relPathOf` maps a Monaco model URI string to the open project
 * file it belongs to (undefined for the sample, probes and anything else outside the project).
 */
export function watchMarkers(
  problems: StaticProblems,
  relPathOf: (monacoUri: string) => string | undefined,
): { refreshAll(): void; dispose(): void } {
  const refresh = (uri: monaco.Uri) => {
    const relPath = relPathOf(uri.toString());
    if (relPath) problems.update(relPath, monaco.editor.getModelMarkers({ resource: uri }));
  };
  const subscription = monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) refresh(uri);
  });
  const refreshAll = () => {
    for (const model of monaco.editor.getModels()) refresh(model.uri);
  };
  refreshAll();
  return { refreshAll, dispose: () => subscription.dispose() };
}

/** The Monaco form of a workbench URI (Monaco re-encodes `file:` URIs, e.g. `c%3A` for `C:`). */
export const monacoKey = (uri: string): string => monaco.Uri.parse(uri).toString();

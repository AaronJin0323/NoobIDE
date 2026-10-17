/**
 * JavaScript navigation through the JavaScript language service (S57): go to definition, find references and the
 * places a rename changes. The rules are in js-navigation.ts; this asks the service. Used by the workbench editor
 * and the capability probe, so the cases test exactly what F12 / Shift+F12 / F2 do.
 *
 * Monaco's own definition / reference / rename providers are switched off (language-config.ts): they only know open
 * files (a closed project script is an extra lib they cannot show), and Monaco's rename edits other files' models
 * behind the save pipeline's back.
 */
import { getJavaScriptWorker } from 'monaco-editor/languages/features/typescript/register';
import { monaco, languageDefaults } from './monaco-setup';
import { htmlRegionAt } from './completion-context';
import { currentProjectScripts } from './project-scripts-monaco';
import {
  hasWord,
  planRename,
  toLocations,
  type NavigationPaths,
  type NavLocation,
  type RenamePlan,
  type ServiceSpan,
} from './js-navigation';

export type Unsupported =
  /** The cursor is in an HTML page's inline `<script>`: the service never sees it (docs/capabilities.md). */
  | 'inline-script'
  /** Not a project `.js` / `.mjs` file. */
  | 'not-a-script';

export type NavigationResult =
  | { readonly kind: 'unsupported'; readonly reason: Unsupported }
  | { readonly kind: 'locations'; readonly locations: readonly NavLocation[] };

/** The text the service holds for a file name: the open model's, or the extra lib's. */
function serviceText(fileName: string): string | null {
  const model = monaco.editor.getModel(monaco.Uri.parse(fileName));
  if (model) return model.getValue();
  return languageDefaults.javascript.getExtraLibs()[fileName]?.content ?? null;
}

/** The open project's scripts (project-scripts.ts) as navigation paths. */
export function projectPaths(): NavigationPaths {
  const scripts = currentProjectScripts();
  return {
    relPathOf: (fileName) => scripts?.relPathOf(fileName) ?? null,
    textOf: serviceText,
    complete: () => scripts?.complete() ?? false,
  };
}

/** Paths for files under one URI folder (the capability probe's own files). */
export function folderPaths(folder: string): NavigationPaths {
  return {
    relPathOf: (fileName) => (fileName.startsWith(folder) ? decodeURIComponent(fileName.slice(folder.length)) : null),
    textOf: serviceText,
    complete: () => true,
  };
}

function unsupportedAt(model: monaco.editor.ITextModel, offset: number, paths: NavigationPaths): Unsupported | null {
  const language = model.getLanguageId();
  if (language === 'html')
    return htmlRegionAt(model.getValue(), offset) === 'script' ? 'inline-script' : 'not-a-script';
  if (language !== 'javascript' || paths.relPathOf(model.uri.toString()) === null) return 'not-a-script';
  return null;
}

async function service(model: monaco.editor.ITextModel) {
  const worker = await getJavaScriptWorker();
  return worker(model.uri);
}

type Query = 'definition' | 'references';

/** Where the name under the cursor is declared (definition) or every place it is used (references). */
export async function navigate(
  query: Query,
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  paths: NavigationPaths = projectPaths(),
): Promise<NavigationResult> {
  const offset = model.getOffsetAt(position);
  const unsupported = unsupportedAt(model, offset, paths);
  if (unsupported) return { kind: 'unsupported', reason: unsupported };
  const ts = await service(model);
  const fileName = model.uri.toString();
  const spans = (
    query === 'definition'
      ? await ts.getDefinitionAtPosition(fileName, offset)
      : await ts.getReferencesAtPosition(fileName, offset)
  ) as ServiceSpan[] | undefined;
  return { kind: 'locations', locations: toLocations(spans ?? [], paths) };
}

/** S57.2: the checked plan for renaming the name under the cursor to `newName` (refusals say why). */
export async function renamePlanAt(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  newName: string,
  htmlPages: readonly { readonly relPath: string; readonly text: string }[],
  paths: NavigationPaths = projectPaths(),
): Promise<RenamePlan> {
  const offset = model.getOffsetAt(position);
  if (unsupportedAt(model, offset, paths)) return { ok: false, reason: 'not-a-script' };
  const ts = await service(model);
  const fileName = model.uri.toString();
  const info = (await ts.getRenameInfo(fileName, offset, { allowRenameOfImportPath: false })) as {
    canRename: boolean;
    displayName?: string;
  };
  if (!info?.canRename) {
    // The service refuses names of its own libraries (console, document): say so rather than "nothing here".
    const definitions = ((await ts.getDefinitionAtPosition(fileName, offset)) ?? []) as ServiceSpan[];
    const builtIn = definitions.some((d) => !/^file:/i.test(d.fileName) || /\.d\.ts$/.test(d.fileName));
    return { ok: false, reason: builtIn ? 'built-in' : 'not-renamable' };
  }
  const locations = ((await ts.findRenameLocations(fileName, offset, false, false, true)) ?? []) as ServiceSpan[];
  return planRename({ info, locations, newName, paths, htmlPages, nameInUse: (name) => nameInUse(name, paths) });
}

/** Where a name is already used: the page's window (`name`, `status`, `location`…) or any project script. */
function nameInUse(name: string, paths: NavigationPaths): string | null {
  if (name in globalThis) return 'browser';
  const texts = new Map<string, string>();
  for (const [fileName, lib] of Object.entries(languageDefaults.javascript.getExtraLibs()))
    texts.set(fileName, lib.content);
  for (const model of monaco.editor.getModels()) {
    if (model.getLanguageId() === 'javascript') texts.set(model.uri.toString(), model.getValue());
  }
  for (const [fileName, text] of texts) {
    const relPath = paths.relPathOf(fileName);
    if (relPath !== null && hasWord(text, name)) return relPath;
  }
  return null;
}

/** The identifier under the cursor (for the rename box), or null. */
export function nameAt(model: monaco.editor.ITextModel, position: monaco.IPosition): string | null {
  return model.getWordAtPosition(position)?.word ?? null;
}

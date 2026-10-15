import nodePath from 'node:path';
import {
  MAX_TEXT_FILE_BYTES,
  isListedRelPath,
  isPortableRelPath,
  type DirListing,
  type FileContent,
  type ListDirError,
  type ReadFileError,
  type TreeEntry,
} from '../../shared/ipc/contract';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import type { PreviewLogEntry } from '../../shared/ipc/preview-contract';
import type { ProblemRecord } from '../../shared/problem';
import { checkFileName } from '../../shared/file-names';
import type { Result } from '../../shared/result';
import { normalizeRelPath } from '../../workspace/paths';
import { isIgnoredRelPath } from '../../workspace/ignore';
import type { AgentToolDefinition } from './model-port';

/**
 * The agent's tools (S34.1, decision 0025). Main process only.
 *
 * Read-only tools run immediately; proposal tools never touch the disk: they are checked here and turned into
 * {@link AiFileChange}s that the user reviews, and the workbench applies accepted ones through the save pipeline.
 *
 * File access goes ONLY through {@link AgentProjectPorts}, which main backs with the existing services
 * (ProjectService listDir/read: realpath containment, symbolic links and junctions that leave the project are never
 * followed; the problems bridge; the PreviewManager) — the agent adds no new file-system path. On top of that every
 * path the model names passes {@link checkAgentPath}: relative, no `..`, no drive/URL prefix, and never a hidden or
 * ignored entry (dotfiles such as `.env` or `.git`, NoobIDE's own `.noobide` folder, `node_modules`, temp files).
 */

export interface AgentProjectPorts {
  /** One folder of the project (ProjectService.listDir). `''` is the project root. */
  listDir(relPath: string): Promise<Result<DirListing, ListDirError>>;
  /** A text file (ProjectService.read: size cap, encoding detection, realpath containment). */
  readFile(relPath: string): Promise<Result<FileContent, ReadFileError>>;
  /** Current runtime problems of this project's preview (problems bridge). */
  problems(): readonly ProblemRecord[];
  /** Most recent console / network / page records of this project's preview, oldest first. */
  consoleEntries(): readonly PreviewLogEntry[];
  /** Reloads this project's running preview. */
  refreshPreview(): Promise<'refreshed' | 'not-running'>;
}

export const LIMITS = {
  /** Characters of one read_file answer; larger files are read in line ranges. */
  readChars: 40_000,
  listEntries: 400,
  listDepth: 6,
  searchFiles: 400,
  searchMatches: 80,
  searchLineChars: 200,
  searchQueryChars: 200,
  problems: 50,
  consoleEntries: 50,
  messageChars: 500,
  reasonChars: 300,
  pathChars: 1024,
} as const;

// ── tool definitions (stable order: prompt caching) ──

const pathProp = (description: string) => ({ type: 'string', minLength: 1, maxLength: LIMITS.pathChars, description });
const reasonProp = {
  type: 'string',
  minLength: 1,
  maxLength: LIMITS.reasonChars,
  description: 'One short sentence for a beginner: why this change helps. Shown above the diff.',
};
const object = (properties: Record<string, unknown>, required: readonly string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const READ_TOOLS = ['list_files', 'read_file', 'search_text', 'get_problems', 'get_console', 'refresh_preview'];
export const PROPOSAL_TOOLS = ['propose_edit', 'propose_create', 'propose_rename', 'propose_delete'];

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List the files and folders of the project. Call this first to see what the project contains, or to look inside one folder. Paths are relative to the project folder and use "/".',
    inputSchema: object(
      {
        path: {
          type: 'string',
          maxLength: LIMITS.pathChars,
          description: 'Folder to list; "" or omitted = project folder.',
        },
        recursive: { type: 'boolean', description: 'Also list sub-folders (bounded).' },
      },
      [],
    ),
  },
  {
    name: 'read_file',
    description:
      'Read a text file of the project. Call this before proposing an edit to a file, so the edit matches the current text exactly. Long files can be read in line ranges.',
    inputSchema: object(
      {
        path: pathProp('File to read, relative to the project folder.'),
        start_line: { type: 'integer', minimum: 1, description: 'First line (1-based), optional.' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line (inclusive), optional.' },
      },
      ['path'],
    ),
  },
  {
    name: 'search_text',
    description:
      'Find plain text (not a regular expression) in the project files, e.g. an id, a class name or a function name. Returns file:line matches.',
    inputSchema: object(
      {
        query: { type: 'string', minLength: 1, maxLength: LIMITS.searchQueryChars, description: 'Text to find.' },
        path: {
          type: 'string',
          maxLength: LIMITS.pathChars,
          description: 'Folder to search in; omitted = whole project.',
        },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
      },
      ['query'],
    ),
  },
  {
    name: 'get_problems',
    description:
      'Get the current errors and warnings of the running webpage preview (JavaScript errors, missing files, console errors). Call this when the user mentions something is broken.',
    inputSchema: object({}, []),
  },
  {
    name: 'get_console',
    description: 'Get the most recent console messages of the running webpage preview.',
    inputSchema: object(
      { limit: { type: 'integer', minimum: 1, maximum: LIMITS.consoleEntries, description: 'How many (default 30).' } },
      [],
    ),
  },
  {
    name: 'refresh_preview',
    description:
      'Reload the running webpage preview, e.g. after the user accepted a change, then check get_problems or get_console.',
    inputSchema: object({}, []),
  },
  {
    name: 'propose_edit',
    description:
      'Propose a change to an existing file. Nothing is written: the user sees the diff and accepts or rejects it, and you get the outcome as the result. Either give old_text (copied exactly from the current file, appearing exactly once) and new_text, or give content (the complete new file).',
    inputSchema: object(
      {
        path: pathProp('Existing file to change.'),
        old_text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_TEXT_FILE_BYTES,
          description: 'Exact text to replace.',
        },
        new_text: { type: 'string', maxLength: MAX_TEXT_FILE_BYTES, description: 'Replacement for old_text.' },
        content: { type: 'string', maxLength: MAX_TEXT_FILE_BYTES, description: 'The complete new file text.' },
        reason: reasonProp,
      },
      ['path', 'reason'],
    ),
  },
  {
    name: 'propose_create',
    description:
      'Propose a new file with its complete content (missing folders are created too). Nothing is written until the user accepts.',
    inputSchema: object(
      {
        path: pathProp('New file, relative to the project folder.'),
        content: { type: 'string', maxLength: MAX_TEXT_FILE_BYTES, description: 'The complete file text.' },
        reason: reasonProp,
      },
      ['path', 'content', 'reason'],
    ),
  },
  {
    name: 'propose_rename',
    description:
      'Propose renaming or moving a file or folder. Nothing changes until the user accepts. Links to it in other files are not updated: propose edits for those too.',
    inputSchema: object(
      {
        path: pathProp('Existing file or folder.'),
        new_path: pathProp('New path; nothing may exist there yet.'),
        reason: reasonProp,
      },
      ['path', 'new_path', 'reason'],
    ),
  },
  {
    name: 'propose_delete',
    description:
      'Propose moving a file to the system trash (recoverable). Only for files the user clearly no longer needs. Nothing changes until the user accepts.',
    inputSchema: object({ path: pathProp('Existing file.'), reason: reasonProp }, ['path', 'reason']),
  },
];

// ── path policy ──

export type PathCheck =
  { readonly ok: true; readonly relPath: string } | { readonly ok: false; readonly reason: string };

/**
 * Turns a path the model wrote into a project-relative portable path, or explains why it is refused. Pure: the ports
 * then realpath-check the real location (links that lead out of the project are refused there).
 */
export function checkAgentPath(
  input: string,
  options: { readonly allowRoot?: boolean; readonly newPath?: boolean } = {},
): PathCheck {
  const refused = (reason: string) => ({ ok: false, reason }) as const;
  if (input.length > LIMITS.pathChars) return refused('the path is too long');
  const trimmedRoot = input === '.' || input === './' ? '' : input;
  if (
    nodePath.isAbsolute(trimmedRoot) ||
    nodePath.posix.isAbsolute(trimmedRoot) ||
    nodePath.win32.isAbsolute(trimmedRoot)
  ) {
    return refused('only paths inside the project folder are allowed (use a relative path such as "index.html")');
  }
  const normal = normalizeRelPath(trimmedRoot);
  if (normal === null)
    return refused('only paths inside the project folder are allowed ("..", drive letters and URLs are not)');
  if (normal === '') return options.allowRoot ? { ok: true, relPath: '' } : refused('a file path is required');
  if (isIgnoredRelPath(normal)) {
    return refused(
      'hidden and ignored files (names starting with ".", .noobide, node_modules) are not available to the assistant',
    );
  }
  if (options.newPath) {
    const name = normal.slice(normal.lastIndexOf('/') + 1);
    if (
      !isPortableRelPath(normal) ||
      !normal.split('/').every((segment) => checkFileName(segment).ok) ||
      !checkFileName(name).ok
    ) {
      return refused(`"${normal}" is not a valid name on Windows and macOS`);
    }
  } else if (!isListedRelPath(normal)) {
    return refused('this path cannot be used');
  }
  return { ok: true, relPath: normal };
}

// ── shared helpers ──

export interface ToolOutcome {
  readonly content: string;
  readonly isError: boolean;
}

const fail = (content: string): ToolOutcome => ({ content, isError: true });
const done = (content: string): ToolOutcome => ({ content, isError: false });

const parentOf = (relPath: string) => (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '');
const nameOf = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1);

type EntryState = TreeEntry['kind'] | 'missing' | 'missing-parent' | 'outside' | 'unreadable';

/** What exists at a path, looked up in its parent's listing (so the name must match exactly). */
async function entryState(ports: AgentProjectPorts, relPath: string): Promise<EntryState> {
  const listing = await ports.listDir(parentOf(relPath));
  if (!listing.ok) {
    if (listing.code === 'not-found' || listing.code === 'not-a-directory') return 'missing-parent';
    return listing.code === 'outside-project' ? 'outside' : 'unreadable';
  }
  const entry = listing.value.entries.find((e) => e.name === nameOf(relPath));
  return entry ? entry.kind : 'missing';
}

/** For a new path: the nearest existing ancestor must be a real folder inside the project. */
async function creatableAt(ports: AgentProjectPorts, relPath: string): Promise<string | null> {
  let current = relPath;
  for (;;) {
    const state = await entryState(ports, current);
    if (state === 'outside') return 'that folder is a link that leads outside the project';
    if (state === 'unreadable') return 'that folder cannot be read';
    if (current === relPath) {
      if (state !== 'missing' && state !== 'missing-parent') return `"${relPath}" already exists`;
    } else if (state !== 'missing' && state !== 'missing-parent') {
      return state === 'directory' ? null : `"${current}" is not a folder`;
    }
    if (state === 'missing') return null; // its parent folder exists (listed)
    current = parentOf(current);
    if (current === '') return null;
  }
}

function readError(code: ReadFileError, relPath: string): string {
  switch (code) {
    case 'not-found':
      return `"${relPath}" does not exist`;
    case 'outside-project':
      return `"${relPath}" is outside the project (a link that leads out of the project folder is not followed)`;
    case 'not-a-file':
      return `"${relPath}" is a folder, not a file`;
    case 'too-large':
      return `"${relPath}" is larger than ${MAX_TEXT_FILE_BYTES} bytes`;
    case 'unsupported-encoding':
      return `"${relPath}" is not a UTF-8 text file`;
    default:
      return `"${relPath}" could not be read`;
  }
}

/**
 * Wraps project data in a frame with a per-run random marker, so text inside a file cannot fake the end of the data
 * and pose as instructions (the system prompt says framed content is data).
 */
export function frameData(nonce: string, attributes: string, body: string): string {
  const safe = body.split(`</data-${nonce}>`).join(`</data-${nonce}_>`);
  return `<data-${nonce} ${attributes}>\n${safe}\n</data-${nonce}>`;
}

const attr = (value: string) => JSON.stringify(value);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ── read-only tools ──

export interface ToolContext {
  readonly ports: AgentProjectPorts;
  /** Random per run (see frameData). */
  readonly nonce: string;
  readonly signal: AbortSignal;
}

export async function runReadTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'list_files':
      return listFiles(ctx, typeof input.path === 'string' ? input.path : '', input.recursive === true);
    case 'read_file':
      return readFileTool(
        ctx,
        input.path as string,
        input.start_line as number | undefined,
        input.end_line as number | undefined,
      );
    case 'search_text':
      return searchText(
        ctx,
        input.query as string,
        typeof input.path === 'string' ? input.path : '',
        input.case_sensitive === true,
      );
    case 'get_problems':
      return getProblems(ctx);
    case 'get_console':
      return getConsole(ctx, typeof input.limit === 'number' ? input.limit : 30);
    case 'refresh_preview':
      return (await ctx.ports.refreshPreview()) === 'refreshed'
        ? done('The preview is reloading. Check get_problems or get_console in a moment.')
        : fail('The preview is not running. Ask the user to start it with the Preview button.');
    default:
      return fail(`unknown tool "${name}"`);
  }
}

async function listFiles(ctx: ToolContext, path: string, recursive: boolean): Promise<ToolOutcome> {
  const checked = checkAgentPath(path, { allowRoot: true });
  if (!checked.ok) return fail(checked.reason);
  const lines: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    const listing = await ctx.ports.listDir(dir);
    if (!listing.ok) {
      if (listing.code === 'outside-project') return 'that folder is outside the project';
      if (listing.code === 'not-found' || listing.code === 'not-a-directory') return `"${dir}" is not a folder`;
      return `"${dir || '.'}" could not be listed`;
    }
    if (listing.value.truncated) truncated = true;
    for (const entry of listing.value.entries) {
      if (ctx.signal.aborted) return null;
      if (lines.length >= LIMITS.listEntries) {
        truncated = true;
        return null;
      }
      if (isIgnoredRelPath(entry.relPath)) continue;
      switch (entry.kind) {
        case 'directory':
          lines.push(`${entry.relPath}/`);
          if (recursive && depth < LIMITS.listDepth) await walk(entry.relPath, depth + 1);
          else if (recursive) truncated = true;
          break;
        case 'file':
          lines.push(entry.relPath);
          break;
        case 'link-outside':
          lines.push(`${entry.relPath} (link outside the project: not available)`);
          break;
        case 'link-broken':
          lines.push(`${entry.relPath} (broken link)`);
          break;
      }
    }
    return null;
  };
  const problem = await walk(checked.relPath, 0);
  if (problem) return fail(problem);
  const header = lines.length === 0 ? '(empty folder)' : lines.join('\n');
  return done(truncated ? `${header}\n(list shortened: list a sub-folder to see more)` : header);
}

async function readFileTool(ctx: ToolContext, path: string, start?: number, end?: number): Promise<ToolOutcome> {
  const checked = checkAgentPath(path);
  if (!checked.ok) return fail(checked.reason);
  const result = await ctx.ports.readFile(checked.relPath);
  if (!result.ok) return fail(readError(result.code, checked.relPath));
  const lines = result.value.text.split(/\r?\n/);
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? lines.length);
  if (from > lines.length || to < from) return fail(`the file has ${lines.length} lines`);
  // Whole lines up to the character limit (at least one line, itself cut if it alone is longer).
  let last = from - 1;
  let size = 0;
  while (last < to && (last === from - 1 || size + (lines[last] as string).length + 1 <= LIMITS.readChars)) {
    size += (lines[last] as string).length + 1;
    last += 1;
  }
  const body = clip(lines.slice(from - 1, last).join('\n'), LIMITS.readChars);
  const note =
    last < lines.length || from > 1
      ? `\n(lines ${from}–${last} of ${lines.length}; read other lines with start_line / end_line)`
      : '';
  const readOnly = result.value.readOnly ? ' read_only="true"' : '';
  return done(
    frameData(
      ctx.nonce,
      `path=${attr(checked.relPath)} lines="${from}-${last}" total_lines="${lines.length}"${readOnly}`,
      body,
    ) + note,
  );
}

async function searchText(ctx: ToolContext, query: string, path: string, caseSensitive: boolean): Promise<ToolOutcome> {
  const checked = checkAgentPath(path, { allowRoot: true });
  if (!checked.ok) return fail(checked.reason);
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: string[] = [];
  let files = 0;
  let truncated = false;
  const queue = [checked.relPath];
  while (queue.length > 0 && !ctx.signal.aborted) {
    const dir = queue.shift() as string;
    const listing = await ctx.ports.listDir(dir);
    if (!listing.ok) {
      if (dir === checked.relPath) return fail(`"${dir || '.'}" could not be searched`);
      continue;
    }
    for (const entry of listing.value.entries) {
      if (isIgnoredRelPath(entry.relPath)) continue;
      if (entry.kind === 'directory') {
        queue.push(entry.relPath);
        continue;
      }
      if (entry.kind !== 'file') continue;
      if (files >= LIMITS.searchFiles || matches.length >= LIMITS.searchMatches) {
        truncated = true;
        break;
      }
      files += 1;
      const read = await ctx.ports.readFile(entry.relPath);
      if (!read.ok || read.value.readOnly) continue; // binary, other encodings, too large
      const lines = read.value.text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < LIMITS.searchMatches; i += 1) {
        const line = lines[i] as string;
        if ((caseSensitive ? line : line.toLowerCase()).includes(needle)) {
          matches.push(`${entry.relPath}:${i + 1}: ${clip(line.trim(), LIMITS.searchLineChars)}`);
        }
      }
    }
  }
  if (matches.length === 0) return done(`No matches for ${attr(query)}.`);
  const body = frameData(ctx.nonce, `search=${attr(query)}`, matches.join('\n'));
  return done(truncated ? `${body}\n(more matches not shown: search a sub-folder or a longer text)` : body);
}

function getProblems(ctx: ToolContext): ToolOutcome {
  const records = ctx.ports.problems().slice(0, LIMITS.problems);
  if (records.length === 0) return done('No problems are reported by the preview right now.');
  const lines = records.map((r) => {
    const where = r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : 'unknown location';
    const stale = r.stale ? ' (before the last refresh)' : '';
    return `${r.severity} ${r.code} at ${where}${stale}${r.count > 1 ? ` ×${r.count}` : ''}: ${clip(r.originalMessage, LIMITS.messageChars)}`;
  });
  return done(frameData(ctx.nonce, 'kind="problems"', lines.join('\n')));
}

function getConsole(ctx: ToolContext, limit: number): ToolOutcome {
  const entries = ctx.ports.consoleEntries();
  const recent = entries.slice(Math.max(0, entries.length - Math.min(limit, LIMITS.consoleEntries)));
  if (recent.length === 0) return done('The preview console is empty (or the preview is not running).');
  const lines = recent.map((e) => {
    const where = e.url ? ` (${clip(e.url, 200)}${e.line ? `:${e.line}` : ''})` : '';
    return `[${e.level}] ${e.source}${where}: ${clip(e.message, LIMITS.messageChars)}`;
  });
  return done(frameData(ctx.nonce, 'kind="console"', lines.join('\n')));
}

// ── proposal tools ──

export type ProposalCheck =
  | { readonly ok: true; readonly change: AiFileChange; readonly reason: string }
  | { readonly ok: false; readonly error: string };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) count += 1;
  return count;
}

/** The text with the file's line ending (a model usually writes "\n"). */
const withEol = (text: string, eol: '\n' | '\r\n') => (eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text);

/** Checks a proposal tool call and builds the change the user will review. Reads the current text as `before`. */
export async function checkProposal(
  name: string,
  input: Record<string, unknown>,
  ports: AgentProjectPorts,
): Promise<ProposalCheck> {
  const reason = clip(String(input.reason ?? '').trim(), LIMITS.reasonChars);
  const refuse = (error: string): ProposalCheck => ({ ok: false, error });
  switch (name) {
    case 'propose_edit': {
      const checked = checkAgentPath(input.path as string);
      if (!checked.ok) return refuse(checked.reason);
      const current = await ports.readFile(checked.relPath);
      if (!current.ok) return refuse(readError(current.code, checked.relPath));
      if (current.value.readOnly) return refuse(`"${checked.relPath}" is not UTF-8 text, so it cannot be edited here`);
      const before = current.value.text;
      let after: string;
      const hasReplace = typeof input.old_text === 'string' || typeof input.new_text === 'string';
      if (typeof input.content === 'string') {
        if (hasReplace) return refuse('give either content, or old_text with new_text — not both');
        after = withEol(input.content, current.value.eol);
      } else if (typeof input.old_text === 'string' && typeof input.new_text === 'string') {
        let oldText = input.old_text;
        let newText = input.new_text;
        if (countOccurrences(before, oldText) === 0 && current.value.eol === '\r\n') {
          oldText = withEol(oldText, '\r\n');
          newText = withEol(newText, '\r\n');
        }
        const count = countOccurrences(before, oldText);
        if (count === 0)
          return refuse('old_text was not found in the current file; read the file again and copy the text exactly');
        if (count > 1)
          return refuse(`old_text appears ${count} times; include more surrounding lines so it appears once`);
        const at = before.indexOf(oldText);
        after = before.slice(0, at) + newText + before.slice(at + oldText.length);
      } else {
        return refuse('give old_text and new_text, or content');
      }
      if (after === before) return refuse('this edit would not change the file');
      if (byteLength(after) > MAX_TEXT_FILE_BYTES) return refuse('the new text is too large');
      return { ok: true, reason, change: { kind: 'edit', relPath: checked.relPath, before, after } };
    }
    case 'propose_create': {
      const checked = checkAgentPath(input.path as string, { newPath: true });
      if (!checked.ok) return refuse(checked.reason);
      const problem = await creatableAt(ports, checked.relPath);
      if (problem) return refuse(problem);
      const after = input.content as string;
      if (byteLength(after) > MAX_TEXT_FILE_BYTES) return refuse('the file text is too large');
      return { ok: true, reason, change: { kind: 'create', relPath: checked.relPath, after } };
    }
    case 'propose_rename': {
      const from = checkAgentPath(input.path as string);
      if (!from.ok) return refuse(from.reason);
      const to = checkAgentPath(input.new_path as string, { newPath: true });
      if (!to.ok) return refuse(to.reason);
      if (from.relPath === to.relPath) return refuse('the new path is the same as the old one');
      if (to.relPath.startsWith(`${from.relPath}/`)) return refuse('a folder cannot be moved into itself');
      const state = await entryState(ports, from.relPath);
      if (state !== 'file' && state !== 'directory')
        return refuse(`"${from.relPath}" is not a file or folder of the project`);
      const target = await entryState(ports, to.relPath);
      if (target === 'missing-parent') return refuse(`the folder of "${to.relPath}" does not exist`);
      if (target !== 'missing')
        return refuse(target === 'outside' ? 'that folder is outside the project' : `"${to.relPath}" already exists`);
      return { ok: true, reason, change: { kind: 'rename', relPath: from.relPath, to: to.relPath } };
    }
    case 'propose_delete': {
      const checked = checkAgentPath(input.path as string);
      if (!checked.ok) return refuse(checked.reason);
      const state = await entryState(ports, checked.relPath);
      if (state === 'directory') return refuse('only single files can be proposed for deletion');
      if (state !== 'file') return refuse(`"${checked.relPath}" is not a file of the project`);
      return { ok: true, reason, change: { kind: 'delete', relPath: checked.relPath } };
    }
    default:
      return refuse(`unknown tool "${name}"`);
  }
}

/** Paths a change touches (one change per path per step: a second edit would be based on stale text). */
export function touchedPaths(change: AiFileChange): string[] {
  return change.kind === 'rename' ? [change.relPath, change.to] : [change.relPath];
}

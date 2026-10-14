#!/usr/bin/env node
// NoobIDE harness CLI — cross-platform (Windows/macOS), no dependencies.
//
//   node harness/session.mjs start              orientation at the beginning of a session
//   node harness/session.mjs status             progress per milestone
//   node harness/session.mjs next [--all]       features that are ready to work on
//   node harness/session.mjs show <id>          details of a feature (S07.2), session (S07) or milestone (M2)
//   node harness/session.mjs set <id> <status> [--evidence "..."] [--owner]
//   node harness/session.mjs check              validate features.json (also run by `npm run verify`)
//
// Agents must change feature status through `set`, never by hand-editing features.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FEATURES = path.join(HERE, 'features.json');
const PROGRESS = path.join(HERE, 'PROGRESS.md');
const FEATURES_REL = 'harness/features.json';

const SATISFIED = new Set(['done', 'needs_manual_check', 'superseded']);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);

function load() {
  return JSON.parse(readFileSync(FEATURES, 'utf8'));
}
function save(data) {
  writeFileSync(FEATURES, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function index(data) {
  const byId = new Map(data.features.map((f) => [f.id, f]));
  const bySession = new Map();
  for (const f of data.features) {
    if (!bySession.has(f.session)) bySession.set(f.session, []);
    bySession.get(f.session).push(f);
  }
  return { byId, bySession };
}

function sessionComplete(data, idx, sid) {
  const feats = (idx.bySession.get(sid) ?? []).filter((f) => f.verify !== 'human');
  return feats.length > 0 && feats.every((f) => SATISFIED.has(f.status));
}

function readyFeatures(data, idx) {
  const sessionOk = new Map(data.sessions.map((s) => [s.id, s.depends_on.every((d) => sessionComplete(data, idx, d))]));
  return data.features.filter((f) => {
    if (f.status !== 'todo' && f.status !== 'in_progress') return false;
    if (f.session !== 'H' && !sessionOk.get(f.session)) return false;
    return f.depends_on.every((d) => SATISFIED.has(idx.byId.get(d)?.status));
  });
}

function currentSession(data, idx) {
  // first session (in roadmap order) that is not complete and whose session deps are complete
  for (const s of data.sessions) {
    if (sessionComplete(data, idx, s.id)) continue;
    if (s.depends_on.every((d) => sessionComplete(data, idx, d))) return s;
  }
  return null;
}

function bar(done, total, width = 20) {
  const n = total ? Math.round((done / total) * width) : 0;
  return '█'.repeat(n) + '░'.repeat(width - n);
}

// ---------------------------------------------------------------- validation
function validate(data) {
  const errors = [];
  const warnings = [];
  const statuses = new Set(data.statuses);
  const kinds = new Set(Object.keys(data.verify_kinds));
  const milestones = new Set(data.milestones.map((m) => m.id));
  const sessions = new Set(data.sessions.map((s) => s.id));
  const ids = new Set();
  for (const s of data.sessions) {
    if (!milestones.has(s.milestone)) errors.push(`session ${s.id}: unknown milestone ${s.milestone}`);
    for (const d of s.depends_on) if (!sessions.has(d)) errors.push(`session ${s.id}: unknown session dependency ${d}`);
  }
  for (const f of data.features) {
    const where = `feature ${f.id ?? '(no id)'}`;
    for (const k of [
      'id',
      'session',
      'milestone',
      'title',
      'acceptance',
      'verify',
      'depends_on',
      'status',
      'evidence',
    ]) {
      if (!(k in f)) errors.push(`${where}: missing field "${k}"`);
    }
    if (ids.has(f.id)) errors.push(`${where}: duplicate id`);
    ids.add(f.id);
    if (!statuses.has(f.status)) errors.push(`${where}: invalid status "${f.status}"`);
    if (!kinds.has(f.verify)) errors.push(`${where}: invalid verify kind "${f.verify}"`);
    if (f.session !== 'H' && !sessions.has(f.session)) errors.push(`${where}: unknown session ${f.session}`);
    if (!milestones.has(f.milestone)) errors.push(`${where}: unknown milestone ${f.milestone}`);
    if (!Array.isArray(f.acceptance) || f.acceptance.length === 0)
      errors.push(`${where}: acceptance must be a non-empty array`);
    if (f.status === 'done' && !String(f.evidence ?? '').trim()) errors.push(`${where}: done without evidence`);
    if (f.status === 'superseded' && !f.superseded_by) errors.push(`${where}: superseded without "superseded_by"`);
  }
  const byId = new Map(data.features.map((f) => [f.id, f]));
  for (const f of data.features) {
    for (const d of f.depends_on ?? []) {
      const dep = byId.get(d);
      if (!dep) errors.push(`feature ${f.id}: unknown dependency ${d}`);
      else if (f.status === 'done' && !SATISFIED.has(dep.status))
        errors.push(`feature ${f.id}: done but dependency ${d} is ${dep.status}`);
    }
    if (f.superseded_by && !byId.has(f.superseded_by))
      errors.push(`feature ${f.id}: superseded_by unknown id ${f.superseded_by}`);
  }
  // cycle detection
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`dependency cycle: ${[...trail, id].join(' → ')}`);
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id)?.depends_on ?? []) if (byId.has(d)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);

  // tamper guard against the last commit: features may be added, never removed or weakened
  const head = git(['show', `HEAD:${FEATURES_REL}`]);
  if (head) {
    try {
      const prev = JSON.parse(head);
      for (const p of prev.features) {
        const cur = byId.get(p.id);
        if (!cur) {
          errors.push(`feature ${p.id} was removed (exists in HEAD). Mark it "superseded" with superseded_by instead.`);
          continue;
        }
        if (cur.status !== 'superseded' && cur.acceptance.length < p.acceptance.length) {
          errors.push(
            `feature ${p.id}: acceptance criteria were removed. Add criteria or supersede the feature; never weaken it.`,
          );
        } else if (cur.status !== 'superseded' && JSON.stringify(cur.acceptance) !== JSON.stringify(p.acceptance)) {
          warnings.push(
            `feature ${p.id}: acceptance text changed since HEAD — make sure it was refined, not weakened.`,
          );
        }
        if (p.verify !== cur.verify) warnings.push(`feature ${p.id}: verify kind changed ${p.verify} → ${cur.verify}`);
      }
    } catch {
      warnings.push('could not parse features.json from HEAD; tamper guard skipped');
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- commands
function cmdCheck() {
  const data = load();
  const { errors, warnings } = validate(data);
  for (const w of warnings) console.log(yellow('warn  ') + w);
  for (const e of errors) console.log(red('error ') + e);
  if (errors.length) {
    console.log(red(`features.json: ${errors.length} error(s)`));
    process.exit(1);
  }
  console.log(green(`features.json OK`) + dim(` — ${data.features.length} features, ${data.sessions.length} sessions`));
}

function cmdStatus() {
  const data = load();
  const idx = index(data);
  console.log(bold('Milestone progress') + dim('  (done + needs_manual_check / total, owner tasks excluded)'));
  for (const m of data.milestones) {
    const fs = data.features.filter((f) => f.milestone === m.id && f.verify !== 'human');
    const ok = fs.filter((f) => SATISFIED.has(f.status)).length;
    const manual = fs.filter((f) => f.status === 'needs_manual_check').length;
    const blocked = fs.filter((f) => f.status === 'blocked').length;
    const extra = [manual && yellow(`${manual} manual check`), blocked && red(`${blocked} blocked`)]
      .filter(Boolean)
      .join(', ');
    if (!fs.length) {
      console.log(`  ${m.id} ${dim('owner-led (see owner tasks)'.padEnd(28))} ${m.title}`);
      continue;
    }
    console.log(
      `  ${m.id} ${bar(ok, fs.length)} ${String(ok).padStart(3)}/${String(fs.length).padEnd(3)} ${m.title}${extra ? '  ' + extra : ''}`,
    );
  }
  const human = data.features.filter((f) => f.verify === 'human');
  const hOpen = human.filter((f) => f.status !== 'done');
  console.log(`\n${bold('Owner tasks')} ${human.length - hOpen.length}/${human.length} done`);
  for (const f of hOpen) console.log(`  ${f.id.padEnd(6)} ${f.title}`);
  const cur = currentSession(data, idx);
  console.log(
    `\n${bold('Current session')}: ${cur ? `${cur.id} — ${cur.title}` : 'none (all sessions complete or blocked)'}`,
  );
}

function printFeature(f, idx, verbose = false) {
  const st = { done: green, needs_manual_check: yellow, blocked: red, in_progress: yellow }[f.status] ?? ((s) => s);
  console.log(`  ${bold(f.id.padEnd(7))} ${st(f.status.padEnd(18))} ${dim(f.verify.padEnd(11))} ${f.title}`);
  if (verbose) {
    if (f.description) console.log(`           ${dim(f.description)}`);
    for (const a of f.acceptance) console.log(`           • ${a}`);
    if (f.depends_on.length) {
      const deps = f.depends_on.map((d) => `${d}(${idx.byId.get(d)?.status ?? '?'})`).join(', ');
      console.log(`           ${dim('depends on: ' + deps)}`);
    }
    if (f.evidence) console.log(`           ${dim('evidence: ' + f.evidence)}`);
  }
}

function cmdNext(all) {
  const data = load();
  const idx = index(data);
  const ready = readyFeatures(data, idx);
  const cur = currentSession(data, idx);
  const list = all || !cur ? ready : ready.filter((f) => f.session === cur.id);
  if (cur)
    console.log(`${bold('Session ' + cur.id)} — ${cur.title}\n  ${dim(cur.goal)}\n  ${dim('PLAN: ' + cur.plan_refs)}`);
  console.log(bold(all ? '\nAll ready features:' : '\nReady in this session:'));
  if (!list.length) console.log('  (none — check blocked features or owner tasks with `status`)');
  for (const f of list) printFeature(f, idx, true);
  const humanReady = ready.filter((f) => f.verify === 'human' && !list.includes(f));
  if (humanReady.length) {
    console.log(bold('\nOwner tasks that are unblocked:'));
    for (const f of humanReady) printFeature(f, idx);
  }
}

function cmdShow(id) {
  const data = load();
  const idx = index(data);
  const m = data.milestones.find((x) => x.id === id);
  if (m) {
    console.log(`${bold(m.id)} ${m.title}  ${dim('PLAN ' + m.plan_refs)}\nExit criteria:`);
    for (const e of m.exit_criteria) console.log(`  • ${e}`);
    for (const s of data.sessions.filter((x) => x.milestone === id)) console.log(`  ${s.id} ${s.title}`);
    return;
  }
  const s = data.sessions.find((x) => x.id === id);
  if (s) {
    console.log(
      `${bold(s.id)} ${s.title} (${s.milestone})\n  ${s.goal}\n  ${dim('depends on: ' + (s.depends_on.join(', ') || '—') + '   PLAN: ' + s.plan_refs)}`,
    );
    for (const f of idx.bySession.get(id) ?? []) printFeature(f, idx, true);
    return;
  }
  const f = idx.byId.get(id);
  if (!f) {
    console.error(red(`unknown id ${id}`));
    process.exit(1);
  }
  printFeature(f, idx, true);
}

function cmdSet(id, status, opts) {
  const data = load();
  const idx = index(data);
  const f = idx.byId.get(id);
  if (!f) {
    console.error(red(`unknown feature ${id}`));
    process.exit(1);
  }
  if (!data.statuses.includes(status)) {
    console.error(red(`invalid status "${status}". One of: ${data.statuses.join(', ')}`));
    process.exit(1);
  }
  if (f.verify === 'human' && status === 'done' && !opts.owner) {
    console.error(red(`${id} is an owner task. Only the project owner closes it (pass --owner when they confirm).`));
    process.exit(1);
  }
  if (status === 'done') {
    if (!opts.evidence && !f.evidence) {
      console.error(red('done requires --evidence "<test names / command output / commit / manual note>"'));
      process.exit(1);
    }
    const open = f.depends_on.filter((d) => !SATISFIED.has(idx.byId.get(d)?.status));
    if (open.length) {
      console.error(red(`cannot mark done: dependencies not satisfied: ${open.join(', ')}`));
      process.exit(1);
    }
    if ((f.verify === 'manual-mac' || f.verify === 'manual-win') && !opts.evidence) {
      console.error(
        red(`${f.verify} needs fresh --evidence from a run on that platform; otherwise use needs_manual_check`),
      );
      process.exit(1);
    }
  }
  if (status === 'superseded' && !opts.supersededBy) {
    console.error(red('superseded requires --by <new feature id>'));
    process.exit(1);
  }
  f.status = status;
  if (opts.evidence) f.evidence = opts.evidence;
  if (opts.supersededBy) f.superseded_by = opts.supersededBy;
  const { errors } = validate(data);
  if (errors.length) {
    for (const e of errors) console.error(red('error ') + e);
    console.error(red('not saved'));
    process.exit(1);
  }
  save(data);
  console.log(`${green('saved')} ${id} → ${status}`);
}

function lastProgressEntry() {
  if (!existsSync(PROGRESS)) return null;
  const text = readFileSync(PROGRESS, 'utf8');
  const parts = text.split(/^## /m);
  const entry = parts.find((p, i) => i > 0 && /^Session/.test(p));
  return entry ? '## ' + entry.trim() : null;
}

function cmdStart() {
  console.log(bold('━━ NoobIDE session start ━━'));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(
    `node ${process.version}${nodeMajor < 22 ? red('  (need ≥ 22.12 — see README)') : ''}  platform ${process.platform}/${process.arch}`,
  );
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (!inside) {
    console.log(yellow('git: not a repository yet → run `git init`, then commit (feature S00.2).'));
  } else {
    const branch = git(['branch', '--show-current'])?.trim();
    const dirty = git(['status', '--porcelain'])?.trim();
    const log = git(['log', '--oneline', '-5'])?.trim();
    console.log(`git: branch ${branch || '(none)'}, ${dirty ? yellow('uncommitted changes present') : 'clean'}`);
    if (log)
      console.log(
        dim(
          log
            .split('\n')
            .map((l) => '  ' + l)
            .join('\n'),
        ),
      );
  }
  if (!existsSync(path.join(ROOT, 'node_modules'))) console.log(yellow('node_modules missing → run `npm install`.'));
  console.log('');
  cmdCheck();
  console.log('');
  const entry = lastProgressEntry();
  if (entry) {
    console.log(bold('Last progress entry:'));
    console.log(dim(entry.split('\n').slice(0, 25).join('\n')));
    console.log('');
  }
  cmdStatus();
  console.log('');
  cmdNext(false);
  console.log(
    `\n${bold('Protocol')}: run ${bold('npm run verify')} before changing anything → one feature at a time → ` +
      `\`set <id> done --evidence\` → append to harness/PROGRESS.md → commit. See AGENTS.md.`,
  );
}

// ---------------------------------------------------------------- main
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
switch (cmd) {
  case 'start':
    cmdStart();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'next':
    cmdNext(rest.includes('--all'));
    break;
  case 'show':
    if (!rest[0]) throw new Error('usage: show <id>');
    cmdShow(rest[0]);
    break;
  case 'set':
    if (!rest[0] || !rest[1]) throw new Error('usage: set <id> <status> [--evidence "..."] [--by <id>] [--owner]');
    cmdSet(rest[0], rest[1], {
      evidence: flag('--evidence'),
      supersededBy: flag('--by'),
      owner: rest.includes('--owner'),
    });
    break;
  case 'check':
    cmdCheck();
    break;
  default:
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 11)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    process.exit(cmd ? 1 : 0);
}

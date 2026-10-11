// GET /api/mindmaps?project=<name>[&id=<map_id>] source.
//
// Reads the mind maps `.claude/forge-bin/forge-mindmap.cjs` writes per project into
// `<project>/.claude/forge-mindmaps/<map_id>.json` — the replacement for the retired Control Center's
// radial "MIND MAP" lens (removed with the rest of that dashboard in, commit 1b6bb9d). Read-only:
// this module never writes, never creates the folder and never reads the `.mmd`/`.md` sidecars or
// `index.jsonl` (the JSON file is the one source of truth; index.jsonl is append-only history and can
// hold rows for maps that were later overwritten).
//
// SECURITY (the route is per-project and reachable from the browser):
//   - the project path comes ONLY from server.mjs's resolveProjectByName() (registry allowlist);
//   - a map id must match SAFE_MAP_ID_RE (forge-store's own isValidId shape, bounded length): no '.',
//     no separators, so `../` can never reach a path;
//   - the folder and the file are lstat'ed: a symlink/junction (either the folder or a map file) is
//     refused, and the realpath of the file must still sit inside the realpath of the project — so a
//     link planted inside the project can never make this route read another project or ~/.claude;
//   - every file is size-capped before it is parsed, the listing is entry-capped (readDirBounded), and
//     node/edge counts are capped, so a huge or hostile file cannot stall the single-threaded gateway;
//   - every string that reaches the response is redacted (the generator already redacts on write — this
//     is defense in depth for a hand-edited file).
import fs from 'node:fs';
import path from 'node:path';

import { readDirBounded } from './bounded-readdir.mjs';
import { containmentOk } from './security.mjs';
import { redact } from './redact.mjs';

export const SAFE_MAP_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_MAP_BYTES = 512 * 1024;
export const MAX_LISTED_MAPS = 200;
export const MAX_NODES = 1500;
export const MAX_EDGES = 3000;
const MAX_DIR_ENTRIES = 1000;
const MAX_LABEL_CHARS = 200;
const NODE_KINDS = new Set(['root', 'branch', 'leaf']);

export function safeMapIdOk(id) {
  return typeof id === 'string' && SAFE_MAP_ID_RE.test(id);
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/** The project's mind-map folder, or a reason it cannot be used. Never follows a link. */
function resolveMapsDir(projectPath) {
  const dir = path.join(projectPath, '.claude', 'forge-mindmaps');
  let st;
  try { st = fs.lstatSync(dir); } catch { return { dir, state: 'absent' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { dir, state: 'refused' };
  const realProject = realpathOrNull(projectPath);
  const realDir = realpathOrNull(dir);
  if (!realProject || !realDir || !containmentOk(realProject, realDir)) return { dir, state: 'refused' };
  return { dir, realDir, state: 'ok' };
}

function cleanText(value, fallback) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS - 1) + '…' : s;
  const out = redact(trimmed);
  return out.length ? out : fallback;
}

/** normalizeMap(raw, id) -> a clean {map_id,title,nodes,edges,generated_at,...} — never throws.
 *  Nodes without a usable id are dropped (counted), duplicate ids keep the first, edges that point at
 *  an unknown node are dropped (counted). Nothing is invented: a missing label falls back to the id. */
export function normalizeMap(raw, id) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawNodes = Array.isArray(src.nodes) ? src.nodes : [];
  const rawEdges = Array.isArray(src.edges) ? src.edges : [];
  const nodes = [];
  const seen = new Set();
  let droppedNodes = 0;
  for (const n of rawNodes) {
    if (nodes.length >= MAX_NODES) { droppedNodes += 1; continue; }
    const nid = n && (typeof n.id === 'string' || typeof n.id === 'number') ? String(n.id) : '';
    if (!nid || nid.length > 256 || seen.has(nid)) { droppedNodes += 1; continue; }
    seen.add(nid);
    const parent = n.parent == null ? null : String(n.parent);
    nodes.push({
      id: nid,
      label: cleanText(n.label, nid),
      kind: NODE_KINDS.has(n.kind) ? n.kind : null,
      parent: parent && parent.length <= 256 ? parent : null,
    });
  }
  const edges = [];
  let droppedEdges = 0;
  const edgeKeys = new Set();
  for (const e of rawEdges) {
    if (edges.length >= MAX_EDGES) { droppedEdges += 1; continue; }
    const from = e && e.from != null ? String(e.from) : '';
    const to = e && e.to != null ? String(e.to) : '';
    const key = from + '\u0000' + to;
    if (!seen.has(from) || !seen.has(to) || from === to || edgeKeys.has(key)) { droppedEdges += 1; continue; }
    edgeKeys.add(key);
    edges.push({ from, to });
  }
  const generated = typeof src._generated === 'string' && Number.isFinite(Date.parse(src._generated)) ? src._generated : null;
  return {
    map_id: id,
    title: cleanText(src.title, id),
    nodes,
    edges,
    generated_at: generated,
    dropped_nodes: droppedNodes,
    dropped_edges: droppedEdges,
  };
}

/** Reads + parses one map file that is already known to be inside the folder. */
function readMapFile(realDir, id) {
  const file = path.join(realDir, id + '.json');
  let st;
  try { st = fs.lstatSync(file); } catch { return { status: 404, error: 'mind map not found' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { status: 404, error: 'mind map not found' };
  const realFile = realpathOrNull(file);
  if (!realFile || !containmentOk(realDir, realFile)) return { status: 404, error: 'mind map not found' };
  if (st.size > MAX_MAP_BYTES) return { status: 413, error: 'mind map file is larger than ' + MAX_MAP_BYTES + ' bytes' };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(realFile, 'utf8')); } catch { return { status: 422, error: 'mind map file is not valid JSON' }; }
  return { status: 200, map: normalizeMap(raw, id), size_bytes: st.size, mtime_ms: st.mtimeMs };
}

/** listMindmaps(projectPath) -> {ok, available, maps:[{id,title,node_count,edge_count,generated_at}], ...} */
export function listMindmaps(projectPath) {
  const base = { ok: true, captured_at: new Date().toISOString() };
  const where = resolveMapsDir(projectPath);
  if (where.state === 'absent') return { ...base, available: false, provenance: 'NOT GENERATED', maps: [], unreadable: 0, truncated: false };
  if (where.state === 'refused') return { ...base, available: false, provenance: 'REFUSED', note: 'the mind-map folder is a link or not a folder, so it is not read', maps: [], unreadable: 0, truncated: false };
  let listing;
  try { listing = readDirBounded(where.realDir, MAX_DIR_ENTRIES); } catch {
    return { ...base, available: false, provenance: 'UNREADABLE', maps: [], unreadable: 0, truncated: false };
  }
  const maps = [];
  let unreadable = 0;
  for (const ent of listing.entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const id = ent.name.slice(0, -'.json'.length);
    if (!safeMapIdOk(id)) continue;
    const r = readMapFile(where.realDir, id);
    if (r.status !== 200) { unreadable += 1; continue; }
    maps.push({
      id,
      title: r.map.title,
      node_count: r.map.nodes.length,
      edge_count: r.map.edges.length,
      generated_at: r.map.generated_at ?? new Date(r.mtime_ms).toISOString(),
      generated_at_source: r.map.generated_at ? 'file' : 'mtime',
    });
  }
  maps.sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at) || a.id.localeCompare(b.id));
  const truncated = listing.truncated || maps.length > MAX_LISTED_MAPS;
  return { ...base, available: true, provenance: 'LIVE', maps: maps.slice(0, MAX_LISTED_MAPS), unreadable, truncated };
}

/** readMindmap(projectPath, id) -> {status, body}. The caller has already validated the project. */
export function readMindmap(projectPath, id) {
  if (!safeMapIdOk(id)) return { status: 400, body: { ok: false, error: 'invalid mind map id (allowed: A-Z a-z 0-9 _ -)' } };
  const where = resolveMapsDir(projectPath);
  if (where.state !== 'ok') return { status: 404, body: { ok: false, error: 'mind map not found' } };
  const r = readMapFile(where.realDir, id);
  if (r.status !== 200) return { status: r.status, body: { ok: false, error: r.error } };
  return { status: 200, body: { ok: true, provenance: 'LIVE', map: r.map, captured_at: new Date().toISOString() } };
}

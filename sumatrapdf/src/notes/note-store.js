export const revision = (value) => Number(value?.updatedAt || value?.createdAt) || 0;

function tombstones(a, b) {
  const out = Object.create(null);
  for (const source of [a, b])
    for (const [id, stamp] of Object.entries(source || {})) {
      if (Number.isFinite(Number(stamp))) out[id] = Math.max(out[id] || 0, Number(stamp));
    }
  return out;
}
function mergeTurns(local, remote, deleted, active) {
  const mine = new Map((local || []).map((t) => [t.id, t]));
  const all = new Map((remote || []).map((t) => [t.id, t]));
  for (const t of local || []) if (!all.has(t.id)) all.set(t.id, t);
  const result = [];
  for (const [id, incoming] of all) {
    const current = mine.get(id);
    const winner = current && (active(id) || revision(current) >= revision(incoming)) ? current : incoming;
    if (deleted[id] && deleted[id] >= revision(winner)) continue;
    if (current) {
      Object.assign(current, winner);
      result.push(current);
    } else result.push(structuredClone(winner));
  }
  return result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// Keep live objects so an in-flight model request still owns its target.
export function mergePage(local, remote, active = () => false) {
  if (remote && !Array.isArray(remote.annotations)) throw new Error("Invalid stored notes");
  const deleted = tombstones(local._deletedNotes, remote?._deletedNotes);
  const mine = new Map(local.annotations.map((a) => [a.id, a]));
  const all = new Map((remote?.annotations || []).map((a) => [a.id, a]));
  for (const a of local.annotations) if (!all.has(a.id)) all.set(a.id, a);
  const annotations = [];
  for (const [id, incoming] of all) {
    const current = mine.get(id);
    const winner = current && (active(id, "") || revision(current) >= revision(incoming)) ? current : incoming;
    if (deleted[id] && deleted[id] >= revision(winner)) continue;
    const removedTurns = tombstones(current?._deletedTurns, incoming._deletedTurns);
    const thread = mergeTurns(current?.thread, incoming.thread, removedTurns, (turnId) => active(id, turnId));
    const a = current || structuredClone(winner);
    Object.assign(a, winner, { thread, _deletedTurns: removedTurns });
    annotations.push(a);
  }
  local.annotations = annotations;
  local._deletedNotes = deleted;
  return local;
}

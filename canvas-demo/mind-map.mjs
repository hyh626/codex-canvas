import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const idPattern = /^[a-z][a-z0-9-]{0,39}$/;
export const mindMapNodeLimit = 64;

export function validateMindMap(component) {
  if (Object.keys(component).sort().join() !== 'id,kind,nodes,rootId' ||
      component.kind !== 'mind_map' || !idPattern.test(component.rootId) ||
      !Array.isArray(component.nodes) || component.nodes.length < 1 ||
      component.nodes.length > mindMapNodeLimit)
    throw Error('Invalid mind map component');
  const byId = new Map();
  for (const node of component.nodes) {
    if (!node || Object.keys(node).sort().join() !== 'id,label,order,parentId' ||
        !idPattern.test(node.id) || byId.has(node.id) ||
        typeof node.label !== 'string' || !node.label.trim() || node.label.length > 120 ||
        !Number.isInteger(node.order) || node.order < 0 ||
        !(node.parentId === null || (typeof node.parentId === 'string' && idPattern.test(node.parentId))))
      throw Error('Invalid mind map node');
    byId.set(node.id, node);
  }
  const roots = component.nodes.filter(node => node.parentId === null);
  if (roots.length !== 1 || roots[0].id !== component.rootId || roots[0].order !== 0)
    throw Error('Mind map needs one root');
  const groups = new Map();
  for (const node of component.nodes) {
    if (node.parentId === null) continue;
    if (!byId.has(node.parentId) || node.parentId === node.id)
      throw Error('Invalid mind map parent');
    const siblings = groups.get(node.parentId) ?? [];
    siblings.push(node.order);
    groups.set(node.parentId, siblings);
    const visited = new Set([node.id]);
    let current = node;
    while (current.parentId !== null) {
      if (visited.has(current.parentId)) throw Error('Mind map cycle');
      visited.add(current.parentId);
      current = byId.get(current.parentId);
      if (!current) throw Error('Invalid mind map parent');
    }
    if (current.id !== component.rootId) throw Error('Disconnected mind map node');
  }
  for (const siblings of groups.values()) {
    siblings.sort((a,b) => a-b);
    if (siblings.some((order,index) => order !== index)) throw Error('Invalid mind map sibling order');
  }
  return component;
}

export function orderedMindMapNodes(component) {
  validateMindMap(component);
  const children = new Map();
  for (const node of component.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a,b) => a.order-b.order);
  const result = [];
  const visit = node => {
    result.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  visit(children.get(null)[0]);
  return result;
}

export function descendants(component, nodeId) {
  const found = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of component.nodes)
      if (found.has(node.parentId) && !found.has(node.id)) { found.add(node.id); changed = true; }
  }
  return found;
}

function normalizeOrder(component, parentId) {
  component.nodes.filter(node => node.parentId === parentId)
    .sort((a,b) => a.order-b.order)
    .forEach((node,index) => { node.order = index; });
}

export function applyMindMapCommand(component, data) {
  validateMindMap(component);
  const { operation, nodeId, parentId, text } = data;
  const node = component.nodes.find(item => item.id === nodeId);
  const parent = component.nodes.find(item => item.id === parentId);
  if (operation !== 'mind_map_add' && !node) throw Error('Mind map node no longer exists');
  if (operation === 'mind_map_rename') {
    node.label = text;
  } else if (operation === 'mind_map_add') {
    if (!parent) throw Error('Mind map parent no longer exists');
    const siblings = component.nodes.filter(item => item.parentId === parentId);
    const order = data.order ?? siblings.length;
    if (!Number.isInteger(order) || order < 0 || order > siblings.length) throw Error('Invalid mind map sibling position');
    for (const sibling of siblings) if (sibling.order >= order) sibling.order++;
    component.nodes.push({ id: nodeId ?? `node-${randomUUID().slice(0,8)}`, parentId, order, label: text ?? 'New idea' });
  } else if (operation === 'mind_map_move') {
    if (node.id === component.rootId || !parent || descendants(component, node.id).has(parentId))
      throw Error('Invalid mind map move');
    const oldParent = node.parentId;
    node.order = Number.MAX_SAFE_INTEGER;
    normalizeOrder(component, oldParent);
    const siblings = component.nodes.filter(item => item.parentId === parentId && item.id !== node.id);
    const order = data.order ?? siblings.length;
    if (!Number.isInteger(order) || order < 0 || order > siblings.length) throw Error('Invalid mind map sibling position');
    for (const sibling of siblings) if (sibling.order >= order) sibling.order++;
    node.parentId = parentId;
    node.order = order;
  } else if (operation === 'mind_map_delete') {
    if (node.id === component.rootId) throw Error('Cannot delete mind map root');
    const removed = descendants(component, node.id);
    component.nodes = component.nodes.filter(item => !removed.has(item.id));
    normalizeOrder(component, node.parentId);
  } else if (operation === 'mind_map_duplicate') {
    if (node.id === component.rootId) throw Error('Cannot duplicate mind map root');
    const subtree = descendants(component, node.id);
    const ids = new Map([...subtree].map(id => [id, data.idMap?.[id] ?? `node-${randomUUID().slice(0,8)}`]));
    const originals = orderedMindMapNodes(component).filter(item => subtree.has(item.id));
    for (const sibling of component.nodes)
      if (sibling.parentId === node.parentId && sibling.order > node.order) sibling.order++;
    for (const original of originals)
      component.nodes.push({ ...original, id: ids.get(original.id), parentId: ids.get(original.parentId) ?? original.parentId,
        order: original.id === node.id ? node.order + 1 : original.order,
        label: original.id === node.id ? `${original.label} copy`.slice(0, 120) : original.label });
  } else throw Error('Unknown mind map operation');
  validateMindMap(component);
  component.nodes = orderedMindMapNodes(component);
  return component;
}

export function selectionContext(component, selection, baseRevision, comments = []) {
  validateMindMap(component);
  if (!selection || !['node','subtree','multi'].includes(selection.mode) ||
      !Array.isArray(selection.nodeIds) || selection.nodeIds.length < 1 ||
      selection.nodeIds.length > mindMapNodeLimit ||
      (selection.mode !== 'multi' && selection.nodeIds.length !== 1) ||
      new Set(selection.nodeIds).size !== selection.nodeIds.length)
    throw Error('Invalid mind map selection');
  const byId = new Map(component.nodes.map(node => [node.id,node]));
  for (const id of selection.nodeIds) if (!byId.has(id)) throw Error('Selected mind map node no longer exists');
  const ordered = orderedMindMapNodes(component);
  const requested = new Set(selection.nodeIds);
  const ids = selection.mode === 'subtree' ? descendants(component, selection.nodeIds[0]) : new Set(requested);
  if (selection.mode === 'multi') {
    for (const id of requested) {
      let parent = byId.get(byId.get(id).parentId);
      while (parent && parent.id !== component.rootId) {
        ids.add(parent.id);
        parent = byId.get(parent.parentId);
      }
    }
  }
  const nodes = ordered.filter(node => ids.has(node.id)).map(node => ({ ...node }));
  const ancestors = [];
  const ancestorIds = new Set();
  for (const node of nodes) {
    let parent = byId.get(node.parentId);
    while (parent) { if (!ids.has(parent.id)) ancestorIds.add(parent.id); parent = byId.get(parent.parentId); }
  }
  for (const node of ordered) if (ancestorIds.has(node.id)) ancestors.push({ id: node.id, label: node.label });
  const nodeIds = ordered.filter(node => requested.has(node.id)).map(node => node.id);
  return {
    schemaVersion: 1,
    baseRevision,
    componentId: component.id,
    selection: { mode: selection.mode, nodeIds },
    context: {
      ancestors,
      nodes,
      comments: comments.filter(comment => comment.component_id === component.id && ids.has(comment.node_id) && !comment.resolved)
        .map(({ node_id, revision, text }) => ({ nodeId: node_id, revision, text })),
    },
  };
}

export function assertScopedMindMapProposal(before, after, context) {
  const beforeComponent = before.components.find(component => component.id === context.componentId);
  const afterComponent = after.components.find(component => component.id === context.componentId);
  if (!beforeComponent || !afterComponent || afterComponent.kind !== 'mind_map' ||
      before.components.length !== after.components.length ||
      before.components.some((component,index) => component.id !== after.components[index]?.id ||
        (component.id !== context.componentId && !isDeepStrictEqual(component, after.components[index]))))
    throw Error('Agent proposal changes content outside the selected mind map');
  validateMindMap(afterComponent);
  const selected = new Set(context.selection.nodeIds);
  const allowed = context.selection.mode === 'subtree'
    ? descendants(beforeComponent, context.selection.nodeIds[0]) : selected;
  const prior = new Map(beforeComponent.nodes.map(node => [node.id,node]));
  const next = new Map(afterComponent.nodes.map(node => [node.id,node]));
  for (const node of beforeComponent.nodes) {
    if (!allowed.has(node.id) && !isDeepStrictEqual(node, next.get(node.id)))
      throw Error('Agent proposal changes a node outside the selection');
    if (allowed.has(node.id) && next.has(node.id)) {
      const changed = next.get(node.id);
      if (changed.parentId !== node.parentId && !allowed.has(changed.parentId))
        throw Error('Agent proposal moves a node outside the selection');
    }
  }
  for (const node of afterComponent.nodes)
    if (!prior.has(node.id) && !allowed.has(node.parentId))
      throw Error('Agent proposal adds a node outside the selection');
}

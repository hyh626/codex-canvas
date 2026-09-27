import { anchorExists } from "./html.mjs";

export function currentComments(events, sinceSeq = 0) {
  const comments = new Map();
  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    if (event.type === "comment.created")
      comments.set(event.event_id, { comment_id: event.event_id, ...event.payload, resolved: false });
    else if (event.type === "comment.anchor_changed") {
      const comment = comments.get(event.payload.comment_id);
      if (comment) Object.assign(comment, {
        component_id: event.payload.component_id,
        node_id: event.payload.node_id,
        revision: event.payload.revision,
      });
    } else if (event.type === "comment.resolved") {
      const comment = comments.get(event.payload.comment_id);
      if (comment) comment.resolved = true;
    }
  }
  return [...comments.values()];
}

export function changeComment(store, operation, data) {
  if (!["reanchor", "resolve"].includes(operation))
    throw Object.assign(Error("Unknown comment operation"), { status: 404 });
  const created = store.events.find((event) => event.type === "comment.created" && event.event_id === data.comment_id);
  if (!created) throw Object.assign(Error("Comment not found"), { status: 404 });
  const comment = currentComments(store.events).find((item) => item.comment_id === data.comment_id);
  if (comment.resolved) throw Object.assign(Error("Comment is already resolved"), { status: 409 });
  if (operation === "resolve") {
    store.append("comment.resolved", { comment_id: data.comment_id }, "human", [data.comment_id]);
    return;
  }
  if (data.component_id !== comment.component_id || data.from_node_id !== comment.node_id)
    throw Object.assign(Error("Comment anchor changed; reload before reanchoring"), { status: 409 });
  const targetComponentId = data.target_component_id ?? data.component_id;
  const targetNodeId = data.to_node_id;
  if (!anchorExists(store.state.components.find((item) => item.id === targetComponentId), targetNodeId))
    throw Object.assign(Error("Target comment anchor does not exist"), { status: 422 });
  store.append("comment.anchor_changed", {
    comment_id: data.comment_id,
    from_component_id: comment.component_id,
    from_node_id: comment.node_id,
    component_id: targetComponentId,
    node_id: targetNodeId,
    revision: store.revision,
  }, "human", [data.comment_id]);
}

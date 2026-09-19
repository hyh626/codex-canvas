import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Structured human intent is recorded alongside the deterministic state diff.
export function componentCommand(store, data) {
  const {
    operation,
    componentId,
    nodeId,
    text,
    direction,
    baseRevision,
    commandId,
  } = data;
  const intent = JSON.parse(
    JSON.stringify({
      operation,
      componentId,
      nodeId,
      text,
      direction,
      baseRevision,
    }),
  );
  const previous = store.events.find(
    (e) =>
      e.type === "workspace.edit_committed" &&
      e.payload.command_id === commandId,
  );
  if (previous) {
    if (!isDeepStrictEqual(previous.payload.intent, intent))
      throw Error("Command ID reused with different input");
    return previous;
  }
  if (baseRevision !== store.revision)
    throw Object.assign(
      Error(
        "Revision conflict. Your draft is preserved; reload the latest component before retrying.",
      ),
      { status: 409 },
    );
  const state = structuredClone(store.state);
  const index = state.components.findIndex((c) => c.id === componentId);
  const card = state.components[index];
  if (operation !== "create" && !card)
    throw Error("Component no longer exists");
  switch (operation) {
    case "create":
      state.components.push({
        id: `card-${randomUUID().slice(0, 8)}`,
        title: "Untitled idea",
        body: "Add your next thought here.",
        color: "#6366f1",
      });
      break;
    case "duplicate":
      state.components.splice(index + 1, 0, {
        ...card,
        id: `card-${randomUUID().slice(0, 8)}`,
      });
      break;
    case "delete":
      if (state.components.length === 1)
        throw Error("Keep at least one component on the canvas");
      state.components.splice(index, 1);
      break;
    case "move": {
      if (![1, -1].includes(direction))
        throw Error("Direction must be -1 or 1");
      const next = index + direction;
      if (next < 0 || next >= state.components.length)
        throw Error("Component is already at this edge");
      [state.components[index], state.components[next]] = [
        state.components[next],
        state.components[index],
      ];
      break;
    }
    case "set_text":
      if (!["title", "body"].includes(nodeId) || typeof text !== "string")
        throw Error("Unsupported editable node");
      card[nodeId] = text;
      break;
    default:
      throw Error("Unknown component operation");
  }
  return store.commit({ state, baseRevision, commandId, intent });
}

const card = (id, title, body, color) => ({ id, title, body, color });

const htmlFixture = `<article data-node-id="root" style="display:flex;flex-direction:column;gap:16px;padding:24px;background:#eef2ff;border-radius:16px">
  <header data-node-id="heading"><small data-node-id="eyebrow">CUJ PLAYGROUND</small><h2 data-node-id="title">A shared HTML component</h2></header>
  <section data-node-id="content"><p data-node-id="body">Edit this node, then ask the agent to change the layout.</p><ul data-node-id="features"><li data-node-id="feature-one">Stable comment anchors</li><li data-node-id="feature-two">One shared history</li></ul></section>
</article>`;

const commit = (events, actor) =>
  events.some(
    (event) =>
      event.type === "workspace.edit_committed" &&
      event.actor.kind === actor &&
      event.payload.intent?.operation !== "load_scenario" &&
      event.payload.mode === "edit",
  );
const operation = (events, name) =>
  events.some(
    (event) =>
      event.type === "workspace.edit_committed" &&
      event.payload.intent?.operation === name,
  );

export const scenarios = [
  {
    id: "human-edit",
    title: "Human edits the model",
    summary:
      "Edit one node and verify that the canvas, model and diff converge.",
    expected:
      "Only welcome.title changes; the component ID and other fields stay stable.",
    selectedComponentId: "welcome",
    fixture: {
      components: [
        card(
          "welcome",
          "Build something together.",
          "Double-click this title to begin.",
          "#6366f1",
        ),
      ],
    },
    steps: [
      {
        label: "Double-click the title and commit “Start your project”.",
        done: ({ state, events }) =>
          state.components[0]?.title === "Start your project" &&
          commit(events, "human"),
      },
      {
        label: "Open the latest commit in Trajectory and inspect its node-level diff.",
        manual: true,
      },
    ],
  },
  {
    id: "comment-agent",
    title: "Comment → agent proposal",
    summary:
      "Anchor feedback to a node, then let an engine act on that context.",
    expected:
      "The comment remains anchored and the agent changes only the title.",
    selectedComponentId: "welcome",
    fixture: {
      components: [
        card(
          "welcome",
          "A rough direction",
          "Comments are durable model context, not prompt-only UI state.",
          "#6366f1",
        ),
      ],
    },
    steps: [
      {
        label: "Comment on title: “标题：Build together”.",
        done: ({ events }) =>
          events.some(
            (event) =>
              event.type === "comment.created" &&
              event.payload.node_id === "title" &&
              event.payload.text.includes("Build together"),
          ),
      },
      {
        label: "Use the comment as the instruction and run the mock agent.",
        done: ({ state, events }) =>
          state.components[0]?.title === "Build together" &&
          commit(events, "agent"),
      },
    ],
  },
  {
    id: "shared-undo",
    title: "Human + agent share Undo",
    summary:
      "Prove that manual and agent edits are transactions in one history.",
    expected:
      "Two undo operations return to Baseline without rewriting prior events.",
    selectedComponentId: "welcome",
    fixture: {
      components: [
        card(
          "welcome",
          "Baseline",
          "Human and agent commits use the same history.",
          "#6366f1",
        ),
      ],
    },
    steps: [
      {
        label: "Commit the title “Human version” manually.",
        done: ({ events }) => commit(events, "human"),
      },
      {
        label: "Run the mock agent with “标题：Agent version”.",
        done: ({ events }) => commit(events, "agent"),
      },
      {
        label: "Press Undo twice; the title should return to Baseline.",
        done: ({ state, events }) =>
          state.components[0]?.title === "Baseline" &&
          events.filter(
            (event) =>
              event.type === "workspace.edit_committed" &&
              event.payload.mode === "undo",
          ).length >= 2,
      },
    ],
  },
  {
    id: "component-lifecycle",
    title: "Component lifecycle",
    summary: "Exercise identity, ordering and deletion as model operations.",
    expected:
      "The duplicate gets a new ID; moves and deletion preserve the remaining data.",
    selectedComponentId: "alpha",
    fixture: {
      components: [
        card("alpha", "Alpha", "Duplicate this card.", "#6366f1"),
        card("omega", "Omega", "Keep this card unchanged.", "#0d9488"),
      ],
    },
    steps: [
      {
        label: "Duplicate Alpha; the copy should be selected with a new ID.",
        done: ({ events }) => operation(events, "duplicate"),
      },
      {
        label: "Move the duplicate later in the document order.",
        done: ({ events }) => operation(events, "move"),
      },
      {
        label: "Delete the duplicate; Alpha and Omega should remain.",
        done: ({ state, events }) =>
          operation(events, "delete") &&
          state.components.map((item) => item.id).join(",") === "alpha,omega",
      },
    ],
  },
  {
    id: "html-component",
    title: "HTML node + layout edit",
    summary:
      "Edit authoritative HTML through stable node IDs, then change its layout.",
    expected:
      "Text editing preserves surrounding HTML; the agent changes flex direction to row.",
    selectedComponentId: "hero",
    fixture: { components: [{ id: "hero", kind: "html", html: htmlFixture }] },
    steps: [
      {
        label: "Double-click the title and commit “A shared launch”.",
        done: ({ state, events }) =>
          state.components[0]?.html.includes(">A shared launch</h2>") &&
          commit(events, "human"),
      },
      {
        label: "Run the mock agent with “layout: horizontal”.",
        done: ({ state, events }) =>
          /flex-direction\s*:\s*row/.test(state.components[0]?.html || "") &&
          commit(events, "agent"),
      },
    ],
  },
  {
    id: "audited-request",
    title: "Audited model request",
    summary:
      "Inspect reconstruction, optional capture and the committed proposal.",
    expected:
      "The request has assert=true; capture adds a body blob without changing execution.",
    selectedComponentId: "welcome",
    fixture: {
      components: [
        card(
          "welcome",
          "Audit the request",
          "Enable capture, then run a deterministic proposal.",
          "#6366f1",
        ),
      ],
    },
    steps: [
      {
        label: "Enable Capture full request and run “change color”.",
        done: ({ events }) =>
          events.some(
            (event) =>
              event.type === "model.request_prepared" &&
              event.payload.verification?.assert === true &&
              event.payload.body,
          ),
      },
      {
        label: "Open model.request_prepared in Trajectory and inspect the rebuilt request.",
        manual: true,
      },
    ],
  },
];

export const scenarioById = new Map(
  scenarios.map((scenario) => [scenario.id, scenario]),
);

export function scenarioContext(scenario, view) {
  const started = [...view.events]
    .reverse()
    .find((event) => event.type === "scenario.started");
  if (!started || started.payload.scenario_id !== scenario.id)
    return { active: false, state: view.state, events: [] };
  return {
    active: true,
    state: view.state,
    events: view.events.filter((event) => event.seq > started.seq),
    started,
  };
}

export function scenarioProgress(scenario, view) {
  const context = scenarioContext(scenario, view);
  return {
    active: context.active,
    steps: scenario.steps.map((step) => ({
      label: step.label,
      manual: step.manual === true,
      done: step.manual ? false : context.active && step.done(context),
    })),
  };
}

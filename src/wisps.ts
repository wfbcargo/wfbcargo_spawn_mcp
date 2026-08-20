/**
 * Reading Savi's fleet — how many sub-agents are running right now.
 *
 * spawn_savi can hand Savi a task it fans out across its own sub-agents, but
 * until now nothing on this side could see whether that fan-out was idle,
 * half-spoken-for, or full. The agent API has no endpoint for it (every
 * studio-chat GET is a 404), so the only place the state is legible is the play
 * page a builder already keeps open: the studio broadcasts its whole state to
 * that page over a websocket, and the little flames along the top of it — the
 * wisps — are its visible form. One wisp per sub-agent, eight slots in all.
 *
 * Two readings, deliberately. The websocket frame carries what each sub-agent
 * is doing; counting the wisps in the DOM carries only how many there are. Both
 * derive from the same studio state, so they agree, and either one alone still
 * answers the question this module exists for. Neither format is ours, so
 * everything here degrades to null rather than throwing.
 */

/** Slots on the wisp stage. The studio's fan-out limit, not ours. */
export const WISP_CAPACITY = 8;

/** Keep server prose from arriving in the model's context at full length. */
const MAX_TEXT = 160;

/**
 * A wisp is gone the moment it lands, so anything not terminal is still
 * burning. Listed as an exclusion because new running-ish states are likelier
 * to appear than new terminal ones, and miscounting a live sub-agent as free
 * capacity is the more expensive mistake: it invites a handoff into a full
 * fleet.
 *
 * Two vocabularies meet here. A wisp reports a state ("running"); a finished
 * lane reports a VERDICT on the work — "ok" or "partial" — which reads like a
 * state and is not one. Both are terminal, and lanes get a structural check
 * as well, so the roll-up does not rest on this list alone.
 */
const TERMINAL = new Set([
  "complete",
  "completed",
  "done",
  "error",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "ok",
  "partial",
]);

export type Wisp = {
  id: string;
  status: string;
  /** What Savi says this one is doing, when it says anything. */
  doing: string | null;
  error: string | null;
};

export type Weave = {
  id: string;
  title: string;
  status: string;
  phase: string | null;
  lanes: { total: number; running: number; done: number };
  startedAt: number | null;
  completedAt: number | null;
};

export type StudioSnapshot = {
  appId: string | null;
  wisps: Wisp[];
  weaves: Weave[];
  /** Turns waiting to start, distinct from queued weaves. */
  queuedTurns: number;
  capturedAt: number;
};

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clip(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isRunning(status: string): boolean {
  return !TERMINAL.has(status.toLowerCase());
}

/**
 * Narrow one studio state frame to the part about the fleet.
 *
 * The frame also carries the studio's chat history, its command list, and the
 * full text of every task Savi was given — kilobytes of it. None of that is
 * capacity, and all of it would be billed to the model reading this, so the
 * projection keeps titles and one-line summaries and drops the rest.
 */
export function projectStudioFrame(raw: unknown, capturedAt: number): StudioSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;
  if (frame.type !== "state") return null;

  const wispRows = Array.isArray(frame.activeWisps) ? frame.activeWisps : [];
  const weaveRows = Array.isArray(frame.weaves) ? frame.weaves : [];

  const wisps: Wisp[] = wispRows.filter((w): w is Record<string, unknown> => !!w && typeof w === "object").map((w, i) => ({
    id: str(w.id, `wisp-${i}`),
    status: str(w.status, "running"),
    // statusText is the live line and sentMessage the standing one; either
    // beats showing an id, and the raw `task` is a whole prompt.
    doing: clip(w.statusText) ?? clip(w.sentMessage),
    error: clip(w.error),
  }));

  const weaves: Weave[] = weaveRows.filter((v): v is Record<string, unknown> => !!v && typeof v === "object").map((v, i) => {
    const laneRows = Array.isArray(v.lanes) ? v.lanes : [];
    // completedAt first: a timestamp means finished whatever the verdict is
    // called, which keeps the roll-up right when a new verdict word appears.
    const laneDone = laneRows.map((row) => {
      const lane = (row ?? {}) as Record<string, unknown>;
      return millis(lane.completedAt) != null || !isRunning(str(lane.status, "running"));
    });
    return {
      id: str(v.id, `weave-${i}`),
      title: str(clip(v.title) ?? "", "untitled"),
      status: str(v.status, "running"),
      phase: clip(v.phase),
      lanes: {
        total: laneDone.length,
        running: laneDone.filter((done) => !done).length,
        done: laneDone.filter((done) => done).length,
      },
      startedAt: millis(v.startedAt),
      completedAt: millis(v.completedAt),
    };
  });

  return {
    appId: typeof frame.appId === "string" ? frame.appId : null,
    wisps,
    weaves,
    queuedTurns: Array.isArray(frame.queue) ? frame.queue.length : 0,
    capturedAt,
  };
}

export type FleetReport = {
  /** Where the numbers came from — "screen" is the wisp count, "studio" the socket frame. */
  source: "studio" | "screen" | "none";
  busy: number;
  free: number;
  capacity: number;
  running: number;
  queued: number;
  /** One line per burning wisp: what Savi has it doing. */
  workingOn: string[];
  inFlight: Array<{ title: string; status: string; phase: string | null; lanes: string }>;
  lastFinished: { title: string; completedAt: number | null } | null;
  observedAt: number | null;
  advice: string;
  note?: string;
};

export type FleetInput = {
  snapshot: StudioSnapshot | null;
  /** Wisps counted in the play page's DOM, or null when there is no session. */
  onScreen: number | null;
  sessionOpen: boolean;
};

/**
 * Fold the two readings into one answer.
 *
 * The on-screen count wins the arithmetic when both are present. It is the same
 * state one render later, so they agree in practice, and it is the reading that
 * survives the socket's shape changing — while the frame is what makes the
 * count mean something, by naming the work behind each flame.
 */
export function summarizeFleet(input: FleetInput): FleetReport {
  const { snapshot, onScreen, sessionOpen } = input;

  const running = snapshot ? snapshot.wisps.filter((w) => isRunning(w.status)).length : 0;
  const queued = snapshot
    ? snapshot.weaves.filter((v) => v.status.toLowerCase() === "queued").length + snapshot.queuedTurns
    : 0;

  const source: FleetReport["source"] = snapshot ? "studio" : onScreen != null ? "screen" : "none";
  const counted = onScreen ?? (snapshot ? running + queued : 0);
  const busy = Math.min(WISP_CAPACITY, Math.max(0, counted));
  const free = Math.max(0, WISP_CAPACITY - busy);

  const inFlight = (snapshot?.weaves ?? [])
    .filter((v) => !v.completedAt)
    .map((v) => ({
      title: v.title,
      status: v.status,
      phase: v.phase,
      lanes: `${v.lanes.done}/${v.lanes.total} lanes done`,
    }));

  const finished = (snapshot?.weaves ?? [])
    .filter((v) => v.completedAt != null)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];

  return {
    source,
    busy,
    free,
    capacity: WISP_CAPACITY,
    running: snapshot ? running : busy,
    queued,
    workingOn: (snapshot?.wisps ?? []).filter((w) => isRunning(w.status) && w.doing).map((w) => w.doing!),
    inFlight,
    lastFinished: finished ? { title: finished.title, completedAt: finished.completedAt } : null,
    observedAt: snapshot?.capturedAt ?? null,
    advice: adviseFleet(source, free, busy),
    ...(source === "none"
      ? {
          note: sessionOpen
            ? "A play session is open but the studio has not broadcast its state to it yet. Give it a few seconds, or spawn_play_reload."
            : "No play session. The wisps only exist on the play page — spawn_play_open, then ask again.",
        }
      : {}),
  };
}

/**
 * The nudge. Idle lanes are the whole point of measuring this: they are
 * parallelism already paid for, and an agent that builds serially past four
 * free sub-agents is choosing to be slower.
 */
export function adviseFleet(source: FleetReport["source"], free: number, busy: number): string {
  if (source === "none") {
    return "Fleet unknown, and that is not a reason to build alone: assume the lanes are free and hand Savi a broad slice with spawn_savi task. Open the play page to actually see them.";
  }
  if (free === 0) {
    return `All ${WISP_CAPACITY} lanes are burning. A further handoff queues behind them rather than starting, so this is the moment to build in your own area instead — or to look at what has landed with spawn_latest.`;
  }
  if (busy === 0) {
    return `Savi's whole fan-out is idle — ${WISP_CAPACITY} sub-agents doing nothing. Anything separable from what you are holding should go over with spawn_savi task, stated broadly enough that it splits. Building it yourself, one file at a time, is the slow way to the same place.`;
  }
  return `${free} of ${WISP_CAPACITY} lanes are idle. That is ${free} sub-agent${free === 1 ? "" : "s"} you are not using: hand over another broad slice with spawn_savi task, keepOff whatever you are still holding.`;
}

/** One line, for tools whose subject is something else. */
export function renderFleetLine(report: FleetReport): string {
  if (report.source === "none") return "Savi's fleet: not visible (no play session open)";
  const detail = report.queued ? `, ${report.queued} queued` : "";
  return `Savi's fleet: ${report.busy}/${report.capacity} wisps burning${detail} — ${report.free} lane${report.free === 1 ? "" : "s"} free`;
}

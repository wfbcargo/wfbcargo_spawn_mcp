import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WISP_CAPACITY,
  isRunning,
  projectStudioFrame,
  renderFleetLine,
  summarizeFleet,
  type StudioSnapshot,
} from "../src/wisps.js";

/**
 * Shaped from a real studio broadcast: four wisps burning, four weaves in
 * flight, one weave queued, and one finished eight-lane fan-out behind them.
 */
function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: "state",
    appId: "42595f57",
    queue: [],
    activeWisps: [
      {
        id: "wisp-ed97b3b6-0",
        status: "running",
        statusText: null,
        sentMessage: "Sent wisp to rebuild the nine set pieces out of real geometry",
        returnedMessage: "Wisp returned from rebuilding the nine set pieces",
        error: null,
        task: "x".repeat(4000),
      },
      { id: "wisp-81295052-0", status: "running", statusText: "wiring the phone controller", sentMessage: "Sent wisp", error: null },
      { id: "wisp-b3c1ba76-0", status: "running", statusText: null, sentMessage: "Sent wisp to fix the banner", error: null },
      { id: "wisp-aa312386-0", status: "running", statusText: null, sentMessage: null, error: null },
    ],
    weaves: [
      {
        id: "weave-9b6f039e",
        title: "Eight again",
        status: "complete",
        verdict: "partial",
        phase: "what came back",
        startedAt: 1787240877961,
        completedAt: 1787244153794,
        // A finished lane reports a verdict, not a state, and carries the
        // timestamp that says so — both as the studio actually sends them.
        lanes: [
          { seq: 1, label: "the robbery, seen", status: "partial", completedAt: 1787242041750 },
          { seq: 2, label: "the six faceless", status: "partial", completedAt: 1787241791308 },
          { seq: 3, label: "the rat king", status: "ok", completedAt: 1787242029287 },
          { seq: 4, label: "two players", status: "ok", completedAt: 1787242768817 },
          { seq: 5, label: "acts two and three", status: "ok", completedAt: 1787243323995 },
          { seq: 6, label: "gear at arm's length", status: "ok", completedAt: 1787243523705 },
          { seq: 7, label: "what a room sounds like", status: "ok", completedAt: 1787244153794 },
          { seq: 8, label: "the real ceiling", status: "ok", completedAt: 1787243821709 },
        ],
      },
      {
        id: "weave-472653f7",
        title: "Nine tableaux made of boxes",
        status: "running",
        phase: null,
        startedAt: 1787243497669,
        completedAt: null,
        lanes: [{ seq: 1, label: "the tableaux", status: "running", completedAt: null }],
      },
      {
        id: "weave-0c086154",
        title: "Fossils in the walls",
        status: "queued",
        startedAt: 1787244226382,
        completedAt: null,
        lanes: [],
      },
    ],
    // Everything below is the rest of the studio's state — history, commands,
    // context accounting. The projection must not carry any of it.
    recentHistory: [{ type: "image", data: "x".repeat(50_000) }],
    commands: ["/publish", "/stop"],
    percentContextFree: 12,
    ...overrides,
  };
}

const snapshot = () => projectStudioFrame(frame(), 1_000)!;

describe("projectStudioFrame", () => {
  it("keeps the fleet and drops the studio's history", () => {
    const s = snapshot();
    assert.equal(s.appId, "42595f57");
    assert.equal(s.wisps.length, 4);
    assert.equal(s.weaves.length, 3);
    assert.equal(s.queuedTurns, 0);
    assert.equal(s.capturedAt, 1_000);
    // The whole point of projecting: the frame is kilobytes, the snapshot is not.
    const serialized = JSON.stringify(s);
    assert.ok(!serialized.includes("recentHistory"));
    assert.ok(!serialized.includes("percentContextFree"));
    assert.ok(serialized.length < 2_000, `snapshot is ${serialized.length} bytes`);
  });

  it("prefers the live status line, falls back to what was sent", () => {
    const [first, second, , fourth] = snapshot().wisps;
    assert.equal(first.doing, "Sent wisp to rebuild the nine set pieces out of real geometry");
    assert.equal(second.doing, "wiring the phone controller");
    assert.equal(fourth.doing, null);
  });

  it("truncates prose so a runaway field cannot flood the context", () => {
    const long = frame({ activeWisps: [{ id: "w", status: "running", statusText: "y".repeat(900) }] });
    const doing = projectStudioFrame(long, 0)!.wisps[0].doing!;
    assert.ok(doing.length <= 160, `got ${doing.length}`);
    assert.ok(doing.endsWith("…"));
  });

  it("rolls lanes up by whether they are still burning", () => {
    const [eight, tableaux, fossils] = snapshot().weaves;
    assert.deepEqual(eight.lanes, { total: 8, running: 0, done: 8 });
    assert.deepEqual(tableaux.lanes, { total: 1, running: 1, done: 0 });
    assert.deepEqual(fossils.lanes, { total: 0, running: 0, done: 0 });
  });

  it("counts a lane as done from its timestamp, whatever its verdict is called", () => {
    const novel = frame({
      weaves: [
        {
          id: "w",
          title: "t",
          status: "running",
          lanes: [
            { seq: 1, status: "salvaged", completedAt: 1 },
            { seq: 2, status: "running", completedAt: null },
          ],
        },
      ],
    });
    assert.deepEqual(projectStudioFrame(novel, 0)!.weaves[0].lanes, { total: 2, running: 1, done: 1 });
  });

  it("returns null for anything that is not a state frame", () => {
    assert.equal(projectStudioFrame({ type: "message", text: "hi" }, 0), null);
    assert.equal(projectStudioFrame(null, 0), null);
    assert.equal(projectStudioFrame("state", 0), null);
    assert.equal(projectStudioFrame(42, 0), null);
  });

  it("survives a frame whose arrays hold junk", () => {
    const junk = frame({ activeWisps: [null, 7, {}], weaves: [{ lanes: "nope" }] });
    const s = projectStudioFrame(junk, 0)!;
    assert.equal(s.wisps.length, 1);
    assert.equal(s.wisps[0].status, "running");
    assert.deepEqual(s.weaves[0].lanes, { total: 0, running: 0, done: 0 });
    assert.equal(s.weaves[0].title, "untitled");
  });
});

describe("isRunning", () => {
  it("treats unknown states as still burning, not as free capacity", () => {
    assert.equal(isRunning("running"), true);
    assert.equal(isRunning("thinking"), true);
    // A verdict on finished work, not a state — counting it as burning would
    // report a sub-agent that has already gone out.
    assert.equal(isRunning("partial"), false);
    assert.equal(isRunning("ok"), false);
    assert.equal(isRunning("complete"), false);
    assert.equal(isRunning("Failed"), false);
  });
});

describe("summarizeFleet", () => {
  it("counts the wisps on screen and reports the rest as free", () => {
    const report = summarizeFleet({ snapshot: snapshot(), onScreen: 5, sessionOpen: true });
    assert.equal(report.source, "studio");
    assert.equal(report.busy, 5);
    assert.equal(report.free, 3);
    assert.equal(report.capacity, WISP_CAPACITY);
    assert.equal(report.running, 4);
    assert.equal(report.queued, 1);
  });

  it("falls back to the frame's own arithmetic when the page cannot be read", () => {
    const report = summarizeFleet({ snapshot: snapshot(), onScreen: null, sessionOpen: true });
    assert.equal(report.busy, 5);
    assert.equal(report.free, 3);
  });

  it("still answers the question from the screen alone", () => {
    const report = summarizeFleet({ snapshot: null, onScreen: 6, sessionOpen: true });
    assert.equal(report.source, "screen");
    assert.equal(report.busy, 6);
    assert.equal(report.free, 2);
    assert.deepEqual(report.workingOn, []);
    assert.equal(report.note, undefined);
  });

  it("names what each burning wisp is doing, and only those", () => {
    const report = summarizeFleet({ snapshot: snapshot(), onScreen: 5, sessionOpen: true });
    assert.deepEqual(report.workingOn, [
      "Sent wisp to rebuild the nine set pieces out of real geometry",
      "wiring the phone controller",
      "Sent wisp to fix the banner",
    ]);
  });

  it("lists only unfinished weaves, and the most recent finish behind them", () => {
    const report = summarizeFleet({ snapshot: snapshot(), onScreen: 5, sessionOpen: true });
    assert.deepEqual(
      report.inFlight.map((w) => w.title),
      ["Nine tableaux made of boxes", "Fossils in the walls"]
    );
    assert.equal(report.inFlight[0].lanes, "0/1 lanes done");
    assert.equal(report.lastFinished?.title, "Eight again");
  });

  it("never reports negative headroom when the studio overruns its own cap", () => {
    const report = summarizeFleet({ snapshot: null, onScreen: 12, sessionOpen: true });
    assert.equal(report.busy, WISP_CAPACITY);
    assert.equal(report.free, 0);
  });

  it("distinguishes no session from a session that has heard nothing yet", () => {
    const cold = summarizeFleet({ snapshot: null, onScreen: null, sessionOpen: false });
    assert.equal(cold.source, "none");
    assert.match(cold.note!, /spawn_play_open/);

    const waiting = summarizeFleet({ snapshot: null, onScreen: null, sessionOpen: true });
    assert.match(waiting.note!, /has not broadcast/);
  });
});

describe("advice", () => {
  const adviceFor = (onScreen: number) =>
    summarizeFleet({ snapshot: null, onScreen, sessionOpen: true }).advice;

  it("pushes hardest when the whole fan-out is idle", () => {
    assert.match(adviceFor(0), /whole fan-out is idle/);
    assert.match(adviceFor(0), /spawn_savi task/);
  });

  it("counts the idle lanes back at the model", () => {
    assert.match(adviceFor(6), /2 of 8 lanes are idle/);
    assert.match(adviceFor(7), /1 sub-agent you are not using/);
  });

  it("stops asking for more once every lane is burning", () => {
    const full = adviceFor(8);
    assert.match(full, /All 8 lanes are burning/);
    assert.ok(!/hand over another/.test(full));
  });

  it("treats an unknown fleet as a reason to delegate, not a reason to stall", () => {
    const unknown = summarizeFleet({ snapshot: null, onScreen: null, sessionOpen: false });
    assert.match(unknown.advice, /assume the lanes are free/);
  });
});

describe("renderFleetLine", () => {
  it("reads as one line for tools whose subject is something else", () => {
    const report = summarizeFleet({ snapshot: snapshot(), onScreen: 5, sessionOpen: true });
    assert.equal(renderFleetLine(report), "Savi's fleet: 5/8 wisps burning, 1 queued — 3 lanes free");
  });

  it("drops the queue clause when nothing is waiting", () => {
    const bare: StudioSnapshot = { appId: null, wisps: [], weaves: [], queuedTurns: 0, capturedAt: 0 };
    const report = summarizeFleet({ snapshot: bare, onScreen: 1, sessionOpen: true });
    assert.equal(renderFleetLine(report), "Savi's fleet: 1/8 wisps burning — 7 lanes free");
  });

  it("says so plainly when there is nothing to read", () => {
    const report = summarizeFleet({ snapshot: null, onScreen: null, sessionOpen: false });
    assert.equal(renderFleetLine(report), "Savi's fleet: not visible (no play session open)");
  });
});

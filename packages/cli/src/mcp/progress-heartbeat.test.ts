import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  MAX_PROGRESS_INTERVAL_MS,
  MIN_PROGRESS_INTERVAL_MS,
  NOOP_HEARTBEAT,
  PROGRESS_INTERVAL_ENV_VAR,
  type ProgressFrame,
  resolveProgressIntervalMs,
  startHeartbeat,
} from "./progress-heartbeat.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("startHeartbeat", () => {
  it("emits periodic frames with progress strictly increasing from 1", async () => {
    const frames: ProgressFrame[] = [];
    const heartbeat = startHeartbeat({
      token: 2,
      send: (frame) => frames.push(frame),
      label: "team",
      intervalMs: 20,
    });

    try {
      await wait(110);
    } finally {
      heartbeat.stop();
    }

    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.map((frame) => frame.progress)).toEqual(
      Array.from({ length: frames.length }, (_, index) => index + 1)
    );
    expect(frames.every((frame) => frame.progressToken === 2)).toBe(true);
  });

  it("echoes a string progress token unchanged", async () => {
    const frames: ProgressFrame[] = [];
    const heartbeat = startHeartbeat({
      token: "abc",
      send: (frame) => frames.push(frame),
      label: "run_prompt",
      intervalMs: 20,
    });

    try {
      await wait(50);
    } finally {
      heartbeat.stop();
    }

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((frame) => frame.progressToken === "abc")).toBe(true);
  });

  it("stops idempotently and emits no frames after stop", async () => {
    const frames: ProgressFrame[] = [];
    const heartbeat = startHeartbeat({
      token: 3,
      send: (frame) => frames.push(frame),
      label: "compare_models",
      intervalMs: 20,
    });

    await wait(45);
    heartbeat.stop();
    heartbeat.stop();
    const countAtStop = frames.length;

    await wait(65);

    expect(heartbeat.active).toBe(false);
    expect(frames.length).toBe(countAtStop);
    expect(heartbeat.emitted).toBe(countAtStop);
  });

  it("tick emits immediately and shares the periodic monotonic counter", async () => {
    const frames: ProgressFrame[] = [];
    const heartbeat = startHeartbeat({
      token: 4,
      send: (frame) => frames.push(frame),
      label: "team",
      intervalMs: 20,
    });

    try {
      heartbeat.tick("1/3 models done");
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ progress: 1, message: "1/3 models done" });

      await wait(50);
      heartbeat.tick("2/3 models done");
    } finally {
      heartbeat.stop();
    }

    expect(frames.at(-1)?.message).toBe("2/3 models done");
    expect(frames.map((frame) => frame.progress)).toEqual(
      Array.from({ length: frames.length }, (_, index) => index + 1)
    );
  });

  it("returns NOOP_HEARTBEAT for absent or invalid tokens", async () => {
    const frames: ProgressFrame[] = [];
    const invalidTokens: unknown[] = [undefined, null, {}, Number.NaN, true];

    for (const token of invalidTokens) {
      const heartbeat = startHeartbeat({
        token,
        send: (frame) => frames.push(frame),
        label: "team",
        intervalMs: 20,
      });

      expect(heartbeat).toBe(NOOP_HEARTBEAT);
      expect(heartbeat.active).toBe(false);
      expect(heartbeat.emitted).toBe(0);
      expect(() => {
        heartbeat.tick("ignored");
        heartbeat.stop();
        heartbeat.stop();
      }).not.toThrow();
    }

    await wait(45);
    expect(frames).toHaveLength(0);
  });

  it("swallows synchronous sender errors from tick and the periodic timer", async () => {
    const heartbeat = startHeartbeat({
      token: 5,
      send: () => {
        throw new Error("sync sender failure");
      },
      label: "team",
      intervalMs: 20,
    });

    try {
      expect(() => heartbeat.tick()).not.toThrow();
      await wait(50);
      expect(heartbeat.emitted).toBeGreaterThanOrEqual(3);
    } finally {
      heartbeat.stop();
    }
  });

  it("handles rejected sender promises without an unhandled rejection", async () => {
    const heartbeat = startHeartbeat({
      token: 6,
      send: () => Promise.reject(new Error("async sender failure")),
      label: "team",
      intervalMs: 20,
    });

    try {
      expect(() => heartbeat.tick()).not.toThrow();
      await wait(50);
      expect(heartbeat.emitted).toBeGreaterThanOrEqual(3);
    } finally {
      heartbeat.stop();
    }

    await wait(0);
  });
});

describe("resolveProgressIntervalMs", () => {
  it("uses the default when the environment value is unset or empty", () => {
    expect(resolveProgressIntervalMs({})).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
    expect(resolveProgressIntervalMs({ [PROGRESS_INTERVAL_ENV_VAR]: "" })).toBe(
      DEFAULT_PROGRESS_INTERVAL_MS
    );
  });

  it("clamps values below the minimum up to the minimum", () => {
    expect(resolveProgressIntervalMs({ [PROGRESS_INTERVAL_ENV_VAR]: "1" })).toBe(
      MIN_PROGRESS_INTERVAL_MS
    );
  });

  it("clamps values above the maximum down to the maximum", () => {
    expect(resolveProgressIntervalMs({ [PROGRESS_INTERVAL_ENV_VAR]: "600000" })).toBe(
      MAX_PROGRESS_INTERVAL_MS
    );
  });

  it("uses the default for garbage, negative, and zero values", () => {
    for (const value of ["garbage", "-1", "0"]) {
      expect(resolveProgressIntervalMs({ [PROGRESS_INTERVAL_ENV_VAR]: value })).toBe(
        DEFAULT_PROGRESS_INTERVAL_MS
      );
    }
  });
});

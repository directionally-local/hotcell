import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../src/config.js";
import { DriverRouter } from "../src/driver/router.js";
import type { CreateOptions, Driver } from "../src/driver/types.js";
import { SandboxStore } from "../src/store.js";
import { emptyUsage } from "../src/store.js";
import type { SandboxRecord } from "../src/types.js";

function record(id: string, driver?: string): SandboxRecord {
  return {
    id,
    image: "alpine",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    driver,
    labels: {},
    env: {},
    persist: true,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    sleepAfterMs: 0,
    usage: emptyUsage(),
    limits: {},
  };
}

function opts(id: string, driver?: string): CreateOptions {
  return { id, image: "alpine", driver };
}

/** A minimal Driver that records which instance handled each call. */
function fakeDriver(name: string, calls: string[]): Driver {
  return {
    name,
    create: async (o: CreateOptions) => {
      calls.push(`${name}:create:${o.id}`);
    },
    start: async (o: CreateOptions) => {
      calls.push(`${name}:start:${o.id}`);
    },
    stop: async (id: string) => {
      calls.push(`${name}:stop:${id}`);
    },
    destroy: async (id: string) => {
      calls.push(`${name}:destroy:${id}`);
    },
    poolStats: () => ({ spares: 1, reservedMb: 64 }),
  } as unknown as Driver;
}

function setup() {
  const store = new SandboxStore();
  const calls: string[] = [];
  const built: string[] = [];
  const router = new DriverRouter(
    {} as Config,
    store,
    "container",
    (name) => {
      built.push(name);
      return fakeDriver(name, calls);
    },
  );
  return { store, calls, built, router };
}

describe("DriverRouter", () => {
  it("dispatches create to the driver named on the options", async () => {
    const { store, calls, router } = setup();
    try {
      await router.create(opts("a", "firecracker"));
      assert.deepEqual(calls, ["firecracker:create:a"]);
    } finally {
      store.close();
    }
  });

  it("falls back to the sandbox record's driver", async () => {
    const { store, calls, router } = setup();
    try {
      store.add(record("a", "applevz"));
      await router.create(opts("a"));
      assert.deepEqual(calls, ["applevz:create:a"]);
    } finally {
      store.close();
    }
  });

  it("falls back to the default driver when nothing selects one", async () => {
    const { store, calls, router } = setup();
    try {
      await router.create(opts("a"));
      assert.deepEqual(calls, ["container:create:a"]);
    } finally {
      store.close();
    }
  });

  it("prefers the options driver over the record", async () => {
    const { store, calls, router } = setup();
    try {
      store.add(record("a", "applevz"));
      await router.create(opts("a", "firecracker"));
      assert.deepEqual(calls, ["firecracker:create:a"]);
    } finally {
      store.close();
    }
  });

  it("routes id-addressed ops by the record's driver", async () => {
    const { store, calls, router } = setup();
    try {
      store.add(record("a", "firecracker"));
      await router.stop("a");
      await router.destroy("a");
      assert.deepEqual(calls, ["firecracker:stop:a", "firecracker:destroy:a"]);
    } finally {
      store.close();
    }
  });

  it("constructs and caches one instance per driver name", async () => {
    const { store, built, router } = setup();
    try {
      await router.create(opts("a", "firecracker"));
      await router.create(opts("b", "firecracker"));
      await router.create(opts("c", "container"));
      assert.deepEqual(built, ["firecracker", "container"]);
    } finally {
      store.close();
    }
  });

  it("aggregates poolStats across instantiated drivers", async () => {
    const { store, router } = setup();
    try {
      await router.create(opts("a", "firecracker"));
      await router.create(opts("b", "container"));
      assert.deepEqual(router.poolStats(), { spares: 2, reservedMb: 128 });
    } finally {
      store.close();
    }
  });

  it("throws for an unknown driver name", async () => {
    const store = new SandboxStore();
    try {
      const router = new DriverRouter({} as Config, store, "bogus");
      assert.throws(() => router.create(opts("a")), /unknown driver "bogus"/);
    } finally {
      store.close();
    }
  });
});

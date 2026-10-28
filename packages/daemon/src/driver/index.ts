import type { Config } from "../config.js";
import { dirname, join, resolve } from "node:path";
import { AppleVzDriver } from "./applevz.js";
import { ContainerDriver } from "./container.js";
import { FirecrackerDriver } from "./firecracker.js";
import type { Driver, ResourceLimits } from "./types.js";

/**
 * The daemon-default resource shape — what a create resolves to when the body
 * names no limits. Must fold exactly like the API's `resolveLimits` (server.ts):
 * only >0 values are kept. Warm-pool spares boot with this shape so plain
 * creates stay pool-eligible.
 */
function defaultLimits(config: Config): ResourceLimits {
  const limits: ResourceLimits = {};
  if (config.defaultMemoryMb > 0) limits.memoryMb = config.defaultMemoryMb;
  if (config.defaultCpus > 0) limits.cpus = config.defaultCpus;
  if (config.defaultPidsLimit > 0) limits.pidsLimit = config.defaultPidsLimit;
  return limits;
}

/** Known driver names, in preference/isolation order. */
export const DRIVER_NAMES = ["container", "firecracker", "applevz"] as const;

/**
 * Construct the runtime driver named by `config.driver` (`SBX_DRIVER`) — the
 * daemon's default. The `DriverRouter` calls `createNamedDriver` to build other
 * drivers on demand for per-sandbox isolation selection.
 */
export function createDriver(config: Config): Driver {
  return createNamedDriver(config.driver, config);
}

/**
 * Construct a specific runtime driver by name. The container driver is fully
 * built; the microVM drivers compile and report a clear "needs <host>" error
 * from `ping()` so a bad selection fails with guidance. Adding a real driver is
 * a one-line change here.
 */
export function createNamedDriver(name: string, config: Config): Driver {
  switch (name) {
    case "container":
      return new ContainerDriver(
        undefined,
        {
          enforce: config.egressEnforce,
          network: config.egressNetwork,
          subnet: config.egressSubnet,
          dns: config.egressDnsResolver,
        },
        { baseDir: join(dirname(resolve(config.dbPath)), "container-agent") },
        {
          depth: config.containerWarmPool,
          image: config.defaultImage,
          limits: defaultLimits(config),
          reservationMb: config.defaultReservationMb,
          stateDir: join(dirname(resolve(config.dbPath)), "container-pool"),
        },
      );
    case "firecracker":
      return new FirecrackerDriver({
        fcBin: config.fcBin,
        kernel: config.fcKernel,
        rootfs: config.fcRootfs,
        stateDir: config.fcStateDir,
        diskGb: config.fcDiskGb,
        imageCacheDir: config.fcImageCacheDir,
        warmPool: config.fcWarmPool,
        // A plain create of the daemon's default image + default limits adopts a spare.
        poolImage: config.defaultImage,
        poolLimits: defaultLimits(config),
        // Guest egress relay target: the gateway on this host.
        egressPort: config.egressPort,
        egressHost: config.host,
      });
    case "applevz":
      return new AppleVzDriver({
        helperPath: config.vzHelperPath,
        kernel: config.vzKernel,
        rootfs: config.vzRootfs,
        stateDir: config.vzStateDir,
        diskGb: config.vzDiskGb,
        imageCacheDir: config.vzImageCacheDir,
        warmPool: config.vzWarmPool,
        // A plain create of the daemon's default image + default limits adopts a spare.
        poolImage: config.defaultImage,
        poolLimits: defaultLimits(config),
        // Guest egress relay target: the gateway on this host.
        egressPort: config.egressPort,
        egressHost: config.host,
      });
    default:
      throw new Error(`unknown driver "${name}" (expected: ${DRIVER_NAMES.join(" | ")})`);
  }
}

// Synchronous sleep between `scw` polls. The driver is synchronous end to end
// (spawnSync), so the wait is too.
export function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

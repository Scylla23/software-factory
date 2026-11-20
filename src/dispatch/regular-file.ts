import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Darwin O_NOFOLLOW_ANY checks every component in the same open as the leaf. */
export function readRegularFile(path: string, limit: number): Buffer {
  if (process.platform !== "darwin") throw new Error("safe file capture requires Darwin O_NOFOLLOW_ANY");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error(`unsafe or oversize regular file ${path}`);
    const bytes = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, null);
      if (!count) break;
      read += count;
    }
    if (read !== stat.size) throw new Error(`file changed during capture ${path}`);
    return bytes.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

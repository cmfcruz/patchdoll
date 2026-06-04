import { spawn } from "node:child_process";
import type { Socket } from "node:net";

export interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}

export async function readPeerCredentials(
  socket: Socket,
  helperPath = "/usr/local/bin/patchdoll-peercred"
): Promise<PeerCredentials> {
  const fd = socketFd(socket);
  if (fd === undefined) {
    throw new Error("Unable to inspect Unix socket file descriptor");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["ignore", "pipe", "pipe", fd]
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error("Peer credential helper did not expose stdio pipes"));
      return;
    }
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new Error(`Unable to run peer credential helper: ${error.message}`)
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Peer credential helper exited with ${code ?? "unknown"}: ${stderr.trim()}`
          )
        );
        return;
      }

      const credentials = parsePeerCredentials(stdout);
      if (!credentials) {
        reject(new Error("Peer credential helper returned invalid output"));
        return;
      }
      resolve(credentials);
    });
  });
}

function socketFd(socket: Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return typeof handle?.fd === "number" ? handle.fd : undefined;
}

function parsePeerCredentials(value: string): PeerCredentials | undefined {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }

  const credentials = parsed as Record<string, unknown>;
  const pid = credentials.pid;
  const uid = credentials.uid;
  const gid = credentials.gid;
  if (
    typeof pid !== "number" ||
    typeof uid !== "number" ||
    typeof gid !== "number"
  ) {
    return undefined;
  }

  return { pid, uid, gid };
}

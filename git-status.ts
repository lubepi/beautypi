import { spawn } from "node:child_process";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

export type GitPollingMode = "full" | "branch" | "off";

const CACHE_TTL_MS = 1000; // 1 second for file status
const BRANCH_TTL_MS = 500; // Shorter TTL so branch updates quickly after invalidation
let cachedStatus: CachedGitStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let pendingFetch: Promise<void> | null = null;
let pendingBranchFetch: Promise<void> | null = null;
let invalidationCounter = 0; // Track invalidations to prevent stale updates
let branchInvalidationCounter = 0;

/**
 * Parse git status --porcelain output
 *
 * Format: XY filename
 * X = index status, Y = working tree status
 * ?? = untracked
 * Other X values = staged
 * Other Y values = unstaged
 */
function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    // X position (index/staged)
    if (x && x !== " " && x !== "?") {
      staged++;
    }

    // Y position (working tree/unstaged)
    if (y && y !== " ") {
      unstaged++;
    }
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

/**
 * Fetch git status - porzellan output
 */
async function fetchGitStatus(): Promise<CachedGitStatus | null> {
  const invalidationVersion = invalidationCounter;
  try {
    const output = await runGit(["status", "--porcelain", "--untracked-files=normal"]);
    if (invalidationVersion !== invalidationCounter) return null; // Stale

    if (output === null) {
      cachedStatus = null;
      return null;
    }

    const parsed = parseGitStatusOutput(output);
    cachedStatus = { ...parsed, timestamp: Date.now() };
    return cachedStatus;
  } catch {
    cachedStatus = null;
    return null;
  }
}

/**
 * Fetch current git branch
 */
async function fetchGitBranch(): Promise<string | null> {
  const invalidationVersion = branchInvalidationCounter;
  try {
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (invalidationVersion !== branchInvalidationCounter) return null; // Stale

    if (branch === null || branch === "HEAD") {
      cachedBranch = { branch: null, timestamp: Date.now() };
      return null;
    }

    cachedBranch = { branch, timestamp: Date.now() };
    return branch;
  } catch {
    cachedBranch = { branch: null, timestamp: Date.now() };
    return null;
  }
}

/**
 * Get git status with caching
 */
export function getGitStatus(branch: string | null, pollingMode?: GitPollingMode): GitStatus {
  const now = Date.now();

  // Return cached status if fresh
  if (cachedStatus && now - cachedStatus.timestamp < CACHE_TTL_MS && invalidationCounter === 0) {
    return {
      branch: cachedBranch?.branch ?? branch,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  // Trigger background fetch if not already pending
  if (!pendingFetch && (pollingMode === "full" || pollingMode === undefined)) {
    pendingFetch = fetchGitStatus().finally(() => { pendingFetch = null; });
  }
  if (!pendingBranchFetch) {
    pendingBranchFetch = fetchGitBranch().finally(() => { pendingBranchFetch = null; });
  }

  // Return whatever we have (possibly stale)
  return {
    branch: cachedBranch?.branch ?? branch,
    staged: cachedStatus?.staged ?? 0,
    unstaged: cachedStatus?.unstaged ?? 0,
    untracked: cachedStatus?.untracked ?? 0,
  };
}

/**
 * Invalidate git status cache (e.g., on file write)
 */
export function invalidateGitStatus(): void {
  invalidationCounter++;
  cachedStatus = null;
}

/**
 * Invalidate git branch cache
 */
export function invalidateGitBranch(): void {
  branchInvalidationCounter++;
  cachedBranch = null;
}

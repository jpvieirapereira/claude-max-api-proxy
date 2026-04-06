/**
 * Per-Agent Concurrency Queue
 *
 * Each agent (identified by agentKey) gets its own FIFO queue.
 * Only one subprocess per agent runs at a time (serialized).
 * A global ceiling limits total concurrent processes across all agents.
 */

const MAX_CONCURRENT = parseInt(process.env.CLAUDE_MAX_CONCURRENT || "3", 10);
const MAX_QUEUE_PER_AGENT = parseInt(process.env.CLAUDE_MAX_QUEUE_PER_AGENT || "5", 10);
const QUEUE_WAIT_MS = parseInt(process.env.CLAUDE_QUEUE_WAIT_MS || "60000", 10);

interface WaitEntry {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface AgentQueue {
  active: boolean;
  waiting: WaitEntry[];
}

const agents = new Map<string, AgentQueue>();
let globalActive = 0;

/**
 * Try to start the next waiting request for any agent (round-robin fairness).
 */
function drainGlobal(): void {
  if (globalActive >= MAX_CONCURRENT) return;

  for (const [, agent] of agents) {
    if (globalActive >= MAX_CONCURRENT) break;
    if (!agent.active && agent.waiting.length > 0) {
      const next = agent.waiting.shift()!;
      clearTimeout(next.timer);
      agent.active = true;
      globalActive++;
      next.resolve(makeRelease(agent));
    }
  }
}

function makeRelease(agent: AgentQueue): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    agent.active = false;
    globalActive--;
    drainGlobal();
  };
}

/**
 * Clean up empty agent entries to prevent memory leaks.
 */
function cleanup(agentKey: string): void {
  const agent = agents.get(agentKey);
  if (agent && !agent.active && agent.waiting.length === 0) {
    agents.delete(agentKey);
  }
}

/**
 * Acquire a slot for the given agent. Resolves immediately if both
 * the agent slot and a global slot are available. Otherwise waits
 * in the agent's FIFO queue.
 *
 * Throws if the agent's queue is full or the wait times out.
 */
export function acquire(agentKey: string): Promise<() => void> {
  let agent = agents.get(agentKey);
  if (!agent) {
    agent = { active: false, waiting: [] };
    agents.set(agentKey, agent);
  }

  // Fast path: agent idle + global slot available
  if (!agent.active && globalActive < MAX_CONCURRENT) {
    agent.active = true;
    globalActive++;
    return Promise.resolve(makeRelease(agent));
  }

  // Queue is full
  if (agent.waiting.length >= MAX_QUEUE_PER_AGENT) {
    return Promise.reject(
      new Error(`Queue full for agent ${agentKey} (max ${MAX_QUEUE_PER_AGENT})`)
    );
  }

  // Wait in queue with timeout
  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = agent!.waiting.findIndex((e) => e.timer === timer);
      if (idx !== -1) agent!.waiting.splice(idx, 1);
      cleanup(agentKey);
      reject(new Error(`Queue timeout after ${QUEUE_WAIT_MS}ms for agent ${agentKey}`));
    }, QUEUE_WAIT_MS);

    agent!.waiting.push({ resolve, reject, timer });
  });
}

/**
 * Get current queue stats (for /health endpoint)
 */
export function queueStats(): {
  globalActive: number;
  globalMax: number;
  agents: Record<string, { active: boolean; waiting: number }>;
} {
  const agentStats: Record<string, { active: boolean; waiting: number }> = {};
  for (const [key, agent] of agents) {
    agentStats[key] = { active: agent.active, waiting: agent.waiting.length };
  }
  return {
    globalActive,
    globalMax: MAX_CONCURRENT,
    agents: agentStats,
  };
}

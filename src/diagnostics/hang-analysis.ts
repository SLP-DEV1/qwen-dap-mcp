import type { DebugProtocol } from '@vscode/debugprotocol';

import type { DiagnosisConfidence } from './analyze-snapshot.js';
import {
  assessProjectFrames,
  type IntelligentDiagnosisOptions,
} from './intelligent-diagnosis.js';

export type HangWaitKind =
  | 'mutex'
  | 'rwlock'
  | 'condition-variable'
  | 'semaphore'
  | 'event'
  | 'thread-join'
  | 'futex'
  | 'io'
  | 'sleep-timer'
  | 'scheduler-park'
  | 'running-user-code'
  | 'unknown';

export type HangFrameVariables = {
  frameIndex: number;
  frame: DebugProtocol.StackFrame;
  variables: DebugProtocol.Variable[];
  collectionErrors?: string[];
};

export type HangThreadEvidence = {
  thread: DebugProtocol.Thread;
  stack: DebugProtocol.StackFrame[];
  variableFrames: HangFrameVariables[];
  collectionErrors?: string[];
};

export type HangWaitState = {
  kind: HangWaitKind;
  blocked: boolean;
  confidence: DiagnosisConfidence;
  matchedFrameIndex?: number;
  matchedFunction?: string;
  rationale: string[];
};

export type HangThreadTriage = {
  threadId: number;
  threadName: string;
  topFunction?: string;
  projectFunction?: string;
  projectFrameIndex?: number;
  projectControlled: boolean;
  wait: HangWaitState;
  collectionErrors?: string[];
};

export type PointerRole =
  | 'synchronization'
  | 'owner-or-thread'
  | 'buffer-or-object'
  | 'generic-pointer';

export type PointerObservation = {
  address: string;
  source: 'memoryReference' | 'value';
  threadId: number;
  threadName: string;
  frameIndex: number;
  frameName: string;
  variableName: string;
  variableType?: string;
  variableValue: string;
  role: PointerRole;
};

export type PointerProvenanceGroup = {
  address: string;
  observations: PointerObservation[];
  aliases: string[];
  threadIds: number[];
  sharedAcrossThreads: boolean;
  synchronizationRelevant: boolean;
  confidence: DiagnosisConfidence;
  rationale: string[];
};

export type PointerProvenanceV2 = {
  version: 2;
  groups: PointerProvenanceGroup[];
  nullLike: Array<Omit<PointerObservation, 'address'> & { address: '0x0' }>;
  limitations: string[];
};

export type DeadlockHeuristic = {
  classification:
    | 'deadlock-candidate'
    | 'lock-contention'
    | 'global-wait'
    | 'io-wait'
    | 'mixed-wait'
    | 'no-deadlock-signal'
    | 'unknown';
  likelihood: DiagnosisConfidence;
  blockedThreadIds: number[];
  runnableProjectThreadIds: number[];
  sharedSynchronizationAddresses: string[];
  cycleProven: false;
  ownershipGraphAvailable: false;
  evidence: string[];
  limitations: string[];
};

export type HangDiagnosis = {
  summary: string;
  classification: DeadlockHeuristic['classification'];
  confidence: DiagnosisConfidence;
  allThreadTriage: HangThreadTriage[];
  deadlock: DeadlockHeuristic;
  pointerProvenance: PointerProvenanceV2;
  nextActions: string[];
  limitations: string[];
};

type WaitRule = {
  kind: HangWaitKind;
  re: RegExp;
  confidence: DiagnosisConfidence;
  rationale: string;
};

const WAIT_RULES: WaitRule[] = [
  {
    kind: 'condition-variable',
    re: /(?:pthread_cond_(?:timed)?wait|condition_variable.*wait|condvar.*wait|rtlwaitonaddress|waitonaddress)/i,
    confidence: 'high',
    rationale: 'stack contains a condition-variable/address-wait primitive',
  },
  {
    kind: 'futex',
    re: /(?:futex|__lll_lock_wait|lll_futex_wait|futex_wait|do_futex)/i,
    confidence: 'high',
    rationale: 'stack contains a futex/low-level lock wait primitive',
  },
  {
    kind: 'rwlock',
    re: /(?:pthread_rwlock|srwlock|acquiresrwlock|rwlock|shared_mutex)/i,
    confidence: 'high',
    rationale: 'stack contains a reader/writer lock wait primitive',
  },
  {
    kind: 'mutex',
    re: /(?:pthread_mutex|std::.*mutex|criticalsection|entercriticalsection|mutex.*lock|lock_slow|__gthread_mutex)/i,
    confidence: 'high',
    rationale: 'stack contains a mutex/critical-section acquisition primitive',
  },
  {
    kind: 'semaphore',
    re: /(?:sem_(?:timed)?wait|semaphore.*wait|acquire.*semaphore)/i,
    confidence: 'high',
    rationale: 'stack contains a semaphore wait primitive',
  },
  {
    kind: 'thread-join',
    re: /(?:pthread_join|std::thread::join|thread.*join|wait.*thread|join_handle)/i,
    confidence: 'high',
    rationale: 'stack contains a thread-join wait primitive',
  },
  {
    kind: 'io',
    re: /(?:epoll_(?:p)?wait|\bpoll\b|\bppoll\b|\bselect\b|\bpselect\b|\bkevent\b|\brecv\b|recvfrom\b|\baccept\b|getqueuedcompletionstatus|readfile|io_uring_enter)/i,
    confidence: 'high',
    rationale: 'stack contains a blocking I/O wait primitive',
  },
  {
    kind: 'sleep-timer',
    re: /(?:nanosleep|clock_nanosleep|usleep|\bsleep\b|waitabletimer|delayexecution)/i,
    confidence: 'high',
    rationale: 'stack contains a sleep/timer wait primitive',
  },
  {
    kind: 'event',
    re: /(?:waitforsingleobject|waitformultipleobjects|ntwaitforsingleobject|ntwaitformultipleobjects|event.*wait)/i,
    confidence: 'medium',
    rationale: 'stack contains a generic operating-system wait/event primitive',
  },
  {
    kind: 'scheduler-park',
    re: /(?:\bpark\b|parking_lot|threadpool|worker.*wait|scheduler.*wait|yield_processor)/i,
    confidence: 'medium',
    rationale: 'stack looks parked in a scheduler/worker wait loop',
  },
];

const STRONG_LOCK_WAITS = new Set<HangWaitKind>([
  'mutex',
  'rwlock',
  'futex',
  'thread-join',
]);

const POINTER_NAME_RE = /(?:ptr|pointer|this|self|owner|mutex|lock|guard|critical|cond|semaphore|event|handle|buffer|buf|node|object|obj|context|ctx|state|queue|list|map|tree|head|tail)/i;
const POINTER_TYPE_RE = /(?:\*|\bptr\b|pointer|unique_ptr|shared_ptr|weak_ptr|handle|mutex|lock|condition_variable|semaphore)/i;
const SYNC_RE = /(?:mutex|lock|guard|critical|cond|semaphore|event|futex|rwlock|srw)/i;
const OWNER_RE = /(?:owner|thread|tid|handle)/i;
const BUFFER_RE = /(?:buffer|buf|node|object|obj|context|ctx|state|queue|list|map|tree|head|tail|this|self)/i;

function normalizedHex(value: string): string | undefined {
  const matched = value.match(/0x[0-9a-f]+/i)?.[0];
  if (!matched) return undefined;
  try {
    return `0x${BigInt(matched).toString(16)}`;
  } catch {
    return matched.toLowerCase();
  }
}

function pointerRole(variable: DebugProtocol.Variable): PointerRole {
  const text = `${variable.name} ${variable.type ?? ''}`;
  if (SYNC_RE.test(text)) return 'synchronization';
  if (OWNER_RE.test(text)) return 'owner-or-thread';
  if (BUFFER_RE.test(text)) return 'buffer-or-object';
  return 'generic-pointer';
}

function looksPointerLike(variable: DebugProtocol.Variable): boolean {
  return Boolean(variable.memoryReference)
    || POINTER_NAME_RE.test(variable.name)
    || POINTER_TYPE_RE.test(variable.type ?? '');
}

function variableAddress(
  variable: DebugProtocol.Variable,
): { address: string; source: PointerObservation['source'] } | undefined {
  const memoryReference = variable.memoryReference
    ? normalizedHex(variable.memoryReference)
    : undefined;
  if (memoryReference) return { address: memoryReference, source: 'memoryReference' };
  if (!looksPointerLike(variable)) return undefined;
  const value = normalizedHex(variable.value);
  return value ? { address: value, source: 'value' } : undefined;
}

export function classifyThreadWait(
  evidence: HangThreadEvidence,
  analysisOptions: IntelligentDiagnosisOptions = {},
): HangWaitState {
  const inspectedFrames = evidence.stack.slice(0, 12);
  for (const rule of WAIT_RULES) {
    const index = inspectedFrames.findIndex((frame) => rule.re.test(frame.name));
    if (index >= 0) {
      return {
        kind: rule.kind,
        blocked: true,
        confidence: rule.confidence,
        matchedFrameIndex: index,
        matchedFunction: inspectedFrames[index]?.name,
        rationale: [rule.rationale],
      };
    }
  }

  const project = assessProjectFrames(evidence.stack, analysisOptions)
    .find((item) => item.projectControlled);
  if (project) {
    return {
      kind: 'running-user-code',
      blocked: false,
      confidence: project.confidence,
      matchedFrameIndex: project.index,
      matchedFunction: project.frame.name,
      rationale: ['no recognized blocking primitive was found and a project-controlled frame is active'],
    };
  }

  return {
    kind: 'unknown',
    blocked: false,
    confidence: 'low',
    rationale: evidence.stack.length === 0
      ? ['the adapter returned no stack frames for this thread']
      : ['no recognized wait primitive or project-controlled active frame was found'],
  };
}

function buildPointerProvenance(evidence: HangThreadEvidence[]): PointerProvenanceV2 {
  const observations: PointerObservation[] = [];
  const nullLike: PointerProvenanceV2['nullLike'] = [];

  for (const threadEvidence of evidence) {
    for (const variableFrame of threadEvidence.variableFrames) {
      for (const variable of variableFrame.variables) {
        const resolved = variableAddress(variable);
        if (!resolved) continue;
        const observation: PointerObservation = {
          address: resolved.address,
          source: resolved.source,
          threadId: threadEvidence.thread.id,
          threadName: threadEvidence.thread.name,
          frameIndex: variableFrame.frameIndex,
          frameName: variableFrame.frame.name,
          variableName: variable.name,
          ...(variable.type === undefined ? {} : { variableType: variable.type }),
          variableValue: variable.value,
          role: pointerRole(variable),
        };
        if (resolved.address === '0x0') {
          nullLike.push({ ...observation, address: '0x0' });
        } else {
          observations.push(observation);
        }
      }
    }
  }

  const byAddress = new Map<string, PointerObservation[]>();
  for (const observation of observations) {
    const group = byAddress.get(observation.address) ?? [];
    group.push(observation);
    byAddress.set(observation.address, group);
  }

  const groups = [...byAddress.entries()].map(([address, items]) => {
    const threadIds = [...new Set(items.map((item) => item.threadId))].sort((a, b) => a - b);
    const aliases = [...new Set(items.map((item) => item.variableName))].sort();
    const synchronizationRelevant = items.some((item) => item.role === 'synchronization');
    const sharedAcrossThreads = threadIds.length > 1;
    const rationale: string[] = [];
    if (sharedAcrossThreads) rationale.push(`the same pointer value is visible from ${threadIds.length} threads`);
    if (aliases.length > 1) rationale.push(`the address is observed through ${aliases.length} variable names`);
    if (synchronizationRelevant) rationale.push('at least one observation is synchronization-related');
    if (items.some((item) => item.source === 'memoryReference')) {
      rationale.push('at least one observation uses an adapter-provided memoryReference');
    }
    return {
      address,
      observations: items,
      aliases,
      threadIds,
      sharedAcrossThreads,
      synchronizationRelevant,
      confidence: sharedAcrossThreads || items.some((item) => item.source === 'memoryReference')
        ? 'high'
        : 'medium',
      rationale,
    } satisfies PointerProvenanceGroup;
  }).sort((a, b) => {
    const score = (group: PointerProvenanceGroup) =>
      Number(group.synchronizationRelevant) * 4
      + Number(group.sharedAcrossThreads) * 2
      + group.observations.length;
    return score(b) - score(a) || a.address.localeCompare(b.address);
  });

  return {
    version: 2,
    groups,
    nullLike,
    limitations: [
      'Pointer provenance v2 correlates adapter-exposed pointer values across bounded thread/frame locals; it does not dereference arbitrary memory or infer object ownership without evidence.',
      'Matching addresses prove aliasing/value reuse, not lock ownership or causality by themselves.',
    ],
  };
}

function buildDeadlockHeuristic(
  triage: HangThreadTriage[],
  pointerProvenance: PointerProvenanceV2,
): DeadlockHeuristic {
  const blocked = triage.filter((item) => item.wait.blocked);
  const strongLockBlocked = blocked.filter((item) => STRONG_LOCK_WAITS.has(item.wait.kind));
  const ioBlocked = blocked.filter((item) => item.wait.kind === 'io');
  const runnableProject = triage.filter((item) => item.projectControlled && !item.wait.blocked);
  const sharedSynchronization = pointerProvenance.groups
    .filter((group) => group.sharedAcrossThreads && group.synchronizationRelevant);
  const evidence: string[] = [];

  if (blocked.length > 0) {
    evidence.push(`${blocked.length}/${triage.length} captured threads match a recognized blocking primitive.`);
  }
  if (strongLockBlocked.length > 0) {
    evidence.push(`${strongLockBlocked.length} thread(s) are blocked in strong lock/join waits.`);
  }
  if (runnableProject.length > 0) {
    evidence.push(`${runnableProject.length} project-controlled thread(s) do not match a known wait primitive.`);
  }
  if (sharedSynchronization.length > 0) {
    evidence.push(`${sharedSynchronization.length} synchronization-related pointer value(s) are visible across multiple threads.`);
  }

  let classification: DeadlockHeuristic['classification'] = 'unknown';
  let likelihood: DiagnosisConfidence = 'low';

  if (triage.length === 0) {
    classification = 'unknown';
  } else if (strongLockBlocked.length >= 2 && runnableProject.length === 0) {
    classification = 'deadlock-candidate';
    likelihood = 'medium';
    evidence.push('multiple threads are simultaneously blocked in strong lock/join waits and no project-controlled runnable thread was identified');
  } else if (sharedSynchronization.length > 0 && strongLockBlocked.length >= 1) {
    classification = 'lock-contention';
    likelihood = 'medium';
  } else if (blocked.length === triage.length && ioBlocked.length === blocked.length && blocked.length > 0) {
    classification = 'io-wait';
    likelihood = 'high';
  } else if (blocked.length === triage.length && blocked.length > 0) {
    classification = 'global-wait';
    likelihood = 'medium';
  } else if (blocked.length > 0) {
    classification = 'mixed-wait';
    likelihood = 'medium';
  } else {
    classification = 'no-deadlock-signal';
    likelihood = 'low';
  }

  return {
    classification,
    likelihood,
    blockedThreadIds: blocked.map((item) => item.threadId),
    runnableProjectThreadIds: runnableProject.map((item) => item.threadId),
    sharedSynchronizationAddresses: sharedSynchronization.map((group) => group.address),
    cycleProven: false,
    ownershipGraphAvailable: false,
    evidence,
    limitations: [
      'Generic DAP does not expose a portable lock-owner graph, so qwen-dap-mcp never labels a cycle as proven from stack waits alone.',
      'Condition-variable, semaphore, event, scheduler, and timer waits alone are not promoted to a deadlock candidate because they are common in healthy idle worker pools.',
      'A deadlock-candidate means the captured state is consistent with deadlock; confirm ownership/wait edges with adapter-specific lock metadata or repeated evidence when available.',
    ],
  };
}

export function analyzeHang(
  evidence: HangThreadEvidence[],
  analysisOptions: IntelligentDiagnosisOptions = {},
): HangDiagnosis {
  const allThreadTriage: HangThreadTriage[] = evidence.map((item) => {
    const project = assessProjectFrames(item.stack, analysisOptions)
      .find((assessment) => assessment.projectControlled);
    const wait = classifyThreadWait(item, analysisOptions);
    return {
      threadId: item.thread.id,
      threadName: item.thread.name,
      ...(item.stack[0] ? { topFunction: item.stack[0].name } : {}),
      ...(project ? { projectFunction: project.frame.name, projectFrameIndex: project.index } : {}),
      projectControlled: Boolean(project),
      wait,
      ...(item.collectionErrors?.length ? { collectionErrors: item.collectionErrors } : {}),
    };
  });

  const pointerProvenance = buildPointerProvenance(evidence);
  const deadlock = buildDeadlockHeuristic(allThreadTriage, pointerProvenance);
  const blockedCount = allThreadTriage.filter((item) => item.wait.blocked).length;
  const summary = allThreadTriage.length === 0
    ? 'No thread evidence was available for hang triage.'
    : `${blockedCount}/${allThreadTriage.length} captured threads match recognized wait states; global classification: ${deadlock.classification}.`;

  const nextActions: string[] = [];
  if (deadlock.classification === 'deadlock-candidate') {
    nextActions.push('Inspect the listed blocked threads together and confirm which thread owns each contended synchronization object before claiming a cycle.');
    nextActions.push('Use repeated captures or adapter-specific lock-owner diagnostics to distinguish a stable deadlock from temporary contention.');
  } else if (deadlock.classification === 'lock-contention') {
    nextActions.push('Inspect the shared synchronization pointer groups and compare the project-controlled caller frames that lead into the waits.');
  } else if (deadlock.classification === 'io-wait') {
    nextActions.push('Check whether the process is legitimately waiting for external I/O and identify the project frame that issued the blocking operation.');
  } else if (deadlock.classification === 'no-deadlock-signal') {
    nextActions.push('Look for busy-loop/livelock behavior in runnable project-controlled threads; a hang can occur without a blocking primitive.');
  } else {
    nextActions.push('Compare blocked and runnable project-controlled threads to identify the thread responsible for forward progress.');
  }
  if (pointerProvenance.groups.some((group) => group.sharedAcrossThreads)) {
    nextActions.push('Use Pointer-Provenance v2 cross-thread aliases as evidence anchors, not as proof of ownership or root cause.');
  }

  const collectionLimitations = evidence.flatMap((item) => item.collectionErrors ?? []);
  return {
    summary,
    classification: deadlock.classification,
    confidence: deadlock.likelihood,
    allThreadTriage,
    deadlock,
    pointerProvenance,
    nextActions,
    limitations: [
      'Hang triage is a bounded snapshot of thread state. It does not prove lack of forward progress unless the caller has independently established that the process is hung.',
      'Wait classification is heuristic and adapter/platform function names vary.',
      ...(collectionLimitations.length === 0
        ? []
        : [`Some thread evidence could not be collected: ${collectionLimitations.join('; ')}`]),
    ],
  };
}

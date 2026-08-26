import type { DebugProtocol } from '@vscode/debugprotocol';

export type SymbolHealthStatus = 'good' | 'partial' | 'poor' | 'unknown';

export type SymbolHealth = {
  status: SymbolHealthStatus;
  summary: string;
  stack: {
    totalFrames: number;
    namedFrames: number;
    sourceMappedFrames: number;
    topFrameNamed: boolean;
    topFrameSourceMapped: boolean;
  };
  modules: {
    collected: boolean;
    totalModules: number;
    withExplicitStatus: number;
    symbolsAvailable: number;
    symbolsMissing: number;
    symbolsUnknown: number;
  };
  limitations: string[];
};

const UNRESOLVED_FRAME_NAME = /^(?:\?\?|unknown|<unknown>|<unresolved>|0x[0-9a-f]+)$/i;
const NEGATIVE_SYMBOL_STATUS = /(?:not\s+(?:loaded|found|available)|missing|no\s+(?:symbols?|debug)|unavailable|failed|error)/i;
const POSITIVE_SYMBOL_STATUS = /(?:loaded|available|found|present|resolved|success)/i;

function frameHasName(frame: DebugProtocol.StackFrame): boolean {
  const name = frame.name?.trim();
  return Boolean(name && !UNRESOLVED_FRAME_NAME.test(name));
}

function frameHasSource(frame: DebugProtocol.StackFrame): boolean {
  const source = frame.source;
  const hasSourceIdentity = Boolean(source?.path?.trim() || source?.name?.trim());
  return hasSourceIdentity && Number.isFinite(frame.line) && frame.line > 0;
}

function moduleSymbolState(module: DebugProtocol.Module): 'available' | 'missing' | 'unknown' {
  const status = module.symbolStatus?.trim() ?? '';
  if (status && NEGATIVE_SYMBOL_STATUS.test(status)) return 'missing';
  if (module.symbolFilePath?.trim()) return 'available';
  if (status && POSITIVE_SYMBOL_STATUS.test(status)) return 'available';
  return 'unknown';
}

export function assessSymbolHealth(
  stack: readonly DebugProtocol.StackFrame[],
  modules?: readonly DebugProtocol.Module[],
): SymbolHealth {
  const namedFrames = stack.filter(frameHasName).length;
  const sourceMappedFrames = stack.filter(frameHasSource).length;
  const top = stack[0];
  const states = modules?.map(moduleSymbolState) ?? [];
  const symbolsAvailable = states.filter((state) => state === 'available').length;
  const symbolsMissing = states.filter((state) => state === 'missing').length;
  const symbolsUnknown = states.filter((state) => state === 'unknown').length;
  const withExplicitStatus = modules?.filter((module) => Boolean(module.symbolStatus?.trim() || module.symbolFilePath?.trim())).length ?? 0;

  let status: SymbolHealthStatus;
  if (stack.length === 0 && (modules?.length ?? 0) === 0) {
    status = 'unknown';
  } else if (
    stack.length > 0
    && namedFrames === 0
    && sourceMappedFrames === 0
    && symbolsAvailable === 0
  ) {
    status = 'poor';
  } else if (
    sourceMappedFrames === 0
    && symbolsMissing > 0
    && symbolsAvailable === 0
  ) {
    status = 'poor';
  } else if (
    namedFrames > 0
    && sourceMappedFrames > 0
    && symbolsMissing === 0
  ) {
    status = 'good';
  } else if (namedFrames > 0 || sourceMappedFrames > 0 || symbolsAvailable > 0) {
    status = 'partial';
  } else {
    status = 'unknown';
  }

  const limitations: string[] = [];
  if (modules === undefined) {
    limitations.push('Loaded-module symbol status was not collected for this snapshot.');
  } else if (modules.length > 0 && withExplicitStatus === 0) {
    limitations.push('The adapter returned modules without explicit symbolStatus or symbolFilePath evidence.');
  }
  if (stack.length > 0 && namedFrames === 0) {
    limitations.push('No sampled stack frame exposes a resolved function name.');
  }
  if (stack.length > 0 && sourceMappedFrames === 0) {
    limitations.push('No sampled stack frame includes source file and line information.');
  }

  const summary = status === 'good'
    ? 'Resolved function names and source locations are present, with no explicit missing-module symbol evidence.'
    : status === 'partial'
      ? 'Some symbol evidence is resolved, but stack/source/module evidence is incomplete or mixed.'
      : status === 'poor'
        ? 'The sampled stop has little usable symbol/source evidence or explicit missing-symbol evidence.'
        : 'The snapshot does not contain enough symbol evidence for a reliable quality classification.';

  return {
    status,
    summary,
    stack: {
      totalFrames: stack.length,
      namedFrames,
      sourceMappedFrames,
      topFrameNamed: top ? frameHasName(top) : false,
      topFrameSourceMapped: top ? frameHasSource(top) : false,
    },
    modules: {
      collected: modules !== undefined,
      totalModules: modules?.length ?? 0,
      withExplicitStatus,
      symbolsAvailable,
      symbolsMissing,
      symbolsUnknown,
    },
    limitations,
  };
}

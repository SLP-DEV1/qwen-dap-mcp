let buffer = Buffer.alloc(0);
let seq = 1;
let launchRequest;

function write(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function response(request, body = {}) {
  write({ seq: seq++, type: 'response', request_seq: request.seq, success: true, command: request.command, body });
}

function failure(request, message) {
  write({ seq: seq++, type: 'response', request_seq: request.seq, success: false, command: request.command, message });
}

function event(name, body = {}) {
  write({ seq: seq++, type: 'event', event: name, body });
}

function verifiedBreakpoints(items = []) {
  return items.map((item, index) => ({
    id: index + 1,
    verified: true,
    ...(item.line ? { line: item.line } : {}),
    ...(item.instructionReference ? { instructionReference: item.instructionReference } : {}),
  }));
}

function handle(request) {
  switch (request.command) {
    case 'initialize':
      response(request, {
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
        supportsModulesRequest: true,
        supportsDisassembleRequest: true,
        supportsReadMemoryRequest: true,
        supportsExceptionInfoRequest: true,
        supportsConditionalBreakpoints: true,
        supportsHitConditionalBreakpoints: true,
        supportsLogPoints: true,
        supportsFunctionBreakpoints: true,
        supportsInstructionBreakpoints: true,
        supportsDataBreakpoints: true,
        exceptionBreakpointFilters: [
          { filter: 'mock_throw', label: 'Mock throw', default: false, supportsCondition: true },
        ],
      });
      break;
    case 'launch':
    case 'attach':
      if (request.arguments?.failImmediately) {
        failure(request, `Mock ${request.command} rejected immediately`);
        break;
      }
      launchRequest = request;
      event('initialized');
      break;
    case 'setBreakpoints':
      response(request, { breakpoints: verifiedBreakpoints(request.arguments?.breakpoints ?? []) });
      break;
    case 'setFunctionBreakpoints':
      response(request, { breakpoints: verifiedBreakpoints(request.arguments?.breakpoints ?? []) });
      break;
    case 'setInstructionBreakpoints':
      response(request, { breakpoints: verifiedBreakpoints(request.arguments?.breakpoints ?? []) });
      break;
    case 'dataBreakpointInfo':
      response(request, {
        dataId: `mock:${request.arguments?.name ?? 'value'}`,
        description: `Mock watchpoint for ${request.arguments?.name ?? 'value'}`,
        accessTypes: ['read', 'write', 'readWrite'],
        canPersist: true,
      });
      break;
    case 'setDataBreakpoints':
      response(request, { breakpoints: verifiedBreakpoints(request.arguments?.breakpoints ?? []) });
      break;
    case 'setExceptionBreakpoints':
      response(request, {
        breakpoints: (request.arguments?.filters ?? []).map((filter, index) => ({ id: index + 1, verified: true, message: filter })),
      });
      break;
    case 'configurationDone':
      response(request);
      if (launchRequest) {
        response(launchRequest);
        launchRequest = undefined;
      }
      event('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
      break;
    case 'threads':
      response(request, { threads: [{ id: 1, name: 'main' }] });
      break;
    case 'stackTrace':
      response(request, {
        stackFrames: [{
          id: 100,
          name: 'main',
          source: { name: 'main.cpp', path: '/tmp/main.cpp' },
          line: 42,
          column: 1,
          instructionPointerReference: '0x1000',
          moduleId: 'mock-main',
        }],
        totalFrames: 1,
      });
      break;
    case 'scopes':
      response(request, {
        scopes: [
          { name: 'Locals', variablesReference: 200, expensive: false },
          { name: 'Registers', variablesReference: 300, expensive: false },
        ],
      });
      break;
    case 'variables':
      if (request.arguments?.variablesReference === 300) {
        response(request, {
          variables: [
            { name: 'rip', value: '0x1000', type: 'uint64', variablesReference: 0 },
            { name: 'rsp', value: '0x2000', type: 'uint64', variablesReference: 0 },
          ],
        });
      } else {
        response(request, { variables: [{ name: 'answer', value: '42', type: 'int', variablesReference: 0 }] });
      }
      break;
    case 'evaluate':
      response(request, { result: '42', type: 'int', variablesReference: 0 });
      break;
    case 'modules':
      response(request, {
        modules: [{ id: 'mock-main', name: 'fake-app', path: '/tmp/fake-app', addressRange: '0x1000-0x1fff', symbolStatus: 'Symbols loaded' }],
        totalModules: 1,
      });
      break;
    case 'disassemble': {
      const count = request.arguments?.instructionCount ?? 4;
      const instructionOffset = request.arguments?.instructionOffset ?? 0;
      response(request, {
        instructions: Array.from({ length: count }, (_, index) => ({
          address: `0x${(0x1000 + instructionOffset + index).toString(16)}`,
          instructionBytes: index === 0 ? '90' : 'cc',
          instruction: index === 0 ? 'nop' : 'int3',
          symbol: index === 0 ? 'main' : undefined,
        })),
      });
      break;
    }
    case 'readMemory': {
      const requested = request.arguments?.count ?? 4;
      const bytes = Buffer.from([0x90, 0x90, 0xcc, 0xc3]).subarray(0, requested);
      response(request, {
        address: request.arguments?.memoryReference ?? '0x1000',
        data: bytes.toString('base64'),
        unreadableBytes: Math.max(0, requested - bytes.length),
      });
      break;
    }
    case 'exceptionInfo':
      response(request, {
        exceptionId: 'MOCK_ACCESS_VIOLATION',
        description: 'Mock access violation',
        breakMode: 'unhandled',
        details: { message: 'Mock exception details' },
      });
      break;
    case 'pause':
      if (request.arguments?.threadId === 999) {
        failure(request, 'Mock pause rejected');
        break;
      }
      response(request);
      setTimeout(() => event('stopped', { reason: 'pause', threadId: request.arguments?.threadId ?? 1, allThreadsStopped: true }), 5);
      break;
    case 'continue':
    case 'next':
    case 'stepIn':
    case 'stepOut':
      if (request.arguments?.threadId === 999) {
        failure(request, `Mock ${request.command} rejected`);
        break;
      }
      response(request, request.command === 'continue' ? { allThreadsContinued: true } : {});
      setTimeout(() => event('stopped', {
        reason: request.command === 'continue' ? 'breakpoint' : 'step',
        threadId: 1,
        allThreadsStopped: true,
      }), 5);
      break;
    case 'disconnect':
      response(request);
      event('terminated');
      setTimeout(() => process.exit(0), 5);
      break;
    default:
      failure(request, `Unsupported mock command: ${request.command}`);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const payload = buffer.subarray(start, end).toString('utf8');
    buffer = buffer.subarray(end);
    handle(JSON.parse(payload));
  }
});

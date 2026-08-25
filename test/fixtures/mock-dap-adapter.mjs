let buffer = Buffer.alloc(0);
let seq = 1;
let launchRequest;

function write(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function response(request, body = {}) {
  write({
    seq: seq++,
    type: 'response',
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  });
}

function event(name, body = {}) {
  write({ seq: seq++, type: 'event', event: name, body });
}

function handle(request) {
  switch (request.command) {
    case 'initialize':
      response(request, {
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
      });
      break;
    case 'launch':
    case 'attach':
      launchRequest = request;
      event('initialized');
      break;
    case 'setBreakpoints':
      response(request, {
        breakpoints: (request.arguments?.breakpoints ?? []).map((bp, index) => ({
          id: index + 1,
          verified: true,
          line: bp.line,
        })),
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
        stackFrames: [
          {
            id: 100,
            name: 'main',
            source: { name: 'main.cpp', path: '/tmp/main.cpp' },
            line: 42,
            column: 1,
          },
        ],
        totalFrames: 1,
      });
      break;
    case 'scopes':
      response(request, {
        scopes: [{ name: 'Locals', variablesReference: 200, expensive: false }],
      });
      break;
    case 'variables':
      response(request, {
        variables: [{ name: 'answer', value: '42', type: 'int', variablesReference: 0 }],
      });
      break;
    case 'evaluate':
      response(request, { result: '42', type: 'int', variablesReference: 0 });
      break;
    case 'continue':
    case 'next':
    case 'stepIn':
    case 'stepOut':
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
      write({
        seq: seq++,
        type: 'response',
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: `Unsupported mock command: ${request.command}`,
      });
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

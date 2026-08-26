import { isIP } from 'node:net';

import { DapError } from './dap/errors.js';

export const REMOTE_DEBUG_HOSTS_ENV = 'QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS';

export type RemoteTcpEndpoint = {
  host: string;
  port: number;
  target: string;
  loopback: boolean;
};

function stripIpv6Brackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

export function normalizeRemoteDebugHost(value: string): string {
  const host = stripIpv6Brackets(value.trim()).toLowerCase();
  if (!host) throw new DapError('Remote debugger host must not be empty.');
  if (host.length > 253) throw new DapError('Remote debugger host is too long.');
  if (/\s|[\u0000-\u001f\u007f]/.test(host)) {
    throw new DapError('Remote debugger host must not contain whitespace or control characters.');
  }

  const ipVersion = isIP(host);
  if (ipVersion === 0) {
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      throw new DapError(`Invalid remote debugger hostname '${value}'.`);
    }
    for (const label of host.split('.')) {
      if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) {
        throw new DapError(`Invalid remote debugger hostname '${value}'.`);
      }
    }
  }
  return host;
}

export function isLoopbackRemoteDebugHost(host: string): boolean {
  const normalized = normalizeRemoteDebugHost(host);
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
  }
  return false;
}

function configuredRemoteHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env[REMOTE_DEBUG_HOSTS_ENV];
  if (!raw?.trim()) return new Set();
  const hosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    hosts.add(normalizeRemoteDebugHost(trimmed));
  }
  return hosts;
}

export function assertRemoteDebugHostAllowed(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = normalizeRemoteDebugHost(host);
  if (isLoopbackRemoteDebugHost(normalized)) return normalized;

  const allowlist = configuredRemoteHosts(env);
  if (allowlist.has(normalized)) return normalized;

  throw new DapError(
    `Remote debugger host '${normalized}' is not allowed. Loopback endpoints are allowed by default. `
      + `For an explicitly authorized remote target, add the exact hostname or IP to ${REMOTE_DEBUG_HOSTS_ENV}. `
      + 'Prefer an SSH/VPN tunnel to a loopback endpoint because native debug servers do not provide a general secure transport boundary.',
  );
}

export function buildRemoteTcpEndpoint(
  host: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): RemoteTcpEndpoint {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new DapError(`Remote debugger port must be an integer from 1 to 65535; received ${String(port)}.`);
  }
  const normalizedHost = assertRemoteDebugHostAllowed(host, env);
  const targetHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return {
    host: normalizedHost,
    port,
    target: `${targetHost}:${port}`,
    loopback: isLoopbackRemoteDebugHost(normalizedHost),
  };
}

export function parseRemoteTcpTarget(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoteTcpEndpoint {
  const value = target.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DapError('Remote debugger target must be a TCP host:port endpoint.');
  }

  let host: string;
  let portText: string;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close <= 1 || value[close + 1] !== ':') {
      throw new DapError(`Invalid bracketed remote debugger endpoint '${target}'.`);
    }
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || value.indexOf(':') !== separator) {
      throw new DapError(
        `Remote debugger target '${target}' must use host:port; bracket IPv6 addresses as [::1]:1234.`,
      );
    }
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }

  if (!/^\d{1,5}$/.test(portText)) {
    throw new DapError(`Remote debugger target '${target}' has an invalid TCP port.`);
  }
  return buildRemoteTcpEndpoint(host, Number(portText), env);
}

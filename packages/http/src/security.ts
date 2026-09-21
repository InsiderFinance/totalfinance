/** Shared HTTP policy: discovery and dispatch must agree about which calls need authority. */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ErrorCode, InputError } from '@totalfinance/core';

export function operationWrites(operation: {
  sideEffect: string;
  requiredCapabilities: readonly string[];
}): boolean {
  // Approval persists a grant even though its domain sideEffect is `none`.
  return (
    operation.sideEffect !== 'none' ||
    operation.requiredCapabilities.some((name) =>
      ['trade:approve', 'trade:paper', 'portfolio:write'].includes(name),
    )
  );
}

export class HttpRequestError extends InputError {
  constructor(
    readonly status: number,
    message: string,
    field: string,
    code: ErrorCode = ErrorCode.InputWrongShape,
  ) {
    super(message, { code, context: { function: 'createLocalHttpServer', field } });
  }
}

export function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]!.toLowerCase() === name) count += 1;
  }
  const value = request.headers[name];
  if (count > 1 || Array.isArray(value)) {
    throw new HttpRequestError(400, `Only one ${name} header is supported.`, name);
  }
  return value;
}

/** Validate authorities without DNS resolution, aliases supplied by the caller, or forwarded headers. */
export function requireLocalRequest(request: IncomingMessage, host: string): void {
  const authority = singleHeader(request, 'host');
  const origin = singleHeader(request, 'origin');
  const localPort = request.socket.localPort;
  const allowedHosts = new Set([hostForUrl(host).toLowerCase()]);
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
    for (const alias of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(alias);
  } else if (request.socket.localAddress !== undefined) {
    allowedHosts.add(hostForUrl(request.socket.localAddress).toLowerCase());
  }
  const expectedAuthority = (value: string): boolean => {
    try {
      const parsed = new URL(`http://${value}`);
      return (
        // Reject userinfo, paths, whitespace, percent-encoded hosts and URL parser rewrites.
        (parsed.host.toLowerCase() === value.toLowerCase() ||
          (localPort === 80 && `${parsed.host.toLowerCase()}:80` === value.toLowerCase())) &&
        parsed.username === '' &&
        parsed.password === '' &&
        allowedHosts.has(parsed.hostname.toLowerCase()) &&
        Number(parsed.port || 80) === localPort
      );
    } catch {
      return false;
    }
  };
  if (authority === undefined || !expectedAuthority(authority)) {
    throw new HttpRequestError(
      authority === undefined ? 400 : 403,
      'Host must name this server and its bound port.',
      'host',
    );
  }
  if (origin !== undefined) {
    // Missing Origin is normal for local non-browser clients; opaque/null origins are not trusted.
    if (!origin.startsWith('http://') || !expectedAuthority(origin.slice('http://'.length))) {
      throw new HttpRequestError(
        403,
        'Origin must name this local HTTP server and port.',
        'origin',
      );
    }
  }
}

export function requireJson(request: IncomingMessage): void {
  const contentType = singleHeader(request, 'content-type');
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpRequestError(
      415,
      'JSON POST requests require Content-Type: application/json.',
      'content-type',
    );
  }
}

export function requireBearer(request: IncomingMessage, token: Buffer | undefined): void {
  if (token === undefined) {
    throw new HttpRequestError(
      403,
      'This server has no write credential. Configure authenticationToken (at least 32 random characters), --token-file, or TOTALFINANCE_HTTP_TOKEN to enable authenticated mutations.',
      'authorization',
      ErrorCode.OperationCapabilityMissing,
    );
  }
  const authorization = singleHeader(request, 'authorization');
  const match =
    authorization === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
  const received = Buffer.from(match?.[1] ?? '', 'utf8');
  if (received.length !== token.length || !timingSafeEqual(received, token)) {
    throw new HttpRequestError(
      401,
      'A valid server-owned Authorization: Bearer credential is required for this mutation.',
      'authorization',
      ErrorCode.OperationCapabilityMissing,
    );
  }
}

/** Only origin-form targets; decode once, inside the handler's protected boundary. */
export function requestRoute(target: string): { pathname: string; segments: string[] } {
  const hasControl = (value: string): boolean =>
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  try {
    if (
      !target.startsWith('/') ||
      target.startsWith('//') ||
      /[\\#\s]/.test(target) ||
      hasControl(target)
    ) {
      throw new Error('invalid target');
    }
    // Validate escapes in queries too, even though current routes do not consume query parameters.
    decodeURIComponent(target);
    const pathname = target.split('?')[0]!;
    const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    for (const [index, segment] of segments.entries()) {
      if (
        segment.includes('\\') ||
        hasControl(segment) ||
        segment === '.' ||
        segment === '..' ||
        (segment.includes('/') && !(segments[0] === 'artifacts' && index > 0))
      ) {
        throw new Error('invalid segment');
      }
    }
    return { pathname: new URL(target, 'http://localhost').pathname, segments };
  } catch {
    throw new HttpRequestError(400, 'Malformed HTTP request target or URL encoding.', 'url');
  }
}

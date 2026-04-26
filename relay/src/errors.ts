// Error envelope and code mapping per lld.md §3.5.

export type ErrorSymbol =
  | 'parse_error'
  | 'invalid_request'
  | 'method_not_found'
  | 'invalid_params'
  | 'unauthenticated'
  | 'forbidden'
  | 'rate_limited'
  | 'recipient_not_found'
  | 'not_a_participant'
  | 'thread_not_found'
  | 'thread_terminal'
  | 'invalid_transition'
  | 'not_authorized_transition'
  | 'state_changed'
  | 'duplicate_idempotency_key'
  | 'invalid_intent_payload'
  | 'teammate_blocked'
  | 'internal';

interface ErrorMapping {
  rpc: number;
  http: number;
}

export const ERROR_MAP: Record<ErrorSymbol, ErrorMapping> = {
  parse_error: { rpc: -32700, http: 400 },
  invalid_request: { rpc: -32600, http: 400 },
  method_not_found: { rpc: -32601, http: 404 },
  invalid_params: { rpc: -32602, http: 400 },
  unauthenticated: { rpc: -32001, http: 401 },
  forbidden: { rpc: -32002, http: 403 },
  rate_limited: { rpc: -32003, http: 429 },
  recipient_not_found: { rpc: -32004, http: 404 },
  not_a_participant: { rpc: -32005, http: 403 },
  thread_not_found: { rpc: -32006, http: 404 },
  thread_terminal: { rpc: -32007, http: 409 },
  invalid_transition: { rpc: -32008, http: 409 },
  not_authorized_transition: { rpc: -32009, http: 403 },
  state_changed: { rpc: -32010, http: 409 },
  duplicate_idempotency_key: { rpc: -32011, http: 409 },
  invalid_intent_payload: { rpc: -32012, http: 400 },
  teammate_blocked: { rpc: -32013, http: 403 },
  internal: { rpc: -32099, http: 500 },
};

export interface ErrorEnvelope {
  code: ErrorSymbol;
  message: string;
  request_id: string;
  details?: Record<string, unknown>;
}

export class RelayError extends Error {
  readonly code: ErrorSymbol;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorSymbol, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_MAP[this.code].http;
  }

  get rpcCode(): number {
    return ERROR_MAP[this.code].rpc;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      request_id: requestId,
      details: this.details,
    };
  }
}

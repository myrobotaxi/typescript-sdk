// Typed REST endpoint callers (MYR-80). Thin wrappers over HttpCore;
// every path derives from the single baseUrl config. Endpoint reference:
// rest-api.md §7.

import type { VehicleState } from '@myrobotaxi/contracts/types';
import { HttpCore } from './http.js';
import type { Paginated, RequestOpts, RestClientOptions, RestResult } from './types.js';

export interface VehicleSummary {
  readonly id: string;
  readonly name: string;
  /** Always redacted to last-4 by the server (data-classification §2.1). */
  readonly vin: string;
}

export interface DriveSummary {
  readonly id: string;
  readonly vehicleId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly distance?: number;
  readonly duration?: number;
}

export interface InviteRecord {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
}

export class RestClient {
  private readonly http: HttpCore;

  constructor(opts: RestClientOptions) {
    this.http = new HttpCore(opts);
  }

  readonly vehicles = {
    /** GET /api/vehicles — owned vehicles (rest-api.md §7.0, MYR-91). */
    list: (o: RequestOpts = {}): Promise<RestResult<VehicleSummary[]>> =>
      this.http.request('GET', '/api/vehicles', o),
  };

  readonly snapshot = {
    /** GET /api/vehicles/{id}/snapshot (NFR-3.11, FR-2.1). */
    get: (vehicleId: string, o: RequestOpts = {}): Promise<RestResult<Partial<VehicleState>>> =>
      this.http.request('GET', `/api/vehicles/${encodeURIComponent(vehicleId)}/snapshot`, o),
  };

  readonly drives = {
    /** GET /api/vehicles/{id}/drives — cursor-paginated (rest-api §4.2). */
    list: (
      vehicleId: string,
      page: { cursor?: string; limit?: number } = {},
      o: RequestOpts = {},
    ): Promise<RestResult<Paginated<DriveSummary>>> =>
      this.http.request('GET', `/api/vehicles/${encodeURIComponent(vehicleId)}/drives`, {
        ...o,
        query: { cursor: page.cursor, limit: page.limit },
      }),
    /** GET /api/drives/{driveId} (FR-3.4). */
    get: (driveId: string, o: RequestOpts = {}): Promise<RestResult<DriveSummary>> =>
      this.http.request('GET', `/api/drives/${encodeURIComponent(driveId)}`, o),
    /** GET /api/drives/{driveId}/route (FR-3.3).
     *  TODO(MYR-55): replace `unknown` with the generated route-shape
     *  type from @myrobotaxi/contracts once the contract doc settles. */
    route: (driveId: string, o: RequestOpts = {}): Promise<RestResult<unknown>> =>
      this.http.request('GET', `/api/drives/${encodeURIComponent(driveId)}/route`, o),
  };

  readonly invites = {
    /** POST /api/invites (FR-5.1). */
    create: (email: string, o: RequestOpts = {}): Promise<RestResult<InviteRecord>> =>
      this.http.request('POST', '/api/invites', { ...o, body: { email } }),
    /** GET /api/invites (FR-5.2). */
    list: (o: RequestOpts = {}): Promise<RestResult<InviteRecord[]>> =>
      this.http.request('GET', '/api/invites', o),
    /** DELETE /api/invites/{id} (FR-5.3). */
    revoke: (inviteId: string, o: RequestOpts = {}): Promise<RestResult<void>> =>
      this.http.request('DELETE', `/api/invites/${encodeURIComponent(inviteId)}`, o),
  };

  readonly users = {
    /** DELETE /api/users/me (FR-10.1). */
    delete: (o: RequestOpts = {}): Promise<RestResult<void>> =>
      this.http.request('DELETE', '/api/users/me', o),
    /** GET /api/users/me/export (GDPR Art. 15/20, rest-api §7.7).
     *  TODO(MYR-55): type the export archive shape from the contract
     *  once it settles; `unknown` is intentional until then. */
    export: (o: RequestOpts = {}): Promise<RestResult<unknown>> =>
      this.http.request('GET', '/api/users/me/export', o),
  };
}

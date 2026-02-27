import type { Session } from '../types';
import { importPrivateKey, createDPoPProof } from './oauth';

/**
 * Response type for listRecords API
 */
export interface ListRecordsResponse<T = unknown> {
  records: Array<{
    uri: string;
    cid: string;
    value: T;
  }>;
  cursor?: string;
}

/**
 * Response type for putRecord API
 */
export interface PutRecordResponse {
  uri: string;
  cid: string;
}

/**
 * Write operation for applyWrites
 */
export type WriteOp =
  | {
      $type: 'com.atproto.repo.applyWrites#create';
      collection: string;
      rkey: string;
      value: unknown;
    }
  | {
      $type: 'com.atproto.repo.applyWrites#update';
      collection: string;
      rkey: string;
      value: unknown;
    }
  | { $type: 'com.atproto.repo.applyWrites#delete'; collection: string; rkey: string };

/**
 * Response type for applyWrites API
 */
export interface ApplyWritesResponse {
  commit: {
    cid: string;
    rev: string;
  };
  results: Array<{
    uri: string;
    cid: string;
  }>;
}

/**
 * Error returned by PDS API
 */
export interface PDSError {
  error: string;
  message?: string;
}

/**
 * Result of a PDS operation
 */
export type PDSResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; retryable: boolean };

/**
 * Client for interacting with the user's Personal Data Server (PDS)
 * Uses DPoP for authenticated requests
 */
export class PDSClient {
  private session: Session;
  private dpopNonce: string | null = null;

  constructor(session: Session) {
    this.session = session;
  }

  /**
   * Make an authenticated request to the PDS
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<PDSResult<T>> {
    const url = `${this.session.pdsUrl}/xrpc/${endpoint}`;
    console.log(`[PDSClient] ${method} ${url}`);

    try {
      // Import the DPoP key
      const privateKeyJwk = JSON.parse(this.session.dpopPrivateKey);
      const privateKey = await importPrivateKey(privateKeyJwk);
      const publicKeyJwk = { ...privateKeyJwk };
      delete (publicKeyJwk as Record<string, unknown>).d;

      // Create DPoP proof with access token hash (ath)
      let dpopProof = await createDPoPProof(
        privateKey,
        publicKeyJwk,
        method,
        url,
        this.dpopNonce || undefined,
        this.session.accessToken
      );

      const headers: Record<string, string> = {
        Authorization: `DPoP ${this.session.accessToken}`,
        DPoP: dpopProof,
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      let response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle DPoP nonce requirement
      // Track error text/data to avoid reading response body twice
      let errorText: string | null = null;
      let errorData: PDSError | null = null;

      if (!response.ok) {
        errorText = await response.text();
        try {
          errorData = JSON.parse(errorText) as PDSError;
        } catch {
          // Not JSON
        }

        const newNonce = response.headers.get('DPoP-Nonce');

        if (errorData?.error === 'use_dpop_nonce' && newNonce) {
          // Store nonce for future requests and retry
          this.dpopNonce = newNonce;
          // Reset - we'll get fresh error from retry if needed
          errorText = null;
          errorData = null;

          dpopProof = await createDPoPProof(
            privateKey,
            publicKeyJwk,
            method,
            url,
            newNonce,
            this.session.accessToken
          );

          response = await fetch(url, {
            method,
            headers: {
              ...headers,
              DPoP: dpopProof,
            },
            body: body ? JSON.stringify(body) : undefined,
          });
        }
      }

      // Store any new nonce for future requests
      const responseNonce = response.headers.get('DPoP-Nonce');
      if (responseNonce) {
        this.dpopNonce = responseNonce;
      }

      if (!response.ok) {
        // Only read body if we haven't already (retry case or fresh error)
        if (errorText === null) {
          errorText = await response.text();
          try {
            errorData = JSON.parse(errorText) as PDSError;
          } catch {
            // Not JSON
          }
        }

        let errorMessage = `HTTP ${response.status}`;
        if (errorData) {
          errorMessage = errorData.message || errorData.error || errorMessage;
        } else if (errorText) {
          errorMessage = errorText.substring(0, 100);
        }

        // Determine if error is retryable
        const retryable = response.status === 429 || response.status >= 500;

        console.error(`[PDSClient] Request failed: ${method} ${endpoint}`, {
          status: response.status,
          error: errorMessage,
        });

        return { success: false, error: errorMessage, retryable };
      }

      const data = (await response.json()) as T;
      console.log(`[PDSClient] ${method} ${endpoint} succeeded`);
      return { success: true, data };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Network error';
      console.error(`[PDSClient] Request error: ${method} ${endpoint}`, error);
      return { success: false, error: errorMessage, retryable: true };
    }
  }

  /**
   * List records in a collection with pagination support
   */
  async listRecords<T = unknown>(
    collection: string,
    cursor?: string,
    limit = 100
  ): Promise<PDSResult<ListRecordsResponse<T>>> {
    const params = new URLSearchParams({
      repo: this.session.did,
      collection,
      limit: String(limit),
    });
    if (cursor) {
      params.set('cursor', cursor);
    }

    return this.request<ListRecordsResponse<T>>('GET', `com.atproto.repo.listRecords?${params}`);
  }

  /**
   * List all records in a collection (handles pagination)
   * Includes safety limits to prevent infinite loops from malicious/buggy PDS
   */
  async listAllRecords<T = unknown>(
    collection: string,
    options?: { maxPages?: number; maxRecords?: number }
  ): Promise<PDSResult<Array<{ uri: string; cid: string; value: T }>>> {
    const MAX_PAGES = options?.maxPages ?? 50;
    const MAX_RECORDS = options?.maxRecords ?? 10000;

    const allRecords: Array<{ uri: string; cid: string; value: T }> = [];
    let cursor: string | undefined;
    let pageCount = 0;

    while (pageCount < MAX_PAGES && allRecords.length < MAX_RECORDS) {
      const result = await this.listRecords<T>(collection, cursor);
      if (!result.success) {
        return result;
      }

      allRecords.push(...result.data.records);
      pageCount++;

      if (!result.data.cursor || result.data.records.length === 0) {
        break;
      }
      cursor = result.data.cursor;
    }

    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[PDSClient] Hit max page limit (${MAX_PAGES}) for collection ${collection}, ` +
          `fetched ${allRecords.length} records`
      );
    }

    if (allRecords.length >= MAX_RECORDS) {
      console.warn(
        `[PDSClient] Hit max record limit (${MAX_RECORDS}) for collection ${collection}`
      );
    }

    return { success: true, data: allRecords };
  }

  /**
   * Create or update a record in the PDS
   */
  async putRecord(
    collection: string,
    rkey: string,
    record: unknown
  ): Promise<PDSResult<PutRecordResponse>> {
    return this.request<PutRecordResponse>('POST', 'com.atproto.repo.putRecord', {
      repo: this.session.did,
      collection,
      rkey,
      record,
    });
  }

  /**
   * Delete a record from the PDS
   */
  async deleteRecord(collection: string, rkey: string): Promise<PDSResult<void>> {
    // deleteRecord returns empty body on success
    const result = await this.request<Record<string, never>>(
      'POST',
      'com.atproto.repo.deleteRecord',
      {
        repo: this.session.did,
        collection,
        rkey,
      }
    );

    if (result.success) {
      return { success: true, data: undefined };
    }
    return result;
  }

  /**
   * Apply multiple write operations in a single request (batch)
   * This uses only 1-2 subrequests regardless of how many operations
   */
  async applyWrites(writes: WriteOp[]): Promise<PDSResult<ApplyWritesResponse>> {
    if (writes.length === 0) {
      return {
        success: true,
        data: { commit: { cid: '', rev: '' }, results: [] },
      };
    }

    return this.request<ApplyWritesResponse>('POST', 'com.atproto.repo.applyWrites', {
      repo: this.session.did,
      writes,
    });
  }

  /**
   * Batch create/update multiple records in a single request
   * Returns the URIs and CIDs for each record
   *
   * First attempts applyWrites#create for efficiency.
   * Falls back to individual putRecord calls (upserts) if batch fails,
   * which handles cases where rkeys already exist on PDS.
   */
  async putRecordsBatch(
    records: Array<{ collection: string; rkey: string; record: unknown }>
  ): Promise<PDSResult<Array<{ uri: string; cid: string }>>> {
    const writes: WriteOp[] = records.map((r) => ({
      $type: 'com.atproto.repo.applyWrites#create' as const,
      collection: r.collection,
      rkey: r.rkey,
      value: r.record,
    }));

    const result = await this.applyWrites(writes);
    if (result.success) {
      return { success: true, data: result.data.results };
    }

    // Batch create failed - likely due to existing rkeys. Fall back to individual upserts.
    console.log(
      `[PDSClient] Batch create failed (${result.error}), falling back to individual puts...`
    );

    const results: Array<{ uri: string; cid: string }> = [];
    const errors: string[] = [];

    for (const record of records) {
      const putResult = await this.putRecord(record.collection, record.rkey, record.record);
      if (putResult.success) {
        results.push({ uri: putResult.data.uri, cid: putResult.data.cid });
      } else {
        errors.push(`${record.rkey}: ${putResult.error}`);
      }
    }

    if (errors.length > 0) {
      console.error(`[PDSClient] ${errors.length}/${records.length} puts failed:`, errors);
    }

    if (results.length === 0 && errors.length > 0) {
      return { success: false, error: errors.join('; '), retryable: false };
    }

    console.log(
      `[PDSClient] Fallback puts completed: ${results.length}/${records.length} succeeded`
    );
    return { success: true, data: results };
  }
}

/**
 * Create a PDS client for the given session
 */
export function createPDSClient(session: Session): PDSClient {
  return new PDSClient(session);
}

import type {CapabilitySpec} from './compat';
import {RESULT_EXPORT_PREPARE, RESULT_EXPORT_READ_CHUNK} from './material-result-export';

/** Fixed result operations: metadata first, bytes only after local approval. */
export function resultFileCapabilities(endpoint: string, ready: boolean): CapabilitySpec[] {
  if (!ready) return [];
  const id = {type: 'string', minLength: 1, maxLength: 1024};
  const common = {version: {const: 1}, endpoint_id: {const: endpoint}, authorization_revision: {type: 'string', pattern: '^[a-f0-9]{64}$'}};
  return [
    {name: RESULT_EXPORT_PREPARE, description: 'Prepare one referenced Codex result file for local approval', risk: 'none', timeout_ms: 30000,
      input_schema: {type: 'object', additionalProperties: false, required: [...Object.keys(common), 'work', 'turn_id', 'source_message_id', 'exact_href'], properties: {...common,
        work: {type: 'object', additionalProperties: false, required: ['node_id', 'endpoint_id', 'kind', 'native_id'], properties: {node_id: {const: endpoint}, endpoint_id: {const: endpoint}, kind: {const: 'conversation'}, native_id: id}}, turn_id: id, source_message_id: id, exact_href: id, page_cursor: id}}},
    {name: RESULT_EXPORT_READ_CHUNK, description: 'Read a chunk of a separately approved result snapshot', risk: 'none', timeout_ms: 30000,
      input_schema: {type: 'object', additionalProperties: false, required: [...Object.keys(common), 'export_id', 'asset_version', 'sha256', 'chunk_index'], properties: {...common, export_id: id, asset_version: {const: 1}, sha256: {type: 'string', pattern: '^[a-f0-9]{64}$'}, chunk_index: {type: 'integer', minimum: 0, maximum: 102}}}},
  ];
}

/**
 * Mnestra — core type definitions
 */

export type SourceType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'bug_fix'
  | 'architecture'
  | 'code_context';

export type Category =
  | 'technical'
  | 'business'
  | 'workflow'
  | 'debugging'
  | 'architecture'
  | 'convention'
  | 'relationship';

export type Importance = 'critical' | 'important' | 'minor';

export type RelationshipType =
  | 'supersedes'
  | 'relates_to'
  | 'contradicts'
  | 'elaborates'
  | 'caused_by'
  | 'blocks'
  | 'inspired_by'
  | 'cross_project_link';

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'supersedes',
  'relates_to',
  'contradicts',
  'elaborates',
  'caused_by',
  'blocks',
  'inspired_by',
  'cross_project_link',
];

export interface MemoryItem {
  id: string;
  content: string;
  source_type: SourceType;
  category: Category | null;
  project: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  is_active: boolean;
  archived: boolean;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySession {
  id: string;
  project: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MemoryRelationship {
  id: string;
  source_id: string;
  target_id: string;
  relationship_type: RelationshipType;
  created_at: string;
}

export interface RememberInput {
  content: string;
  project?: string;
  source_type?: SourceType;
  category?: Category | null;
  metadata?: Record<string, unknown>;
}

export type RememberResult = 'inserted' | 'updated' | 'skipped';

export interface RecallInput {
  query: string;
  project?: string | null;
  token_budget?: number;
  min_results?: number;
}

export interface RecallHit {
  id: string;
  content: string;
  source_type: SourceType;
  category: Category | null;
  project: string;
  score: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SearchInput {
  query: string;
  project?: string | null;
  source_type?: SourceType | null;
  limit?: number;
}

export interface StatusReport {
  total_active: number;
  sessions: number;
  by_project: Record<string, number>;
  by_source_type: Record<string, number>;
  by_category: Record<string, number>;
}

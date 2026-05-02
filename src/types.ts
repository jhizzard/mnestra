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

/**
 * Sprint 50 T2 (TermDeck): identity of the LLM that produced a memory row.
 * Stored on `memory_items.source_agent`; populated by SessionEnd hooks
 * (Claude direct, plus TermDeck's per-adapter panel-close trigger from
 * Sprint 50 T1). NULL for historical rows that pre-date the column —
 * see migrations/015_source_agent.sql for the backfill rule.
 */
export type SourceAgent = 'claude' | 'codex' | 'gemini' | 'grok' | 'orchestrator';

export const SOURCE_AGENTS: SourceAgent[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'orchestrator',
];

export interface RecallInput {
  query: string;
  project?: string | null;
  token_budget?: number;
  min_results?: number;
  /**
   * Filter results by the source agent that produced each row. Omit (or
   * pass an empty array) for no filter — the default, returns all agents.
   * When set, rows with NULL source_agent (historical, pre-Sprint-50 except
   * the backfilled session_summary rows) are excluded.
   */
  source_agents?: string[] | null;
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

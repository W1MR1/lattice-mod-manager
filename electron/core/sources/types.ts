import type { GameContext, ModProject, ModRef, ModVersion, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';

export interface SourceAdapter {
  search(q: SearchQuery): Promise<SearchResult>;
  versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]>;
  project(ref: ModRef, ctx: GameContext): Promise<ModProject | null>;
  meta(refs: ModRef[], ctx: GameContext): Promise<Map<string, ProjectMeta>>;
}

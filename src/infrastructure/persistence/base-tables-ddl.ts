/**
 * 六张**基础表**的**增量** DDL —— M12 · 迁移 0024（`elizaos-base-tables`）。
 *
 * ============================================================================
 *  ⚠️ 这份文件**只含外键与索引**，不含建表
 * ============================================================================
 * 实测发现：迁移 0023（`lg-runtime-compatibility-tables`）**已经建了全部六张表**
 * （agents / entities / memories / participants / rooms / worlds），
 * 且列集合与本文件取证得到的**逐表相同**：
 *   agents 17 · entities 5 · memories 10 · participants 6 · rooms 10 · worlds 6
 *
 * 0023 只建了**主键与唯一约束**，缺的是：
 *   · **12 条外键**（FK 链：`agents ← entities ← memories`、`rooms → participants`）
 *   · **7 个索引**（含 `idx_memories_*` / `idx_participants_*`）
 * ⇒ 这就是 0024 的全部内容。建表**不在**这里。
 *
 * ============================================================================
 *  来源与边界（如实记录）
 * ============================================================================
 * · **来源**：隔离库 `lg_test_w1` 上由**旧宿主**（plugin-sql 1.7.2）从零建出后，
 *   用 `pg_dump --schema-only` 捕获，**再剔除建表语句**。
 *   **不是**手写的。· 捕获时间：2026-10-19（M12 W0b/W1）。
 * · 这六张表承载 `messages` 镜像等既有功能 —— 本阶段**只接管维护权，不删表结构**。
 * ⚠️ **只增不改**：已发布的迁移内容不许再改；需要改就加新的版本号。
 * ⚠️ 全部语句为**幂等 DDL**（约束包在 `DO` 块里按 `pg_constraint.conname` 判存在性）。
 *
 * 生成方式：`pnpm thinhost:base-ddl:capture -- <lg_test_db>`
 * （⚠️ 全程不进 shell —— 代码页 936 会损坏 UTF-8 输出，见 `L-QQP-03`。）
 */

/** 基础表的增量 DDL：12 条外键 + 7 个索引 */
export const BASE_TABLE_DDL: readonly string[] = [
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agents_pkey') then
    alter table public.agents add constraint agents_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entities_pkey') then
    alter table public.entities add constraint entities_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'id_agent_id_unique') then
    alter table public.entities add constraint id_agent_id_unique UNIQUE (id, agent_id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memories_pkey') then
    alter table public.memories add constraint memories_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'participants_pkey') then
    alter table public.participants add constraint participants_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rooms_pkey') then
    alter table public.rooms add constraint rooms_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'worlds_pkey') then
    alter table public.worlds add constraint worlds_pkey PRIMARY KEY (id);
  end if;
end $$;;`,
    `create index if not exists idx_fragments_order ON public.memories USING btree (((metadata ->> 'documentId'::text)), ((metadata ->> 'position'::text)));`,
    `create index if not exists idx_memories_document_id ON public.memories USING btree (((metadata ->> 'documentId'::text)));`,
    `create index if not exists idx_memories_metadata_type ON public.memories USING btree (((metadata ->> 'type'::text)));`,
    `create index if not exists idx_memories_type_room ON public.memories USING btree (type, room_id);`,
    `create index if not exists idx_memories_world_id ON public.memories USING btree (world_id);`,
    `create index if not exists idx_participants_room ON public.participants USING btree (room_id);`,
    `create index if not exists idx_participants_user ON public.participants USING btree (entity_id);`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entities_agent_id_agents_id_fk') then
    alter table public.entities add constraint entities_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_agent') then
    alter table public.memories add constraint fk_agent FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_room') then
    alter table public.participants add constraint fk_room FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_user') then
    alter table public.participants add constraint fk_user FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memories_agent_id_agents_id_fk') then
    alter table public.memories add constraint memories_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memories_entity_id_entities_id_fk') then
    alter table public.memories add constraint memories_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memories_room_id_rooms_id_fk') then
    alter table public.memories add constraint memories_room_id_rooms_id_fk FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'participants_agent_id_agents_id_fk') then
    alter table public.participants add constraint participants_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'participants_entity_id_entities_id_fk') then
    alter table public.participants add constraint participants_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'participants_room_id_rooms_id_fk') then
    alter table public.participants add constraint participants_room_id_rooms_id_fk FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rooms_agent_id_agents_id_fk') then
    alter table public.rooms add constraint rooms_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
    `do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'worlds_agent_id_agents_id_fk') then
    alter table public.worlds add constraint worlds_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
  end if;
end $$;;`,
]
